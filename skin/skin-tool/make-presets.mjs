#!/usr/bin/env node
// Builds presets/<skin>.css and ATTRIBUTION.md from the palette table below, in the exact shape skin.mjs
// accepts: no comments, no quotes, nothing fetched. Since 17 Oct 2026 (the final set) there are 16 skins, each ONE
// name with a dark half and a light half in one file (FAMILIES), so Claude shows whichever matches its own
// Settings > Appearance (verified live 12 Oct 2026: the page follows Claude, not the Mac). The palettes below are halves:
// they are never written as files of their own.
// Run: node make-presets.mjs
// Every colour is the scheme's own published value (see ATTRIBUTION.md). Four kinds of value are DERIVED
// and listed there: a darker sidebar where the scheme has none ("computed"), a lighter card shade for light
// schemes ("lighter"), the pop-up shade, and any colour nudged toward white or black until it reads at the
// contrast the tests demand (fit()). Nothing here claims to be official.
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// bg = page, side = sidebar, raised = cards/panels, text = main text, text2 = secondary text,
// muted = hints/placeholders, accent = links, danger/success/warning = status text.
// 'computed' side = bg mixed 20% toward black. 'lighter' raised = bg mixed 55% toward white.
// 'derived' text2 = text mixed 25% toward bg. Anything undefined falls back the same way.
const PALETTES = {
  'tokyo-night':      { src: 'folke/tokyonight.nvim night', bg: '#1a1b26', side: '#16161e', raised: '#292e42', text: '#c0caf5', text2: '#a9b1d6', muted: '#737aa2', accent: '#7aa2f7', danger: '#f7768e', success: '#9ece6a', warning: '#e0af68', hover: '#292e42', selected: '#283457' },
  'catppuccin-mocha': { src: 'catppuccin/palette mocha', bg: '#1e1e2e', side: '#181825', raised: '#313244', text: '#cdd6f4', text2: '#a6adc8', muted: '#7f849c', accent: '#89b4fa', danger: '#f38ba8', success: '#a6e3a1', warning: '#f9e2af' , hover: '#353748', selected: '#414356' },
  'dracula':          { src: 'draculatheme.com spec', note: 'Page, sidebar (#21222c Background Dark), card (#343746 Background Light) and text come from the Dracula spec page. The spec lists #ff6e6e as the bright red; the nudged danger colour is this project\'s own.', bg: '#282a36', side: '#21222c', raised: '#343746', text: '#f8f8f2', text2: 'derived', muted: '#6272a4', accent: '#bd93f9', danger: '#ff5555', success: '#50fa7b', warning: '#f1fa8c' , hover: '#353747', selected: '#44475a' },
  'nord':             { src: 'nordtheme.com', note: 'Nord has no darker shade (the sidebar is computed) and no muted grey in nord0 to nord15; muted is the brightened comment colour used by common ports.', bg: '#2e3440', side: 'computed', raised: '#3b4252', text: '#d8dee9', text2: 'derived', muted: '#616e88', accent: '#88c0d0', danger: '#bf616a', success: '#a3be8c', warning: '#ebcb8b' , hover: '#3b4252', selected: '#434c5e' },
  'gruvbox-dark':     { src: 'morhetz/gruvbox dark medium, hard sidebar', bg: '#282828', side: '#1d2021', raised: '#3c3836', text: '#ebdbb2', text2: '#d5c4a1', muted: '#928374', accent: '#83a598', danger: '#fb4934', success: '#b8bb26', warning: '#fabd2f' , hover: '#3c3836', selected: '#665c54' },
  'one-dark':         { src: 'Atom One Dark syntax + One Dark Pro panels', note: 'The card #2c313a is One Dark Pro\'s list-hover colour; the sidebar #21252b is its widget colour.', bg: '#282c34', side: '#21252b', raised: '#2c313a', text: '#abb2bf', text2: 'derived', muted: '#5c6370', accent: '#61afef', danger: '#e06c75', success: '#98c379', warning: '#e5c07b' , hover: '#2c313a', selected: '#404859' },
  'github-dark':      { src: 'primer/primitives dark default (current)', bg: '#0d1117', side: '#010409', raised: '#151b23', text: '#f0f6fc', text2: '#9198a1', muted: '#656c76', accent: '#4493f8', danger: '#f85149', success: '#3fb950', warning: '#d29922' , hover: '#171b22', selected: '#343941' },
  'rose-pine':        { src: 'rose-pine/palette main; sidebar from the Neovim theme', bg: '#191724', side: '#16141f', raised: '#1f1d2e', text: '#e0def4', text2: '#908caa', muted: '#6e6a86', accent: '#9ccfd8', danger: '#eb6f92', success: '#31748f', warning: '#f6c177' , hover: '#21202e', selected: '#403d52' },
  'classic-dark':     { src: 'Anthropic brand palette + legacy app dark values', bg: '#262624', side: '#1f1e1d', raised: '#30302e', text: '#faf9f5', text2: '#c2c0b6', muted: '#898781', accent: '#6a9bcc', danger: '#ec7e7e', success: '#0ca30c', warning: '#db9300' },

  'solarized-dark':   { src: 'ethanschoonover.com/solarized (dark)', note: 'Mirror of solarized-light: main text is base1 (#93a1a1, the scheme\'s emphasis tone) and secondary is base0 (#839496, the scheme\'s body text, only 4.75:1 on base03); muted is base01 (#586e75, 2.8:1, nudged). Solarized has no darker shade, so the sidebar is computed; hover is base02.', bg: '#002b36', side: 'computed', raised: '#073642', text: '#93a1a1', text2: '#839496', muted: '#586e75', accent: '#268bd2', danger: '#dc322f', success: '#859900', warning: '#b58900', hover: '#073642' },

  'ayu-dark':         { src: 'ayu-theme/vscode-ayu ayu-dark.json (ayu-colors)', note: 'Hover is list.hoverBackground (#47526640) laid over the sidebar; the selected row is computed (Ayu\'s inactive selection is fainter than its hover). Secondary text is descriptionForeground, muted the comment colour, both nudged.', bg: '#10141c', side: '#0d1017', raised: '#141821', text: '#bfbdb6', text2: '#5a6378', muted: '#5a6673', accent: '#e6b450', danger: '#d95757', success: '#70bf56', warning: '#e6b450', hover: '#1c212b' },
  'night-owl':        { src: 'sdras/night-owl-vscode-theme Night Owl-color-theme.json', note: 'Night Owl\'s sidebar and list hover equal its page colour, so the sidebar and hover are computed. The card is its inactive selection colour (#0e293f). The accent is button.background #7e57c2 without its 80% alpha. Its list selection (#234d70 at 55% alpha) is not used: the selected row is computed from the link colour instead (this project\'s choice).', bg: '#011627', side: 'computed', raised: '#0e293f', text: '#d6deeb', text2: '#89a4bb', muted: '#4b6479', accent: '#7e57c2', danger: '#ef5350', success: '#9ccc65', warning: '#b39554' },
  'vs-dark':          { src: 'microsoft/vscode theme-defaults dark_plus.json + dark_vs.json (Dark+)', note: 'Codex\'s dark-plus. Secondary text is the workbench descriptionForeground (#cccccc at 70%) laid over the page; the card is the sidebar shade (#252526). Its inactive selection #37373d comes out too close to the hover once text must read on it, so the selected row is computed from the link colour (a blue tint, like VS Code\'s active selection).', bg: '#1e1e1e', side: '#252526', raised: '#252526', text: '#d4d4d4', text2: '#989898', muted: '#858585', accent: '#3794ff', danger: '#f48771', success: '#487e02', warning: '#cca700', hover: '#2a2d2e' },
  'absolutely-dark':  { src: 'adapted from colour values observed in the Absolutely theme of OpenAI\'s Codex app 26.1007.71326 (not affiliated)', note: 'Page, sidebar, text, muted and accent come from the Codex app\'s Absolutely theme. It defines no card, status, hover or selected colours: the card is the sidebar shade, status colours are borrowed from classic-dark, hover is computed, and the selected row is the clay accent mixed 30% into the sidebar (this project\'s pick; 22% came out too close to the hover).', bg: '#2d2d2b', side: '#373735', raised: '#373735', text: '#f9f9f7', text2: 'derived', muted: '#b2b2b0', accent: '#cc7d5e', danger: '#ec7e7e', success: '#0ca30c', warning: '#db9300', selected: '#644c41' },
  'linea-dark':       { src: 'adapted from colour values observed in the Linear theme of OpenAI\'s Codex app 26.1007.71326 (not affiliated)', note: 'Page and text are the Codex theme\'s chromeTheme surface and ink (#0f0f11, #e3e4e6), which override its editor colours; the card is its editor background (#17181d); accent is its dark chrome accent. Danger and success are its diff colours; warning is borrowed from classic-dark. Secondary text is derived: its sideBar.foreground #d8dce6 is almost the main text, so it would give no step down. Hover and selected are computed.', bg: '#0f0f11', side: '#080a0f', raised: '#17181d', text: '#e3e4e6', text2: 'derived', muted: '#636b7b', accent: '#606acc', danger: '#ff7e78', success: '#69c967', warning: '#db9300' },
  'verc-dark':        { src: 'adapted from colour values observed in the Vercel theme of OpenAI\'s Codex app 26.1007.71326 (not affiliated)', note: 'Page and sidebar are pure black as in the Codex theme; the card shade #0a0a0a is this project\'s pick (the theme has none). Danger and success are its diff colours; warning is borrowed from classic-dark. Hover and selected are computed.', bg: '#000000', side: '#000000', raised: '#0a0a0a', text: '#ededed', text2: '#a1a1a1', muted: '#666666', accent: '#006efe', danger: '#f13342', success: '#00ad3a', warning: '#db9300' },

  'catppuccin-latte': { mode: 'light', src: 'catppuccin/palette latte', bg: '#eff1f5', side: '#e6e9ef', raised: 'lighter', text: '#4c4f69', text2: '#5c5f77', muted: '#6c6f85', accent: '#1e66f5', danger: '#d20f39', success: '#40a02b', warning: '#df8e1d' , hover: '#d8dae1', selected: '#cccfd8' },
  'github-light':     { mode: 'light', src: 'primer/primitives light default (current)', bg: '#ffffff', side: '#f6f8fa', raised: '#ffffff', text: '#1f2328', text2: '#59636e', muted: '#818b98', accent: '#0969da', danger: '#d1242f', success: '#1a7f37', warning: '#9a6700' , hover: '#f4f6f8', selected: '#eff1f3' },
  'solarized-light':  { mode: 'light', src: 'ethanschoonover.com/solarized', note: 'Main text is base02 (#073642), not the scheme body text base00 (#657b83, only 4.1:1 on the page); secondary is base01 and muted is base00, so every step is one shade darker than Solarized itself.', bg: '#fdf6e3', side: '#eee8d5', raised: 'lighter', text: '#073642', text2: '#586e75', muted: '#657b83', accent: '#268bd2', danger: '#dc322f', success: '#859900', warning: '#b58900' },
  'gruvbox-light':    { mode: 'light', src: 'morhetz/gruvbox light medium (hard card)', bg: '#fbf1c7', side: '#f2e5bc', raised: '#f9f5d7', text: '#3c3836', text2: '#504945', muted: '#7c6f64', accent: '#076678', danger: '#9d0006', success: '#79740e', warning: '#b57614' , hover: '#ebdbb2', selected: '#bdae93' },
  'rose-pine-dawn':   { mode: 'light', src: 'rose-pine/palette dawn', note: 'Text is the current palette value #464261; secondary is the older Dawn text #575279 still used by the VS Code theme; muted is Dawn subtle #797593.', bg: '#faf4ed', side: '#f2e9e1', raised: '#fffaf3', text: '#464261', text2: '#575279', muted: '#797593', accent: '#286983', danger: '#b4637a', success: '#56949f', warning: '#ea9d34' , hover: '#f4ede8', selected: '#dfdad9' },
  'tokyo-night-day':  { mode: 'light', src: 'folke/tokyonight.nvim day', bg: '#e1e2e7', side: '#d0d5e3', raised: 'lighter', text: '#3760bf', text2: '#68709a', muted: '#848cb5', hover: '#c4c8da', selected: '#b7c1e3', accent: '#2e7de9', danger: '#f52a65', success: '#587539', warning: '#8c6c3e' },
  'one-light':        { mode: 'light', src: 'Atom One Light syntax + One Light panels', bg: '#fafafa', side: '#eaeaeb', raised: '#ffffff', text: '#383a42', text2: '#696c77', muted: '#a0a1a7', accent: '#4078f2', danger: '#e45649', success: '#50a14f', warning: '#c18401' , hover: '#f0f0f1', selected: '#e5e5e6' },
  'alucard':          { mode: 'light', src: 'draculatheme.com/spec (Alucard Classic)', note: 'Dracula\'s official light variant. Sidebar is Background Lighter (#ece9df), hover Background Light (#dedccf), selected row the spec\'s Selection (#cfcfde); the card shade is computed.', bg: '#fffbeb', side: '#ece9df', raised: 'lighter', text: '#1f1f1f', text2: 'derived', muted: '#6c664b', accent: '#644ac9', danger: '#cb3a2a', success: '#14710a', warning: '#846e15', hover: '#dedccf', selected: '#cfcfde' },
  'nord-light':       { mode: 'light', src: 'nordtheme.com palette (Snow Storm and Polar Night), arranged by this project', note: 'Nord publishes no light variant of its own editor and terminal themes (its docs describe bright designs on Snow Storm backgrounds); this half is a Reskin adaptation, not an official Nord variant. The white card is a project choice. Page nord6, sidebar nord5, hover nord4, text nord0, secondary nord3, muted the brightened comment colour used by common ports; accent nord10, status colours Aurora, all nudged darker until they read.', bg: '#eceff4', side: '#e5e9f0', raised: '#ffffff', text: '#2e3440', text2: '#4c566a', muted: '#616e88', accent: '#5e81ac', danger: '#bf616a', success: '#a3be8c', warning: '#d08770', hover: '#d8dee9' },
  'ayu-light':        { mode: 'light', src: 'ayu-theme/vscode-ayu ayu-light.json (ayu-colors)', note: 'Hover is list.hoverBackground (#6b7d8f24) laid over the sidebar; the selected row is computed. The card is white (Ayu\'s widget shade #fafafa is almost the page).', bg: '#fcfcfc', side: '#f8f9fa', raised: '#ffffff', text: '#5c6166', text2: '#828e9f', muted: '#adaeb1', accent: '#f29718', danger: '#e65050', success: '#6cbf43', warning: '#f29718', hover: '#e4e7eb' },
  'light-owl':        { mode: 'light', src: 'sdras/night-owl-vscode-theme Night Owl-Light-color-theme.json', note: 'Light Owl\'s secondary text equals its main text, so secondary is derived. Danger is editorError.foreground (its errorForeground is plain text). Its added colour is teal, used as success. Card is white.', bg: '#fbfbfb', side: '#f0f0f0', raised: '#ffffff', text: '#403f53', text2: 'derived', muted: '#90a7b2', accent: '#2aa298', danger: '#e64d49', success: '#49d0c5', warning: '#daaa01', hover: '#d3e8f8', selected: '#e0e7ea' },
  'vs-light':         { mode: 'light', src: 'microsoft/vscode theme-defaults light_plus.json + light_vs.json (Light+)', note: 'Codex\'s light-plus. Muted is the input placeholder colour. The card is white, a project choice: VS Code\'s widget shade #f3f3f3 is the sidebar colour, and Claude\'s light cards are lighter than the page.', bg: '#ffffff', side: '#f3f3f3', raised: '#ffffff', text: '#000000', text2: '#717171', muted: '#767676', accent: '#006ab1', danger: '#a1260d', success: '#48985d', warning: '#bf8803', hover: '#e8e8e8', selected: '#e4e6f1' },
  'absolutely-light': { mode: 'light', src: 'adapted from colour values observed in the Absolutely theme of OpenAI\'s Codex app 26.1007.71326 (not affiliated)', note: 'Page, sidebar, text, muted and accent come from the Codex app\'s Absolutely theme; card white; status colours borrowed from classic-light; hover and selected computed.', bg: '#f9f9f7', side: '#f4f4f2', raised: '#ffffff', text: '#2d2d2b', text2: 'derived', muted: '#939391', accent: '#cc7d5e', danger: '#8e2626', success: '#006300', warning: '#734500' },
  'linea-light':      { mode: 'light', src: 'adapted from colour values observed in the Linear theme of OpenAI\'s Codex app 26.1007.71326 (not affiliated)', note: 'Page and text are the chromeTheme surface and ink (#fcfcfd, #1b1b1b); sidebar, secondary, muted and accent from its colours; danger and success its diff colours; warning borrowed from classic-light; card white; hover and selected computed.', bg: '#fcfcfd', side: '#f2f4f8', raised: '#ffffff', text: '#1b1b1b', text2: '#4a5263', muted: '#8a93a6', accent: '#5e6ad2', danger: '#c94446', success: '#52a450', warning: '#734500' },
  'verc-light':       { mode: 'light', src: 'adapted from colour values observed in the Vercel theme of OpenAI\'s Codex app 26.1007.71326 (not affiliated)', note: 'Page and sidebar pure white as in the Codex theme; danger and success its diff colours; warning borrowed from classic-light; hover and selected computed.', bg: '#ffffff', side: '#ffffff', raised: '#ffffff', text: '#171717', text2: '#666666', muted: '#666666', accent: '#006aff', danger: '#eb001d', success: '#28a948', warning: '#734500' },
  'classic-light':    { mode: 'light', src: 'Anthropic brand palette + legacy app light values', bg: '#faf9f5', side: '#f0eee6', raised: '#ffffff', text: '#141413', text2: '#3d3d3a', muted: '#898781', accent: '#6a9bcc', danger: '#8e2626', success: '#006300', warning: '#734500' },
}

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)) }
const lum = (h) => { const c = rgb(h).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
// Perceived colour difference (OKLab distance): 0 = identical; about 0.02 is a just-visible tint, 0.04 clearly visible.
const oklab = (h) => {
  const [r, g, b] = rgb(h).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const dE = (a, b) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]))
