// Centralized user-facing strings.
//
// Every piece of text rendered in the UI lives here so it can be translated
// or swapped for a full i18n library later without touching components.
// Components must never hardcode visible text — import from STRINGS instead.

export const STRINGS = {
  appTitle: 'HERMES',

  // NeuralOrb / HUD overlay states — mirrors the orchestrator's status WS.
  orbState: {
    idle: '',
    listening: 'LISTENING',
    thinking: 'THINKING',
    talking: 'TALKING',
  },

  hud: {
    connecting: 'CONNECTING...',
    wakeWordHint: "DECÍ 'CHE PARCHE'",
  },
} as const
