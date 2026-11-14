# Reskin: instructions for AI agents

Reskin recolours the whole Claude desktop app (macOS) with reviewed colour presets. Unofficial, for fun, at your own risk.
Read this before running anything here. It is short on purpose.

First time only: in Claude choose Help > Troubleshooting > Enable Developer Mode (Claude restarts); the Developer menu then appears.
Tell the user that turning on Developer Mode restarts Claude, and ask them to confirm they are ready first.
Without it there is no Developer > Enable Main Process Debugger item to tick, and every tick run times out.

After updating Reskin: quit and reopen Claude once before the next run, even if Reskin does not ask for a restart. A
colour helper from the older version may still be running inside Claude; `switch`, `tick`, `type`, `font` (except
`font list`), `set`, `look` and `check` refuse with "Quit and reopen Claude once" until it is gone (`status` reports it;
`/skin list`, `/skin about`, `/skin log`, `font list` and offline checks still work). After the restart, offer to
restore the user's previous setup, with or without a colour skin: `tick <preset>` for a skin, or `tick off` (with
`--want-font` / `--want-type` if needed) for no skin, following "After Claude restarts" below, with the user's yes for
that run. Remembered project headers and fonts return in that run. Pass on every `restore:` line. If any result is
unconfirmed, stop and report it; do not retry. Otherwise explain why a part could not be restored, resolve that cause
with the user, and retry only that part through its helper command (no tick).

## What it does, honestly

- To reach Claude's whole window, Reskin needs Claude's own Developer > Enable Main Process Debugger menu item. Ticking
  it opens a debugger port on this Mac (127.0.0.1:9229). While the port is open, any program on this Mac, under any
  user account, can run code inside Claude (the debugger has no password; other machines cannot reach it). Reskin keeps it open as briefly as it can (in `tick` mode it is ready and waiting before the
  user clicks, and closes the port right after applying; tick-mode reports print the measured time). Once Reskin has
  confirmed the port belongs to Claude it sets a timer inside Claude, which closes the port after 8 s (a tick-mode
  preset apply, or a no-skin start) or 22 s (everything else) even if Reskin dies; before that timer is set, only the backup guardians
  close it. In `tick` mode guardian A, started just before the prompt, looks about 90 s after it started and stops at
  the first look that finds the port closed, so a click after the 60 s window is not reliably covered: tell the user
  not to click late, and to quit and reopen Claude if they did. Guardian B starts when the run sees the port open and
  tries up to 30 times, 10 s apart (`tick`; each try can take a few seconds, so several minutes); the `one-click`
  guardian tries 6 times. On a Mac without Chrome,
  Claude is frozen until the user clicks OK on its message, so the port stays open until then: no timer can run sooner.
- After the first apply (or a no-skin `tick off`), a small colour helper stays inside Claude until Claude quits. The debugger is closed by then.
  The helper can only switch between Reskin's presets, Off, the optional type sheet (on or off), the reviewed fonts, sizes
  and weights (the font picker), or remove itself, and
  any program running as this user could ask it to. Its file checks (private folder and files, session ID, numbered requests) catch accidents and stale
  files, not a determined program running as the user, which could also fake the helper's answers. Other user accounts
  cannot reach it (the folder is private to you).
- It never patches Claude's files, never writes Claude's settings, never ticks the menu at login or on relaunch, and
  needs no network.

## The one entry command

    node skin-auto.mjs <command>     (Node 22 or newer, from this folder)