// OKLab/OKLCH back to sRGB hex; null when the colour is outside sRGB.
const fromOklab = ([L, A, B]) => {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  if (lin.some((v) => v < -1e-4 || v > 1 + 1e-4)) return null
  return hex(lin.map((v) => Math.min(1, Math.max(0, v))).map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255))
}
const lch = (h) => { const [L, A, B] = oklab(h); return { L, C: Math.hypot(A, B), H: Math.atan2(B, A) } }
// A colour from lightness, chroma and hue, lowering only the chroma until it fits in sRGB (so hue and lightness stay).
const fromLch = (L, C, H) => {
  for (let c = C; c >= 0; c -= 0.002) { const out = fromOklab([L, c * Math.cos(H), c * Math.sin(H)]); if (out) return out }
  return fromOklab([Math.min(1, Math.max(0, L)), 0, 0])
}
// Claude's own accent ramp (--cds-blue-<step>, read from the page on 12 Oct 2026, probes 6 and 7): the skin ramp keeps
// these lightness steps and Claude's chroma shape, with the skin's own hue and strength.
const CLAUDE_BLUE = { 50: '#e7f1fb', 100: '#cde2fb', 250: '#86b6ef', 300: '#6da7ec', 400: '#3987e5', 450: '#2a78d6', 600: '#184f95', 700: '#0d366b', 800: '#032042', 850: '#03162c' }
// Claude's accent roles per mode: which ramp step each semantic token uses (probes 6 and 7), and how much accent the
// skin blends into its own page for it. Blending into the skin's page (not copying Claude's fixed step) keeps the chip
// visible on pages lighter or darker than Claude's. Shares follow Claude's light values (chip #cde2fb is about 24% of
// #2a78d6 over its page, border #86b6ef about 60%, radio card #e7f1fb about 10%); dark shares are this project's picks.
const ROLE_STEPS = { light: { bgAccent: [100, 0.24], border: [250, 0.6], radio: [50, 0.1] }, dark: { bgAccent: [800, 0.22], border: [700, 0.45], radio: [850, 0.12] } }
// Bare HSL triple ("h s% l%"), the format of Claude's legacy --accent-100 (used by its keyboard-focus outline).
const bareHsl = (h) => {
  const [r, g, b] = rgb(h).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let hue = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  hue = (hue * 60 + 360) % 360
  return `${+hue.toFixed(3)} ${+(sat * 100).toFixed(4)}% ${+(l * 100).toFixed(4)}%`
}
const alpha = (h, a) => `rgba(${rgb(h).join(', ')}, ${a})`

