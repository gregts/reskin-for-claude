# Reskin light

Sixteen colour skins for the Claude desktop app's Code tab, through Claude's own mod colours. No Developer
menu, no debugger port and no tick: install once and the colours stay, through restarts and Claude updates,
and follow Light and Dark by themselves.

Needs Claude Code 2.1.324 or later in the Code tab (type `/status` in a Code tab session to see it).

## Install

In Terminal:

```
claude plugin marketplace add gregts/reskin-for-claude
claude plugin install reskin-light@reskin-for-claude
```

Then open a new Code tab session in the Claude desktop app (or type `/reload-plugins`).

## Use

- `/skin` shows the skin now on and the list.
- `/skin nord` (or any skin, or its short name such as `nor`, `dra`, `tok`) switches every Code tab session
  within about 2 seconds.
- `/skin off` gives Claude's own colours back. Claude's Settings > Appearance also shows "A mod set the
  colors" with a **Remove colors** button.

Skins: absolutely, ayu, catppuccin, classic, dracula, github, gruvbox, kanagawa, linea, night-owl, nord, one,
rose-pine, solarized, tokyo-night, vs. Dracula is on until you pick one.

With Reskin's full flavour installed too, its `/skin` answers, and these colours follow `/skin <skin>` and `/skin off`
typed on their own (with or without `--tick`). Longer one-line commands such as `/skin nord font plex` are left to the
full flavour.

## What it cannot do

Claude's mod colours reach the Code tab only. The Chat tab, fonts, text sizes and bigger sidebar headers need
Reskin's full flavour, which works on top of these colours.

Nine dark halves differ from Reskin's full flavour so Claude agrees to paint them, most slightly and One's warning
colour clearly (it refuses a whole theme
if any text would be too faint). The sidebar is a little paler than in Reskin, and the selected row and the
status dots follow each skin's own colours.
