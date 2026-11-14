---
name: demo
description: Recording and assembling the demo clip: Sam's demo repo, the driver typing into real Claude Code under asciinema and its guards, scene files, privacy scan and title cards
type: procedure
covers:
  - scripts/demo/**
---

# Demo recording

This file covers the clip's rules, how a scene is recorded and how the clip is assembled.
The clip of 2026-11-13 closed TODO #33; on the same day Peter approved a new script, an
async Slack standup, which has not been recorded yet (see Published clip).

## Clip rules

Keep these for any retake:

- One real run on a test account, never Peter's, all in Claude Code. On the first
  morning a fictional Sam asks for his standup for #eng, fixes the first draft twice and
  posts it, and the AI keeps the memo and shows its receipt. The next morning Sam types
  the same request and posts the first draft unedited. The request is the same both days
  so that the only thing that changed is what Milton holds.
- Each fix must make a change a viewer can see. "no emoji" is not one of them: in the
  trials no first draft had an emoji, so it changed nothing on screen; "no headings, no
  bullets" does.
- No title card names a weekday: Claude's draft prints the real date, which a weekday
  card could contradict.
- Sam never says "remember": the next morning's draft must come from the memo Milton
  kept, not from a preference Sam asked the AI to keep.
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
dialog waiting for an answer stops the take instead of typing into it. The driver still
supports Codex (`client: "codex"`); the standup clip does not use it.

## Needs

- `asciinema` 3 and `tmux`.
- A test account's connection key in `MILTON_KEY`. It reaches the client only through
  that variable: the Claude Code MCP config names `${MILTON_KEY}`, and the Codex profile
  must already set `bearer_token_env_var = "MILTON_KEY"` for Milton.
- A separate profile per client, signed in, with no other Milton connection:
  `DEMO_CLAUDE_CONFIG_DIR` or `DEMO_CODEX_HOME`. The driver refuses `~/.claude` and
  `~/.codex`. The Claude Code demo profile's `settings.json` sets
  `autoMemoryEnabled: false`.
- Model calls on that profile are paid usage; they need Peter's approval.

## Run

```sh
sh scripts/demo/make-repo.sh 1      # Sam's repo for Day 1
bun scripts/demo/record.ts warmup scripts/demo/scenes/standup-day-1.json   # once per profile and folder
bun scripts/demo/record.ts check scripts/demo/scenes/standup-day-1.json    # guards only, no model call
bun scripts/demo/record.ts record scripts/demo/scenes/standup-day-1.json <out>/day-1.cast
bun scripts/demo/record.ts scan <out>/day-1.cast
sh scripts/demo/make-repo.sh 2      # the next morning, before Day 2
bun scripts/demo/record.ts record scripts/demo/scenes/standup-day-2.json <out>/day-2.cast
bun scripts/demo/record.ts scan <out>/day-2.cast
```

`warmup` leaves the scene's shell running unrecorded; attach, start the client and clear
first-run dialogs (folder trust, browser tools, renderer offers), then exit. `check` runs
a take's guards (below) and launches nothing. `record` runs the guards, launches the
client unrecorded (see Banner below), then records and writes the `.cast`, a
`.cast.timeline.json` of when each line was typed and answered, and then scans the cast.
Keep recordings outside the repository.

Empty the test account before Day 1 (Delete all memos, in [deletion](deletion.md)), never
between Day 1 and Day 2, since Day 2 depends on Day 1's memo, and again afterwards. Dry
runs use the newcomer account. Peter chooses the account for the final takes; it must
hold no memos and ideally no receipts, because receipts outlive Delete all memos and a
reused request id is refused on camera
([the demo accounts](deploy/e2e.md#the-demo-account)).

### Sam's repo

`scripts/demo/make-repo.sh 1|2` (POSIX sh, macOS `date -v`) rebuilds `/private/tmp/sam-demo`
as Sam's small "invoicer" repo, the material Claude writes the standup from:

- Day 1: yesterday's commits fix the CSV export's timezone bug and add a DST boundary
  test.
- Day 2: those commits move a day back; yesterday's commits add webhook retries with
  backoff, then log each retry, and `TODO.md` marks pagination blocked on staging
  database access.

Dates count calendar days back from the day it runs, so Day 2 can be recorded the next
real morning (preferred: Claude's dates are then real) or right after Day 1. A run on a
Monday dates "yesterday's" commits on the Sunday. The script refuses unless the folder
really is `/private/tmp/sam-demo` (not a link elsewhere) before it deletes anything,
builds the repo without the person's git config, and sets `user.name Sam` and
`user.email sam@example.com` in the repo's local config. The code is real and its test
passes under `bun test`: in the trials Claude pointed out stub code and fake commits on
screen. It prints the git log it made.

### Guards

`record` and `check` refuse a take when:

- The working folder is a git repo whose `git -C <cwd> config user.name`, run with the
  person's own environment, does not print exactly `Sam`. In a trial Claude Code wrote
  "your git user is" followed by the person's real name although the driver's
  `GIT_CONFIG_GLOBAL` names Sam: it evidently does not take the git user from that
  variable. Sam's name in the repo's local config fixed it. The driver still sets
  `GIT_CONFIG_GLOBAL` to a file naming Sam, and `GIT_CONFIG_NOSYSTEM`, for anything else
  that reads the global config; on 2026-11-13 an AI signed an unrecorded draft with the
  operator's name from it.
- For Claude Code, the profile's memory folder for the working folder,
  `$DEMO_CLAUDE_CONFIG_DIR/projects/<folder>/memory/`, where `<folder>` is the cwd with
  every non-alphanumeric character replaced by `-` (`-private-tmp-sam-demo` for
  `/private/tmp/sam-demo`), holds any file. With `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in
  the client's environment, Claude Code's own memory can't be what carries Sam's style
  from Day 1 to Day 2.

The typed `claude` also passes `--disable-slash-commands`. The account syncs an
"engineering" plugin whose standup skill loaded in every trial, and no setting turned it
off; the clip shows plain Claude Code, as most viewers have it. The flag is unverified on
a take: check the first take's screen for any skill loading.

## Scene files

`scripts/demo/scenes/*.json`, one per scene: `client` (`claude` or `codex`), `command`
(typed at the prompt), `lines` (typed in order), and optional `cwd` (default
`/private/tmp/sam-demo`), `size` (`COLSxROWS`, default `100x30`), `idleTimeLimit`
(seconds, default 2; the clip's scenes use 1), `pauseSeconds`, `typingScale` (multiplies
every typing gap, default 1; the clip's scenes use 0.6, Peter, 2026-11-13: "the typing in
the demo could be a little faster"), `endHoldSeconds` and `turnTimeoutSeconds`.

The clip's scenes are `standup-day-1.json` ("write my standup for #eng", "no headings, no
bullets", "way shorter, lowercase, it's slack", "perfect, posting it") and
`standup-day-2.json` ("write my standup for #eng", "perfect, posting it"). The fixes are
written before the take, so check them against the first draft before choosing a take.

## Trials 2026-11-13

Three Monday-and-Tuesday trials ran on the newcomer test account, which kept one memo
each time. Every Day 2 first draft came back as three short lowercase lines drawn from
the new commits and was approved unedited (memo tier untouched, change 0), and Claude
said it matched "your last standup". "no emoji" changed nothing, as no first draft had an
emoji, so the script uses "no headings, no bullets". Day 1 ran about 40 s at 1.5×, Day 2
about 25 s. The engineering plugin's standup skill loaded in every trial;
`--disable-slash-commands` came after them.

## Playback and label

The published player plays at 1.5× speed, on top of the 1 s idle limit (Peter,
2026-11-13). `scan` prints each cast's length as recorded, with pauses trimmed, and at
1.5×. The published clip's label reads "Real run, typing automated, pauses trimmed, sped
up 1.5×. Day 1 is the second take."; the standup clip's label must name its own chosen
takes. The preview page that plays it is in [site](site.md).

## Assembly

```sh
bun scripts/demo/assemble.ts <out>/day-1.cast <out>/day-2.cast <out>/milton-demo.cast
bun scripts/demo/record.ts scan <out>/milton-demo.cast
```

`assemble.ts` writes the title cards as small casts of their own and joins them with the
two approved takes using `asciinema cat`, in this order: "# Morning standup", Day 1,
"# Next morning", Day 2, "# Did you get the memo? Your AI already did." and
"# meetmilton.com · 30-day free trial, no card". The trial length comes from
`packages/theme/facts.ts`, and the copy-drift test reads the committed cast.

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
`apps/site/src/data/milton-demo.cast`.

## Published clip

`/demo` still plays the clip of 2026-11-13: Day 1 in Claude Code (a reply to a manager,
take 2), "# Two weeks and 9 approved drafts later", Day 14 in Codex. It runs 58.7 s at
1.5× and its scan found nothing; its scenes and card list are in git history. When the
standup clip replaces it, the page's heading ("Fixed in Claude Code. Remembered in
Codex.") and label change with it.

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
  clean environment holding only the path, home, locale, the key and the profile (and,
  for Claude Code, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). The typed `claude` and `codex`
  are shell functions that add the MCP config, the two allowed Milton tools, Claude
  Code's `--disable-slash-commands` and Codex's update-check switch off screen.
- `scan` reads the cast's header, its raw events and its screen text with escape codes
  removed, and lists every `mk_` key, `/Users/` or `/home/` path, the account's user name
  and full name, email address outside `.invalid`, `.test`, `.example` and
  `example.com` style domains, and each term in `DEMO_SCAN_TERMS` (comma-separated). Keys
  in its output are masked. It exits 1 on any hit.
- Never edit a cast by hand to hide something without saying so; record again instead.

## Limits

- The idle limit trims only pauses with no output. Claude Code's spinner redraws while a
  reply is written, so model time stays in the cast at full length.
