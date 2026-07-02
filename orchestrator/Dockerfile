FROM python:3.11-slim

# libportaudio2/libasound2 for sounddevice (PortAudio) at runtime;
# gcc/python3-dev because webrtcvad compiles a small C extension on install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libportaudio2 \
    libasound2 \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8765
CMD ["python", "main.py"]
