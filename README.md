# parche-ui

**HERMES** frontend: a holographic-style chat interface (React + Three.js) that
connects to the Hermes API for streaming conversations, with voice support.

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
├── App.tsx                  # Main composition
├── i18n/strings.ts          # All user-facing strings (single source for translation)
├── components/              # Background, orb, messages, input, status
├── hooks/
│   ├── useHermesAPI.ts      # HTTP client (SSE streaming) ← in use
│   ├── useHermesWS.ts       # WebSocket client (legacy / optional)
│   └── useVoice.ts          # Speech recognition + synthesis
└── types/hermes.ts
Dockerfile                   # Multi-stage build (node → nginx)
nginx.conf                   # nginx config (SPA + static asset caching)
stack.yml                    # Portainer / docker-compose stack
```

### Internationalization

All visible text lives in `src/i18n/strings.ts`. Components never hardcode
user-facing strings — they import from `STRINGS`. To translate the UI, swap the
values there (or wire in a full i18n library later). The speech recognition /
synthesis language is configured separately via `VOICE_LOCALE` in the same file.

---

## Environment variables

> ⚠️ Vite **inlines** the `VITE_*` variables at **build time**; they are not read
> at runtime. They must be present when running `npm run build` (or passed as
> build-args when building the Docker image).

| Variable               | Required | Description                                                                 |
| ---------------------- | -------- | --------------------------------------------------------------------------- |
| `VITE_HERMES_API_URL`  | Yes      | HTTP URL of the Hermes API. Default: `https://<hostname>:8000`.             |
| `VITE_HERMES_API_KEY`  | Yes      | API key (`Authorization: Bearer …` header).                                 |
| `VITE_HERMES_WS_URL`   | No       | WebSocket URL (only `useHermesWS`, legacy). Default: `ws://<host>:9119/api/ws`. |

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

On Windows pointing at the Raspberry, in your `.env`:

```env
VITE_HERMES_API_URL=http://192.168.1.xxx:8000
VITE_HERMES_API_KEY=your-api-key
```

---

## Deployment on Raspberry Pi

The stack builds the image on the Raspberry itself and serves it with nginx on
port `8080` (configurable via `HOST_PORT`). Because the `VITE_*` values are
inlined at build time, they are passed as **build-args** through environment
variables.

Both deployment methods below use the same `stack.yml`. Pick whichever you
prefer — there is no functional difference.

### Option A — Portainer stack

1. In Portainer go to **Stacks → Add stack**.
2. **Build method**:
   - **Git repository**: point it at the repo and set *Compose path* to `stack.yml`, **or**
   - **Web editor**: paste the contents of `stack.yml`.
3. Under **Environment variables**, add:

   | Name                  | Value                          |
   | --------------------- | ------------------------------ |
   | `VITE_HERMES_API_URL` | `http://192.168.1.xxx:8000`    |
   | `VITE_HERMES_API_KEY` | `your-api-key`                 |
   | `HOST_PORT`           | `8080` (optional)              |

4. **Deploy the stack**.
5. Open the UI at `http://<raspberry-ip>:8080`.

### Option B — docker compose over SSH

```bash
# On the Raspberry, from the project directory:
cp .env.example .env        # then edit .env with the real values
docker compose -f stack.yml up -d --build
```

`docker compose` reads the `VITE_*` and `HOST_PORT` values from the `.env` file
in the same directory.

### Option C — GitHub Actions self-hosted runner (CI/CD)

If a self-hosted runner is running on the Pi, every push to `main` builds and
deploys automatically. The workflow lives in `.github/workflows/deploy.yml`: it
writes a `.env` from GitHub secrets/variables, then runs `docker compose build`
+ `up -d` on the runner.

One-time setup in the repo **Settings → Secrets and variables → Actions**,
under the **`production`** environment (matching `environment: production` in the
workflow):

| Kind     | Name                  | Value                       |
| -------- | --------------------- | --------------------------- |
| Variable | `VITE_HERMES_API_URL` | `http://192.168.1.xxx:8000` |
| Variable | `HOST_PORT`           | `8080` (optional)           |
| Secret   | `VITE_HERMES_API_KEY` | `your-api-key`              |

Notes:
- The runner user must be able to run Docker (e.g. be in the `docker` group) and
  have `docker compose` (v2) available.
- The workflow uses `runs-on: self-hosted`. If your runner needs extra labels to
  be targeted, add them there.
- You can also trigger it manually via **Actions → Deploy parche-ui → Run workflow**.

> Whichever option you use: if you change the API URL or key, you must
> **redeploy with a rebuild** (Portainer → Stack → *Update* with re-pull/rebuild,
> `docker compose ... up -d --build`, or just push to `main` with Option C),
> because the value is baked into the previous build.

### Manual build (no compose)

```bash
docker build \
  --build-arg VITE_HERMES_API_URL=http://192.168.1.xxx:8000 \
  --build-arg VITE_HERMES_API_KEY=your-api-key \
  -t parche-ui:latest .

docker run -d --restart unless-stopped -p 8080:80 --name parche-ui parche-ui:latest
```
