"""HERMES voice orchestrator — runs on the Raspberry Pi.

EXPERIMENTAL (branch feature/openai-realtime): replaces the old discrete
VAD -> Whisper -> Hermes(HTTP) -> TTS pipeline with a single persistent
connection to OpenAI's Realtime API (speech-to-speech, server-side turn
detection). Hermes stays in the loop as a tool ("ask_hermes") the realtime
model can call for anything requiring real capability (search, actions,
memory) — the model is prompted to speak a short filler phrase before
invoking it, so the conversation never goes silent while Hermes churns.

The UI is still a pure status display — this script pushes
{"status": "idle"|"listening"|"thinking"|"talking"} over a small WebSocket
server so the orb can react in real time.
"""

from __future__ import annotations

import asyncio
import audioop
import base64
import json
import logging
import os
import queue
import threading
from typing import Any
from urllib.parse import urlparse

import httpx
import numpy as np
import sounddevice as sd
import websockets
from dotenv import load_dotenv
from openwakeword.model import Model as WakeWordModel
from openwakeword.utils import download_models as download_wakeword_models

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("orchestrator")

# ── Config ──────────────────────────────────────────────────────────────────

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
HERMES_API_URL = os.getenv("HERMES_API_URL", "http://localhost:8000").rstrip("/")
HERMES_API_KEY = os.getenv("HERMES_API_KEY", "")
# The gateway WS (same channel Telegram uses, tools/skills enabled) — NOT the
# plain REST API (HERMES_API_URL, port 8000), which answers as a bare LLM with
# no tools at all. Same host, its own port/path — confirmed earlier in this
# project from the old browser hook (useHermesWS.ts) that talked to Hermes
# this same way, including the `internal` query-param token.
_HERMES_HOST = urlparse(HERMES_API_URL).hostname or "localhost"
# `or` on purpose, not os.getenv's default param: stack.yml always sets this
# var (possibly to an empty string via ${HERMES_WS_URL:-}), and os.getenv's
# default only kicks in when the var is entirely absent, not when present-but-
# empty — that emptiness was silently winning over this fallback before.
HERMES_WS_URL = os.getenv("HERMES_WS_URL") or f"ws://{_HERMES_HOST}:9119/api/ws"
HERMES_WS_TOKEN = os.getenv("HERMES_WS_TOKEN") or "parche-internal-dev"

STATUS_WS_HOST = os.getenv("STATUS_WS_HOST", "0.0.0.0")
STATUS_WS_PORT = int(os.getenv("STATUS_WS_PORT", "8765"))

# OpenAI Realtime API. Model/voice names are the ones current as of this
# writing (Jan 2026) — check platform.openai.com/docs/guides/realtime if
# either gets rejected by the API, naming has shifted before.
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "gpt-realtime")
REALTIME_VOICE = os.getenv("REALTIME_VOICE", "marin")
REALTIME_SAMPLE_RATE = 24000  # fixed by the API (pcm16, mono)
REALTIME_WS_URL = f"wss://api.openai.com/v1/realtime?model={REALTIME_MODEL}"

DEFAULT_INSTRUCTIONS = """Sos "Parche", un asistente de voz argentino. Hablás en \
español rioplatense, tono informal y directo, como si fueras un amigo copado.

Cuando el pedido del usuario requiera buscar información actualizada, ejecutar \
una acción real (prender/apagar algo, controlar un dispositivo, leer archivos, \
o cualquier cosa que exceda una charla simple), invocá la herramienta \
ask_hermes con el pedido.

Muy importante: cuando decidas invocar ask_hermes, ANTES de esperar el \
resultado respondé primero con una frase corta y natural reconociendo el \
pedido (por ejemplo "dale, dame un segundo", "ok, ya lo hago", "esperá un \
toque que lo reviso") — variá la frase cada vez, que no suene siempre igual. \
Recién después invocá la herramienta.

Cuando recibas el resultado de ask_hermes, contestale al usuario con esa \
información de forma natural y conversacional — no la leas textual si es \
muy larga, resumila.

Si el pedido es una charla simple (saludos, preguntas generales que sabés \
responder vos), contestá directo sin usar la herramienta."""
REALTIME_INSTRUCTIONS = os.getenv("REALTIME_INSTRUCTIONS", DEFAULT_INSTRUCTIONS)

