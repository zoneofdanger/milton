#!/usr/bin/env bun
/** Records one scene of the demo clip as a real interactive session: asciinema
 * records a minimal shell inside a private tmux server, and this script types
 * the scene's lines into it with human-like delays, waiting for each reply.
 * Procedure, scene format and privacy rules: docs/demo.md. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

const SOCKET = "milton-demo"; // a private tmux server, never the person's own
const SESSION = "demo";
const SUPPORT = "/private/tmp/milton-demo-support"; // shell rc and MCP config, never on screen
const PLAYER_SPEED = 1.5; // the published player's speed, docs/demo.md
const SHELL_READY = /^\$ ?$/m; // capture-pane drops the trailing space

type Client = {
  profileVar: string; // the env var naming this client's separate profile
  profileEnv: string; // what the client itself reads
  defaultProfile: string; // the person's real profile, which the driver refuses
  shellFunction: string; // defines the typed command, flags kept off screen
  ready: RegExp; // the input prompt is back
  busy: RegExp; // a reply is still being written
  blocked: RegExp; // a dialog is waiting, so typing would answer it
  exitKeys: string[]; // tmux keys a person would press to quit the client
  notice?: RegExp; // group 1 is whatever the startup banner shows under its fixed lines
  env?: Record<string, string>; // added to the clean environment
  memoryDir?: (profile: string, cwd: string) => string; // the client's own memory for cwd
};

const CLIENTS: Record<string, Client> = {
  claude: {
    profileVar: "DEMO_CLAUDE_CONFIG_DIR",
    profileEnv: "CLAUDE_CONFIG_DIR",
    defaultProfile: join(homedir(), ".claude"),
    shellFunction: `claude() { command claude --mcp-config ${SUPPORT}/mcp.json --strict-mcp-config --allowedTools mcp__milton__get_report,mcp__milton__create_memo --disable-slash-commands "$@"; }`,
    ready: /─{20,}\n❯[ \u00a0]/, // Claude Code puts a no-break space after ❯
    busy: /esc to interrupt/i,
    blocked: /Esc to cancel/,
    exitKeys: ["C-d", "C-d"], // Ctrl-D, and again if it asks to confirm
    notice: /Claude Code v[^\n]*\n[^\n]*\n[^\n]*\n([\s\S]*?)─{20,}/,
    // Claude Code's own memory must not be what carries Sam's style between days.
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    // Its project folder is the cwd with every non-alphanumeric turned into "-".
    memoryDir: (profile, cwd) =>
      join(profile, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), "memory"),
  },
  codex: {
    profileVar: "DEMO_CODEX_HOME",
    profileEnv: "CODEX_HOME",
    defaultProfile: join(homedir(), ".codex"),
    shellFunction: `codex() { command codex -c check_for_update_on_startup=false "$@"; }`,
    ready: /^›[ \u00a0]/m,
    busy: /esc to interrupt/i,
    blocked: /Would you like to|Allow the .* to run/i,
    exitKeys: ["C-c", "C-c"], // Ctrl-C, and again if it asks to confirm
  },
};

type Scene = {
  client: string;
  command: string; // typed at the shell prompt, e.g. "claude"
  lines: string[]; // Sam's lines, each sent once the previous reply is done
  cwd?: string;
  size?: string; // COLSxROWS
  idleTimeLimit?: number; // seconds; asciinema caps every pause to this on playback
  pauseSeconds?: number; // before typing each line
  typingScale?: number; // multiplies every typing gap; under 1 types faster
  endHoldSeconds?: number; // after the last reply, before the recording stops
  turnTimeoutSeconds?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (message: string): never => {
  console.error(`record: ${message}`);
  stop();
  process.exit(1);
};

/** A process the driver started, as tmux reported it. Its start time guards
 * against a reused pid. */
type Started = { pid: number; started: string | null };

/** What the driver launched: the tmux server and the pane's process (the
 * recorder, or unrecorded the shell), by the pids tmux itself printed. Set
 * before the launch, so a failure at any point after it still stops it. */
let launched: {
  server: Started | null;
  pane: Started | null;
  exitKeys: string[];
  tempDir: string | null; // the recorder's private folder
} | null = null;