// --muted-min <n> (trial only, needs --out): the contrast muted hints must reach. Shipped presets use 4.5 (chosen after a live comparison, 12 Oct 2026).
const MUTED_MIN = process.argv.includes('--muted-min') ? Number(process.argv[process.argv.indexOf('--muted-min') + 1]) : 4.5
if (!(MUTED_MIN >= 3 && MUTED_MIN <= 7)) throw new Error('--muted-min must be between 3 and 7')


// Resolves a palette into final colours, and records every derived or nudged value.
function resolve(name, p) {
  const notes = []
  const dark = (p.mode ?? 'dark') === 'dark'
  const bg = p.bg
  const side = p.side === 'computed' ? mix(bg, '#000000', 0.2) : p.side
  if (p.side === 'computed') notes.push(`sidebar ${side} computed (bg mixed 20% toward black; the scheme has no darker shade)`)
  const raised = p.raised === 'lighter' ? mix(bg, '#ffffff', 0.55) : p.raised
  if (p.raised === 'lighter') notes.push(`card shade ${raised} computed (bg mixed 55% toward white; the scheme has no lighter shade, and Claude's own light cards are lighter than the page)`)
  const text = p.text
  const pop = dark ? mix(raised, text, 0.06) : raised
  if (dark) notes.push(`pop-up shade ${pop} computed (card mixed 6% toward text)`)
  // Nudge a colour toward white (dark skins) or black (light skins), keeping its hue, until it reads on the page and on the card.
  // need = [[surface, minimum ratio], ...]
  const fit = (label, c, need) => {
    let t = 0, out = c
    while (t < 1 && need.some(([b, min]) => ratio(out, b) < min)) { t += 0.02; out = mix(c, dark ? '#ffffff' : '#000000', t) }
    if (need.some(([b, min]) => ratio(out, b) < min)) throw new Error(`${name}: ${label} cannot reach ${need.map(([, m]) => m).join(' / ')}:1`)
    if (out !== c) notes.push(`${label} ${c} nudged to ${out} to read on every surface (${need.map(([, m]) => m).join(' / ')}:1)`)
    return out
  }
  // Small text of every kind (body, secondary, link, status) must reach 4.5:1 on all four surfaces, muted hints too (MUTED_MIN).
  const body = (min) => [[bg, min], [raised, min], [side, min], [pop, min]]
  const status = body(4.5)
  let text2 = p.text2
  if (text2 === 'derived') { text2 = mix(text, bg, 0.25); notes.push(`secondary text ${text2} computed (text mixed 25% toward bg; the scheme has no matching token, or this project replaced it: see the note above)`) }
  const out = {
    mode: dark ? 'dark' : 'light', bg, side, raised, pop, text: fit('main text', text, body(4.5)),
    text2: fit('secondary text', text2, body(4.5)), muted: fit('muted text', p.muted, body(MUTED_MIN)),
    accent: fit('link colour', p.accent, body(4.5)), danger: fit('danger text', p.danger, status),
    success: fit('success text', p.success, status), warning: fit('warning text', p.warning, status),
    get border() { return alpha(this.text, 0.12) }, get user() { return alpha(this.text, 0.06) }, notes,
  }
  // Sidebar hover and selected-row backgrounds (--df-hover, --df-selected): the scheme's own highlight and selection
  // colours. Only the sidebar rows get them: elsewhere Claude's see-through hover overlays stay, since a solid colour
  // would vanish on cards that share it. A band too strong for
  // the text on it is mixed toward white (light skins) or black (dark skins), keeping its tint, but only while it
  // still stands out from the sidebar (perceived difference dE: at least 0.03 for hover, 0.055 for selected, and 0.02 between the two). If text still falls
  // short at that point, the text colours are darkened (light) or lightened (dark) to read 4.5:1 on the band too.
  const t = out
  const onRow = () => [[t.text, 4.5], [t.text2, 4.5], [t.muted, MUTED_MIN], [t.accent, 4.5]]
  const rowBg = (label, c, fallback, minVis) => {
    let base = c
    if (c === undefined) { base = fallback; notes.push(`${label} ${base} computed (${label === 'hover' ? 'text mixed 8% into the sidebar' : 'link colour mixed 22% into the sidebar'}; the scheme has no published token, or this project replaced it: see the note above)`) }
    if (dE(base, side) < minVis) {
      // Too faint against our sidebar: strengthen it toward the text colour, keeping its tint, until it shows.
      let j = 0, b2 = base
      while (j < 1 && dE(b2, side) < minVis) { j += 0.02; b2 = mix(base, t.text, j) }
      notes.push(`${label} ${base} strengthened to ${b2} so it stands out from the sidebar`)
      base = b2
    }
    let k = 0, res = base
    while (k < 1 && onRow().some(([x, min]) => ratio(x, res) < min)) {
      const next = mix(base, dark ? '#000000' : '#ffffff', k + 0.02)
      if (dE(next, side) < minVis) break
      k += 0.02; res = next
    }
    if (res !== base) notes.push(`${label} ${base} moved to ${res} so text reads better on it, while the band still stands out from the sidebar`)
    return res
  }
  t.hover = rowBg('hover', p.hover, mix(side, t.text, 0.08), 0.03)
  t.selected = rowBg('selected row', p.selected, mix(side, t.accent, 0.22), 0.055)
  if (dE(t.hover, t.selected) < 0.02) throw new Error(`${name}: hover ${t.hover} and selected ${t.selected} look too alike`)
  const rows = (min) => [...body(min), [t.hover, min], [t.selected, min]]
  t.text = fit('main text (on row bands)', t.text, rows(4.5))
  t.text2 = fit('secondary text (on row bands)', t.text2, rows(4.5))
  t.muted = fit('muted text (on row bands)', t.muted, rows(MUTED_MIN))
  t.accent = fit('link colour (on row bands)', t.accent, rows(4.5))
  // Status text and icons (the waiting hand, the error triangle) sit on sidebar rows too.
  t.danger = fit('danger text (on row bands)', t.danger, rows(4.5))
  t.warning = fit('warning text (on row bands)', t.warning, rows(4.5))
  t.success = fit('success text (on row bands)', t.success, rows(4.5))
  // Keep the order: secondary text must stay clearly stronger than muted hints (refits can bring them together).
  const k2 = (x) => ratio(x, side)
  if (k2(t.text2) < k2(t.muted) * 1.15) {
    const before = t.text2
    let j = 0
    while (j < 1 && k2(t.text2) < k2(t.muted) * 1.15) { j += 0.02; t.text2 = mix(before, dark ? '#ffffff' : '#000000', j) }
    if (k2(t.text2) < k2(t.muted) * 1.15) throw new Error(`${name}: secondary text cannot stay clearly stronger than muted hints`)
    notes.push(`secondary text ${before} strengthened to ${t.text2} to stay clearly stronger than muted hints`)
  }
  // And main text must stay at least as strong as secondary text.
  if (k2(t.text) < k2(t.text2)) {
    const before = t.text
    let j = 0
    while (j < 1 && k2(t.text) < k2(t.text2)) { j += 0.02; t.text = mix(before, dark ? '#ffffff' : '#000000', j) }
    if (k2(t.text) < k2(t.text2)) throw new Error(`${name}: main text cannot stay as strong as secondary text`)
    notes.push(`main text ${before} strengthened to ${t.text} to stay at least as strong as secondary text`)
  }
  accentPass(name, p, t, dark, notes)
  return t
}

