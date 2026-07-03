# parche-ui

**HERMES** frontend: a holographic neural-orb display (React + Three.js) that
shows the assistant's current state (listening / thinking / talking).

The UI is a **pure status display** — it owns no microphone, speaker, or chat
logic. All of that (wake word, mic capture + VAD, OpenAI Whisper STT, streaming
Hermes chat, sentence-buffered OpenAI TTS, and speaker playback) lives in
[`orchestrator/main.py`](orchestrator/main.py), which runs as its own container
(`orchestrator` service in `stack.yml`) with `/dev/snd` passed through for real
mic/speaker access. The orchestrator pushes
`{"status": "idle" | "listening" | "thinking" | "talking"}` over a small
WebSocket server; the browser reaches it same-origin at `/ws-status`, which
nginx reverse-proxies to `orchestrator:8765` over the internal docker network
(no separate host/port to configure — see `nginx.conf`).
`docker compose -f stack.yml up -d` (or a push to `main`, see below) brings up
both containers together.

Built with **Vite + React + TypeScript** and served in production by **nginx**
inside a Docker container, designed to run on a Raspberry Pi via Portainer.

---

## Tech stack

- **React 18** + **TypeScript**
- **Vite 5** (dev server and build)
- **Three.js** — holographic background / neural orb
- **nginx alpine** — static server in production
- **Docker** multi-stage build

## Project structure

```
src/
├── App.tsx                       # Main composition
├── i18n/strings.ts               # All user-facing strings (single source for translation)
├── components/                   # Background, neural orb
└── hooks/
    └── useOrchestratorStatus.ts  # WebSocket listener for the Python orchestrator's status
orchestrator/
├── main.py                       # Voice orchestrator: wake word → VAD → Whisper → Hermes → TTS → speakers
├── Dockerfile                    # PortAudio/ALSA + Python deps
├── asound.conf                   # Pins ALSA "default" to the right mic/speaker hardware (card index is Pi-specific!)
├── requirements.txt
└── models/                       # Drop trained wake-word .onnx files here (bind-mounted, gitignored)
Dockerfile                        # Multi-stage build (node → nginx), UI
nginx.conf                        # nginx template: SPA + static caching + /api reverse proxy
stack.yml                         # Portainer / docker-compose stack — both parche-ui and orchestrator
```

### Architecture / API access

In production, nginx does double duty: it serves the static bundle **and**
reverse-proxies `/api/*` to the Hermes container over the shared docker network
`hermes-agent_default` (where Hermes runs as `hermes_agent:8000`).

This means:

- The browser only ever calls **same-origin** `/api/...`, so no Hermes IP is
  baked into the bundle (change the IP freely, no rebuild needed).
- The API key is injected into the `Authorization` header **by nginx at runtime**
  (via `envsubst`, env `HERMES_API_KEY`), so it never ships to the client.

In local development (`npm run dev`) there is no proxy, so you point straight at
Hermes.

### Internationalization

All visible text lives in `src/i18n/strings.ts`. Components never hardcode
user-facing strings — they import from `STRINGS`. To translate the UI, swap the
values there (or wire in a full i18n library later).

---

## Environment variables

> ⚠️ `VITE_*` variables are **inlined by Vite at build time** (not read at
> runtime). Everything else is plain **runtime** env, read by `docker compose`
> from the root `.env` and passed into whichever container declares it.

| Variable                   | Scope      | Container      | Required | Description                                                                 |
| -------------------------- | ---------- | -------------- | -------- | ---------------------------------------------------------------------------- |
| `HERMES_API_KEY`           | runtime    | both           | Yes      | UI: injected by nginx into `Authorization`. Orchestrator: used to call Hermes directly. Never shipped to the browser. |
| `OPENAI_API_KEY`           | runtime    | orchestrator   | Yes      | Whisper STT (TTS moved to ElevenLabs — see below).                          |
| `ELEVEN_LABS_API_KEY`      | runtime    | orchestrator   | Yes      | TTS. Being tried in place of OpenAI's for better native Latin American Spanish voices. |
| `ELEVENLABS_VOICE_ID`      | runtime    | orchestrator   | No       | Default: `wfTWLJ20rcMqvU8gIiAB`.                                            |
| `ELEVENLABS_MODEL_ID`      | runtime    | orchestrator   | No       | Default: `eleven_flash_v2_5` (low-latency model).                           |
| `TTS_SAMPLE_RATE`          | runtime    | orchestrator   | No       | Default: `24000`. Must match an ElevenLabs `pcm_*` output format.           |
| `HOST_PORT`                | runtime    | parche-ui      | No       | Host port the UI is published on. Default: `8080`.                          |
| `VITE_HERMES_API_URL`      | build-time | parche-ui      | No       | API base URL baked into the bundle. Default: `/api` (same-origin proxy).    |
| `VITE_ORCHESTRATOR_WS_URL` | build-time | parche-ui      | No       | Status WebSocket URL. Default: same-origin `/ws-status`, proxied by nginx to `orchestrator:8765` internally — normally never set. |
| `WAKE_WORD_ENABLED`        | runtime    | orchestrator   | No       | `false` by default — permanent VAD-only listening until the wake-word model is trained. |
| `OWW_MODEL_PATH`           | runtime    | orchestrator   | Only if wake word enabled | Path to the trained `.onnx` inside the container; defaults to `/app/models/che_parche.onnx` (bind-mounted from `orchestrator/models/`). |
| `OWW_THRESHOLD`            | runtime    | orchestrator   | No       | Detection score threshold, default `0.5`.                                   |

