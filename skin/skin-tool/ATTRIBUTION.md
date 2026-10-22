# Attribution

These skins are colour tables only (hex values). Each colour scheme belongs to its authors. The starting values
come from each scheme's published palette or theme files, or, for the three Codex-adapted looks, from colour values
observed in the inspected app bundle (the table says which); colours this project derived or changed are listed per
skin below with the original value and the reason. This project is not affiliated with, endorsed by or sponsored by
Anthropic, GitHub, or any of the colour scheme projects. "Claude" is a trademark of Anthropic, PBC.

| Scheme | Licence | Source |
|---|---|---|
| Tokyo Night (night, day) | Apache-2.0 | github.com/folke/tokyonight.nvim |
| Catppuccin (mocha, latte) | MIT | github.com/catppuccin/palette |
| Dracula | MIT | draculatheme.com/contribute, github.com/dracula/visual-studio-code |
| Nord | MIT | nordtheme.com, github.com/nordtheme/nord |
| Gruvbox (dark, light) | "MIT/X11" per its README (no licence file) | github.com/morhetz/gruvbox |
| One Dark, One Light | MIT | github.com/atom/one-dark-syntax, github.com/atom/one-light-syntax, github.com/Binaryify/OneDark-Pro |
| GitHub (dark, light) | MIT | github.com/primer/primitives, github.com/primer/github-vscode-theme |
| Rose Pine (main, dawn) | MIT | github.com/rose-pine/rose-pine-palette (formerly rose-pine/palette), github.com/rose-pine/neovim (dark sidebar) |
| Solarized (light, dark) | MIT | ethanschoonover.com/solarized, github.com/altercation/solarized |
| Dracula's Alucard (light half) | MIT | draculatheme.com/spec, github.com/dracula/dracula-theme |
| Nord light half | MIT (Nord palette) | nordtheme.com; the light half is a Reskin adaptation, not an official Nord variant |
| Ayu (dark, light) | MIT | github.com/ayu-theme/ayu-colors, github.com/ayu-theme/vscode-ayu |
| Night Owl, Light Owl | MIT | github.com/sdras/night-owl-vscode-theme |
| VS (Dark+, Light+) | MIT | github.com/microsoft/vscode (extensions/theme-defaults) |
| Absolutely, Linea, Verc | no separate theme licence found in the inspected app bundle | Adapted from colour values observed in the Absolutely, Linear and Vercel themes of OpenAI's Codex app (version 26.1007.71326); not affiliated with OpenAI, Linear or Vercel. Colour values only; no permission is claimed. |
| Classic dark, Classic light | Apache-2.0 covers only the brand-guidelines skill's palette (no trademark rights are granted); the colours observed in Claude's published stylesheet carry no licence of their own | github.com/anthropics/skills (brand-guidelines); Claude's stylesheet as served to the desktop app |

Values were read from each source between 11 and 17 October 2026: the original schemes on 11 October (checked by independent reviewers), the halves added on 17 October (Alucard, Solarized dark, Nord light, Ayu, Night Owl, Light Owl, VS, Absolutely, Linea, Verc) on that day. Published palettes and values observed inside an app bundle are different kinds of source; the table says which. Shades described as coming from a scheme's VS Code theme are not part of the scheme's own specification. Re-check against the sources before each release.

## Sidebar hover and selected-row colours

