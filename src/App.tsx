import { useEffect, useState } from 'react'
import NeuralOrb from './components/NeuralOrb'
import { useOrchestratorStatus } from './hooks/useOrchestratorStatus'
import { STRINGS } from './i18n/strings'

export default function App() {
  const { status: orbState, connected } = useOrchestratorStatus()

  const [time, setTime] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t) }, [])

  const hh = time.getHours().toString().padStart(2, '0')
  const mm = time.getMinutes().toString().padStart(2, '0')

  return (
    <div className="app">
      <NeuralOrb state={orbState} />

      <div className="hud">
        <div className="hud-top">
          <div className="hud-title-block">
            <span className="hud-title">{STRINGS.appTitle}</span>
            <button
              className="hud-refresh"
              onClick={() => window.location.reload()}
            >↺</button>
          </div>
          <span className="hud-clock">{hh}:{mm}</span>
        </div>

        <div className="hud-center" />

        <div className="hud-bottom">
          {!connected
            ? <span className="hud-hint">{STRINGS.hud.connecting}</span>
            : orbState === 'idle'
              ? <span className="hud-hint">{STRINGS.hud.wakeWordHint}</span>
              : <span className={`hud-state ${orbState}`}>{STRINGS.orbState[orbState]}</span>
          }
        </div>
      </div>
    </div>
  )
}
