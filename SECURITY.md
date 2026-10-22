# Security

## The risk, in plain words

To reach Claude's whole window, Reskin needs one click on Claude's own menu item **Developer > Enable Main Process
Debugger**. That click opens a debugger port on your Mac, `127.0.0.1:9229`. The debugger has no password.

While the port is open, any program on this Mac, under any user account, can run code inside Claude. Other machines
cannot reach it, and nothing from the internet can.

Reskin keeps that window as short as it can and checks that it is closed again. It is a hobby tool. If you are not
comfortable with this, do not use it.

## How long the port stays open

- **Normal run (`/skin <name>` or `tick`).** Reskin has everything prepared and is watching for the port before it asks
  you to click. As soon as the port opens it connects, paints, closes the port and reports the measured time ("seen
  open -> confirmed closed"). On the tested Mac this was 0.1 s.
- **Click only while the card asks.** You have 60 seconds. After that, do not click. If you clicked late anyway, quit
  and reopen Claude. A backup guardian, started just before the card, looks about 90 seconds after it started and closes
  the port if it finds it open, but it stops at the first look that finds the port closed, so do not rely on it.
- **If Reskin dies after it saw the port open,** a second backup guardian, started at that moment, looks after about 43
  seconds (after 6 seconds if Reskin is already gone), then tries to close the port up to 30 times, 10 seconds apart,
  until it sees it closed. Each try can itself take a few seconds, so this can last several minutes. If Reskin dies in the instant between your click and seeing the
  port open, only the first guardian is left: quit and reopen Claude.
- **Once Reskin has set its timer inside Claude,** that timer closes the port after 8 s (painting a skin) or 22 s
  (anything else), even if Reskin dies. Reskin sets it right after checking that the port belongs to Claude; before
  that, only the guardians close the port.
- **On a Mac without Google Chrome,** Claude shows "Inspector session is active" and freezes until you click OK. Nothing
  can close the port before that click, so the open time includes your click.
- **`skin.mjs` run directly** (developers only) has no guardian and no run lock. It sets the 22 s timer once it reaches
  Claude; if it stops before that, the port stays open until you quit Claude.
- **Switching skins later** (`/skin <name>` while the helper runs, `switch`, Raycast) opens no port at all.

## What Reskin does to limit the risk

- Checks Claude's code signature, on disk and on the running process, before anything else. If that fails, it refuses.
- Refuses to start if port 9229 is already open, or if another Reskin run is in progress (a lock on local port 47619).
- Before sending anything, checks that the process listening on the port is that same signed Claude, listening on
  127.0.0.1 only, and that Claude itself holds the other end of Reskin's connection.
- Sends colours only. A skin may set colour values and nothing else (no hiding, moving or relabelling), each stylesheet
  is at most 16 KB, and only Reskin's own 16 skins are accepted.
- Clears the menu tick when it closes the debugger and checks that it worked; if not, it tells you not to click the
  item and to quit and reopen Claude.
- Never clicks the menu item itself in this release, never runs at login and never reapplies a skin on its own.
- After the first skin, a colour helper stays inside Claude until it quits. It accepts only skin names, `off`, `remove`
  and a read-only check. Its files sit in `~/Library/Application Support/claude-skin/`, a folder only you can open
  (folder 700, files 600).
- Sends nothing off this Mac (its only connections are to Claude on 127.0.0.1) and changes no Claude files or settings.
- Writes one log entry per run to `~/Library/Logs/Reskin/skin.log`, with known secret formats removed.

## Accepted risks

These were reviewed and left as they are:

- Any program running as you can ask the colour helper to switch skins, or fake its answers. Such a program could do
  more harm without Reskin. `/skin` talks to the helper through files in your user folder, so such a program could
  change them; quitting Claude always ends the helper.
- Settings in the environment (`RESKIN_STATE_DIR`, `RESKIN_LOG_DIR`, `SKIN_LOCK_PORT`) can move Reskin's files and
  lock. The `/skin` plugin passes none.
- On a Mac without Chrome there is no deadline: only your OK or quitting Claude ends the frozen state.
- The Developer menu item is found by its English name.
- The command you typed is written to the log. The secret filter knows common formats only.
- Node is found in `/opt/homebrew/bin`, then `/usr/local/bin`, then on your `PATH` (the Raycast scripts try your `PATH`
  first).
- A clock set back by more than 2 s, or a program backdating files, can make an old helper look like a leftover. The
  harm is a second skin on top; quitting Claude fixes it.

## Report a security problem

Use GitHub's private vulnerability reporting on this repository (the **Security** tab, then **Report a vulnerability**).
Please do not post details in a public issue. Include the Claude version, the macOS version, what you ran, and the
relevant log entry (read it first and remove anything private).

If a run leaves port 9229 open: quit and reopen Claude. `lsof -nP -iTCP:9229 -sTCP:LISTEN` should then print nothing.
