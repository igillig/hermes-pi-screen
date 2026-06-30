// Centralized user-facing strings.
//
// Every piece of text rendered in the UI lives here so it can be translated
// or swapped for a full i18n library later without touching components.
// Components must never hardcode visible text — import from STRINGS instead.

export const STRINGS = {
  appTitle: 'HERMES',

  // NeuralOrb / HUD overlay states.
  orbState: {
    idle: '',
    listening: 'LISTENING',
    thinking: 'THINKING',
    speaking: 'SPEAKING',
  },

  hud: {
    tapToSpeak: 'TAP TO SPEAK',
  },

  inputBar: {
    voiceStartLabel: 'Speak',
    voiceStopLabel: 'Stop',
    voiceStartTitle: 'Tap to speak',
    voiceStopTitle: 'Tap to stop',
    placeholderListening: 'Listening...',
    placeholderSpeaking: 'Hermes is speaking...',
    placeholderThinking: 'Generating response...',
    placeholderIdle: 'Type or use the microphone...',
    send: 'SEND',
    stop: 'STOP',
  },

  message: {
    user: 'USER',
    hermes: 'HERMES',
  },

  messageList: {
    emptyTitle: 'SYSTEM READY',
    emptySubtitle: 'Type or speak to begin',
    processingLabel: 'Hermes is processing',
  },

  status: {
    online: 'ONLINE',
    error: 'ERROR',
    listening: 'LISTENING',
    processing: 'PROCESSING',
    responding: 'RESPONDING',
  },
} as const

// Speech recognition / synthesis locale (BCP-47).
// This drives the spoken-language behavior, not the UI text — change it to
// match the language the user actually speaks to Hermes.
export const VOICE_LOCALE = 'es-AR'