ASK_HERMES_TOOL = {
    "type": "function",
    "name": "ask_hermes",
    "description": (
        "Le pasa un pedido a Hermes, el agente con capacidad de buscar "
        "informacion, ejecutar acciones reales y memoria de largo plazo. "
        "Usala cada vez que el pedido del usuario requiera algo que no "
        "podes resolver vos solo con conversacion."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "El pedido del usuario, para que Hermes lo procese.",
            },
        },
        "required": ["prompt"],
    },
}

MIC_DEVICE = os.getenv("MIC_DEVICE") or None
SPEAKER_DEVICE = os.getenv("SPEAKER_DEVICE") or None

# Raises the server VAD's sensitivity threshold (0-1, API default ~0.5) so
# quiet echo bleed-through doesn't count as speech while actual close-mic
# talking still does — first line of defense against self-answer loops,
# tried before giving up barge-in via MIC_MUTE_WHILE_SPEAKING.
VAD_THRESHOLD = float(os.getenv("VAD_THRESHOLD", "0.7"))
MIC_FRAME_MS = 100  # chunk size fed to the Realtime API's input audio buffer;
# bigger than the API's own minimum to cut down how often we hop threads /
# hit the network per second on the Pi's limited CPU (was 20ms — 5x the rate).
# Off by default — needs to stay possible to interrupt Parche mid-response.
# Only turn this on if VAD_THRESHOLD alone isn't enough and you'd rather trade
# barge-in away for stability.
MIC_MUTE_WHILE_SPEAKING = os.getenv("MIC_MUTE_WHILE_SPEAKING", "false").lower() == "true"
MIC_UNMUTE_DELAY_S = float(os.getenv("MIC_UNMUTE_DELAY_S", "0.4"))  # see mic_muted above

# Wake word, via openWakeWord. Uses the bundled pretrained "hey_jarvis" model
# by default — no custom training needed. Set OWW_MODEL_PATH to a custom
# trained model (see orchestrator/.env.example) to use a different phrase.
WAKE_WORD_ENABLED = os.getenv("WAKE_WORD_ENABLED", "true").lower() == "true"
OWW_MODEL_PATH = os.getenv("OWW_MODEL_PATH") or "hey_jarvis"
OWW_THRESHOLD = float(os.getenv("OWW_THRESHOLD", "0.5"))
OWW_SAMPLE_RATE = 16000
OWW_CHUNK_SAMPLES = int(os.getenv("OWW_CHUNK_SAMPLES", "1280"))  # 80ms, openWakeWord's recommended chunk size

wakeword_model = None
if WAKE_WORD_ENABLED:
    download_wakeword_models()  # fetches the pretrained models, incl. hey_jarvis (idempotent)
    wakeword_model = WakeWordModel(wakeword_models=[OWW_MODEL_PATH], inference_framework="onnx")

# ── Status WebSocket server ──────────────────────────────────────────────────

clients: set[websockets.WebSocketServerProtocol] = set()
current_status = "idle"
cancel_event = asyncio.Event()


async def status_handler(websocket: websockets.WebSocketServerProtocol) -> None:
    clients.add(websocket)
    try:
        await websocket.send(json.dumps({"status": current_status}))
        async for message in websocket:
            try:
                msg = json.loads(message)
            except json.JSONDecodeError:
                continue
            action = msg.get("action")
            if action == "cancel":
                log.info("cancel requested from UI")
                cancel_event.set()
            elif action == "start":
                start_session()
            elif action == "stop":
                stop_session()
    finally:
        clients.discard(websocket)


current_session_task: asyncio.Task | None = None


def start_session() -> None:
    global current_session_task
    if current_session_task is not None and not current_session_task.done():
        return  # already running
    log.info("session start requested from UI")
    current_session_task = asyncio.get_event_loop().create_task(_session_runner())


def stop_session() -> None:
    if current_session_task is not None and not current_session_task.done():
        log.info("session stop requested from UI")
        wake_word_stop_event.set()
        current_session_task.cancel()