See `orchestrator/.env.example` for the full list (VAD tuning, audio device selection, wake-word training steps) and for running `main.py` directly outside Docker.

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

---

## Local development

```bash
npm install
npm run dev      # http://localhost:5173
```

Other scripts:

```bash
npm run build    # type-check + produce dist/
npm run preview  # serve the production build locally
```

There is no nginx proxy in `vite dev`, so point straight at Hermes in your `.env`:

```env
VITE_HERMES_API_URL=http://192.168.1.xxx:8000
```

---

## Deployment on Raspberry Pi

`stack.yml` builds and runs **two** containers: `parche-ui` (nginx on port
`8080`, configurable via `HOST_PORT`) and `orchestrator` (voice, with `/dev/snd`
passed through so it can reach the Pi's real mic/speakers). Both join the
external `hermes-agent_default` network (where Hermes runs), so it must already
exist on the host. `docker compose -f stack.yml up -d` brings up both together
— there's no separate step for the orchestrator.

All deployment methods below use the same `stack.yml`. Pick whichever you
prefer — there is no functional difference.

### Option A — Portainer stack

1. In Portainer go to **Stacks → Add stack**.
2. **Build method**:
   - **Git repository**: point it at the repo and set *Compose path* to `stack.yml`, **or**
   - **Web editor**: paste the contents of `stack.yml`.
3. Under **Environment variables**, add:

   | Name                  | Value                |
   | --------------------- | -------------------- |
   | `HERMES_API_KEY`      | `your-api-key`       |
   | `OPENAI_API_KEY`      | `your-openai-key`    |
   | `ELEVEN_LABS_API_KEY` | `your-elevenlabs-key`|
   | `HOST_PORT`           | `8080` (optional)    |

4. **Deploy the stack**.
5. Open the UI at `http://<raspberry-ip>:8080`.

### Option B — docker compose over SSH

```bash
# On the Raspberry, from the project directory:
cp .env.example .env        # then set HERMES_API_KEY, OPENAI_API_KEY, ELEVEN_LABS_API_KEY (and HOST_PORT if needed)
docker compose -f stack.yml up -d --build
```

`docker compose` reads all of these from the `.env` file in the same directory.

### Option C — GitHub Actions self-hosted runner (CI/CD)

If a self-hosted runner is running on the Pi, every push to `main` builds and
deploys automatically. The workflow lives in `.github/workflows/deploy.yml`: it
writes a `.env` from GitHub secrets/variables, then runs `docker compose build`
+ `up -d` on the runner — both containers, one push.

One-time setup in the repo **Settings → Secrets and variables → Actions**,
under the **`production`** environment (matching `environment: production` in the
workflow):

| Kind     | Name               | Value             |
| -------- | ------------------ | ----------------- |
| Secret   | `HERMES_API_KEY`   | `your-api-key`    |
| Secret   | `OPENAI_API_KEY`   | `your-openai-key` |
| Variable | `HOST_PORT`        | `8080` (optional) |
| Variable | `WAKE_WORD_ENABLED`| `false` (optional, default false) |

Notes:
- The runner user must be able to run Docker (e.g. be in the `docker` group) and
  have `docker compose` (v2) available.
- The runner's user (or whoever `dockerd` runs containers as) needs permission
  to open `/dev/snd/*` — usually just being in the host's `audio` group.
- The workflow uses `runs-on: self-hosted`. If your runner needs extra labels to
  be targeted, add them there.
- You can also trigger it manually via **Actions → Deploy parche-ui → Run workflow**.
- To enable the wake word later: drop the trained `.onnx` into
  `orchestrator/models/` on the Pi (or via git), set `WAKE_WORD_ENABLED=true`,
  and redeploy — no image rebuild needed since the model is bind-mounted.

> Runtime env changes only need a restart (`docker compose ... up -d`), not a
> rebuild. A rebuild is only required if you change build-time `VITE_*` values
> or the Dockerfiles themselves.

### Manual build (no compose)

```bash
docker build -t parche-ui:latest .

docker run -d --restart unless-stopped \
  -p 8080:80 \
  --network hermes-agent_default \
  -e HERMES_API_KEY=your-api-key \
  -e NGINX_ENVSUBST_FILTER=HERMES_ \
  --name parche-ui parche-ui:latest

docker build -t parche-orchestrator:latest orchestrator

# --network-alias orchestrator matters: nginx.conf proxies /ws-status to
# "orchestrator:8765" by container/service name, not by --name.
docker run -d --restart unless-stopped \
  --network hermes-agent_default \
  --network-alias orchestrator \
  --device /dev/snd:/dev/snd \
  -v "$(pwd)/orchestrator/models:/app/models" \
  -e OPENAI_API_KEY=your-openai-key \
  -e ELEVEN_LABS_API_KEY=your-elevenlabs-key \
  -e HERMES_API_KEY=your-api-key \
  --name parche-orchestrator parche-orchestrator:latest
```
