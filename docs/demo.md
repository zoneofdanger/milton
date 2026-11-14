---
name: demo
description: Recording and assembling the demo clip: the driver typing into real Claude Code or Codex under asciinema, scene files, privacy scan and title cards
type: procedure
covers:
  - scripts/demo/**
---

# Demo recording

This file covers the clip's rules, how a scene is recorded and how the clip is assembled.
The clip of 2026-11-13 closed TODO #33.

## Clip rules

Keep these for any retake:

- One real run on a test account, never Peter's: Day 1 in Claude Code, where a fictional
  Sam fixes a generic first draft and the AI keeps the memo and shows its receipt; Day 14
  in Codex, where the first draft is approved unedited. The memos the card counts
  between the two days are real memos from earlier real sessions, not seeded text, and
  Peter approves them.
- Never show Sam asking "Did you get the memo?": the homepage promises the AI reads
  Milton unprompted.
- Say "AI", not "assistant". Original names only, no film characters.
- The label says the run is real, the typing automated and the pauses trimmed, and
  discloses which take was chosen.
- Self-host asciinema-player and put the one-line setup command under it.

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
1.5×. The clip's label reads "Real run, typing automated, pauses trimmed, sped up 1.5×.
Day 1 is the second take." The preview page that plays it is in [site](site.md).

## Assembly

```sh
bun scripts/demo/assemble.ts <out>/day-1.cast <out>/day-14.cast <out>/milton-demo.cast
bun scripts/demo/record.ts scan <out>/milton-demo.cast
```

`assemble.ts` writes the title cards as small casts of their own and joins them with the
two approved takes using `asciinema cat`, in this order: "# Day 1", Day 1, "# Two weeks
and 9 approved drafts later", "# Day 14", Day 14, "# Did you get the memo? Your AI
already did." and "# meetmilton.com · 30-day free trial, no card". The trial length
comes from `packages/theme/facts.ts`, and the copy-drift test reads the committed cast.

- A card leaves any alternate screen, resets, clears, and prints its line in bold, a third
  of the way down (the play button covers the middle) and centred across.
- Each card, and each take's last frame, holds for 2 s at 1.5×. The takes end on their
  receipt with no later output, so without a hold the receipt would flash past. A hold
  is a run of empty output events 0.75 s apart, under the 1 s idle limit, so the limit
  doesn't trim it; an empty event draws nothing.
- The header names nothing about the machine: no timestamp, command or environment.
- No recorded event is changed. The script checks that every event of both takes reaches
  the output in order with its interval and data intact, and refuses otherwise.

Scan the assembled cast before it enters the repository, at
`apps/site/src/data/milton-demo.cast`. The clip of 2026-11-13 (Day 1 take 2 and Day 14)
runs 58.7 s at 1.5×, and its scan found nothing.

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