| Command | Needs | Does |
|---|---|---|
| `switch <preset\|off\|remove>` | a running helper | asks the helper; no tick, no port, no Chrome |
| `tick <preset\|remove>` | the user clicks the menu item once | default when there is no helper |
| `tick off [--want-font=<name\|name-size\|off>] [--want-type=on\|off]` | the user clicks the menu item once | the no-skin tick (mod: `/skin type on --tick`, `/skin font <name> [size] --tick`, `/skin font <name> type on --tick`, `/skin fonts --tick`): starts the colour helper only, puts no skin on. Before the prompt it prints a `PLAN: {json}` line (after `Ready.`) naming every part it will set: the asked ones and the remembered headers and font. After the close the helper takes any Reskin skin off (a Claude page may reload once), a check must say "no skin on", then the parts run in order and stop at the first that does not complete (`part:` lines). Refused before any prompt when a helper of this version is already running ("no tick is needed"), old or unknown. `off` is a target for `tick` only; `tick remove` keeps its meaning |
| `one-click <preset\|remove>` | Accessibility for this terminal | the run ticks the menu itself. Not in the public release: there `release.json` says `"oneClick": false` and the tool refuses it |
| `type <on\|off>` | a running helper | the optional type sheet: sidebar project headers 14px; active projects (a session running, waiting or unread) in the skin's accent, the open chat's project also with an accent stripe at the left of its header row; session names 13px. No tick, no port. `switch off` keeps it; `switch remove` takes it off |
| `font <name>[-<size 12 to 16>]\|off\|list` | a running helper, except for `list` | in this release (`release.json` says `"font": true`; a copy without it refuses fonts): body text, replies, message box, buttons and sidebar in one of the reviewed fonts (`list` shows them and their download links); an optional size (12 to 16 px) applies to chat text only (replies, the user's sent questions and the message box), for example `font plex-16`. Checks the font is installed first. Code and the serif titles stay Claude's; Claude's own font menu has no effect on that text while one is on. `type off` keeps the font, `font off` keeps the headers; `switch remove` takes both |
| `set [<preset>\|off] [font <name>\|off] [type on\|off]` | a running helper | the one-line command: checks every part first (nothing sent if any is wrong), then skin, font, type in that order, each through its own request; stops at the first part that does not complete and reports each part from the helper's last proven state. With no helper it refuses with "No colour helper is running"; then, with the user's yes, `tick <preset> --want-font=<name\|off> --want-type=on\|off` applies the skin and those parts in one tick run (`part:` lines) |
| `look show` / `look set <all\|chat\|rows\|headers\|ui> font=<name\|same\|claude> size=<n\|claude> weight=<n\|claude>` | a running helper of this release | shipped with `font`: the font picker behind `/skin fonts`. `all` takes a font only (one font everywhere) and keeps each part's size and weight. `show` prints what the helper proves is on now as one `LOOK: {json}` line (read-only). `set` changes one part of the app (chat text, sidebar rows, project headers, everything else) and keeps the others; it checks the whole result first (weights the font has, every font installed). No tick, no port. `font <name>` replaces the whole look; `font off` clears it |
| `--lock-wait=<ms>` (with a helper command) | nothing | waits up to that long (1 to 20000 ms) for another Reskin run to finish; without it a busy run lock refuses at once. The `/skin` plugin adds it to every helper command. `look show` has a 13 s deadline after it has the lock; a check already running can delay its exit by up to 4 s |
| `status` | nothing | read-only: helper, request count, last skin and saved type preference; use `check` to inspect type on the current pages |
| `check` | a running helper | read-only health check: does the skin still show its own colours? No tick, no port |

Presets: the file names in `presets/` without `.css` (for example `tokyo-night`, `dracula`; each has a dark and a light half). Use preset names only. Short and old names (`dra`, `kan`, `tokyo-night-day`; `SKIN_ALIASES` in `skin-lib.mjs`) are read as their preset.
For colour skins, `skin-auto.mjs` accepts only preset names, and each preset stylesheet may set colours only (no
hiding, moving or relabelling anything). The one type sheet (`type/sidebar-headers.css`) has its own stricter check: exact selectors,
font size and weight within fixed limits, and colour only as the skin's own text tokens. Fonts, sizes and weights are
small extra rules in that same sheet (one per part, in a fixed order), each checked the same way: only their own exact
selectors, only the five font tokens and `font-family` set to a stack from `FONT_STACKS`, sizes and weights only from
fixed lists, and the whole sheet at most 4,608 bytes (`TYPE_MAX`).

## Rules for agents

1. Before every `tick` run, explain that the user's click briefly opens a local debugger with no password: while it is
   open, any program on the Mac can run code inside Claude. Say what this run will apply, remove or restore, then ask
   whether to proceed. A yes covers that run only. The public release does not offer `one-click`; do not suggest it.
   `switch` and `status` open nothing and may be run when the user asks for a skin change.
2. Never ask for, or set up, blanket shell approvals for these commands. Never run them in the background.
3. For a colour change, try `switch <preset>` first; for fonts or project headers, the matching helper command first
   (`font`, `look set`, `type`). If the tool answers "No colour helper is running", offer a tick run that matches the
   request: `tick <preset>` for a colour skin, or `tick off` with `--want-font` / `--want-type` for fonts or headers
   without a skin. Ask before that run. If it answers "switch unconfirmed", or any result is unconfirmed, tell the user
   and stop; never fall back to a tick on your own.
4. In `tick` mode, pass the tool's prompt to the user as soon as it prints `READY_TO_TICK`: they must click
   Developer > Enable Main Process Debugger once, within 60 s, only while the prompt is active. For a no-skin run,
   explain the `PLAN:` line first (any skin taken off, a possible page reload, the remembered fonts and headers). If the
   prompt expires or the run ends, they must not click; if they clicked late, tell them to quit and reopen Claude. On a Mac without Google Chrome, Claude then shows
   "Inspector session is active": they click OK. With Chrome, a `chrome://inspect` tab may open: they close it.
5. On a Mac without Google Chrome, Claude's whole window (any chat or terminal shown inside it included) stops
   updating until the user clicks OK on that message. Say so before the tick, so a frozen window does not alarm them.

## Success and stop conditions

Normal runs end with `PORT_STATE: closed|open|unknown` and `RESULT: ok|failed|refused`. A `look show` that hits its
deadline can end with `RESULT: failed` and no `PORT_STATE` line; a missing line is never proof that the port is closed.
Tick runs report the debugger and helper state (`debugger: ...`, `helper: ...`), plus `sampled colour checks: N of M
passed (U unknown)` when available. Helper commands print the lines relevant to that command.

- Success: `RESULT: ok` and `PORT_STATE: closed`. Unknown colour checks are not failures, but are not passes either.
- After `switch`, `RESULT: ok` is the colour helper's own report (no debugger checks it, and a program running as the
  user could fake it). When the user needs proof that no skin or helper is left, the answer is: quit and reopen Claude.