let psWedged = false;
let leftovers = false; // a stop reported processes it could not end

/** pid -> { ppid, start time } for every process, or null when ps fails or
 * takes over 5 s. Bounded, so a wedged ps can't hold up the driver; after one
 * timeout it isn't asked again. */
function processTable() {
  if (psWedged) return null;
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  if (r.error) psWedged = true;
  if (r.status !== 0 || !r.stdout?.trim()) return null;
  const table = new Map<number, { ppid: number; started: string }>();
  for (const line of r.stdout.split("\n")) {
    const [pid, ppid, ...lstart] = line.trim().split(/\s+/);
    if (pid)
      table.set(Number(pid), { ppid: Number(ppid), started: lstart.join(" ") });
  }
  return table;
}

/** The ones of `procs` still running, or null when that can't be checked. */
function running(procs: Started[]) {
  const table = processTable();
  if (!table) return null;
  return procs.filter((p) => table.get(p.pid)?.started === p.started);
}

/** tmux on the private socket, bounded so an unresponsive server can't hang the
 * driver. Returns null on failure or timeout. */
function tmuxRaw(args: string[], env?: Record<string, string>, ms = 10_000) {
  const r = spawnSync("tmux", ["-L", SOCKET, ...args], {
    encoding: "utf8",
    env: env ?? cleanEnv({}),
    timeout: ms,
    killSignal: "SIGKILL",
  });
  return r.status === 0 ? r.stdout : null;
}

/** Ends the client and the shell the way a person would, so the recorder ends
 * by itself. Bounded; does nothing once the pane's process has gone. Without a
 * verifiable pane pid it still sends the keys, and gives them a fixed while. */
function exitCleanly(pane: Started | null, keys: string[]) {
  const gone = () => (pane?.started ? running([pane])?.length === 0 : false);
  const atPrompt = () =>
    SHELL_READY.test(
      tmuxRaw(["capture-pane", "-p", "-t", SESSION], undefined, 3000) ?? "",
    );
  if (gone()) return;
  for (const key of keys) {
    if (atPrompt()) break;
    tmuxRaw(["send-keys", "-t", SESSION, key], undefined, 3000);
    Bun.sleepSync(1000);
  }
  if (atPrompt()) {
    tmuxRaw(["send-keys", "-t", SESSION, "-l", "exit"], undefined, 3000);
    tmuxRaw(["send-keys", "-t", SESSION, "Enter"], undefined, 3000);
  }
  const until = Date.now() + (pane?.started ? 5000 : 2000);
  while (Date.now() < until && !gone()) Bun.sleepSync(250);
}

/** Ends what the driver launched and reports whether anything of it is left.
 * `tmux kill-server` alone is not enough: asciinema survives it with its shell
 * and client. So: exit the client and shell cleanly, stop the tmux server with
 * a time limit, then send SIGHUP, SIGTERM and SIGKILL only to the two pids tmux
 * printed, each still checked against its start time. It hunts nothing else:
 * any other process left from the take is reported by pid, not signalled.
 * Synchronous, so it can run on any exit. */
function stop() {
  if (!launched) return true;
  const run = launched;
  launched = null;
  const targets = [run.server, run.pane].filter(
    (p): p is Started => p !== null && p.started !== null,
  );
  // The take's other processes as they are now, to report any that outlive it.
  const before = processTable();
  const seen: Started[] = [];
  if (before)
    for (const [pid, p] of before)
      for (let up = p.ppid, hops = 0; up > 1 && hops < 64; hops++) {
        if (targets.some((t) => t.pid === up)) {
          seen.push({ pid, started: p.started });
          break;
        }
        up = before.get(up)?.ppid ?? 0;
      }
  exitCleanly(run.pane, run.exitKeys);
  tmuxRaw(["kill-server"], undefined, 3000);
  let left = running(targets);
  for (const sig of ["SIGHUP", "SIGTERM", "SIGKILL"] as const) {
    for (const until = Date.now() + 2000; Date.now() < until;) {
      if (left && !left.length) break;
      Bun.sleepSync(200);
      left = running(left ?? targets);
    }
    if (!left || !left.length) break;
    for (const p of left)
      try {
        process.kill(p.pid, sig);
      } catch {} // already gone
    left = running(left);
  }
  if (run.tempDir) rmSync(run.tempDir, { recursive: true, force: true });
  const unverified = [run.server, run.pane].filter(
    (p) => p !== null && p.started === null,
  );
  const survivors = running([...targets, ...seen]);
  if (!survivors || unverified.length) {
    const pids = [run.server, run.pane, ...seen].flatMap((p) =>
      p ? [p.pid] : [],
    );
    console.error(
      `record: could not check which processes from the take are still running; check with ps for pids ${pids.join(", ")} and stop any by pid`,
    );
    leftovers = true;
    return false;
  }
  leftovers ||= survivors.length > 0;
  if (survivors.length)
    console.error(
      `record: these processes from the take are still running: ${survivors.map((p) => p.pid).join(", ")}; stop them by pid`,
    );
  return survivors.length === 0;
}

