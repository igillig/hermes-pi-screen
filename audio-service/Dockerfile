FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Piper TTS binary (aarch64 for Pi 5)
RUN mkdir -p /opt/piper && \
    curl -fsSL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz \
    | tar -xz -C /opt/piper --strip-components=1 && \
    ln -s /opt/piper/piper /usr/local/bin/piper

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download Whisper model so first request isn't slow
ARG WHISPER_MODEL=small
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

# Download Piper voice model
ARG PIPER_VOICE=es_ES-davefx-medium
RUN mkdir -p /app/models && \
    curl -fsSL \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium/${PIPER_VOICE}.onnx" \
      -o "/app/models/${PIPER_VOICE}.onnx" && \
    curl -fsSL \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium/${PIPER_VOICE}.onnx.json" \
      -o "/app/models/${PIPER_VOICE}.onnx.json"

COPY main.py .

ENV WHISPER_MODEL=${WHISPER_MODEL}
ENV PIPER_VOICE=${PIPER_VOICE}

EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