- `RESULT: refused`: nothing was changed. Report the reason line.
- A `WARNING:` that the menu item may still show a tick: tell the user not to click that item (a click would open the
  debugger again) and to quit and reopen Claude instead.
- Near the end of a tick run, when enough of its time limit is left, the run waits 5 s and looks at the closed port once
  more: `debugger: confirmed closed (...; still closed 5 s later)` means it found the port closed. Without those
  words, the look may have been skipped or unreadable, or found the port open again: read the warnings and the final
  port state. A `WARNING:` that the debugger opened again means a second click, most likely: the run tried to close it and
  reports from a fresh look (`PORT_STATE` and the exit code say whether that worked). Tell the user to click the item
  only while a run asks, never after. Nothing watches the port after the run ends.
- `PORT_STATE: open` or `unknown` after a tick run: stop. Tell the user to quit Claude completely (Cmd+Q) and reopen
  it. Do not ask them to click or untick the Developer menu item. Before any further Reskin run, confirm that
  `lsof -nP -iTCP:9229 -sTCP:LISTEN` prints nothing (exit 1).
- Exit codes: 0 ok, 1 failed, 2 usage, 3 port not confirmed closed, 4 took too long, 5 refused, 6 throwaway Chrome
  left running, 130 interrupted.

## Health check

`check` (the user types `/skin check`) asks the colour helper to read Claude's colours and compares them with the active
skin. It changes nothing and opens no port, so it may be run whenever the user asks. It prints `health: pass`,
`health: no skin on`, `health: FAIL (...)`, `health: Claude's structure changed (...)`, `health: unknown (...)` or
`health: helper not answering`. On a fail it prints a `Repair:` line: pass it on. An `untested:` line means this Claude version is
not listed in `tested-versions.json`. `status` shows the last result and says when Claude's version has
changed since. The answer is the helper's own report, with the same honest limit as `switch`.

## Troubleshooting log

Every `/skin` run (except `/skin about`, `/skin log` and `/skin band on|off`; band button actions are logged) and every
direct run of `skin-auto.mjs` adds one entry to `~/Library/Logs/Reskin/skin.log` (older: `skin.log.1`). A change that
finishes after `/skin` stopped waiting adds a separate completion entry. When a user reports a problem, read the newest entries there first (`/skin log` shows their summaries):
each has the command, Claude's version and Appearance, the Mac's mode, the skin's mode, port 9229 before and after, the
path, every output line with its time, the result and the exit code. Known secret formats are removed before writing;
that is a filter, not a guarantee, so read an entry before you paste it anywhere. `RESKIN_LOG=off` turns
the tool's logging off for one run.

## After Claude restarts

The helper is gone with Claude. `status` shows `helper: none` and may offer `Reapply <skin>?` (or, when only headers or
a font were on, "Reapply the project headers?" with `/skin type on --tick` or `/skin fonts --tick`). Offer it to the user;
it needs one tick. Nothing is reapplied without that tick. Within the tick run that applies the skin, the remembered sidebar
headers and font (if any) come back by themselves through the new helper, with no second tick; the run prints a
`restore:` line saying what came back or what could not.

## For other Claude Code mods

A mod that draws its own band can offer Reskin's rows: a `Button` keyed `skin-skins-open`, `skin-fonts-open` or
`skin-sidebar-open`. Reskin answers the press and opens that row; the other mod needs no Reskin state.
