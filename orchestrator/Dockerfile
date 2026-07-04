FROM python:3.11-slim

# libportaudio2/libasound2 for sounddevice (PortAudio) at runtime; pulseaudio
# for module-echo-cancel (acoustic echo cancellation on the mic — see
# docker-entrypoint.sh); gcc/python3-dev in case any dependency needs to
# compile a C extension on install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libportaudio2 \
    libasound2 \
    pulseaudio \
    pulseaudio-utils \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
# Routes the ALSA "default" PCM to the correct card/devices for this Pi's
# hardware (see the file for details, and how to update it if the card index
# changes). PulseAudio's module-alsa-sink/source (in docker-entrypoint.sh)
# talk to the same hw:2,x devices directly, so this mostly matters as a
# fallback if MIC_DEVICE/SPEAKER_DEVICE are ever unset.
COPY asound.conf /etc/asound.conf
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

EXPOSE 8765
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["python", "main.py"]
