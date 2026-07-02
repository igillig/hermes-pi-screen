# parche-ui

**HERMES** frontend: a holographic neural-orb display (React + Three.js) that
shows the assistant's current state (listening / thinking / talking).

The UI is a **pure status display** — it owns no microphone, speaker, or chat
logic. All of that (mic capture + VAD, OpenAI Whisper STT, streaming Hermes
chat, sentence-buffered OpenAI TTS, and speaker playback) lives in
[`orchestrator/main.py`](orchestrator/main.py), a Python script that runs
directly on the Raspberry Pi host (it needs real audio hardware access, so it
isn't containerized like the UI). The orchestrator pushes
`{"status": "listening" | "thinking" | "talking"}` over a small WebSocket
server that this UI connects to and mirrors onto the orb.

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
├── main.py                       # Voice orchestrator: mic/VAD → Whisper → Hermes → TTS → speakers
└── requirements.txt
Dockerfile                        # Multi-stage build (node → nginx), UI only
nginx.conf                        # nginx template: SPA + static caching + /api reverse proxy
stack.yml                         # Portainer / docker-compose stack (UI only)
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
> runtime). Non-`VITE_` variables (`HERMES_API_KEY`, `HOST_PORT`) are plain
> **runtime** env for the container.

| Variable                   | Scope      | Required | Description                                                                 |
| -------------------------- | ---------- | -------- | ---------------------------------------------------------------------------- |
| `HERMES_API_KEY`           | runtime    | Yes      | Injected by nginx into the `Authorization` header. Never shipped to the client. |
| `HOST_PORT`                | runtime    | No       | Host port the UI is published on. Default: `8080`.                          |
| `VITE_HERMES_API_URL`      | build-time | No       | API base URL baked into the bundle. Default: `/api` (same-origin proxy).    |
| `VITE_ORCHESTRATOR_WS_URL` | build-time | No       | WebSocket URL for the Python orchestrator's status broadcasts. Default: `ws://<hostname>:8765`. |

See `orchestrator/.env.example` for the orchestrator's own configuration (OpenAI key, Hermes API URL, audio devices, VAD tuning).

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

The stack builds the image on the Raspberry itself and serves it with nginx on
port `8080` (configurable via `HOST_PORT`). nginx reverse-proxies `/api` to the
Hermes container, so the only value you must provide is the runtime
`HERMES_API_KEY`. parche-ui joins the external `hermes-agent_default` network
(where Hermes runs), so it must already exist on the host.

All deployment methods below use the same `stack.yml`. Pick whichever you
prefer — there is no functional difference.

### Option A — Portainer stack

1. In Portainer go to **Stacks → Add stack**.
2. **Build method**:
   - **Git repository**: point it at the repo and set *Compose path* to `stack.yml`, **or**
   - **Web editor**: paste the contents of `stack.yml`.
3. Under **Environment variables**, add:

   | Name             | Value             |
   | ---------------- | ----------------- |
   | `HERMES_API_KEY` | `your-api-key`    |
   | `HOST_PORT`      | `8080` (optional) |

4. **Deploy the stack**.
5. Open the UI at `http://<raspberry-ip>:8080`.

### Option B — docker compose over SSH

```bash
# On the Raspberry, from the project directory:
cp .env.example .env        # then set HERMES_API_KEY (and HOST_PORT if needed)
docker compose -f stack.yml up -d --build
```

`docker compose` reads `HERMES_API_KEY` and `HOST_PORT` from the `.env` file in
the same directory.

### Option C — GitHub Actions self-hosted runner (CI/CD)

If a self-hosted runner is running on the Pi, every push to `main` builds and
deploys automatically. The workflow lives in `.github/workflows/deploy.yml`: it
writes a `.env` from GitHub secrets/variables, then runs `docker compose build`
+ `up -d` on the runner.

One-time setup in the repo **Settings → Secrets and variables → Actions**,
under the **`production`** environment (matching `environment: production` in the
workflow):

| Kind     | Name             | Value             |
| -------- | ---------------- | ----------------- |
| Secret   | `HERMES_API_KEY` | `your-api-key`    |
| Variable | `HOST_PORT`      | `8080` (optional) |

Notes:
- The runner user must be able to run Docker (e.g. be in the `docker` group) and
  have `docker compose` (v2) available.
- The workflow uses `runs-on: self-hosted`. If your runner needs extra labels to
  be targeted, add them there.
- You can also trigger it manually via **Actions → Deploy parche-ui → Run workflow**.

> The API key is a **runtime** env, so rotating it only needs a restart
> (`docker compose ... up -d`), not a rebuild. A rebuild is only required if you
> change build-time `VITE_*` values.

### Manual build (no compose)

```bash
docker build -t parche-ui:latest .

docker run -d --restart unless-stopped \
  -p 8080:80 \
  --network hermes-agent_default \
  -e HERMES_API_KEY=your-api-key \
  -e NGINX_ENVSUBST_FILTER=HERMES_ \
  --name parche-ui parche-ui:latest
```
