import io
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from faster_whisper import WhisperModel
from pydantic import BaseModel

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
PIPER_VOICE   = os.getenv("PIPER_VOICE", "es_ES-davefx-medium")
MODEL_DIR     = Path("/app/models")

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Load at startup — keeps latency low per request
whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")


class SpeakRequest(BaseModel):
    text: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    data = await audio.read()
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
        f.write(data)
        tmp = f.name
    try:
        segments, _ = whisper.transcribe(tmp, language="es")
        text = " ".join(s.text for s in segments).strip()
        return {"text": text}
    finally:
        os.unlink(tmp)


@app.post("/speak")
def speak(req: SpeakRequest):
    model_path = MODEL_DIR / f"{PIPER_VOICE}.onnx"
    if not model_path.exists():
        raise HTTPException(500, f"Piper model not found: {model_path}")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name

    try:
        proc = subprocess.run(
            ["piper", "--model", str(model_path), "--output_file", wav_path],
            input=req.text.encode(),
            capture_output=True,
        )
        if proc.returncode != 0:
            raise HTTPException(500, f"Piper error: {proc.stderr.decode()}")

        with open(wav_path, "rb") as f:
            wav_bytes = f.read()
    finally:
        os.unlink(wav_path)

    return StreamingResponse(io.BytesIO(wav_bytes), media_type="audio/wav")
