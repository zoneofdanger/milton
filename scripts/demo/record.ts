#!/usr/bin/env bun
/** Records one scene of the demo clip as a real interactive session: asciinema
 * records a minimal shell inside a private tmux server, and this script types
 * the scene's lines into it with human-like delays, waiting for each reply.
 * Procedure, scene format and privacy rules: docs/demo.md. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
  process.exit(1);
};

function tmux(args: string[], env?: Record<string, string>) {
  const r = spawnSync("tmux", ["-L", SOCKET, ...args], {
    encoding: "utf8",
    env: env ?? cleanEnv({}),
  });
  if (r.status !== 0 && args[0] !== "kill-server")
    fail(`tmux ${args[0]} failed: ${r.stderr.trim()}`);
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
  tmux(["kill-server"]);
  const env = cleanEnv({
    MILTON_KEY: key!,
    ZDOTDIR: SUPPORT,
    [client.profileEnv]: resolve(profile!),
    ...client.env,
  });
  tmux(
    [
      ["-f", join(SUPPORT, "tmux.conf"), "new-session", "-d", "-s", SESSION],
      ["-x", cols!, "-y", rows!, "-c", cwd, pane],
    ].flat(),
    env,
  );
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
    tmux(["kill-server"]);
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
  start(scene, client, out);
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
  tmux(["kill-server"]);
  await sleep(500);
  writeFileSync(`${out}.timeline.json`, JSON.stringify(timeline, null, 2));
  if (problem) console.error(`record: stopped early, ${problem}`);
  const hits = scan(out);
  return problem || hits ? 1 : 0;
}

/** Leaves the scene's shell running unrecorded, to clear first-run dialogs. */
function warmup(scenePath: string) {
  const { scene, client } = loadScene(scenePath);
  start(scene, client, null);
  console.log(
    `Attach with: tmux -L ${SOCKET} attach -t ${SESSION}\n` +
      `Run ${scene.command}, clear any trust or notice dialogs, then exit.\n` +
      `Stop with: tmux -L ${SOCKET} kill-server`,
  );
  return 0;
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

const [command, ...args] = process.argv.slice(2);
if (command === "record" && args.length === 2)
  process.exit(await record(args[0]!, args[1]!));
else if (command === "warmup" && args.length === 1)
  process.exit(warmup(args[0]!));
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
