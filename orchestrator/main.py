"""HERMES voice orchestrator — runs on the Raspberry Pi.

Owns the whole voice loop end to end: wake-word gating, mic capture + VAD,
OpenAI Whisper (STT), streaming chat against the Hermes API, sentence-buffered
OpenAI TTS, and playback on the Pi's speakers. The UI is a pure status display
— this script pushes {"status": "idle"|"listening"|"thinking"|"talking"} over
a small WebSocket server so the orb can react in real time.
"""

import asyncio
import audioop
import io
import json
import logging
import os
import re
import wave
from collections.abc import AsyncIterator, Iterator
from contextlib import closing

import httpx
import numpy as np
import sounddevice as sd
import webrtcvad
import websockets
from dotenv import load_dotenv
from openai import OpenAI
from openwakeword.model import Model as WakeWordModel
from openwakeword.utils import download_models as download_wakeword_models

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("orchestrator")

# ── Config ──────────────────────────────────────────────────────────────────

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
HERMES_API_URL = os.getenv("HERMES_API_URL", "http://localhost:8000").rstrip("/")
HERMES_API_KEY = os.getenv("HERMES_API_KEY", "")

STATUS_WS_HOST = os.getenv("STATUS_WS_HOST", "0.0.0.0")
STATUS_WS_PORT = int(os.getenv("STATUS_WS_PORT", "8765"))

STT_LANGUAGE = os.getenv("STT_LANGUAGE", "es")
TTS_MODEL = os.getenv("TTS_MODEL", "tts-1-hd")
TTS_VOICE = os.getenv("TTS_VOICE", "nova")
TTS_SAMPLE_RATE = 24000  # fixed by OpenAI's "pcm" response format

MIC_SAMPLE_RATE = int(os.getenv("MIC_SAMPLE_RATE", "16000"))
MIC_DEVICE = os.getenv("MIC_DEVICE") or None
SPEAKER_DEVICE = os.getenv("SPEAKER_DEVICE") or None

# Wake word ("che parche"), via openWakeWord — see orchestrator/.env.example for
# how to train the custom model. Disabled by default: until the custom model is
# trained and validated, the mic just listens permanently (VAD-only, no gate).
WAKE_WORD_ENABLED = os.getenv("WAKE_WORD_ENABLED", "false").lower() == "true"
OWW_MODEL_PATH = os.getenv("OWW_MODEL_PATH")
OWW_THRESHOLD = float(os.getenv("OWW_THRESHOLD", "0.5"))
OWW_SAMPLE_RATE = 16000
OWW_CHUNK_SAMPLES = int(os.getenv("OWW_CHUNK_SAMPLES", "1280"))  # 80ms, openWakeWord's recommended chunk size

VAD_AGGRESSIVENESS = int(os.getenv("VAD_AGGRESSIVENESS", "2"))
FRAME_MS = 30
SPEECH_START_FRAMES = int(os.getenv("SPEECH_START_FRAMES", "3"))   # ~90ms of voice to trigger
SPEECH_END_FRAMES = int(os.getenv("SPEECH_END_FRAMES", "20"))      # ~600ms of silence to cut
MIN_UTTERANCE_MS = int(os.getenv("MIN_UTTERANCE_MS", "250"))
MIN_UTTERANCE_BYTES = MIC_SAMPLE_RATE * 2 * MIN_UTTERANCE_MS // 1000

HISTORY_LIMIT = 20

SENTENCE_BOUNDARY = re.compile(r"[^.!?\n]*[.!?\n]+")

openai_client = OpenAI(api_key=OPENAI_API_KEY)

wakeword_model = None
if WAKE_WORD_ENABLED:
    if not OWW_MODEL_PATH:
        raise RuntimeError("WAKE_WORD_ENABLED=true requires OWW_MODEL_PATH")
    download_wakeword_models()  # fetches the shared feature-extraction models (idempotent)
    wakeword_model = WakeWordModel(wakeword_models=[OWW_MODEL_PATH], inference_framework="onnx")

# ── Status WebSocket server ──────────────────────────────────────────────────

clients: set[websockets.WebSocketServerProtocol] = set()
current_status = "idle"