function tmux(args: string[], env?: Record<string, string>) {
  const r = spawnSync("tmux", ["-L", SOCKET, ...args], {
    encoding: "utf8",
    env: env ?? cleanEnv({}),
    timeout: 10_000, // a stopped server would otherwise hang the driver
    killSignal: "SIGKILL",
  });
  if (r.status !== 0 && args[0] !== "kill-server")
    fail(
      `tmux ${args[0]} failed: ${r.error ? "no answer in 10 s" : r.stderr.trim()}`,
    );
  return r.stdout;
}

const screen = () => tmux(["capture-pane", "-p", "-t", SESSION]);

/** Sam's own git identity. Clients read the global git config for the person's
 * name, and an AI once signed a draft with the operator's name from it. */
function samGitConfig() {
  const path = join(tmpdir(), "sam-demo.gitconfig");
  writeFileSync(path, "[user]\n\tname = Sam\n\temail = sam@example.com\n");
  return path;
}

/** Only what the shell and clients need; nothing from the caller's session. */
function cleanEnv(extra: Record<string, string>) {
  const keep = ["PATH", "HOME", "LANG", "TMPDIR", "USER", "LOGNAME"];
  const env: Record<string, string> = { SHELL: "/bin/zsh" };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return {
    ...env,
    TERM: "xterm-256color",
    GIT_CONFIG_GLOBAL: samGitConfig(),
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
}

/** The neutral working folder: a path that names no person. */
function checkCwd(cwd: string) {
  const user = userInfo().username;
  if (!cwd.startsWith("/") || cwd.includes("/Users/") || cwd.includes(user))
    fail(`cwd ${cwd} must be absolute and name no home folder or user`);
}

/** Refuses a take that could show the person's git name or carry Sam's style by
 * any route but Milton. Runs before anything launches; makes no model call. */
function checkTake(scene: Scene, client: Client) {
  const cwd = scene.cwd ?? "/private/tmp/sam-demo";
  checkCwd(cwd);
  // Claude Code takes the git user from the repo's config, not from the
  // driver's GIT_CONFIG_GLOBAL, and once showed the person's real name. So the
  // repo itself must name Sam, read with the person's own environment.
  const git = (args: string[]) =>
    spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: process.env,
    });
  const inRepo =
    existsSync(cwd) &&
    git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
  if (
    inRepo &&
    git(["config", "user.name"]).stdout.replace(/\n$/, "") !== "Sam"
  )
    fail(
      `git user.name in ${cwd} is not Sam; rebuild it with scripts/demo/make-repo.sh`,
    );
  if (!client.memoryDir) return;
  const profile = process.env[client.profileVar];
  if (!profile) fail(`set ${client.profileVar} to the client's test profile`);
  const dir = client.memoryDir(
    resolve(profile!),
    existsSync(cwd) ? realpathSync(cwd) : cwd,
  );
  const files = existsSync(dir)
    ? readdirSync(dir, { recursive: true }).filter((f) =>
        statSync(join(dir, String(f))).isFile(),
      )
    : [];
  if (files.length)
    fail(
      `${dir} holds ${files.length} file(s); the client's own memory must be empty`,
    );
}