// The interaction accent: Claude's blue becomes the skin's own accent, with the button text chosen together
// with the fill. One search over the fill's lightness: at each step the button text is re-picked (white, or the skin's
// darkest colour), and the smallest move that meets every rule wins. No move meets them all: the generator stops loudly.
function accentPass(name, p, t, dark, notes) {
  const darkInk = dark ? t.bg : t.text
  const surfaces = [t.bg, t.side, t.raised, t.pop, t.hover, t.selected] // focus rings and unread dots sit on all of these
  // White button text whenever it reads 4.5:1;
  // otherwise whichever reads better.
  const pickOn = (f) => (ratio('#ffffff', f) >= 4.5 || ratio('#ffffff', f) >= ratio(darkInk, f) ? '#ffffff' : darkInk)
  const ok = (f) => ratio(pickOn(f), f) >= 4.5 && surfaces.every((s) => ratio(f, s) >= 3)
  // At most 0.15 in OKLab lightness away from the start colour: beyond that it would no longer be the skin's colour.
  const search = (start) => {
    const base = lch(start)
    for (let d = 0; d <= 0.15 + 1e-9; d += 0.0025) {
      for (const sign of d === 0 ? [1] : [-1, 1]) {
        const f = fromLch(base.L + sign * d, base.C, base.H)
        if (ok(f)) return f
      }
    }
    return null
  }
  let fill = search(p.accent)
  // A published accent that cannot meet the rules at its own strength within that range (Ayu Light's bright orange):
  // the closest colour that does, same hue, lightness within 0.2 and strength (chroma) lowered at most by half.
  if (fill === null) {
    const base = lch(p.accent)
    let best = null
    for (let k = 1; k >= 0.5 - 1e-9; k -= 0.02) {
      for (let d = -0.2; d <= 0.2 + 1e-9; d += 0.0025) {
        const f = fromLch(base.L + d, base.C * k, base.H)
        if (ok(f) && (best === null || dE(f, p.accent) < dE(best, p.accent))) best = f
      }
    }
    fill = best
    if (fill !== null) notes.push(`accent fill: the published accent ${p.accent} cannot carry 4.5:1 button text and show 3:1 on every surface at its own strength, so the closest colour that does (same hue, lower strength) is used`)
  }
  if (fill === null) throw new Error(`${name}: no accent fill near ${p.accent} (lightness within 0.15 at full strength, or within 0.2 at down to half strength) reaches 4.5:1 button text and 3:1 against every surface`)
  if (fill !== p.accent) notes.push(`accent fill ${p.accent} moved to ${fill} (perceived difference ${dE(fill, p.accent).toFixed(3)}) so button text reads 4.5:1 and it shows 3:1 on every surface`)
  const on = pickOn(fill)
  // Hover: away from the button text (more contrast), and still clearly different from the fill.
  const fl = lch(fill), away = on === '#ffffff' ? -1 : 1
  let hover = null
  for (const dir of [away, -away]) {
    for (let d = 0.06; d <= 0.2 && hover === null; d += 0.01) {
      const h = fromLch(fl.L + dir * d, fl.C, fl.H)
      if (ratio(on, h) >= 4.5 && dE(h, fill) >= 0.03) hover = h
    }
    if (hover !== null) break
  }
  if (hover === null) throw new Error(`${name}: no accent hover keeps button text at 4.5:1`)
  // The ramp: Claude's lightness at every step, the fill's hue, chroma scaled by Claude's own chroma shape. 450 is the fill.
  const c450 = lch(CLAUDE_BLUE[450]).C
  const ramp = {}
  for (const [step, h] of Object.entries(CLAUDE_BLUE)) {
    const cb = lch(h)
    ramp[step] = fromLch(cb.L, fl.C * (cb.C / c450), fl.H)
  }
  ramp[450] = fill
  // Claude uses role 400 only for the fill hover (probe 8: its one user is --cds-role-accent-fill-hover). In light skins the
  // hover is darker than the fill, so 400 runs darker than 450 there: intended, the hover goes away from the button text.
  ramp[400] = hover
  const roles = ROLE_STEPS[dark ? 'dark' : 'light']
  const share = ([, k]) => mix(t.bg, fill, k)
  // Accent background (selected chips): readable for links and main text, and visible against the page.
  let bgAccent = share(roles.bgAccent)
  const readsOn = (b) => ratio(t.accent, b) >= 4.5 && ratio(t.text, b) >= 4.5
  if (!readsOn(bgAccent)) {
    let k = 0, b2 = bgAccent
    while (k < 1 && !readsOn(b2)) { k += 0.02; b2 = mix(bgAccent, t.bg, k) }
    if (!readsOn(b2) || dE(b2, t.bg) < 0.03) throw new Error(`${name}: accent background cannot read 4.5:1 and still show`)
    notes.push(`accent background ${bgAccent} moved to ${b2} so link and main text read 4.5:1 on it`)
    bgAccent = b2
  }
  if (dE(bgAccent, t.bg) < 0.03) throw new Error(`${name}: accent background does not show against the page`)
  const border = share(roles.border)
  if (dE(border, t.bg) < 0.03) throw new Error(`${name}: accent border does not show against the page`)
  const radio = share(roles.radio)
  // The role steps the semantic tokens come from carry the same values, so roles and semantics never disagree.
  ramp[roles.bgAccent[0]] = bgAccent; ramp[roles.border[0]] = border; ramp[roles.radio[0]] = radio
  t.acc = { fill, on, hover, ramp, bgAccent, border, radio, muted: alpha(fill, 0.1), hsl: bareHsl(fill) }
  notes.push(`accent: fill ${fill}, button text ${on}, hover ${hover}, chip ${bgAccent}, border ${border} (ramp from Claude's lightness steps with this hue)`)
}