async def set_status(status: str) -> None:
    global current_status
    if status == current_status:
        return
    current_status = status
    log.info("status -> %s", status)
    message = json.dumps({"status": status})
    dead = []
    for ws in clients:
        try:
            await ws.send(message)
        except websockets.ConnectionClosed:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


# ── Audio device helpers ─────────────────────────────────────────────────────
# Real mic/speaker hardware often refuses to open at an arbitrary rate/format
# (PortAudio "Invalid sample rate" / "Sample format not supported" — see
# orchestrator/asound.conf and git history on main for how this Pi's Astro
# MixAmp Pro was routed). We always open at whatever the device reports as its
# default, then resample in software with the stdlib `audioop`.

def _query_native_rate(device: str | int | None, kind: str) -> int:
    info = sd.query_devices(device, kind) if device is not None else sd.query_devices(kind=kind)
    return int(info["default_samplerate"])


def _frames_at_rate(
    device: str | int | None, target_rate: int, frame_ms: int,
    stop_event: threading.Event | None = None,
):
    """Yields fixed-size `frame_ms`-long PCM16 mono chunks at `target_rate`,
    resampling on the fly from the mic's native rate. Runs forever, unless
    stop_event is set — needed because this runs in a plain executor thread,
    which asyncio task cancellation does NOT actually interrupt: without this,
    stopping a session while wait_for_wake_word is blocked here leaves its
    InputStream open forever, and the next start fails with "Device
    unavailable" fighting over the same mic."""
    native_rate = _query_native_rate(device, "input")
    native_frame_samples = max(1, native_rate * frame_ms // 1000)
    frame_bytes = target_rate * frame_ms // 1000 * 2

    buffer = b""
    state = None
    with sd.InputStream(
        samplerate=native_rate, channels=1, dtype="int16",
        blocksize=native_frame_samples, device=device,
    ) as stream:
        while True:
            if stop_event is not None and stop_event.is_set():
                return
            data, _ = stream.read(native_frame_samples)
            chunk = data.tobytes()
            if native_rate != target_rate:
                chunk, state = audioop.ratecv(chunk, 2, 1, native_rate, target_rate, state)
            buffer += chunk
            while len(buffer) >= frame_bytes:
                yield buffer[:frame_bytes]
                buffer = buffer[frame_bytes:]


_PLAYBACK_CONFIGS: list[tuple[int, str]] = [
    (1, "int16"),
    (2, "int16"),
    (1, "float32"),
    (2, "float32"),
    (2, "int32"),
]
_output_config_cache: dict[str | int | None, tuple[int, str]] = {}


def _prepare_output_audio(int16_mono: np.ndarray, channels: int, dtype: str) -> np.ndarray:
    if dtype == "int16":
        data = int16_mono
    elif dtype == "float32":
        data = int16_mono.astype(np.float32) / 32768.0
    elif dtype == "int32":
        data = int16_mono.astype(np.int32) << 16
    else:
        raise ValueError(f"unsupported playback dtype: {dtype}")
    return np.column_stack([data, data]) if channels == 2 else data


def _open_output_stream() -> tuple[sd.OutputStream, int, int, str]:
    """Opens a persistent output stream for continuous realtime playback,
    trying candidate (channels, dtype) configs until one is accepted."""
    native_rate = _query_native_rate(SPEAKER_DEVICE, "output")
    cached = _output_config_cache.get(SPEAKER_DEVICE)
    candidates = [cached] if cached else _PLAYBACK_CONFIGS

    last_err: Exception | None = None
    for channels, dtype in candidates:
        try:
            stream = sd.OutputStream(
                samplerate=native_rate, channels=channels, dtype=dtype, device=SPEAKER_DEVICE,
            )
            stream.start()
            _output_config_cache[SPEAKER_DEVICE] = (channels, dtype)
            return stream, native_rate, channels, dtype
        except sd.PortAudioError as e:
            last_err = e
            log.warning("playback config channels=%d dtype=%s rejected: %s", channels, dtype, e)
    raise last_err


# ── Wake word (blocking, runs in a worker thread) ───────────────────────────

# Set by stop_session() to break wait_for_wake_word out of its blocking loop —
# cancelling the asyncio task wrapping it does NOT stop the underlying thread.
wake_word_stop_event = threading.Event()


def wait_for_wake_word() -> None:
    """Blocks until the wake word is detected, or wake_word_stop_event is set."""
    wakeword_model.reset()
    wake_word_stop_event.clear()
    frame_ms = OWW_CHUNK_SAMPLES * 1000 // OWW_SAMPLE_RATE
    log.info("wake word listener: armed (threshold=%.2f)", OWW_THRESHOLD)
    frame_count = 0
    best_scores: dict[str, float] = {}
    best_rms = 0.0
    for frame in _frames_at_rate(MIC_DEVICE, OWW_SAMPLE_RATE, frame_ms, stop_event=wake_word_stop_event):
        pcm = np.frombuffer(frame, dtype=np.int16)
        # RMS of the raw samples — independent of what the wakeword model
        # thinks, this tells us whether real (loud) audio is reaching it at
        # all, to rule out a mic gain/routing problem vs. an accent/model
        # mismatch when scores stay low.
        rms = float(np.sqrt(np.mean(pcm.astype(np.float64) ** 2)))
        best_rms = max(best_rms, rms)
        scores = wakeword_model.predict(pcm)
        frame_count += 1
        for name, score in scores.items():
            if score > best_scores.get(name, 0.0):
                best_scores[name] = score
        if frame_count % 25 == 0:  # ~every 2s at 80ms/frame
            log.info("wake word listener: alive, %d frames, best scores so far: %s, peak RMS: %.0f",
                      frame_count, {k: round(v, 3) for k, v in best_scores.items()}, best_rms)
            best_rms = 0.0
        if any(score >= OWW_THRESHOLD for score in scores.values()):
            log.info("wake word detected: %s", {k: round(v, 3) for k, v in scores.items()})
            return


# ── Hermes bridge — two modes, picked by HERMES_MODE ────────────────────────
# "http": plain REST /v1/chat/completions. Simple, proven, but answers as a
#   bare LLM — no tools/skills, can't actually turn anything on.
# "ws": the gateway WebSocket (same channel Telegram uses, tools/skills
#   enabled). Same JSON-RPC-ish protocol the old browser hook (useHermesWS.ts,
#   pre-Realtime-API) used: wait for gateway.ready, create a session, submit
#   the prompt, collect message.delta until message.complete. Still being
#   debugged (auth/port/path) — keep HERMES_MODE=http as the safe fallback
#   while that's sorted out.
HERMES_MODE = os.getenv("HERMES_MODE", "http").lower()


def _ask_hermes_http_sync(prompt: str) -> str:
    url = f"{HERMES_API_URL}/v1/chat/completions"
    headers = {"Content-Type": "application/json"}
    if HERMES_API_KEY:
        headers["Authorization"] = f"Bearer {HERMES_API_KEY}"
    payload = {"model": "hermes", "messages": [{"role": "user", "content": prompt}], "stream": False}
    resp = httpx.post(url, headers=headers, json=payload, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


async def _ask_hermes_http(prompt: str) -> str:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _ask_hermes_http_sync, prompt)


async def _ask_hermes_ws(prompt: str) -> str:
    # Hermes itself confirmed this exact URL+token combo connects and gets
    # gateway.ready when tested directly — if this still 403s from in here,
    # it's very likely the gateway checking the connecting IP/network as
    # "internal", not the token itself (our container's docker-network IP vs.
    # the Pi's LAN IP the direct test used).
    url = f"{HERMES_WS_URL}?internal={HERMES_WS_TOKEN}"
    log.info("hermes gateway: connecting to %s", HERMES_WS_URL)
    async with websockets.connect(url) as ws:
        log.info("hermes gateway: connected")
        accumulated = ""

        async for raw in ws:
            for line in raw.split("\n"):
                line = line.strip()
                if not line:
                    continue
                msg = json.loads(line)
                method = msg.get("method")
                mtype = (msg.get("params") or {}).get("type")
                # Full message, not just method/type — tool-call details (which
                # tool, args, whether it actually ran vs errored) live in
                # params/payload fields we don't otherwise parse, and this is
                # the only way to see whether Hermes really executed something
                # or is just claiming to.
                log.info("hermes gateway message: %s", line[:2000])

                if method == "event" and mtype == "gateway.ready":
                    # yolo=True skips Hermes's tool-execution approval gate
                    # (the one-shot confirmation we hit earlier with
                    # execute_code) — needed since nothing here can interactively
                    # approve a tool call mid-voice-conversation.
                    await ws.send(json.dumps({
                        "id": 0, "method": "session.create", "params": {"internal": True, "yolo": True},
                    }) + "\n")

                elif msg.get("id") == 0 and msg.get("result"):
                    session_id = msg["result"].get("session_id")
                    # The gateway's prompt.submit handler reads params["text"]
                    # specifically (confirmed against its actual source) —
                    # "messages"/"content" are silently ignored, which is why
                    # every earlier attempt got treated as an empty prompt.
                    await ws.send(json.dumps({
                        "id": 2, "method": "prompt.submit",
                        "params": {
                            "session_id": session_id,
                            "text": prompt,
                            "internal": True,
                        },
                    }) + "\n")

                elif method == "event" and mtype == "message.delta":
                    accumulated += (msg.get("params", {}).get("payload") or {}).get("text", "")

                elif method == "event" and mtype == "message.complete":
                    payload = msg.get("params", {}).get("payload") or {}
                    return payload.get("text") or accumulated
    return accumulated


async def ask_hermes(prompt: str) -> str:
    try:
        if HERMES_MODE == "ws":
            return await _ask_hermes_ws(prompt)
        return await _ask_hermes_http(prompt)
    except Exception:
        log.exception("ask_hermes (%s) failed for prompt: %r", HERMES_MODE, prompt)
        return "No pude conectarme con Hermes ahora, intentemos de nuevo en un rato."


# ── Realtime session ─────────────────────────────────────────────────────────

class RealtimeSession:
    """Owns the audio in/out threads and event handling for one connection to
    the OpenAI Realtime API."""

    def __init__(self, ws: websockets.WebSocketClientProtocol) -> None:
        self.ws = ws
        self.loop = asyncio.get_running_loop()
        self.mic_queue: asyncio.Queue[bytes] = asyncio.Queue()
        # Plain thread-safe queue, not asyncio.Queue — the playback thread reads
        # from it with a native blocking get(), no cross-thread round-trip
        # through the event loop per chunk (that was starving the loop enough
        # to miss WebSocket keepalive pings and cause choppy/dropped audio).
        self.playback_queue: queue.Queue[bytes | None] = queue.Queue()
        self.stop_event = threading.Event()
        self.awaiting_hermes = False
        self.speaking = False
        # Half-duplex mic muting: no acoustic echo cancellation on this hardware
        # (raw ALSA, not WebRTC), so without a properly isolated mic/headset the
        # server VAD picks up Parche's own voice from the speaker and starts
        # phantom turns. Dropping mic frames while speaking (+ a short grace
        # period after) avoids that at the cost of not being able to barge in
        # mid-response.
        self.mic_muted = False
        self.output_stream: sd.OutputStream | None = None

    def start_audio_threads(self) -> None:
        threading.Thread(target=self._mic_thread, daemon=True).start()
        threading.Thread(target=self._playback_thread, daemon=True).start()

    def stop_audio_threads(self) -> None:
        self.stop_event.set()
        self.playback_queue.put_nowait(None)

    def _mic_thread(self) -> None:
        try:
            log.info("mic thread starting (device=%s, target_rate=%d)", MIC_DEVICE, REALTIME_SAMPLE_RATE)
            sent = 0
            for frame in _frames_at_rate(MIC_DEVICE, REALTIME_SAMPLE_RATE, MIC_FRAME_MS):
                if self.stop_event.is_set():
                    log.info("mic thread stopping")
                    return
                self.loop.call_soon_threadsafe(self.mic_queue.put_nowait, frame)
                sent += 1
                if sent % 50 == 0:  # ~5s at 100ms frames, just a heartbeat
                    log.info("mic thread alive: %d frames sent so far", sent)
        except Exception:
            log.exception("mic thread crashed")

    def _playback_thread(self) -> None:
        try:
            stream, native_rate, channels, dtype = _open_output_stream()
        except Exception:
            log.exception("playback thread failed to open output stream")
            return
        log.info("playback stream open: native_rate=%d channels=%d dtype=%s", native_rate, channels, dtype)
        self.output_stream = stream
        state = None
        try:
            while True:
                pcm = self.playback_queue.get()
                if pcm is None or self.stop_event.is_set():
                    log.info("playback thread stopping")
                    return
                if native_rate != REALTIME_SAMPLE_RATE:
                    pcm, state = audioop.ratecv(pcm, 2, 1, REALTIME_SAMPLE_RATE, native_rate, state)
                int16_mono = np.frombuffer(pcm, dtype=np.int16)
                audio = _prepare_output_audio(int16_mono, channels, dtype)
                try:
                    stream.write(audio)
                except sd.PortAudioError:
                    # stream was aborted by interrupt_playback() — reactivate and drop this chunk
                    stream.start()
        except Exception:
            log.exception("playback thread crashed")
        finally:
            stream.stop()
            stream.close()

    def interrupt_playback(self) -> None:
        """Drops anything queued/currently playing — used on cancel and on
        server-detected barge-in (user starts talking over the assistant).
        `sd.stop()` only affects streams opened via the sd.play()/sd.rec()
        shortcuts, not our own explicit sd.OutputStream — has to be aborted
        directly."""
        while not self.playback_queue.empty():
            try:
                self.playback_queue.get_nowait()
            except queue.Empty:
                break
        if self.output_stream is not None:
            try:
                self.output_stream.abort()
            except sd.PortAudioError:
                pass

    async def send_mic_audio(self) -> None:
        sent = 0
        while True:
            frame = await self.mic_queue.get()
            if self.mic_muted:
                continue  # half-duplex: don't feed our own echo back while/just after talking
            b64 = base64.b64encode(frame).decode("ascii")
            await self.ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": b64}))
            sent += 1
            if sent % 250 == 0:
                log.info("sent %d audio chunks to the realtime API so far", sent)

    async def _unmute_mic_after_delay(self) -> None:
        # response.done only means the API finished SENDING audio — our local
        # playback_queue can still be draining if it arrived faster than real
        # time, so wait for that too before starting the grace period. Without
        # this, the mic could reopen while the speaker is still audibly
        # finishing the response, picking itself back up as "new" speech.
        while not self.playback_queue.empty():
            await asyncio.sleep(0.05)
        await asyncio.sleep(MIC_UNMUTE_DELAY_S)
        self.mic_muted = False

    async def handle_event(self, event: dict[str, Any]) -> None:
        etype = event.get("type")
        if etype != "response.output_audio.delta":  # too spammy to log every single one
            log.info("realtime event: %s", etype)

        if etype == "input_audio_buffer.speech_started":
            if self.speaking:
                # Real barge-in (AEC keeps this from firing on Parche's own
                # echo) — the user started talking over the assistant, stop.
                self.interrupt_playback()
                self.speaking = False
            await set_status("listening")

        elif etype == "response.output_audio.delta":
            pcm = base64.b64decode(event["delta"])
            self.playback_queue.put_nowait(pcm)
            if not self.speaking:
                self.speaking = True
                if MIC_MUTE_WHILE_SPEAKING:
                    self.mic_muted = True
                await set_status("talking")

        elif etype == "response.output_audio_transcript.done":
            log.info("parche dice: %s", event.get("transcript"))

        elif etype == "response.function_call_arguments.done":
            if event.get("name") == "ask_hermes":
                call_id = event["call_id"]
                try:
                    args = json.loads(event.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                prompt = args.get("prompt", "")
                self.awaiting_hermes = True
                await set_status("thinking")
                asyncio.create_task(self._resolve_hermes_call(call_id, prompt))

        elif etype == "response.done":
            self.speaking = False
            if MIC_MUTE_WHILE_SPEAKING:
                asyncio.create_task(self._unmute_mic_after_delay())
            if not self.awaiting_hermes:
                await set_status("listening")

        elif etype == "error":
            log.warning("realtime API error: %s", event)

    async def _resolve_hermes_call(self, call_id: str, prompt: str) -> None:
        log.info("ask_hermes: %s", prompt)
        reply = await ask_hermes(prompt)
        log.info("hermes: %s", reply)
        if not self.awaiting_hermes:
            return  # cancelled while Hermes was thinking — drop the result
        self.awaiting_hermes = False
        try:
            await self.ws.send(json.dumps({
                "type": "conversation.item.create",
                "item": {"type": "function_call_output", "call_id": call_id, "output": reply},
            }))
            await self.ws.send(json.dumps({"type": "response.create"}))
        except websockets.ConnectionClosed:
            # The whole session (not just this turn) got stopped from the UI
            # while Hermes was still working — nothing left to report this to.
            log.info("session ended before Hermes's reply could be relayed: %s", reply)

    async def cancel(self) -> None:
        self.interrupt_playback()
        self.awaiting_hermes = False
        self.speaking = False
        self.mic_muted = False
        await self.ws.send(json.dumps({"type": "response.cancel"}))
        await set_status("listening")


def _session_update_payload() -> dict[str, Any]:
    # GA API shape: audio config (format/voice/turn_detection) moved from flat
    # session.* fields into session.audio.input / session.audio.output.
    return {
        "type": "session.update",
        "session": {
            "type": "realtime",
            "instructions": REALTIME_INSTRUCTIONS,
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": REALTIME_SAMPLE_RATE},
                    "turn_detection": {"type": "server_vad", "threshold": VAD_THRESHOLD},
                },
                "output": {
                    "format": {"type": "audio/pcm", "rate": REALTIME_SAMPLE_RATE},
                    "voice": REALTIME_VOICE,
                },
            },
            "tools": [ASK_HERMES_TOOL],
            "tool_choice": "auto",
        },
    }