function loadScene(path: string) {
  const scene = JSON.parse(readFileSync(path, "utf8")) as Scene;
  const client = CLIENTS[scene.client];
  if (!client) fail(`unknown client ${scene.client}`);
  if (!scene.command || !scene.lines?.length)
    fail("scene needs command and lines");
  return { scene, client: client! };
}

/** Starts the private tmux server with a minimal shell, recorded or not. */
function start(scene: Scene, client: Client, cast: string | null) {
  const key = process.env.MILTON_KEY;
  if (!key) fail("set MILTON_KEY to the test account's connection key");
  const profile = process.env[client.profileVar];
  if (!profile) fail(`set ${client.profileVar} to the client's test profile`);
  if (resolve(profile!) === client.defaultProfile)
    fail(`${client.profileVar} is the real profile; use a separate one`);
  const cwd = scene.cwd ?? "/private/tmp/sam-demo";
  checkCwd(cwd);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(SUPPORT, { recursive: true });
  const url = process.env.DEMO_MILTON_URL ?? "https://mcp.meetmilton.com/mcp";
  const mcp = {
    mcpServers: {
      milton: {
        type: "http",
        url,
        headers: { Authorization: "Bearer ${MILTON_KEY}" },
      },
    },
  };
  writeFileSync(join(SUPPORT, "mcp.json"), JSON.stringify(mcp));
  writeFileSync(
    join(SUPPORT, ".zshrc"),
    [
      "unset HISTFILE",
      "PS1='$ '",
      "RPROMPT=''",
      "PROMPT_EOL_MARK=''",
      client.shellFunction,
      "clear",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(SUPPORT, "tmux.conf"),
    "set -g status off\nset -g focus-events on\nset -sg escape-time 0\nset -g default-terminal xterm-256color\n",
  );
  const [cols, rows] = (scene.size ?? "100x30").split("x");
  const shell = "/bin/zsh -d -i";
  const pane = cast
    ? `asciinema rec -q --overwrite --idle-time-limit ${scene.idleTimeLimit ?? 2} -c '${shell}' '${cast}'`
    : shell;
  tmuxRaw(["kill-server"], undefined, 3000);
  const env = cleanEnv({
    MILTON_KEY: key!,
    ZDOTDIR: SUPPORT,
    [client.profileEnv]: resolve(profile!),
    ...client.env,
  });
  launched = {
    server: null,
    pane: null,
    exitKeys: client.exitKeys,
    tempDir: cast ? dirname(cast) : null,
  };
  const ids = tmux(
    [
      ["-f", join(SUPPORT, "tmux.conf"), "new-session", "-d", "-s", SESSION],
      ["-P", "-F", "#{pid} #{pane_pid}"],
      ["-x", cols!, "-y", rows!, "-c", cwd, pane],
    ].flat(),
    env,
  );
  const [serverPid, panePid] = ids.trim().split(" ").map(Number);
  const table = processTable();
  const started = (pid: number | undefined) =>
    pid ? { pid, started: table?.get(pid)?.started ?? null } : null;
  launched.server = started(serverPid);
  launched.pane = started(panePid);
  if (!launched.server?.started || !launched.pane?.started)
    fail("could not find the tmux server or the pane's process");
}

async function waitFor(test: (s: string) => boolean, seconds: number) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (test(screen())) return true;
    await sleep(300);
  }
  return false;
}

/** Types like a person: uneven gaps, a little longer after words and stops. */
async function type(text: string, scale = 1) {
  for (const ch of text) {
    tmux(["send-keys", "-t", SESSION, "-l", ch]);
    let ms = 45 + Math.random() * 70;
    if (ch === " ") ms += Math.random() * 60;
    if (/[.,!?]/.test(ch)) ms += 120 + Math.random() * 180;
    await sleep(ms * scale);
  }
  await sleep((350 + Math.random() * 250) * scale);
  tmux(["send-keys", "-t", SESSION, "Enter"]);
}

/** Waits until the reply is done: no busy line, the prompt back, the screen still. */
async function waitTurn(client: Client, timeoutSeconds: number) {
  await sleep(1500);
  const until = Date.now() + timeoutSeconds * 1000;
  let last = "";
  let stableSince = Date.now();
  while (Date.now() < until) {
    const s = screen();
    if (client.blocked.test(s) && !client.busy.test(s))
      return `a dialog is waiting:\n${s}`;
    if (s !== last || client.busy.test(s) || !client.ready.test(s)) {
      last = s;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 3000) return null;
    await sleep(400);
  }
  return `no reply finished within ${timeoutSeconds}s`;
}