function css(c) {
  const i = ' !important'
  return `@media (prefers-color-scheme: ${c.mode}) {
  *, *::before, *::after {
    --cds-surface-0:${c.side}${i}; --cds-surface-1:${c.bg}${i}; --cds-surface-2:${c.raised}${i}; --cds-surface-3:${c.pop}${i};
    --cds-neutral-30:${c.side}${i};
    --cds-text-primary:${c.text}${i}; --cds-text-secondary:${c.text2}${i}; --cds-text-muted:${c.muted}${i}; --cds-text-accent:${c.accent}${i};
    --cds-text-danger:${c.danger}${i}; --cds-text-success:${c.success}${i}; --cds-text-warning:${c.warning}${i};
    --cds-border:${c.border}${i}; --cds-bg-user-message:${c.user}${i};
    ${Object.entries(c.acc.ramp).map(([k, v]) => `--cds-role-accent-${k}:${v}${i};`).join(' ')}
    --cds-role-accent-fill:${c.acc.fill}${i}; --cds-role-accent-fill-hover:${c.acc.hover}${i}; --cds-role-accent-on:${c.acc.on}${i};
    --cds-fill-accent:${c.acc.fill}${i}; --cds-fill-accent-hover:${c.acc.hover}${i}; --cds-on-accent:${c.acc.on}${i};
    --cds-bg-accent:${c.acc.bgAccent}${i}; --cds-bg-accent-chip:${c.acc.bgAccent}${i}; --cds-border-accent:${c.acc.border}${i};
    --cds-radio-group-card-selected:${c.acc.radio}${i}; --cds-bg-accent-muted:${c.acc.muted}${i}; --accent-100:${c.acc.hsl}${i};
  }
  .dframe-sidebar, .dframe-sidebar * { --df-hover:${c.hover}${i}; --df-selected:${c.selected}${i}; }
  .status-dot, [data-cds=Pulse] { --cds-fill-accent:${c.dots.unread}${i}; --cds-fill-warning:${c.dots.waiting}${i}; --cds-fill-danger:${c.dots.error}${i}; --cds-text-muted:${c.dots.running}${i}; }
  html, body, .dframe-content { background-color:${c.bg}${i}; }
  .dframe-sidebar, .dframe-sidebar-body { background-color:${c.side}${i}; }
  .bg-surface-1, .bg-bg-100 { background-color:${c.bg}${i}; }
  .bg-surface-2 { background-color:${c.raised}${i}; }
  .bg-surface-3, .bg-bg-000 { background-color:${c.pop}${i}; }
  .bg-bg-200, .bg-bg-300 { background-color:${c.side}${i}; }
  .text-primary, .text-text-100 { color:${c.text}${i}; }
  .text-secondary, .text-text-300 { color:${c.text2}${i}; }
  .text-text-400, .text-text-500 { color:${c.muted}${i}; }
}
`
}

