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

# PulseAudio system-mode config: the container runs as root, so (a) native
# protocol connections need auth-anonymous (system mode's normal auth model
# expects a pulse-access group membership we don't have here), and (b) the
# ALSA sink/source + module-echo-cancel (WebRTC AEC3) are loaded straight from
# this startup script rather than via `pactl` after the fact — avoids a race
# where a client tries to connect before the daemon is actually ready.
# "hw:2,x" is this Pi's current USB enumeration for the Astro MixAmp Pro — see
# orchestrator/asound.conf if that card index ever changes.
RUN sed -i 's/^load-module module-native-protocol-unix.*/load-module module-native-protocol-unix auth-anonymous=1/' /etc/pulse/system.pa && \
    printf '\n# Parche orchestrator: route the MixAmp Pro through echo cancellation.\nload-module module-alsa-sink device=hw:2,0 sink_name=mixamp_out\nload-module module-alsa-source device=hw:2,1 source_name=mixamp_in\nload-module module-echo-cancel source_master=mixamp_in sink_master=mixamp_out source_name=echo_cancelled_mic sink_name=echo_cancelled_speaker aec_method=webrtc\n' >> /etc/pulse/system.pa
ENV PULSE_SERVER=unix:/var/run/pulse/native

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
# Routes the ALSA "default" PCM to the correct card/devices for this Pi's
# hardware (see the file for details, and how to update it if the card index
# changes). PulseAudio's module-alsa-sink/source (baked into system.pa above)
# talk to the same hw:2,x devices directly, so this mostly matters as a
# fallback if MIC_DEVICE/SPEAKER_DEVICE are ever unset.
COPY asound.conf /etc/asound.conf
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

EXPOSE 8765
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["python", "main.py"]
