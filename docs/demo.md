---
name: demo
description: Recording the demo clip's scenes: the driver that types into a real Claude Code or Codex session under asciinema, scene files and the privacy scan
type: procedure
covers:
  - scripts/demo/**
---

# Demo recording

The clip's shape and rules (scenes, wording, labels, who approves) are TODO #33 in
[TODO.md](../TODO.md). This file covers how a scene is recorded.

`scripts/demo/record.ts` records one scene as a real interactive session, not `-p` or
`exec`. It starts a private tmux server (socket `milton-demo`), runs `asciinema rec` on a
minimal zsh in it, and types the scene's lines with uneven per-character delays. After
each line it waits for the reply to finish: no "esc to interrupt" line, the client's input
prompt back, and the screen unchanged for three seconds, with a per-turn timeout. A
dialog waiting for an answer stops the take instead of typing into it.

## Needs

- `asciinema` 3 and `tmux`.
- A test account's connection key in `MILTON_KEY`. It reaches the client only through
  that variable: the Claude Code MCP config names `${MILTON_KEY}`, and the Codex profile
  must already set `bearer_token_env_var = "MILTON_KEY"` for Milton.
- A separate profile per client, signed in, with no other Milton connection:
  `DEMO_CLAUDE_CONFIG_DIR` or `DEMO_CODEX_HOME`. The driver refuses `~/.claude` and
  `~/.codex`.
- Model calls on that profile are paid usage; they need Peter's approval.

## Run

```sh
bun scripts/demo/record.ts warmup scripts/demo/scenes/day-1.json   # once per profile and folder
bun scripts/demo/record.ts record scripts/demo/scenes/day-1.json <out>/day-1.cast
bun scripts/demo/record.ts scan <out>/day-1.cast
```

`warmup` leaves the scene's shell running unrecorded; attach, start the client and clear
first-run dialogs (folder trust, browser tools, renderer offers), then exit. `record`
first launches the client unrecorded (see Banner below), then records and writes the `.cast`, a `.cast.timeline.json` of when each line was typed and answered, and
then scans the cast. Keep recordings outside the repository.

Empty the test account before a take that must start fresh (Delete all memos, in
[deletion](deletion.md)), and again afterwards. Dry runs use the newcomer account; the
final takes use `sam@milton-test.invalid` ([the demo account](deploy/e2e.md#the-demo-account)),
because receipts outlive Delete all memos and a reused request id is refused on camera.

The driver gives each session Sam's own git identity (`GIT_CONFIG_GLOBAL` pointing at a
file naming Sam, and `GIT_CONFIG_NOSYSTEM`). Clients read the global git config, and on
2026-11-13 an AI signed an unrecorded draft with the operator's name from it.

## Scene files

`scripts/demo/scenes/*.json`, one per scene: `client` (`claude` or `codex`), `command`
(typed at the prompt), `lines` (typed in order), and optional `cwd` (default
`/private/tmp/sam-demo`), `size` (`COLSxROWS`, default `100x30`), `idleTimeLimit`
(seconds, default 2; the clip's scenes use 1), `pauseSeconds`, `typingScale` (multiplies
every typing gap, default 1; the clip's scenes use 0.6, Peter, 2026-11-13: "the typing in
the demo could be a little faster"), `endHoldSeconds` and `turnTimeoutSeconds`. The fixes
in a scene are written before the take, so each must make a change a viewer can see (Day 1:
"no greeting", "no sign-off", then the Sunday offer, Peter, 2026-11-13, after "shorter"
removed the sign-off on camera); check them against the first draft before choosing a take.
Day 1 is recorded on an account with no memos and no earlier receipts:
`sam2@milton-test.invalid` since 2026-11-13 (`~/keys/milton.sam2.env`).

## Playback and label

The published player plays at 1.5× speed, on top of the 1 s idle limit (Peter,
2026-11-13). `scan` prints each cast's length as recorded, with pauses trimmed, and at
1.5×. The clip's label reads "real run, typing automated, pauses trimmed, sped up 1.5×".

## Banner

Claude Code's startup banner can show a rotating notice under its fixed lines, such as
an invite offer ("earn $10 in usage credits") or a new-model announcement. No documented
setting or environment variable turns these off (checked against the settings and
environment variable docs, 2026-11-13). Each one stops after a few showings on a
profile, so `record` launches the client unrecorded first and records only once the
banner shows nothing under its fixed lines; it relaunches up to three times, then
refuses. The take therefore has no cut. Starting the cast after the banner was tried
and rejected: with capture paused during the launch, the player received only Claude
Code's partial redraws, so the input box never appeared.

## Privacy

- The working folder must name no home folder or user; support files (shell rc, MCP
  config, tmux config) live in `/private/tmp/milton-demo-support`, off screen.
- The shell prompt is `$ `, history is off, and the shell, tmux and client start from a
  clean environment holding only the path, home, locale, the key and the profile. The
  typed `claude` and `codex` are shell functions that add the MCP config, the two allowed
  Milton tools and Codex's update-check switch off screen.
- `scan` reads the cast's header, its raw events and its screen text with escape codes
  removed, and lists every `mk_` key, `/Users/` or `/home/` path, the account's user name
  and full name, email address outside `.invalid`, `.test`, `.example` and
  `example.com` style domains, and each term in `DEMO_SCAN_TERMS` (comma-separated). Keys
  in its output are masked. It exits 1 on any hit.
- Never edit a cast by hand to hide something without saying so; record again instead.

## Limits

- The idle limit trims only pauses with no output. Claude Code's spinner redraws while a
  reply is written, so model time stays in the cast at full length.
