#!/usr/bin/env bun
/** Assembles the demo clip from the two approved scene casts: title cards are
 * written as small casts of their own, and `asciinema cat` joins everything in
 * order. No recorded event is changed; the script checks that every one of
 * them reaches the output with its interval and data intact.
 * Shape and rules: docs/demo.md. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TRIAL_DAYS } from "../../packages/theme/facts";

const PLAYER_SPEED = 1.5; // the published player's speed, docs/demo.md
const IDLE_LIMIT = 1; // the scenes' and the player's idle limit, in seconds
// Each card, and each scene's last frame, stays this long on screen at 1.5x.
const HOLD_SECONDS = 2;
// The idle limit caps every gap at 1 s, so a hold is a run of empty output
// events spaced under that limit. An empty event draws nothing.
const KEEP_ALIVE = 0.75;

type Header = {
  version: number;
  term?: { cols?: number; rows?: number };
  idle_time_limit?: number;
};
type Event = [number, string, string];

const fail = (message: string): never => {
  console.error(`assemble: ${message}`);
  process.exit(1);
};

function readCast(path: string) {
  const [first, ...lines] = readFileSync(path, "utf8").trimEnd().split("\n");
  const header = JSON.parse(first!) as Header;
  if (header.version !== 3) fail(`${path} is not asciicast v3`);
  return { header, events: lines.map((l) => JSON.parse(l) as Event) };
}

/** Holds the current frame: empty events, none longer than the idle limit. */
function hold(): Event[] {
  const recorded = HOLD_SECONDS * PLAYER_SPEED;
  const events: Event[] = [];
  for (let t = 0; t < recorded - 1e-9; t += KEEP_ALIVE)
    events.push([Math.min(KEEP_ALIVE, recorded - t), "o", ""]);
  return events;
}

/** One title card: leave any alternate screen, reset, clear, and print the
 * line in bold, centred across, with the cursor hidden; then hold it. */
function card(text: string, cols: number, rows: number): Event[] {
  // A third of the way down, so the play button doesn't cover the first card.
  const row = Math.round(rows / 3);
  const col = Math.max(1, Math.floor((cols - [...text].length) / 2) + 1);
  const draw =
    "\x1b[?1049l\x1b[r\x1b[0m\x1b[?25l\x1b[3J\x1b[H\x1b[2J" +
    `\x1b[${row};${col}H\x1b[1m${text}\x1b[0m`;
  return [[0, "o", draw], ...hold()];
}

/** Clears the card and shows the cursor again, as the next scene starts. */
const handOff: Event = [0, "o", "\x1b[2J\x1b[H\x1b[?25h"];

// No card names a weekday: Claude's standup prints the real date.
const CARDS = {
  day1: "# Morning standup",
  day2: "# Next morning",
  memo: "# Did you get the memo? Your AI already did.",
  // The trial length comes from facts.ts, so the card can't drift from it.
  close: `# meetmilton.com · ${TRIAL_DAYS}-day free trial, no card`,
};

function assemble(day1Path: string, day2Path: string, outPath: string) {
  const day1 = readCast(day1Path);
  const day2 = readCast(day2Path);
  const cols = day1.header.term?.cols ?? 0;
  const rows = day1.header.term?.rows ?? 0;
  for (const [path, cast] of [
    [day1Path, day1],
    [day2Path, day2],
  ] as const) {
    if (cast.header.term?.cols !== cols || cast.header.term?.rows !== rows)
      fail(`${path} is not ${cols}x${rows} like Day 1`);
    if (cast.header.idle_time_limit !== IDLE_LIMIT)
      fail(`${path} does not have the ${IDLE_LIMIT} s idle limit`);
  }

  // The header names nothing about the machine: no timestamp, command or env.
  const header = {
    version: 3,
    term: { cols, rows, type: "xterm-256color" },
    idle_time_limit: IDLE_LIMIT,
    title: "Milton demo",
  };
  const segments: Event[][] = [
    [...card(CARDS.day1, cols, rows), handOff],
    [...hold(), ...card(CARDS.day2, cols, rows), handOff],
    [
      ...hold(),
      ...card(CARDS.memo, cols, rows),
      ...card(CARDS.close, cols, rows),
    ],
  ];
  const work = mkdtempSync(join(tmpdir(), "milton-demo-"));
  try {
    const files = segments.map((events, i) => {
      const file = join(work, `segment-${i}.cast`);
      writeFileSync(
        file,
        [header, ...events].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      return file;
    });
    const order = [files[0]!, day1Path, files[1]!, day2Path, files[2]!];
    const result = spawnSync("asciinema", ["cat", "-q", ...order], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0)
      fail(`asciinema cat failed: ${result.stderr.trim()}`);
    writeFileSync(outPath, result.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Every recorded event must reach the output unchanged, in order.
  const out = readCast(outPath).events;
  const expected = [
    ...segments[0]!,
    ...day1.events,
    ...segments[1]!,
    ...day2.events,
    ...segments[2]!,
  ];
  if (out.length !== expected.length)
    fail(`output has ${out.length} events, expected ${expected.length}`);
  expected.forEach(([interval, code, data], i) => {
    const [gotInterval, gotCode, gotData] = out[i]!;
    if (
      Math.abs(gotInterval - interval) > 5e-4 ||
      gotCode !== code ||
      gotData !== data
    )
      fail(`event ${i + 1} differs from its source`);
  });
  const seconds = out.reduce((s, [t]) => s + Math.min(t, IDLE_LIMIT), 0);
  console.log(
    `${outPath}: ${out.length} events, ${seconds.toFixed(1)}s with pauses trimmed, ` +
      `${(seconds / PLAYER_SPEED).toFixed(1)}s at ${PLAYER_SPEED}x; recorded events unchanged`,
  );
}

const args = process.argv.slice(2);
if (args.length !== 3) {
  console.error(
    "usage: bun scripts/demo/assemble.ts <day-1.cast> <day-2.cast> <out.cast>",
  );
  process.exit(2);
}
assemble(resolve(args[0]!), resolve(args[1]!), resolve(args[2]!));
