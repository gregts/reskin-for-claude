# Reskin: instructions for AI agents

Reskin recolours the whole Claude desktop app (macOS) with reviewed colour presets. Unofficial, for fun, at your own risk.
Read this before running anything here. It is short on purpose.

First time only: in Claude choose Help > Troubleshooting > Enable Developer Mode (Claude restarts); the Developer menu then appears.
Without it there is no Developer > Enable Main Process Debugger item to tick, and every tick run times out.

After updating Reskin: quit and reopen Claude once before the next run. A colour helper from the older version may
still be running inside Claude; every command except `status` refuses with "Quit and reopen Claude once" until it is
gone (`status` says the same).

## What it does, honestly

- To reach Claude's whole window, Reskin needs Claude's own Developer > Enable Main Process Debugger menu item. Ticking
  it opens a debugger port on this Mac (127.0.0.1:9229). While the port is open, any program on this Mac, under any
  user account, can run code inside Claude (the debugger has no password; other machines cannot reach it). Reskin keeps it open as briefly as it can (in `tick` mode it is ready and waiting before the
  user clicks, and closes the port right after applying; tick-mode reports print the measured time). Once Reskin has
  confirmed the port belongs to Claude it sets a timer inside Claude, which closes the port after 8 s (a tick-mode
  preset apply) or 22 s (everything else) even if Reskin dies; before that timer is set, only the backup guardians
  close it. In `tick` mode guardian A, started just before the prompt, looks about 90 s after it started and stops at
  the first look that finds the port closed, so a click after the 60 s window is not reliably covered: tell the user
  not to click late, and to quit and reopen Claude if they did. Guardian B starts when the run sees the port open and
  tries up to 30 times, 10 s apart (`tick`; each try can take a few seconds, so several minutes); the `one-click`
  guardian tries 6 times. On a Mac without Chrome,
  Claude is frozen until the user clicks OK on its message, so the port stays open until then: no timer can run sooner.
- After the first apply, a small colour helper stays inside Claude until Claude quits. The debugger is closed by then.
  The helper can only switch between Reskin's presets, Off, or remove itself, and any program running as this user
  could ask it to. Its file checks (private folder and files, session ID, numbered requests) catch accidents and stale
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
| `one-click <preset\|remove>` | Accessibility for this terminal | the run ticks the menu itself. Not in the public release: there `release.json` says `"oneClick": false` and the tool refuses it |
| `status` | nothing | read-only: helper, request count, last skin |
| `check` | a running helper | read-only health check: does the skin still show its own colours? No tick, no port |

Presets: the file names in `presets/` without `.css` (for example `tokyo-night`, `dracula`; each has a dark and a light half). Use preset names only.
`skin-auto.mjs` refuses anything that is not one of them, and every stylesheet may set colours only (no hiding, moving
or relabelling anything).

## Rules for agents

1. Ask the user before every `tick` or `one-click` run, every time. A yes for one run is not a yes for the next.
   `switch` and `status` open nothing and may be run when the user asks for a skin change.
2. Never ask for, or set up, blanket shell approvals for these commands. Never run them in the background.
3. Run `switch` first. Only when it answers "No colour helper is running" offer `tick <preset>`. If it answers
   "switch unconfirmed", tell the user; never fall back to a tick on your own.
4. In `tick` mode, pass the tool's prompt to the user as soon as it prints `READY_TO_TICK`: they must click
   Developer > Enable Main Process Debugger once, within 60 s. On a Mac without Google Chrome, Claude then shows
   "Inspector session is active": they click OK. With Chrome, a `chrome://inspect` tab may open: they close it.
5. On a Mac without Google Chrome, Claude's whole window (any chat or terminal shown inside it included) stops
   updating until the user clicks OK on that message. Say so before the tick, so a frozen window does not alarm them.

## Success and stop conditions

Every run ends with `PORT_STATE: closed|open|unknown` and `RESULT: ok|failed|refused`. A run that reached Claude also
prints three lines: `sampled colour checks: N of M passed (U unknown)`, `debugger: ...` and `helper: ...`.

- Success: `RESULT: ok` and `PORT_STATE: closed`. Unknown colour checks are not failures, but are not passes either.
- After `switch`, `RESULT: ok` is the colour helper's own report (no debugger checks it, and a program running as the
  user could fake it). When the user needs proof that no skin or helper is left, the answer is: quit and reopen Claude.
- `RESULT: refused`: nothing was changed. Report the reason line.
- A `WARNING:` that the menu item may still show a tick: tell the user not to click that item (a click would open the
  debugger again) and to quit and reopen Claude instead.
- `PORT_STATE: open` or `unknown` after a tick run: stop. Tell the user to untick Developer > Enable Main Process
  Debugger, or quit and reopen Claude. Do not run anything else until `lsof -nP -iTCP:9229 -sTCP:LISTEN` prints
  nothing (exit 1).
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

Every `/skin` run (except `/skin about` and `/skin log`) and every direct run of `skin-auto.mjs` adds one entry to `~/Library/Logs/Reskin/skin.log` (older:
`skin.log.1`). When a user reports a problem, read the newest entries there first (`/skin log` shows their summaries):
each has the command, Claude's version and Appearance, the Mac's mode, the skin's mode, port 9229 before and after, the
path, every output line with its time, the result and the exit code. Known secret formats are removed before writing;
that is a filter, not a guarantee, so read an entry before you paste it anywhere. `RESKIN_LOG=off` turns
the tool's logging off for one run.

## After Claude restarts

The helper is gone with Claude. `status` shows `helper: none` and may offer "Reapply <skin>?". Offer it to the user;
it needs one tick. Nothing is ever reapplied automatically.