async def status_handler(websocket: websockets.WebSocketServerProtocol) -> None:
    clients.add(websocket)
    try:
        await websocket.send(json.dumps({"status": current_status}))
        async for _ in websocket:
            pass  # UI is display-only; incoming messages are ignored
    finally:
        clients.discard(websocket)


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
# Real mic/speaker hardware often refuses to open at an arbitrary rate
# (PortAudio "Invalid sample rate" — common with USB audio that only supports
# its own native rate, e.g. 44100). Instead of guessing MIC_SAMPLE_RATE per
# device, we always open the stream at whatever rate the device reports as its
# default, then resample in software with the stdlib `audioop` (no extra deps,
# works directly on 16-bit mono PCM).

def _query_native_rate(device: str | int | None, kind: str) -> int:
    info = sd.query_devices(device, kind) if device is not None else sd.query_devices(kind=kind)
    return int(info["default_samplerate"])


def _frames_at_rate(device: str | int | None, target_rate: int, frame_ms: int) -> Iterator[bytes]:
    """Yields fixed-size `frame_ms`-long PCM16 mono chunks at `target_rate`,
    resampling on the fly from the mic's native rate."""
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
            data, _ = stream.read(native_frame_samples)
            chunk = data.tobytes()
            if native_rate != target_rate:
                chunk, state = audioop.ratecv(chunk, 2, 1, native_rate, target_rate, state)
            buffer += chunk
            while len(buffer) >= frame_bytes:
                yield buffer[:frame_bytes]
                buffer = buffer[frame_bytes:]


# ── Wake word (blocking, runs in a worker thread) ───────────────────────────

def wait_for_wake_word() -> None:
    """Blocks until "che parche" is detected."""
    wakeword_model.reset()
    frame_ms = OWW_CHUNK_SAMPLES * 1000 // OWW_SAMPLE_RATE
    with closing(_frames_at_rate(MIC_DEVICE, OWW_SAMPLE_RATE, frame_ms)) as frames:
        for frame in frames:
            pcm = np.frombuffer(frame, dtype=np.int16)
            scores = wakeword_model.predict(pcm)
            if any(score >= OWW_THRESHOLD for score in scores.values()):
                return


# ── Mic capture + VAD (blocking, runs in a worker thread) ──────────────────

def capture_utterance() -> bytes | None:
    """Blocks until a full utterance (speech onset -> trailing silence) is captured."""
    vad = webrtcvad.Vad(VAD_AGGRESSIVENESS)
    triggered = False
    num_voiced = 0
    num_silence = 0
    voiced_frames: list[bytes] = []

    with closing(_frames_at_rate(MIC_DEVICE, MIC_SAMPLE_RATE, FRAME_MS)) as frames:
        for frame in frames:
            is_speech = vad.is_speech(frame, MIC_SAMPLE_RATE)

            if not triggered:
                if is_speech:
                    num_voiced += 1
                    voiced_frames.append(frame)
                    if num_voiced >= SPEECH_START_FRAMES:
                        triggered = True
                        num_silence = 0
                else:
                    num_voiced = 0
                    voiced_frames.clear()
            else:
                voiced_frames.append(frame)
                if is_speech:
                    num_silence = 0
                else:
                    num_silence += 1
                    if num_silence >= SPEECH_END_FRAMES:
                        break

    audio = b"".join(voiced_frames)
    if len(audio) < MIN_UTTERANCE_BYTES:
        return None
    return audio


def _pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


def _transcribe_sync(pcm: bytes) -> str:
    wav_bytes = _pcm_to_wav(pcm, MIC_SAMPLE_RATE)
    resp = openai_client.audio.transcriptions.create(
        model="whisper-1",
        file=("utterance.wav", wav_bytes, "audio/wav"),
        language=STT_LANGUAGE,
    )
    return resp.text


async def transcribe(pcm: bytes) -> str:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _transcribe_sync, pcm)


# ── Hermes streaming chat ────────────────────────────────────────────────────

async def stream_hermes(history: list[dict]) -> AsyncIterator[str]:
    url = f"{HERMES_API_URL}/v1/chat/completions"
    headers = {"Content-Type": "application/json"}
    if HERMES_API_KEY:
        headers["Authorization"] = f"Bearer {HERMES_API_KEY}"
    payload = {"model": "hermes", "messages": history, "stream": True}

    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    parsed = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = parsed.get("choices", [{}])[0].get("delta", {}).get("content", "")
                if delta:
                    yield delta


