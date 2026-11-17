export type ModeName = 'light' | 'dark'
/** One mode's three colours, each six-digit hex. */
export type Three = { bg: string; fg: string; accent: string }
/** Your own colours: three per mode, the skin they started from, and whether to force a mode. */
export type Custom = { base: string; light: Three; dark: Three; scheme: 'system' | ModeName }
/** The line under the band's fields: good news, a refusal, or a hint. */
export type Note = { tone: 'ok' | 'bad' | 'info'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'reskin-light': { draft: Shaped<Custom>; note: Note | null; bandOpen: boolean; editing: ModeName }
  }
}
