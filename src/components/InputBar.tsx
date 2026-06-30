import { useRef, useState, type KeyboardEvent } from 'react'
import { STRINGS } from '../i18n/strings'

interface Props {
  onSend: (text: string) => void
  onCancel: () => void
  isListening: boolean
  isSpeaking: boolean
  onVoiceStart: () => void
  onVoiceStop: () => void
  isVoiceSupported: boolean
  interimText: string
  disabled: boolean
}

export default function InputBar({
  onSend, onCancel,
  isListening, isSpeaking,
  onVoiceStart, onVoiceStop,
  isVoiceSupported, interimText,
  disabled,
}: Props) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSend = () => {
    if (!text.trim() || disabled) return
    onSend(text)
    setText('')
    inputRef.current?.focus()
  }

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const handleVoiceClick = () => {
    if (isListening) onVoiceStop()
    else onVoiceStart()
  }

  const displayValue = isListening && interimText ? interimText : text

  return (
    <div className="input-bar">
      {isVoiceSupported && (
        <button
          className={`voice-btn${isListening ? ' listening' : ''}${isSpeaking ? ' speaking' : ''}`}
          onClick={handleVoiceClick}
          disabled={disabled && !isListening}
          aria-label={isListening ? STRINGS.inputBar.voiceStopLabel : STRINGS.inputBar.voiceStartLabel}
          title={isListening ? STRINGS.inputBar.voiceStopTitle : STRINGS.inputBar.voiceStartTitle}
        >
          {isListening ? '◉' : isSpeaking ? '◈' : '🎤'}
        </button>
      )}

      <div className="text-input-wrapper">
        <input
          ref={inputRef}
          className={`text-input${isListening ? ' listening-input' : ''}`}
          type="text"
          value={displayValue}
          onChange={e => { if (!isListening) setText(e.target.value) }}
          onKeyDown={handleKey}
          placeholder={
            isListening ? STRINGS.inputBar.placeholderListening :
            isSpeaking  ? STRINGS.inputBar.placeholderSpeaking :
            disabled    ? STRINGS.inputBar.placeholderThinking :
                          STRINGS.inputBar.placeholderIdle
          }
          disabled={isListening}
          readOnly={isListening}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {disabled && !isListening ? (
        <button className="send-btn cancel" onClick={onCancel}>{STRINGS.inputBar.stop}</button>
      ) : (
        <button
          className="send-btn"
          onClick={handleSend}
          disabled={disabled || !text.trim() || isListening}
        >
          {STRINGS.inputBar.send}
        </button>
      )}
    </div>
  )
}