/** Claude Code's banner can carry a rotating notice (an ad, a new model) that no
 * setting turns off but that stops after a few showings. Launch unrecorded until
 * the banner is plain, so the take needs no cut. */
async function preflight(scene: Scene, client: Client) {
  if (!client.notice) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    start(scene, client, null);
    if (!(await waitFor((s) => SHELL_READY.test(s), 20)))
      fail("the shell prompt never appeared");
    tmux(["send-keys", "-t", SESSION, "-l", scene.command]);
    tmux(["send-keys", "-t", SESSION, "Enter"]);
    const ready = await waitFor((s) => client.ready.test(s), 60);
    await sleep(1500);
    const s = screen();
    stop(); // reports anything left; the take goes ahead and exits 1
    if (!ready) fail(`the client never showed its prompt:\n${s}`);
    const notice = s.match(client.notice)?.[1]?.trim();
    if (!notice) return;
    console.error(
      `record: launch ${attempt} showed a banner notice: ${notice}`,
    );
  }
  fail("the banner still shows a notice after 3 unrecorded launches");
}

async function record(scenePath: string, cast: string) {
  const { scene, client } = loadScene(scenePath);
  checkTake(scene, client);
  await preflight(scene, client);
  const out = resolve(cast);
  mkdirSync(dirname(out), { recursive: true });
  const timeline: { t: number; event: string; line?: string }[] = [];
  const t0 = Date.now();
  const mark = (event: string, line?: string) =>
    timeline.push({ t: (Date.now() - t0) / 1000, event, line });
  // The recorder writes only to a private file. The take is a copy of it, so
  // nothing left running from the take can write to the take.
  const recording = join(
    mkdtempSync(join(tmpdir(), "milton-take-")),
    "take.cast",
  );
  start(scene, client, recording);
  if (!(await waitFor((s) => SHELL_READY.test(s), 20)))
    fail("the shell prompt never appeared");
  await sleep(800);
  await type(scene.command, scene.typingScale);
  mark("launched");
  let problem = await waitTurn(client, 90);
  for (const line of problem ? [] : scene.lines) {
    await sleep((scene.pauseSeconds ?? 2) * 1000);
    mark("typed", line);
    await type(line, scene.typingScale);
    problem = await waitTurn(client, scene.turnTimeoutSeconds ?? 300);
    mark("reply-done");
    if (problem) break;
  }
  await sleep((scene.endHoldSeconds ?? 4) * 1000);
  // The take ends here, on the last reply: copy it before the client is exited,
  // so the exit is not in it. asciinema writes whole lines; wait out a torn one.
  let take = readFileSync(recording);
  for (let i = 0; i < 10 && take.at(-1) !== 0x0a; i++) {
    await sleep(100);
    take = readFileSync(recording);
  }
  stop();
  writeFileSync(out, take);
  writeFileSync(`${out}.timeline.json`, JSON.stringify(timeline, null, 2));
  if (problem) console.error(`record: stopped early, ${problem}`);
  const hits = scan(out);
  return problem || hits || leftovers ? 1 : 0;
}

/** Runs the scene's shell unrecorded, to clear first-run dialogs, and waits until
 * that shell exits or Ctrl-C, then stops everything it started. */
async function warmup(scenePath: string) {
  const { scene, client } = loadScene(scenePath);
  start(scene, client, null);
  console.log(
    `Attach with: tmux -L ${SOCKET} attach -t ${SESSION}\n` +
      `Run ${scene.command}, clear any trust or notice dialogs, then exit the client and the shell.\n` +
      `This waits until the shell exits; Ctrl-C here stops it instead.`,
  );
  const pane = launched!.pane!;
  while (running([pane])?.length !== 0) await sleep(1000);
  return stop() ? 0 : 1;
}

/** Runs a take's guards alone: launches nothing and makes no model call. */
function check(scenePath: string) {
  const { scene, client } = loadScene(scenePath);
  checkTake(scene, client);
  console.log(`${scenePath}: guards pass`);
  return 0;
}

