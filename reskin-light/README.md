# Reskin light

Seventeen colour skins, or your own colours, for the Claude desktop app's Code tab, through Claude's own mod colours. No Developer
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

Skins: absolutely, ayu, catppuccin, classic, dracula, github, gruvbox, kanagawa, linea, night-owl, nord, oled,
one, rose-pine, solarized, tokyo-night, vs. Dracula is on until you pick one.

With Reskin's full flavour installed too, its `/skin` answers, and these colours follow `/skin <skin>` and `/skin off`
typed on their own (with or without `--tick`). `/skin custom` and your saved skins are answered by this flavour either way; if the full
flavour's colours are on, they cover yours, so type `/skin off` and then `/skin custom`. Longer one-line commands such as `/skin nord font plex` are left to the
full flavour.

## Your own colours

Make your own skin in three steps:

1. `/skin custom` opens a band above the message box (✕ closes it). It starts from the skin you have on.
2. Pick **Editing: Light** or **Dark** and type a colour code for the background, text and accent. Each one shows as
   soon as the code is whole (like `#1e1e2e`). Do the other half the same way, or keep the starting skin's.
3. Type a name in **Save as**, like `my-blue`, and press Enter. It is a skin now: `/skin my-blue` puts it back on in
   every Code tab session, and `/skin list` lists it with your saved skins.

- Claude refuses a whole theme if any text would be too faint. The band says which half is too faint and keeps your
  last good colours on; `/skin custom fix` strengthens only that text colour.
- Saving again under the same name updates that skin. `/skin custom forget my-blue` removes it.
- A name can be letters, numbers and hyphens, and never a Reskin skin or command word.
- One line works too: `/skin custom bg #ffffff fg #111111 accent #e66`. `/skin custom copy` gives your colours as a
  line like that.
- With the full flavour's colours on, `/skin my-blue` turns them off for you so yours show (with no click once its
  colour helper is running). With the full flavour's band on, its **Custom** tab opens these same fields, and your
  saved skins show in its Skins menu.

There is no colour picker: Claude's mod controls have text fields only, so colours are typed as codes like `#1e1e2e`.

## What it cannot do

Claude's mod colours reach the Code tab only. The Chat tab, fonts, text sizes and bigger sidebar headers need
Reskin's full flavour, which works on top of these colours.

Nine dark halves differ from Reskin's full flavour so Claude agrees to paint them, most slightly and One's warning
colour clearly (it refuses a whole theme
if any text would be too faint). The sidebar is a little paler than in Reskin, and the selected row and the
status dots follow each skin's own colours.