// The 16 skins: one name each, [dark half, light half]. Nothing else is written to presets/.
const FAMILIES = {
  classic: ['classic-dark', 'classic-light'],
  catppuccin: ['catppuccin-mocha', 'catppuccin-latte'],
  dracula: ['dracula', 'alucard'],
  github: ['github-dark', 'github-light'],
  gruvbox: ['gruvbox-dark', 'gruvbox-light'],
  nord: ['nord', 'nord-light'],
  one: ['one-dark', 'one-light'],
  'rose-pine': ['rose-pine', 'rose-pine-dawn'],
  solarized: ['solarized-dark', 'solarized-light'],
  'tokyo-night': ['tokyo-night', 'tokyo-night-day'],
  ayu: ['ayu-dark', 'ayu-light'],
  'night-owl': ['night-owl', 'light-owl'],
  vs: ['vs-dark', 'vs-light'],
  absolutely: ['absolutely-dark', 'absolutely-light'],
  linea: ['linea-dark', 'linea-light'],
  verc: ['verc-dark', 'verc-light'],
}
for (const [family, [d, l]] of Object.entries(FAMILIES)) {
  if (!PALETTES[d] || !PALETTES[l]) throw new Error(`skin ${family}: missing palette ${!PALETTES[d] ? d : l}`)
  if ((PALETTES[d].mode ?? 'dark') !== 'dark' || PALETTES[l].mode !== 'light') throw new Error(`skin ${family}: needs one dark and one light palette`)
}
const unused = Object.keys(PALETTES).filter((n) => !Object.values(FAMILIES).flat().includes(n))
if (unused.length) throw new Error(`palettes in no skin: ${unused.join(', ')}`)

// ---- Session status dots: the SAME dot colours in every skin, one set per mode, so a dot
// means one thing everywhere (blue unread, amber waiting, red error, grey running). The running dot used to be each skin's
// muted grey; a fixed neutral grey keeps it apart from the darkened waiting dot (Gruvbox Light's brown muted came within
// 0.1 of it), which matters most with Reduce motion on, when the running dot stops blinking. Each starts from Claude's own colour and moves only as far as needed (darker in light mode,
// lighter in dark mode) until it reads DOT_MIN on every sidebar, hover and selected row of every skin in that mode; the
// colour dots are held at a strength of at least 0.2 (lowered only to fit the screen), the running dot is neutral, and the
// waiting dot's hue may turn toward orange (see computeDots). Unread no longer follows the skin's accent (Claude's --cds-fill-accent is set back to the fixed blue on
// .status-dot only, so buttons and focus rings keep the skin's own accent).
const DOT_GAP = 0.12 // the smallest OKLab distance wanted between any two dots (0.1 is the hard floor)
const DOT_MIN = 3.4 // WCAG 1.4.11 asks 3:1 for small marks; 3.4 leaves margin for anti-aliasing on a 6 px dot
const CLAUDE_DOTS = { unread: '#2a78d6', waiting: '#fab219', error: '#d03b3b', running: '#898781' }
function computeDots(halves, mode) {
  const rowsOf = halves.filter((c) => c.mode === mode).flatMap((c) => [c.side, c.hover, c.selected])
  const passes = (c) => rowsOf.every((s) => ratio(c, s) >= DOT_MIN)
  // Claude's hue (the running grey made fully neutral; colour dots at chroma 0.2 or more, lowered only to fit the screen);
  // the lightness moves away from the rows in small steps. Claude's own colour is kept when it already passes. `turn`
  // rotates the hue (radians, toward orange).
  const shade = (role, turn = 0) => {
    const base = CLAUDE_DOTS[role]
    if (turn === 0 && role !== 'running' && passes(base)) return base
    const b = lch(base)
    const C = role === 'running' ? 0 : Math.max(b.C, 0.2)
    for (let d = 0; d <= 0.6 + 1e-9; d += 0.005) {
      const c = fromLch(b.L + (mode === 'dark' ? d : -d), C, b.H - turn)
      if (passes(c)) return c
    }
    throw new Error(`${mode} ${role} dot: no shade of ${base} reaches ${DOT_MIN}:1 on every row`)
  }
  const dots = { unread: shade('unread'), waiting: shade('waiting'), error: shade('error'), running: shade('running') }
  const gap = (d) => { let g = Infinity; const v = Object.values(d); for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) g = Math.min(g, dE(v[i], v[j])); return g }
  // In light mode the waiting dot must go dark (an ochre), close to the grey: if any two dots sit closer than DOT_GAP,
  // turn the waiting dot toward orange as far as it helps (at most 0.6 rad), keeping the turn that leaves the widest gap.
  if (gap(dots) < DOT_GAP) {
    let best = dots
    for (let t = 0.05; t <= 0.6 + 1e-9; t += 0.05) { const d = { ...dots, waiting: shade('waiting', t) }; if (gap(d) > gap(best)) best = d }
    Object.assign(dots, best)
  }
  if (gap(dots) < 0.1) throw new Error(`${mode} dots: two of them look too alike (closest ${gap(dots).toFixed(3)})`)
  return dots
}