def extract_sentences(buffer: str) -> tuple[list[str], str]:
    """Splits complete sentences off the front of `buffer`, returns (sentences, remainder)."""
    sentences = []
    last_end = 0
    for m in SENTENCE_BOUNDARY.finditer(buffer):
        sentence = buffer[last_end:m.end()].strip()
        if sentence:
            sentences.append(sentence)
        last_end = m.end()
    return sentences, buffer[last_end:]


# ── OpenAI TTS + ordered playback ────────────────────────────────────────────

def _synthesize_sync(text: str) -> bytes:
    resp = openai_client.audio.speech.create(
        model=TTS_MODEL, voice=TTS_VOICE, input=text, response_format="pcm",
    )
    return resp.content


async def synthesize(text: str) -> bytes:
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(None, _synthesize_sync, text)
    except Exception:
        log.exception("TTS failed for sentence: %r", text)
        return b""


def _play_pcm_sync(pcm: bytes) -> None:
    if not pcm:
        return
    native_rate = _query_native_rate(SPEAKER_DEVICE, "output")
    if native_rate != TTS_SAMPLE_RATE:
        pcm, _ = audioop.ratecv(pcm, 2, 1, TTS_SAMPLE_RATE, native_rate, None)
    audio = np.frombuffer(pcm, dtype=np.int16)
    sd.play(audio, samplerate=native_rate, device=SPEAKER_DEVICE)
    sd.wait()


async def fill_tts_future(sentence: str, future: asyncio.Future) -> None:
    pcm = await synthesize(sentence)
    if not future.done():
        future.set_result(pcm)


async def playback_worker(queue: asyncio.Queue) -> None:
    """Plays audio futures strictly in order, regardless of TTS completion order."""
    loop = asyncio.get_running_loop()
    first_chunk = True
    while True:
        future = await queue.get()
        if future is None:
            break
        pcm = await future
        if first_chunk and pcm:
            await set_status("talking")
            first_chunk = False
        await loop.run_in_executor(None, _play_pcm_sync, pcm)


async def speak_turn(history: list[dict]) -> str:
    """Streams Hermes's reply, speaking it sentence-by-sentence as it arrives."""
    queue: asyncio.Queue = asyncio.Queue()
    playback_task = asyncio.create_task(playback_worker(queue))

    buffer = ""
    full_reply = ""

    async def schedule(sentence: str) -> None:
        future = asyncio.get_running_loop().create_future()
        await queue.put(future)
        asyncio.create_task(fill_tts_future(sentence, future))

    async for delta in stream_hermes(history):
        buffer += delta
        full_reply += delta
        sentences, buffer = extract_sentences(buffer)
        for sentence in sentences:
            await schedule(sentence)

    if buffer.strip():
        await schedule(buffer)

    await queue.put(None)
    await playback_task
    return full_reply


# ── Main conversation loop ───────────────────────────────────────────────────

async def conversation_loop() -> None:
    loop = asyncio.get_running_loop()
    history: list[dict] = []

    while True:
        try:
            if WAKE_WORD_ENABLED:
                await set_status("idle")
                await loop.run_in_executor(None, wait_for_wake_word)

            await set_status("listening")
            pcm = await loop.run_in_executor(None, capture_utterance)
            if not pcm:
                continue

            await set_status("thinking")
            text = await transcribe(pcm)
            if not text.strip():
                continue
            log.info("user: %s", text)

            history.append({"role": "user", "content": text})
            reply = await speak_turn(history)
            log.info("hermes: %s", reply)
            history.append({"role": "assistant", "content": reply})
            history[:] = history[-HISTORY_LIMIT:]

        except Exception:
            log.exception("turn failed, resetting to listening")
            await asyncio.sleep(0.5)


async def main() -> None:
    async with websockets.serve(status_handler, STATUS_WS_HOST, STATUS_WS_PORT):
        log.info("status WS listening on %s:%d", STATUS_WS_HOST, STATUS_WS_PORT)
        await conversation_loop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