const ANSI =
  /\x1b\[[0-9;?<>=!]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g;
const ALLOWED_EMAIL =
  /@([a-z0-9-]+\.)*(invalid|test|example|localhost)$|@example\.(com|org|net)$/i;
// Masks keys at their own length, so a snippet cut from any offset shows none of one.
const mask = (s: string) =>
  s.replace(/mk_[A-Za-z0-9_.-]*/g, (k) => "mk_" + "*".repeat(k.length - 3));

/** Lists everything in a .cast that could identify the person or leak a key. */
function scan(cast: string) {
  const raw = readFileSync(cast, "utf8");
  const [headerLine, ...rest] = raw.trimEnd().split("\n");
  const header = JSON.parse(headerLine!);
  let output = "";
  let seconds = 0;
  let trimmed = 0;
  const idle = header.idle_time_limit ?? Infinity;
  for (const l of rest) {
    const [interval, code, data] = JSON.parse(l) as [number, string, string];
    seconds += interval;
    trimmed += Math.min(interval, idle);
    if (code === "o") output += data;
  }
  const text = output.replace(ANSI, "");
  const terms = new Set<string>(["/Users/", "/home/", userInfo().username]);
  const fullName = spawnSync("id", ["-F"], { encoding: "utf8" }).stdout ?? "";
  for (const part of fullName.trim().split(/\s+/))
    if (part.length >= 3) terms.add(part);
  for (const t of (process.env.DEMO_SCAN_TERMS ?? "").split(","))
    if (t.trim()) terms.add(t.trim());
  const hits: string[] = [];
  const where = { header: headerLine!, screen: text, raw };
  for (const [name, body] of Object.entries(where)) {
    const lower = body.toLowerCase();
    const safe = mask(body);
    const add = (i: number, what: string) =>
      hits.push(
        `${name}: ${what}: …${safe.slice(Math.max(0, i - 30), i + 40).replace(/\s+/g, " ")}…`,
      );
    for (const m of body.matchAll(/mk_[A-Za-z0-9]/g)) add(m.index!, "key");
    for (const t of terms) {
      let i = lower.indexOf(t.toLowerCase());
      while (i !== -1) {
        add(i, t);
        i = lower.indexOf(t.toLowerCase(), i + 1);
      }
    }
    for (const m of body.matchAll(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    ))
      if (!ALLOWED_EMAIL.test(m[0])) add(m.index!, "email");
  }
  const unique = [...new Set(hits)];
  console.log(
    `${cast}: ${seconds.toFixed(1)}s recorded, ${trimmed.toFixed(1)}s with pauses trimmed (idle limit ${header.idle_time_limit ?? "none"}s), ${(trimmed / PLAYER_SPEED).toFixed(1)}s at ${PLAYER_SPEED}x, ${header.term?.cols}x${header.term?.rows}`,
  );
  console.log(
    unique.length
      ? `${unique.length} privacy hit(s):\n${unique.join("\n")}`
      : "privacy scan: no hits",
  );
  return unique.length;
}

// Ctrl-C and other ends of the driver stop what it launched too.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => fail(`${sig}: stopping`));
process.on("uncaughtException", (e) => fail(String(e?.stack ?? e)));
process.on("unhandledRejection", (e) => fail(String(e)));

const [command, ...args] = process.argv.slice(2);
if (command === "record" && args.length === 2)
  process.exit(await record(args[0]!, args[1]!));
else if (command === "warmup" && args.length === 1)
  process.exit(await warmup(args[0]!));
else if (command === "check" && args.length === 1)
  process.exit(check(args[0]!));
else if (command === "scan" && args.length >= 1)
  process.exit(args.reduce((n, c) => n + scan(c), 0) ? 1 : 0);
else {
  console.error(
    "usage: bun scripts/demo/record.ts record <scene.json> <out.cast>\n" +
      "       bun scripts/demo/record.ts warmup <scene.json>\n" +
      "       bun scripts/demo/record.ts check <scene.json>\n" +
      "       bun scripts/demo/record.ts scan <file.cast>...",
  );
  process.exit(2);
}