Each scheme's own highlight (hover) and selection colour, fetched from the source files on 12 October 2026, before any
adjustment listed further down: Tokyo Night bg_highlight / bg_visual (extras/lua); Catppuccin Overlay 2 at 20% / 30% over
the base (style guide "Selection Background"; 20% for hover is this project's choice); Dracula LineHighlight over the
background / Selection (dracula/visual-studio-code); Nord nord1 / nord2 (nordtheme/vim CursorLine / Visual); Gruvbox
bg1 / bg3 (CursorLine / Visual); One Dark list hover / editor selection over the background (OneDark-Pro); One Light
cursor line / selection (one-light-syntax, computed from its formulas); GitHub neutral subtle / neutral muted over the
background (github-vscode-theme with primer/primitives 7.15.0); Rose Pine highlightLow / highlightMed (rose-pine-palette).
Skins without a separate token have theirs computed and listed below.

## The skins and their halves

Each skin is one file, `presets/<skin>.css`, holding a dark half and a light half (below). Claude shows whichever half
matches its own Settings > Appearance.

- classic: classic-dark (dark) + classic-light (light)
- catppuccin: catppuccin-mocha (dark) + catppuccin-latte (light)
- dracula: dracula (dark) + alucard (light)
- github: github-dark (dark) + github-light (light)
- gruvbox: gruvbox-dark (dark) + gruvbox-light (light)
- nord: nord (dark) + nord-light (light)
- one: one-dark (dark) + one-light (light)
- rose-pine: rose-pine (dark) + rose-pine-dawn (light)
- solarized: solarized-dark (dark) + solarized-light (light)
- tokyo-night: tokyo-night (dark) + tokyo-night-day (light)
- ayu: ayu-dark (dark) + ayu-light (light)
- night-owl: night-owl (dark) + light-owl (light)
- vs: vs-dark (dark) + vs-light (light)
- absolutely: absolutely-dark (dark) + absolutely-light (light)
- linea: linea-dark (dark) + linea-light (light)
- verc: verc-dark (dark) + verc-light (light)

## Session status dots

The same dot colours in every skin, one set per mode, so a dot means the same thing everywhere. Each starts
from Claude's own colour and changes only until it reads 3.4:1 on every sidebar, hover and selected row of every
skin in that mode, and stays clearly apart from the other three. What changes, exactly: the lightness moves away from
the rows; the three colour dots keep Claude's hue at a strength (OKLCH chroma) of at least 0.2, lowered only where the
screen cannot show it; the running dot is made a neutral grey; and where two dots would sit closer than OKLab 0.12, the
waiting dot's hue turns toward orange as far as it helps (in light mode about 20 degrees).

- dark: unread #5ca3fe, waiting #fab219, error #ff7870, running #a1a1a1 (Claude's own: unread #2a78d6, waiting #fab219, error #d03b3b, running #898781)
- light: unread #0362c1, waiting #965001, error #c31a26, running #636363 (Claude's own: unread #2a78d6, waiting #fab219, error #d03b3b, running #898781)

## Values that are derived, not copied

Where a scheme has no suitable shade, or a colour would be hard to read, the generator computes one. Every such value is listed.

### tokyo-night (dark) - folke/tokyonight.nvim night

page #1a1b26, sidebar #16161e, card #292e42, text #c0caf5, secondary #a9b1d6, muted #9a9fbc, link #7aa2f7, hover #292e42, selected row #283457
accent fill #7aa2f7, button text #1a1b26, accent hover #93b6fe, accent chip #2f3954

- pop-up shade #32374d computed (card mixed 6% toward text)
- muted text #737aa2 nudged to #9a9fbc to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #f7768e nudged to #f77990 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- accent: fill #7aa2f7, button text #1a1b26, hover #93b6fe, chip #2f3954, border #455884 (ramp from Claude's lightness steps with this hue)

### catppuccin-mocha (dark) - catppuccin/palette mocha

page #1e1e2e, sidebar #181825, card #313244, text #cdd6f4, secondary #b1b7cf, muted #a5a9ba, link #89b4fa, hover #353748, selected row #3c3e4f
accent fill #89b4fa, button text #1e1e2e, accent hover #a6c8fe, accent chip #363f5b

- pop-up shade #3a3c4f computed (card mixed 6% toward text)
- muted text #7f849c nudged to #a5a9ba to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- selected row #414356 moved to #3c3e4f so text reads better on it, while the band still stands out from the sidebar
- secondary text #a6adc8 strengthened to #b1b7cf to stay clearly stronger than muted hints
- accent: fill #89b4fa, button text #1e1e2e, hover #a6c8fe, chip #363f5b, border #4e628a (ramp from Claude's lightness steps with this hue)

### dracula (dark) - draculatheme.com spec

page #282a36, sidebar #21222c, card #343746, text #f8f8f2, secondary #c4c5c3, muted #a7b0cc, link #c49efa, hover #353747, selected row #3f4153
accent fill #bd93f9, button text #282a36, accent hover #ccacfe, accent chip #463f5e

Note: Page, sidebar (#21222c Background Dark), card (#343746 Background Light) and text come from the Dracula spec page. The spec lists #ff6e6e as the bright red; the nudged danger colour is this project's own.

- pop-up shade #404350 computed (card mixed 6% toward text)
- secondary text #c4c5c3 computed (text mixed 25% toward bg; the scheme has no matching token, or this project replaced it: see the note above)
- muted text #6272a4 nudged to #a7b0cc to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #bd93f9 nudged to #c49efa to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #ff5555 nudged to #ff9292 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- selected row #44475a moved to #3f4153 so text reads better on it, while the band still stands out from the sidebar
- accent background #494161 moved to #463f5e so link and main text read 4.5:1 on it
- accent: fill #bd93f9, button text #282a36, hover #ccacfe, chip #463f5e, border #6b598e (ramp from Claude's lightness steps with this hue)

### nord (dark) - nordtheme.com

page #2e3440, sidebar #252a33, card #3b4252, text #d8dee9, secondary #c6cbd2, muted #b6bcc8, link #8dc3d2, hover #3b4252, selected row #424a5c
accent fill #88c0d0, button text #2e3440, accent hover #9bd3e4, accent chip #3e4d5a

Note: Nord has no darker shade (the sidebar is computed) and no muted grey in nord0 to nord15; muted is the brightened comment colour used by common ports.

- sidebar #252a33 computed (bg mixed 20% toward black; the scheme has no darker shade)
- pop-up shade #444b5b computed (card mixed 6% toward text)
- secondary text #aeb4bf computed (text mixed 25% toward bg; the scheme has no matching token, or this project replaced it: see the note above)
- secondary text #aeb4bf nudged to #b6bcc5 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #616e88 nudged to #b6bcc8 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #88c0d0 nudged to #8dc3d2 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #bf616a nudged to #dfb0b5 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #a3be8c nudged to #a9c293 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- selected row #434c5e moved to #424a5c so text reads better on it, while the band still stands out from the sidebar
- secondary text #b6bcc5 strengthened to #c6cbd2 to stay clearly stronger than muted hints
- accent background #425360 moved to #3e4d5a so link and main text read 4.5:1 on it
- accent: fill #88c0d0, button text #2e3440, hover #9bd3e4, chip #3e4d5a, border #577381 (ramp from Claude's lightness steps with this hue)

### gruvbox-dark (dark) - morhetz/gruvbox dark medium, hard sidebar

page #282828, sidebar #1d2021, card #3c3836, text #ebdbb2, secondary #d5c4a1, muted #b7ada3, link #99b5ab, hover #3c3836, selected row #47403b
accent fill #83a598, button text #282828, accent hover #95b8ab, accent chip #3c4441

- pop-up shade #47423d computed (card mixed 6% toward text)
- muted text #928374 nudged to #b7ada3 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #83a598 nudged to #99b5ab to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #fb4934 nudged to #fd9285 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- selected row #665c54 moved to #47403b so text reads better on it, while the band still stands out from the sidebar
- accent: fill #83a598, button text #282828, hover #95b8ab, chip #3c4441, border #51605a (ramp from Claude's lightness steps with this hue)

### one-dark (dark) - Atom One Dark syntax + One Dark Pro panels

page #282c34, sidebar #21252b, card #2c313a, text #abb2bf, secondary #adb2b9, muted #a0a5ac, link #61afef, hover #2c313a, selected row #333a47
accent fill #61afef, button text #282c34, accent hover #7ac2ff, accent chip #313f4f

Note: The card #2c313a is One Dark Pro's list-hover colour; the sidebar #21252b is its widget colour.

- pop-up shade #343942 computed (card mixed 6% toward text)
- secondary text #8a919c computed (text mixed 25% toward bg; the scheme has no matching token, or this project replaced it: see the note above)
- secondary text #8a919c nudged to #9da3ac to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #5c6370 nudged to #a0a5ac to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #e06c75 nudged to #e6868e to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- selected row #404859 moved to #333a47 so text reads better on it, while the band still stands out from the sidebar
- danger text (on row bands) #e6868e nudged to #e78890 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #9da3ac strengthened to #adb2b9 to stay clearly stronger than muted hints
- accent background #35495d moved to #313f4f so link and main text read 4.5:1 on it
- accent: fill #61afef, button text #282c34, hover #7ac2ff, chip #313f4f, border #426788 (ramp from Claude's lightness steps with this hue)

### github-dark (dark) - primer/primitives dark default (current)

page #0d1117, sidebar #010409, card #151b23, text #f0f6fc, secondary #959ca5, muted #8a8f97, link #4493f8, hover #171b22, selected row #24282e
accent fill #4493f8, button text #0d1117, accent hover #65a7ff, accent chip #182c46

- pop-up shade #222830 computed (card mixed 6% toward text)
- muted text #656c76 nudged to #8a8f97 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #f85149 nudged to #f8544d to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- selected row #343941 moved to #24282e so text reads better on it, while the band still stands out from the sidebar
- danger text (on row bands) #f8544d nudged to #f85751 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #9198a1 strengthened to #959ca5 to stay clearly stronger than muted hints
- accent background #192e49 moved to #182c46 so link and main text read 4.5:1 on it
- accent: fill #4493f8, button text #0d1117, hover #65a7ff, chip #182c46, border #264c7c (ramp from Claude's lightness steps with this hue)

### rose-pine (dark) - rose-pine/palette main; sidebar from the Neovim theme

page #191724, sidebar #16141f, card #1f1d2e, text #e0def4, secondary #9f9cb6, muted #9491a5, link #9ccfd8, hover #21202e, selected row #2c2938
accent fill #9ccfd8, button text #191724, accent hover #afe3ec, accent chip #363f4c

- pop-up shade #2b293a computed (card mixed 6% toward text)
- secondary text #908caa nudged to #928eac to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #6e6a86 nudged to #9491a5 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #31748f nudged to #6b9bae to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- selected row #403d52 moved to #2c2938 so text reads better on it, while the band still stands out from the sidebar
- secondary text #928eac strengthened to #9f9cb6 to stay clearly stronger than muted hints
- accent: fill #9ccfd8, button text #191724, hover #afe3ec, chip #363f4c, border #546a75 (ramp from Claude's lightness steps with this hue)

### classic-dark (dark) - Anthropic brand palette + legacy app dark values

page #262624, sidebar #1f1e1d, card #30302e, text #faf9f5, secondary #c2c0b6, muted #a8a6a2, link #82abd4, hover #31302e, selected row #353d45
accent fill #6a9bcc, button text #262624, accent hover #7caee0, accent chip #343e47

- pop-up shade #3c3c3a computed (card mixed 6% toward text)
- muted text #898781 nudged to #a8a6a2 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #6a9bcc nudged to #82abd4 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #ec7e7e nudged to #ee8b8b to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #0ca30c nudged to #50bd50 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #db9300 nudged to #dd990f to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #31302e computed (text mixed 8% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #353d45 computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- accent background #354049 moved to #343e47 so link and main text read 4.5:1 on it
- accent: fill #6a9bcc, button text #262624, hover #7caee0, chip #343e47, border #455b70 (ramp from Claude's lightness steps with this hue)

### solarized-dark (dark) - ethanschoonover.com/solarized (dark)

page #002b36, sidebar #00222b, card #073642, text #a2aeae, secondary #a1aeb0, muted #94a2a7, link #5aa7dd, hover #073642, selected row #133b4d
accent fill #3093da, button text #002b36, accent hover #46a6ee, accent chip #083c51

Note: Mirror of solarized-light: main text is base1 (#93a1a1, the scheme's emphasis tone) and secondary is base0 (#839496, the scheme's body text, only 4.75:1 on base03); muted is base01 (#586e75, 2.8:1, nudged). Solarized has no darker shade, so the sidebar is computed; hover is base02.

- sidebar #00222b computed (bg mixed 20% toward black; the scheme has no darker shade)
- pop-up shade #0f3c48 computed (card mixed 6% toward text)
- main text #93a1a1 nudged to #95a3a3 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #839496 nudged to #94a3a5 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #586e75 nudged to #94a2a7 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #268bd2 nudged to #5aa7dd to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #dc322f nudged to #ea8482 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #859900 nudged to #99a929 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #b58900 nudged to #c19c29 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- selected row #143f52 computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #143f52 moved to #133b4d so text reads better on it, while the band still stands out from the sidebar
- secondary text #94a3a5 strengthened to #a1aeb0 to stay clearly stronger than muted hints
- main text #95a3a3 strengthened to #a2aeae to stay at least as strong as secondary text
- accent fill #268bd2 moved to #3093da (perceived difference 0.025) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent background #0b425a moved to #083c51 so link and main text read 4.5:1 on it
- accent: fill #3093da, button text #002b36, hover #46a6ee, chip #083c51, border #165a80 (ramp from Claude's lightness steps with this hue)

### ayu-dark (dark) - ayu-theme/vscode-ayu ayu-dark.json (ayu-colors)

page #10141c, sidebar #0d1017, card #141821, text #bfbdb6, secondary #8f95a3, muted #828b95, link #e6b450, hover #1c212b, selected row #292318
accent fill #e6b450, button text #10141c, accent hover #fac764, accent chip #3f3727

Note: Hover is list.hoverBackground (#47526640) laid over the sidebar; the selected row is computed (Ayu's inactive selection is fainter than its hover). Secondary text is descriptionForeground, muted the comment colour, both nudged.

- pop-up shade #1e222a computed (card mixed 6% toward text)
- secondary text #5a6378 nudged to #858c9b to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #5a6673 nudged to #828b95 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #d95757 nudged to #dc6464 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- selected row #3d3424 computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #3d3424 moved to #292318 so text reads better on it, while the band still stands out from the sidebar
- danger text (on row bands) #dc6464 nudged to #dd6767 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #858c9b strengthened to #8f95a3 to stay clearly stronger than muted hints
- accent: fill #e6b450, button text #10141c, hover #fac764, chip #3f3727, border #705c33 (ramp from Claude's lightness steps with this hue)

### night-owl (dark) - sdras/night-owl-vscode-theme Night Owl-color-theme.json

page #011627, sidebar #01121f, card #0e293f, text #d6deeb, secondary #90a9bf, muted #8c9ca9, link #a78dd6, hover #12222f, selected row #262d47
accent fill #9069d6, button text #011627, accent hover #a27cea, accent chip #20284e

Note: Night Owl's sidebar and list hover equal its page colour, so the sidebar and hover are computed. The card is its inactive selection colour (#0e293f). The accent is button.background #7e57c2 without its 80% alpha. Its list selection (#234d70 at 55% alpha) is not used: the selected row is computed from the link colour instead (this project's choice).

- sidebar #01121f computed (bg mixed 20% toward black; the scheme has no darker shade)
- pop-up shade #1a3449 computed (card mixed 6% toward text)
- muted text #4b6479 nudged to #8c9ca9 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #7e57c2 nudged to #a78dd6 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #ef5350 nudged to #f27270 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #12222f computed (text mixed 8% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #262d47 computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- secondary text #89a4bb strengthened to #90a9bf to stay clearly stronger than muted hints
- accent fill #7e57c2 moved to #9069d6 (perceived difference 0.060) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent: fill #9069d6, button text #011627, hover #a27cea, chip #20284e, border #413b76 (ramp from Claude's lightness steps with this hue)

### vs-dark (dark) - microsoft/vscode theme-defaults dark_plus.json + dark_vs.json (Dark+)

page #1e1e1e, sidebar #252526, card #252526, text #d4d4d4, secondary #a6a6a6, muted #999999, link #439aff, hover #2d3031, selected row #233245
accent fill #3794ff, button text #1e1e1e, accent hover #63a9ff, accent chip #233245

Note: Codex's dark-plus. Secondary text is the workbench descriptionForeground (#cccccc at 70%) laid over the page; the card is the sidebar shade (#252526). Its inactive selection #37373d comes out too close to the hover once text must read on it, so the selected row is computed from the link colour (a blue tint, like VS Code's active selection).

- pop-up shade #303030 computed (card mixed 6% toward text)
- muted text #858585 nudged to #999999 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #3794ff nudged to #439aff to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #487e02 nudged to #7fa54e to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #2a2d2e strengthened to #2d3031 so it stands out from the sidebar
- selected row #2c3f56 computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #2c3f56 moved to #233245 so text reads better on it, while the band still stands out from the sidebar
- secondary text #989898 strengthened to #a6a6a6 to stay clearly stronger than muted hints
- accent background #243850 moved to #233245 so link and main text read 4.5:1 on it
- accent: fill #3794ff, button text #1e1e1e, hover #63a9ff, chip #233245, border #295383 (ramp from Claude's lightness steps with this hue)

### absolutely-dark (dark) - adapted from colour values observed in the Absolutely theme of OpenAI's Codex app 26.1007.71326 (not affiliated)

page #2d2d2b, sidebar #373735, card #373735, text #f9f9f7, secondary #c6c6c4, muted #b2b2b0, link #dba48e, hover #444442, selected row #523e35
accent fill #cf7f60, button text #2d2d2b, accent hover #e39172, accent chip #513f37

Note: Page, sidebar, text, muted and accent come from the Codex app's Absolutely theme. It defines no card, status, hover or selected colours: the card is the sidebar shade, status colours are borrowed from classic-dark, hover is computed, and the selected row is the clay accent mixed 30% into the sidebar (this project's pick; 22% came out too close to the hover).

- pop-up shade #434341 computed (card mixed 6% toward text)
- secondary text #c6c6c4 computed (text mixed 25% toward bg; the scheme has no matching token, or this project replaced it: see the note above)
- link colour #cc7d5e nudged to #dba48e to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #ec7e7e nudged to #f09898 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #0ca30c nudged to #63c463 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #db9300 nudged to #e1a429 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #474745 computed (text mixed 8% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- hover #474745 moved to #444442 so text reads better on it, while the band still stands out from the sidebar
- selected row #644c41 moved to #523e35 so text reads better on it, while the band still stands out from the sidebar
- danger text (on row bands) #f09898 nudged to #f09a9a to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #e1a429 nudged to #e2a62d to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #63c463 nudged to #66c566 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- accent fill #cc7d5e moved to #cf7f60 (perceived difference 0.008) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent: fill #cf7f60, button text #2d2d2b, hover #e39172, chip #513f37, border #765243 (ramp from Claude's lightness steps with this hue)

### linea-dark (dark) - adapted from colour values observed in the Linear theme of OpenAI's Codex app 26.1007.71326 (not affiliated)

page #0f0f11, sidebar #080a0f, card #17181d, text #e3e4e6, secondary #aeafb1, muted #858c98, link #7d85d5, hover #1a1b20, selected row #202337
accent fill #606acc, button text #ffffff, accent hover #5058b8, accent chip #21233a

Note: Page and text are the Codex theme's chromeTheme surface and ink (#0f0f11, #e3e4e6), which override its editor colours; the card is its editor background (#17181d); accent is its dark chrome accent. Danger and success are its diff colours; warning is borrowed from classic-dark. Secondary text is derived: its sideBar.foreground #d8dce6 is almost the main text, so it would give no step down. Hover and selected are computed.

- pop-up shade #232429 computed (card mixed 6% toward text)
- secondary text #aeafb1 computed (text mixed 25% toward bg; the scheme has no matching token, or this project replaced it: see the note above)
- muted text #636b7b nudged to #858c98 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #606acc nudged to #7d85d5 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #1a1b20 computed (text mixed 8% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #22253b computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #22253b moved to #202337 so text reads better on it, while the band still stands out from the sidebar
- accent: fill #606acc, button text #ffffff, hover #5058b8, chip #21233a, border #333865 (ramp from Claude's lightness steps with this hue)

### verc-dark (dark) - adapted from colour values observed in the Vercel theme of OpenAI's Codex app 26.1007.71326 (not affiliated)

page #000000, sidebar #000000, card #0a0a0a, text #ededed, secondary #a1a1a1, muted #828282, link #1a7dfe, hover #131313, selected row #051932
accent fill #006efe, button text #ffffff, accent hover #005edc, accent chip #001838

Note: Page and sidebar are pure black as in the Codex theme; the card shade #0a0a0a is this project's pick (the theme has none). Danger and success are its diff colours; warning is borrowed from classic-dark. Hover and selected are computed.

- pop-up shade #181818 computed (card mixed 6% toward text)
- muted text #666666 nudged to #828282 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #006efe nudged to #1a7dfe to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #f13342 nudged to #f13746 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #131313 computed (text mixed 8% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #061c38 computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #061c38 moved to #051932 so text reads better on it, while the band still stands out from the sidebar
- accent: fill #006efe, button text #ffffff, hover #005edc, chip #001838, border #003272 (ramp from Claude's lightness steps with this hue)

### catppuccin-latte (light) - catppuccin/palette latte

page #eff1f5, sidebar #e6e9ef, card #f8f9fb, text #4c4f69, secondary #4f5267, muted #595c6e, link #1955cb, hover #dddee5, selected row #d3d6dd
accent fill #1e66f5, button text #ffffff, accent hover #0652e0, accent chip #c7d7f5

- card shade #f8f9fb computed (bg mixed 55% toward white; the scheme has no lighter shade, and Claude's own light cards are lighter than the page)
- muted text #6c6f85 nudged to #63667a to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #1e66f5 nudged to #1c5ee1 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #d20f39 nudged to #ce0f38 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #40a02b nudged to #2f7620 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #df8e1d nudged to #8f5b13 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #d8dae1 moved to #dddee5 so text reads better on it, while the band still stands out from the sidebar
- selected row #cccfd8 moved to #d3d6dd so text reads better on it, while the band still stands out from the sidebar
- secondary text (on row bands) #5c5f77 nudged to #585b72 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- muted text (on row bands) #63667a nudged to #595c6e to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #1c5ee1 nudged to #1955cb to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #ce0f38 nudged to #b90e32 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #8f5b13 nudged to #815211 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #2f7620 nudged to #2a6a1d to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #585b72 strengthened to #4f5267 to stay clearly stronger than muted hints
- accent background #bdd0f5 moved to #c7d7f5 so link and main text read 4.5:1 on it
- accent: fill #1e66f5, button text #ffffff, hover #0652e0, chip #c7d7f5, border #729ef5 (ramp from Claude's lightness steps with this hue)

### github-light (light) - primer/primitives light default (current)

page #ffffff, sidebar #f6f8fa, card #ffffff, text #1f2328, secondary #545d67, muted #5f6771, link #0863cd, hover #ebeef0, selected row #e3e5e7
accent fill #0969da, button text #ffffff, accent hover #0258bc, accent chip #d6e6f9

- muted text #818b98 nudged to #6a727d to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #f4f6f8 strengthened to #ebeef0 so it stands out from the sidebar
- selected row #eff1f3 strengthened to #e3e5e7 so it stands out from the sidebar
- muted text (on row bands) #6a727d nudged to #5f6771 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #0969da nudged to #0863cd to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #d1242f nudged to #c4222c to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #9a6700 nudged to #8b5d00 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #1a7f37 nudged to #187533 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #59636e strengthened to #545d67 to stay clearly stronger than muted hints
- accent background #c4dbf6 moved to #d6e6f9 so link and main text read 4.5:1 on it
- accent: fill #0969da, button text #ffffff, hover #0258bc, chip #d6e6f9, border #6ba5e9 (ramp from Claude's lightness steps with this hue)

### solarized-light (light) - ethanschoonover.com/solarized

page #fdf6e3, sidebar #eee8d5, card #fefbf2, text #073642, secondary #44555c, muted #4e5f66, link #1b6194, hover #e1dfd1, selected row #d0dad8
accent fill #097cc1, button text #ffffff, accent hover #046aa6, accent chip #c3dadb

Note: Main text is base02 (#073642), not the scheme body text base00 (#657b83, only 4.1:1 on the page); secondary is base01 and muted is base00, so every step is one shade darker than Solarized itself.

- card shade #fefbf2 computed (bg mixed 55% toward white; the scheme has no lighter shade, and Claude's own light cards are lighter than the page)
- secondary text #586e75 nudged to #566c73 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #657b83 nudged to #576a71 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #268bd2 nudged to #1e6ca4 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #dc322f nudged to #c22c29 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #859900 nudged to #606e00 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #b58900 nudged to #826300 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #dcdac9 computed (text mixed 8% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- hover #dcdac9 moved to #e1dfd1 so text reads better on it, while the band still stands out from the sidebar
- selected row #c0cdca computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #c0cdca moved to #d0dad8 so text reads better on it, while the band still stands out from the sidebar
- secondary text (on row bands) #566c73 nudged to #4d6168 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- muted text (on row bands) #576a71 nudged to #4e5f66 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #1e6ca4 nudged to #1b6194 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #c22c29 nudged to #b22826 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #826300 nudged to #755900 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #606e00 nudged to #566300 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #4d6168 strengthened to #44555c to stay clearly stronger than muted hints
- accent fill #268bd2 moved to #097cc1 (perceived difference 0.049) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent background #c2d9db moved to #c3dadb so link and main text read 4.5:1 on it
- accent: fill #097cc1, button text #ffffff, hover #046aa6, chip #c3dadb, border #6badcf (ramp from Claude's lightness steps with this hue)

### gruvbox-light (light) - morhetz/gruvbox light medium (hard card)

page #fbf1c7, sidebar #f2e5bc, card #f9f5d7, text #3c3836, secondary #504945, muted #655a51, link #076678, hover #e9dab5, selected row #ddd5c7
accent fill #076678, button text #ffffff, accent hover #035463, accent chip #d1d9b9

- muted text #7c6f64 nudged to #70645a to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #79740e nudged to #6d680d to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #b57614 nudged to #8d5c10 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #ebdbb2 strengthened to #e8d8b0 so it stands out from the sidebar
- hover #e8d8b0 moved to #e9dab5 so text reads better on it, while the band still stands out from the sidebar
- selected row #bdae93 moved to #ddd5c7 so text reads better on it, while the band still stands out from the sidebar
- muted text (on row bands) #70645a nudged to #655a51 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #8d5c10 nudged to #7f530e to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #6d680d nudged to #625e0c to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- accent background #c0d0b4 moved to #d1d9b9 so link and main text read 4.5:1 on it
- accent: fill #076678, button text #ffffff, hover #035463, chip #d1d9b9, border #699e98 (ramp from Claude's lightness steps with this hue)

### rose-pine-dawn (light) - rose-pine/palette dawn

page #faf4ed, sidebar #f2e9e1, card #fffaf3, text #464261, secondary #544f74, muted #5d5b72, link #26657e, hover #e6dfdd, selected row #dcd7d7
accent fill #286983, button text #ffffff, accent hover #125871, accent chip #d1d9d9

Note: Text is the current palette value #464261; secondary is the older Dawn text #575279 still used by the VS Code theme; muted is Dawn subtle #797593.

- muted text #797593 nudged to #6a6781 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #b4637a nudged to #975366 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #56949f nudged to #417079 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #ea9d34 nudged to #8c5e1f to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #f4ede8 strengthened to #e6dfdd so it stands out from the sidebar
- selected row #dfdad9 strengthened to #dcd7d7 so it stands out from the sidebar
- muted text (on row bands) #6a6781 nudged to #5d5b72 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #286983 nudged to #26657e to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #975366 nudged to #884b5c to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #8c5e1f nudged to #7e551c to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #417079 nudged to #3b656d to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #575279 strengthened to #544f74 to stay clearly stronger than muted hints
- accent background #c8d3d4 moved to #d1d9d9 so link and main text read 4.5:1 on it
- accent: fill #286983, button text #ffffff, hover #125871, chip #d1d9d9, border #7ca1ad (ramp from Claude's lightness steps with this hue)

### tokyo-night-day (light) - folke/tokyonight.nvim day

page #e1e2e7, sidebar #d0d5e3, card #f2f2f4, text #274285, secondary #40465f, muted #4a4f66, link #1d4f94, hover #c6cadb, selected row #bac3e4
accent fill #1569d3, button text #ffffff, accent hover #0257b9, accent chip #b0c5e2

- card shade #f2f2f4 computed (bg mixed 55% toward white; the scheme has no lighter shade, and Claude's own light cards are lighter than the page)
- main text #3760bf nudged to #3358b0 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #68709a nudged to #535a7b to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #848cb5 nudged to #545a74 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #2e7de9 nudged to #215aa8 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #f52a65 nudged to #b01e49 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #587539 nudged to #4a6230 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #8c6c3e nudged to #705632 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #c4c8da moved to #c6cadb so text reads better on it, while the band still stands out from the sidebar
- selected row #b7c1e3 moved to #bac3e4 so text reads better on it, while the band still stands out from the sidebar
- main text (on row bands) #3358b0 nudged to #2d4d9b to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text (on row bands) #535a7b nudged to #494f6c to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- muted text (on row bands) #545a74 nudged to #4a4f66 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #215aa8 nudged to #1d4f94 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #b01e49 nudged to #9b1a40 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #705632 nudged to #654d2d to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #4a6230 nudged to #43582b to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #494f6c strengthened to #40465f to stay clearly stronger than muted hints
- main text #2d4d9b strengthened to #274285 to stay at least as strong as secondary text
- accent fill #2e7de9 moved to #1569d3 (perceived difference 0.064) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent: fill #1569d3, button text #ffffff, hover #0257b9, chip #b0c5e2, border #6799db (ramp from Claude's lightness steps with this hue)

### one-light (light) - Atom One Light syntax + One Light panels

page #fafafa, sidebar #eaeaeb, card #ffffff, text #383a42, secondary #50535b, muted #5c5d60, link #3059b3, hover #e0e0e2, selected row #d7d7d9
accent fill #386fe8, button text #ffffff, accent hover #275cd3, accent chip #cbd9f6

- secondary text #696c77 nudged to #656872 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #a0a1a7 nudged to #66676b to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #4078f2 nudged to #3665cb to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #e45649 nudged to #b24339 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #50a14f nudged to #3a7439 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #c18401 nudged to #8b5f01 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #f0f0f1 strengthened to #dedee0 so it stands out from the sidebar
- hover #dedee0 moved to #e0e0e2 so text reads better on it, while the band still stands out from the sidebar
- selected row #e5e5e6 strengthened to #d7d7d9 so it stands out from the sidebar
- secondary text (on row bands) #656872 nudged to #5b5e67 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- muted text (on row bands) #66676b nudged to #5c5d60 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #3665cb nudged to #3059b3 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #b24339 nudged to #a03c33 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #8b5f01 nudged to #7d5601 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #3a7439 nudged to #346833 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #5b5e67 strengthened to #50535b to stay clearly stronger than muted hints
- accent fill #4078f2 moved to #386fe8 (perceived difference 0.028) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent: fill #386fe8, button text #ffffff, hover #275cd3, chip #cbd9f6, border #86a7ef (ramp from Claude's lightness steps with this hue)

### alucard (light) - draculatheme.com/spec (Alucard Classic)

page #fffbeb, sidebar #ece9df, card #fffdf6, text #1f1f1f, secondary #555450, muted #635e45, link #6249c5, hover #e1dfd3, selected row #d8d8e4
accent fill #644ac9, button text #ffffff, accent hover #5436b5, accent chip #ded6e4

Note: Dracula's official light variant. Sidebar is Background Lighter (#ece9df), hover Background Light (#dedccf), selected row the spec's Selection (#cfcfde); the card shade is computed.

- card shade #fffdf6 computed (bg mixed 55% toward white; the scheme has no lighter shade, and Claude's own light cards are lighter than the page)
- secondary text #575652 computed (text mixed 25% toward bg; the scheme has no matching token, or this project replaced it: see the note above)
- danger text #cb3a2a nudged to #bf3727 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #846e15 nudged to #7c6714 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #dedccf moved to #e1dfd3 so text reads better on it, while the band still stands out from the sidebar
- selected row #cfcfde moved to #d8d8e4 so text reads better on it, while the band still stands out from the sidebar
- muted text (on row bands) #6c664b nudged to #635e45 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #644ac9 nudged to #6249c5 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #bf3727 nudged to #ac3223 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #7c6714 nudged to #705d12 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #14710a nudged to #136c0a to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #575652 strengthened to #555450 to stay clearly stronger than muted hints
- accent background #dad1e3 moved to #ded6e4 so link and main text read 4.5:1 on it
- accent: fill #644ac9, button text #ffffff, hover #5436b5, chip #ded6e4, border #a291d7 (ramp from Claude's lightness steps with this hue)

### nord-light (light) - nordtheme.com palette (Snow Storm and Polar Night), arranged by this project

page #eceff4, sidebar #e5e9f0, card #ffffff, text #2e3440, secondary #495366, muted #525d73, link #455f7f, hover #dadfea, selected row #d0d7e1
accent fill #5679a3, button text #ffffff, accent hover #456790, accent chip #cdd7e4

Note: Nord publishes no light variant of its own editor and terminal themes (its docs describe bright designs on Snow Storm backgrounds); this half is a Reskin adaptation, not an official Nord variant. The white card is a project choice. Page nord6, sidebar nord5, hover nord4, text nord0, secondary nord3, muted the brightened comment colour used by common ports; accent nord10, status colours Aurora, all nudged darker until they read.

- muted text #616e88 nudged to #5b6780 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #5e81ac nudged to #4d6a8d to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #bf616a nudged to #a05159 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #a3be8c nudged to #5b6a4e to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #d08770 nudged to #8d5c4c to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #d8dee9 moved to #dadfea so text reads better on it, while the band still stands out from the sidebar
- selected row #c4cdda computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #c4cdda moved to #d0d7e1 so text reads better on it, while the band still stands out from the sidebar
- muted text (on row bands) #5b6780 nudged to #525d73 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #4d6a8d nudged to #455f7f to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #a05159 nudged to #8d474e to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #8d5c4c nudged to #7c5143 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #5b6a4e nudged to #546248 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #4c566a strengthened to #495366 to stay clearly stronger than muted hints
- accent fill #5e81ac moved to #5679a3 (perceived difference 0.027) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent background #c8d3e1 moved to #cdd7e4 so link and main text read 4.5:1 on it
- accent: fill #5679a3, button text #ffffff, hover #456790, chip #cdd7e4, border #92a8c3 (ramp from Claude's lightness steps with this hue)

### ayu-light (light) - ayu-theme/vscode-ayu ayu-light.json (ayu-colors)

page #fcfcfc, sidebar #f8f9fa, card #ffffff, text #585d62, secondary #565f69, muted #676869, link #905a0e, hover #edeff2, selected row #eee6db
accent fill #aa6700, button text #ffffff, accent hover #925802, accent chip #eee3d2

Note: Hover is list.hoverBackground (#6b7d8f24) laid over the sidebar; the selected row is computed. The card is white (Ayu's widget shade #fafafa is almost the page).

- secondary text #828e9f nudged to #68727f to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #adaeb1 nudged to #727375 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #f29718 nudged to #a06410 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #e65050 nudged to #c64545 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #6cbf43 nudged to #477e2c to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #f29718 nudged to #a06410 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #e4e7eb moved to #edeff2 so text reads better on it, while the band still stands out from the sidebar
- selected row #e5d8c7 computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #e5d8c7 moved to #eee6db so text reads better on it, while the band still stands out from the sidebar
- secondary text (on row bands) #68727f nudged to #5e6772 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- muted text (on row bands) #727375 nudged to #676869 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #a06410 nudged to #905a0e to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #c64545 nudged to #b63f3f to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #a06410 nudged to #905a0e to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #477e2c nudged to #417428 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #5e6772 strengthened to #565f69 to stay clearly stronger than muted hints
- main text #5c6166 strengthened to #585d62 to stay at least as strong as secondary text
- accent fill: the published accent #f29718 cannot carry 4.5:1 button text and show 3:1 on every surface at its own strength, so the closest colour that does (same hue, lower strength) is used
- accent fill #f29718 moved to #aa6700 (perceived difference 0.181) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent background #e8d8c0 moved to #eee3d2 so link and main text read 4.5:1 on it
- accent: fill #aa6700, button text #ffffff, hover #925802, chip #eee3d2, border #cba365 (ramp from Claude's lightness steps with this hue)

### light-owl (light) - sdras/night-owl-vscode-theme Night Owl-Light-color-theme.json

page #fbfbfb, sidebar #f0f0f0, card #ffffff, text #403f53, secondary #565562, muted #566369, link #1c6c65, hover #dcedf9, selected row #d8dfe3
accent fill #03857c, button text #ffffff, accent hover #00716a, accent chip #c5e2e0

Note: Light Owl's secondary text equals its main text, so secondary is derived. Danger is editorError.foreground (its errorForeground is plain text). Its added colour is teal, used as success. Card is white.

- secondary text #6f6e7d computed (text mixed 25% toward bg; the scheme has no matching token, or this project replaced it: see the note above)
- secondary text #6f6e7d nudged to #6d6c7b to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #90a7b2 nudged to #5f6e75 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #2aa298 nudged to #1f7870 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #e64d49 nudged to #c1413d to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #49d0c5 nudged to #2a7972 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #daaa01 nudged to #876901 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #d3e8f8 moved to #dcedf9 so text reads better on it, while the band still stands out from the sidebar
- selected row #e0e7ea strengthened to #d6dde1 so it stands out from the sidebar
- selected row #d6dde1 moved to #d8dfe3 so text reads better on it, while the band still stands out from the sidebar
- secondary text (on row bands) #6d6c7b nudged to #62616f to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- muted text (on row bands) #5f6e75 nudged to #566369 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #1f7870 nudged to #1c6c65 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #c1413d nudged to #aa3936 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #876901 nudged to #775c01 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #2a7972 nudged to #256a64 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #62616f strengthened to #565562 to stay clearly stronger than muted hints
- accent fill #2aa298 moved to #03857c (perceived difference 0.091) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent background #bfdfdd moved to #c5e2e0 so link and main text read 4.5:1 on it
- accent: fill #03857c, button text #ffffff, hover #00716a, chip #c5e2e0, border #66b4af (ramp from Claude's lightness steps with this hue)

### vs-light (light) - microsoft/vscode theme-defaults light_plus.json + light_vs.json (Light+)

page #ffffff, sidebar #f3f3f3, card #ffffff, text #000000, secondary #5a5a5a, muted #646464, link #0066aa, hover #e9e9e9, selected row #dfe0e9
accent fill #006ab1, button text #ffffff, accent hover #045995, accent chip #cee2f0

Note: Codex's light-plus. Muted is the input placeholder colour. The card is white, a project choice: VS Code's widget shade #f3f3f3 is the sidebar colour, and Claude's light cards are lighter than the page.

- secondary text #717171 nudged to #6f6f6f to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- muted text #767676 nudged to #6f6f6f to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #48985d nudged to #3a7a4a to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- warning text #bf8803 nudged to #916702 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #e8e8e8 moved to #e9e9e9 so text reads better on it, while the band still stands out from the sidebar
- selected row #e4e6f1 strengthened to #dbdde7 so it stands out from the sidebar
- selected row #dbdde7 moved to #dfe0e9 so text reads better on it, while the band still stands out from the sidebar
- secondary text (on row bands) #6f6f6f nudged to #646464 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- muted text (on row bands) #6f6f6f nudged to #646464 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #006ab1 nudged to #0066aa to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- warning text (on row bands) #916702 nudged to #835d02 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #3a7a4a nudged to #346e43 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #646464 strengthened to #5a5a5a to stay clearly stronger than muted hints
- accent background #c2dbec moved to #cee2f0 so link and main text read 4.5:1 on it
- accent: fill #006ab1, button text #ffffff, hover #045995, chip #cee2f0, border #66a6d0 (ramp from Claude's lightness steps with this hue)

### absolutely-light (light) - adapted from colour values observed in the Absolutely theme of OpenAI's Codex app 26.1007.71326 (not affiliated)

page #f9f9f7, sidebar #f4f4f2, card #ffffff, text #2d2d2b, secondary #585856, muted #636361, link #8c5640, hover #eaeae8, selected row #e9e0db
accent fill #ae6244, button text #ffffff, accent hover #9b5033, accent chip #ebded6

Note: Page, sidebar, text, muted and accent come from the Codex app's Absolutely theme; card white; status colours borrowed from classic-light; hover and selected computed.

- secondary text #60605e computed (text mixed 25% toward bg; the scheme has no matching token, or this project replaced it: see the note above)
- muted text #939391 nudged to #70706e to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #cc7d5e nudged to #9b5f47 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #e4e4e2 computed (text mixed 8% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- hover #e4e4e2 moved to #eaeae8 so text reads better on it, while the band still stands out from the sidebar
- selected row #e0d3cc computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #e0d3cc moved to #e9e0db so text reads better on it, while the band still stands out from the sidebar
- muted text (on row bands) #70706e nudged to #636361 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #9b5f47 nudged to #8c5640 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #60605e strengthened to #585856 to stay clearly stronger than muted hints
- accent fill #cc7d5e moved to #ae6244 (perceived difference 0.090) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent background #e7d5cc moved to #ebded6 so link and main text read 4.5:1 on it
- accent: fill #ae6244, button text #ffffff, hover #9b5033, chip #ebded6, border #cc9e8c (ramp from Claude's lightness steps with this hue)

### linea-light (light) - adapted from colour values observed in the Linear theme of OpenAI's Codex app 26.1007.71326 (not affiliated)

page #fcfcfd, sidebar #f2f4f8, card #ffffff, text #1b1b1b, secondary #4a5263, muted #5f6571, link #515cb6, hover #e8eaec, selected row #dee1f3
accent fill #5e6ad2, button text #ffffff, accent hover #4e58be, accent chip #dee0f5

Note: Page and text are the chromeTheme surface and ink (#fcfcfd, #1b1b1b); sidebar, secondary, muted and accent from its colours; danger and success its diff colours; warning borrowed from classic-light; card white; hover and selected computed.

- muted text #8a93a6 nudged to #69707e to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #5e6ad2 nudged to #5a66ca to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- danger text #c94446 nudged to #c14143 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- success text #52a450 nudged to #3e7d3d to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #e1e3e6 computed (text mixed 8% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- hover #e1e3e6 moved to #e8eaec so text reads better on it, while the band still stands out from the sidebar
- selected row #d1d5ee computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #d1d5ee moved to #dee1f3 so text reads better on it, while the band still stands out from the sidebar
- muted text (on row bands) #69707e nudged to #5f6571 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #5a66ca nudged to #515cb6 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #c14143 nudged to #ae3b3c to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #3e7d3d nudged to #387137 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- accent background #d6d9f3 moved to #dee0f5 so link and main text read 4.5:1 on it
- accent: fill #5e6ad2, button text #ffffff, hover #4e58be, chip #dee0f5, border #9da4e3 (ramp from Claude's lightness steps with this hue)

### verc-light (light) - adapted from colour values observed in the Vercel theme of OpenAI's Codex app 26.1007.71326 (not affiliated)

page #ffffff, sidebar #ffffff, card #ffffff, text #171717, secondary #5c5c5c, muted #666666, link #0062eb, hover #f4f4f4, selected row #e4efff
accent fill #006aff, button text #ffffff, accent hover #015bdc, accent chip #e2eeff

Note: Page and sidebar pure white as in the Codex theme; danger and success its diff colours; warning borrowed from classic-light; hover and selected computed.

- success text #28a948 nudged to #20873a to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #ececec computed (text mixed 8% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- hover #ececec moved to #f4f4f4 so text reads better on it, while the band still stands out from the sidebar
- selected row #c7deff computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #c7deff moved to #e4efff so text reads better on it, while the band still stands out from the sidebar
- link colour (on row bands) #006aff nudged to #0062eb to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- danger text (on row bands) #eb001d nudged to #d8001b to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- success text (on row bands) #20873a nudged to #1d7c35 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- secondary text #666666 strengthened to #5c5c5c to stay clearly stronger than muted hints
- accent background #c2dbff moved to #e2eeff so link and main text read 4.5:1 on it
- accent: fill #006aff, button text #ffffff, hover #015bdc, chip #e2eeff, border #66a6ff (ramp from Claude's lightness steps with this hue)

### classic-light (light) - Anthropic brand palette + legacy app light values

page #faf9f5, sidebar #f0eee6, card #ffffff, text #141413, secondary #3d3d3a, muted #615f5b, link #436281, hover #e5e4de, selected row #d7ddde
accent fill #4a7aa9, button text #ffffff, accent hover #396896, accent chip #d0dbe3

- muted text #898781 nudged to #6e6c67 to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- link colour #6a9bcc nudged to #4a6d8f to read on every surface (4.5 / 4.5 / 4.5 / 4.5:1)
- hover #deddd5 computed (text mixed 8% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- hover #deddd5 moved to #e5e4de so text reads better on it, while the band still stands out from the sidebar
- selected row #cbd2d3 computed (link colour mixed 22% into the sidebar; the scheme has no published token, or this project replaced it: see the note above)
- selected row #cbd2d3 moved to #d7ddde so text reads better on it, while the band still stands out from the sidebar
- muted text (on row bands) #6e6c67 nudged to #615f5b to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- link colour (on row bands) #4a6d8f nudged to #436281 to read on every surface (4.5 / 4.5 / 4.5 / 4.5 / 4.5 / 4.5:1)
- accent fill #6a9bcc moved to #4a7aa9 (perceived difference 0.108) so button text reads 4.5:1 and it shows 3:1 on every surface
- accent: fill #4a7aa9, button text #ffffff, hover #396896, chip #d0dbe3, border #90adc7 (ramp from Claude's lightness steps with this hue)