// Quick early refusals; the full skin.mjs check-css also runs on every written file below.
function check(name, s) {
  if (/["'\\]/.test(s)) throw new Error(`${name}: quotes or backslashes`)
  if (s.includes('/*') || s.includes('*/')) throw new Error(`${name}: comment`)
  if (/url|@import|image-set|image\s*\(|src\s*\(|\/\/|@font-face|@namespace|expression\s*\(/i.test(s)) throw new Error(`${name}: loads something`)
  if (!/^@media\s*\(\s*prefers-color-scheme\s*:\s*(?:dark|light)\s*\)\s*\{/i.test(s)) throw new Error(`${name}: must start with a colour-scheme block`)
  for (const k of ['bg', 'side', 'raised', 'text', 'text2', 'muted', 'accent', 'danger', 'success', 'warning']) {
    if (!['lighter', 'derived', 'computed'].includes(PALETTES[name][k]) && !/^#[0-9a-f]{6}$/.test(PALETTES[name][k])) throw new Error(`${name}: bad or missing value for ${k}`)
  }
  for (const k of ['hover', 'selected']) {
    if (PALETTES[name][k] !== undefined && !/^#[0-9a-f]{6}$/.test(PALETTES[name][k])) throw new Error(`${name}: bad value for ${k}`)
  }
}

const OUT = process.argv.includes('--out') ? path.resolve(process.argv[process.argv.indexOf('--out') + 1]) : path.dirname(fileURLToPath(import.meta.url))
if (process.argv.includes('--out') && !/^[^-]/.test(process.argv[process.argv.indexOf('--out') + 1] ?? '')) throw new Error('--out needs a folder name')
if (MUTED_MIN !== 4.5 && OUT === path.dirname(fileURLToPath(import.meta.url))) throw new Error('--muted-min is for trial sets only; pass --out <another folder>')
if (MUTED_MIN > 4.5) console.log(`NOTE: muted hints at ${MUTED_MIN}:1 are stronger than secondary text (4.5:1); trial only`)
const dir = path.join(OUT, 'presets')
mkdirSync(dir, { recursive: true })
const resolved = {}
for (const [name, p] of Object.entries(PALETTES)) {
  resolved[name] = resolve(name, p)
  resolved[name].name = name
}
const DOTS = { dark: computeDots(Object.values(resolved), 'dark'), light: computeDots(Object.values(resolved), 'light') }
for (const c of Object.values(resolved)) c.dots = DOTS[c.mode]
for (const mode of ['dark', 'light']) console.log(`dots (${mode}): unread ${DOTS[mode].unread}, waiting ${DOTS[mode].waiting}, error ${DOTS[mode].error}, running ${DOTS[mode].running}`)
for (const [family, [d, l]] of Object.entries(FAMILIES)) {
  const s = css(resolved[d]) + css(resolved[l])
  check(d, s)
  check(l, s)
  writeFileSync(path.join(dir, `${family}.css`), s)
  console.log(`presets/${family}.css  ${d} + ${l}`)
}

// Run skin.mjs's own stylesheet check on every written file, so the generator can never ship one the tool refuses.
import { spawnSync } from 'node:child_process'
for (const f of Object.keys(FAMILIES)) {
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'skin.mjs'), 'check-css', path.join(dir, `${f}.css`)], { encoding: 'utf8', timeout: 10_000 })
  if (r.status !== 0) throw new Error(`${f}: refused by skin.mjs check-css: ${(r.stdout + r.stderr).trim()}`)
}

// Only now, with the new files written and accepted: the files this generator wrote before 17 Oct 2026 (per-half and
// -auto presets) are removed by name. Any other unknown file is left alone and reported (never delete
// what the generator did not make; the tests refuse a presets/ folder that is not exactly the 16 skins).
const OBSOLETE = ['catppuccin-auto', 'catppuccin-latte', 'catppuccin-mocha', 'classic-auto', 'classic-dark', 'classic-light', 'github-auto',
  'github-dark', 'github-light', 'gruvbox-auto', 'gruvbox-dark', 'gruvbox-light', 'one-auto', 'one-dark', 'one-light', 'rose-pine-auto',
  'rose-pine-dawn', 'solarized-light', 'tokyo-night-auto', 'tokyo-night-day', 'warm-dark']
for (const f of readdirSync(dir).filter((x) => x.endsWith('.css'))) {
  const n = f.slice(0, -4)
  if (Object.hasOwn(FAMILIES, n) || n.startsWith('dotcheck-')) continue
  if (OBSOLETE.includes(n)) { unlinkSync(path.join(dir, f)); console.log(`removed presets/${f} (an earlier generated name)`) }
  else console.log(`WARNING: presets/${f} is not one of the 16 skins and was not made by this generator; left in place`)
}

// ---- ATTRIBUTION.md: sources, licences and every derived value ----
const LICENCES = `# Attribution

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

Each skin is one file, \`presets/<skin>.css\`, holding a dark half and a light half (below). Claude shows whichever half
matches its own Settings > Appearance.

${Object.entries(FAMILIES).map(([f, [d, l]]) => `- ${f}: ${d} (dark) + ${l} (light)`).join('\n')}

## Session status dots

The same dot colours in every skin, one set per mode, so a dot means the same thing everywhere. Each starts
from Claude's own colour and changes only until it reads ${DOT_MIN}:1 on every sidebar, hover and selected row of every
skin in that mode, and stays clearly apart from the other three. What changes, exactly: the lightness moves away from
the rows; the three colour dots keep Claude's hue at a strength (OKLCH chroma) of at least 0.2, lowered only where the
screen cannot show it; the running dot is made a neutral grey; and where two dots would sit closer than OKLab 0.12, the
waiting dot's hue turns toward orange as far as it helps (in light mode about 20 degrees).

${['dark', 'light'].map((m) => `- ${m}: unread ${DOTS[m].unread}, waiting ${DOTS[m].waiting}, error ${DOTS[m].error}, running ${DOTS[m].running} (Claude's own: unread ${CLAUDE_DOTS.unread}, waiting ${CLAUDE_DOTS.waiting}, error ${CLAUDE_DOTS.error}, running ${CLAUDE_DOTS.running})`).join('\n')}

## Values that are derived, not copied

Where a scheme has no suitable shade, or a colour would be hard to read, the generator computes one. Every such value is listed.
`
let report = LICENCES
for (const [name, c] of Object.entries(resolved)) {
  report += `\n### ${name} (${c.mode}) - ${PALETTES[name].src}\n\n`
  report += `page ${c.bg}, sidebar ${c.side}, card ${c.raised}, text ${c.text}, secondary ${c.text2}, muted ${c.muted}, link ${c.accent}, hover ${c.hover}, selected row ${c.selected}\n`
  report += `accent fill ${c.acc.fill}, button text ${c.acc.on}, accent hover ${c.acc.hover}, accent chip ${c.acc.bgAccent}\n`
  if (PALETTES[name].note) report += `\nNote: ${PALETTES[name].note}\n`
  for (const n of c.notes) report += `\n- ${n}`
  report += '\n'
}
writeFileSync(path.join(OUT, 'ATTRIBUTION.md'), report)
console.log('ATTRIBUTION.md')

// ---- Raycast Script Command (one command with a skin dropdown) ----
// In Raycast: Settings > Extensions > Script Commands > Add Script Directory > pick the raycast folder.
import { chmodSync } from 'node:fs'
const rdir = path.join(OUT, 'raycast')
mkdirSync(rdir, { recursive: true })
const pretty = (n) => n.split('-').map((w) => ({ github: 'GitHub' })[w] ?? w[0].toUpperCase() + w.slice(1)).join(' ')
const TITLES = { one: 'One', vs: 'VS', 'rose-pine': 'Rose Pine', 'night-owl': 'Night Owl', 'tokyo-night': 'Tokyo Night' }
const opts = [{ title: 'Remove skin', value: 'off' }, ...Object.keys(FAMILIES).map((f) => ({ title: TITLES[f] ?? pretty(f), value: f }))]

const script = `#!/bin/bash
# Generated by make-presets.mjs. Recolours the whole Claude app. Switches through the colour helper when one is running;
# otherwise, where the release has one-click, it ticks the menu itself (needs Accessibility for Raycast; quit your own
# Chrome first). Where it does not (a release.json without "oneClick": true), it asks you to run /skin in Claude once.
# @raycast.schemaVersion 1
# @raycast.title Reskin
# @raycast.mode silent
# @raycast.packageName Reskin
# @raycast.icon 🎨
# @raycast.argument1 { "type": "dropdown", "placeholder": "Skin", "data": ${JSON.stringify(opts)} }

TOOL="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node 2>/dev/null)"
[ -x "$NODE" ] || NODE=/opt/homebrew/bin/node
[ -x "$NODE" ] || NODE=/usr/local/bin/node
[ -x "$NODE" ] || { echo "Node 22 or newer is needed"; exit 1; }
NAME="$1"
case "$NAME" in *[!a-z0-9-]*|"") echo "Bad skin name"; exit 1;; esac
[ "$NAME" = "off" ] || [ -f "$TOOL/presets/$NAME.css" ] || { echo "No such skin: $NAME"; exit 1; }
# Ask the colour helper first (no debugger). Only when no helper is running does the run tick the menu
# itself (one-click). An unconfirmed switch is reported, never followed by a tick.
if [ "$NAME" = "off" ]; then SW=remove; else SW="$NAME"; fi
OUT=$("$NODE" "$TOOL/skin-auto.mjs" switch "$SW" 2>&1); CODE=$?
if printf '%s\\n' "$OUT" | grep -q '^No colour helper is running'; then
  if [ -e "$TOOL/release.json" ] && ! /usr/bin/grep -Eq '"oneClick"[[:space:]]*:[[:space:]]*true' "$TOOL/release.json" 2>/dev/null; then
    echo "No colour helper yet: run /skin $NAME in Claude once (one tick); after that Raycast switches with no tick"; exit 1
  fi
  OUT=$("$NODE" "$TOOL/skin-auto.mjs" one-click "$SW" 2>&1); CODE=$?
fi
# Raycast shows only the last line, so put the most important thing last: a warning, else the note, else the result.
WARN=$(printf '%s\\n' "$OUT" | grep 'WARNING:' | grep -i 'port 9229' | tail -1)
[ -n "$WARN" ] || WARN=$(printf '%s\\n' "$OUT" | grep 'WARNING:' | tail -1)
if [ $CODE -eq 0 ]; then
  NOTE=$(printf '%s\\n' "$OUT" | grep '^NOTE:' | head -1)
  echo "\${WARN:-\${NOTE:-Skin $NAME done}}"
else
  REASON=$(printf '%s\\n' "$OUT" | grep -v -e '^RESULT:' -e '^PORT_STATE:' -e '^\\[' -e '^[{}"]' -e 'WARNING:' | tail -1)
  echo "Failed (exit $CODE): \${WARN:-\${REASON:-see terminal}}"
  exit 1
fi
`
writeFileSync(path.join(rdir, 'reskin.sh'), script)
chmodSync(path.join(rdir, 'reskin.sh'), 0o755)
console.log('raycast/reskin.sh')

// ---- One fixed Raycast command (one hotkey): Tokyo Night. Older fixed commands for removed names are deleted. ----
for (const old of ['reskin-tokyo-night-dark.sh', 'reskin-tokyo-night-light.sh', 'reskin-tokyo-night-auto.sh']) { try { unlinkSync(path.join(rdir, old)); console.log(`removed raycast/${old}`) } catch {} }
function fixedCommand(file, title, skin) {
  const body = script
    .replace(/# @raycast\.title .*/, `# @raycast.title ${title}`)
    .replace(/# @raycast\.argument1 .*\n/, '')
    .replace('NAME="$1"', `NAME="${skin}"`)
  writeFileSync(path.join(rdir, file), body)
  chmodSync(path.join(rdir, file), 0o755)
  console.log(`raycast/${file}`)
}
fixedCommand('reskin-tokyo-night.sh', 'Reskin: Tokyo Night', 'tokyo-night')
