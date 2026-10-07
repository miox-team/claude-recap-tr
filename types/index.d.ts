export type RecapMode = 'on' | 'mute' | 'off'
export type ModeChoice = { mode: RecapMode; at: number }
export type NarrationPhase = 'summarizing' | 'speaking' | 'done' | 'busy' | 'noVoice'
export type Narration = { text: string; phase: NarrationPhase }

declare module 'claude-code' {
  interface PluginState {
    recap: { narration: Narration | null; choiceHere: ModeChoice | null }
  }
}