async def run_realtime_session() -> None:
    # No "OpenAI-Beta: realtime=v1" header — that opts into the old beta
    # session shape, which the GA API now rejects with beta_api_shape_disabled.
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}
    # More lenient ping timeout — the Pi's event loop sharing a CPU with the
    # resampling/audio threads can lag past the 20s default under load, which
    # was closing the connection with "keepalive ping timeout".
    async with websockets.connect(
        REALTIME_WS_URL, additional_headers=headers, ping_interval=20, ping_timeout=60,
    ) as ws:
        await ws.send(json.dumps(_session_update_payload()))

        session = RealtimeSession(ws)
        session.start_audio_threads()
        await set_status("listening")

        sender_task = asyncio.create_task(session.send_mic_audio())
        canceller_task = asyncio.create_task(_watch_for_cancel(session))
        try:
            async for raw in ws:
                await session.handle_event(json.loads(raw))
        finally:
            sender_task.cancel()
            canceller_task.cancel()
            session.stop_audio_threads()


async def _watch_for_cancel(session: RealtimeSession) -> None:
    while True:
        await cancel_event.wait()
        cancel_event.clear()
        await session.cancel()


# ── Main ─────────────────────────────────────────────────────────────────────
# The realtime session is NOT started automatically — the mic stays fully
# closed (no cost, nothing listening) until the UI sends {"action": "start"},
# and {"action": "stop"} tears it down again. With WAKE_WORD_ENABLED, pressing
# start arms wake-word listening (status "wake_word") instead of opening the
# realtime session immediately; saying it is what actually opens the connection.

async def _session_runner() -> None:
    try:
        if WAKE_WORD_ENABLED:
            await set_status("wake_word")
            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, wait_for_wake_word)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("wake word listener crashed, stopping session")
                return

        while True:
            try:
                await run_realtime_session()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("realtime session dropped, reconnecting")
                await set_status("idle")
                await asyncio.sleep(2)
    except asyncio.CancelledError:
        log.info("session stopped")
    finally:
        await set_status("idle")


async def main() -> None:
    async with websockets.serve(status_handler, STATUS_WS_HOST, STATUS_WS_PORT):
        log.info("status WS listening on %s:%d", STATUS_WS_HOST, STATUS_WS_PORT)
        await set_status("idle")
        await asyncio.Event().wait()  # everything else is driven by UI start/stop actions


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
