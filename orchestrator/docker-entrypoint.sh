#!/bin/sh
# Starts a headless PulseAudio instance and wires up module-echo-cancel
# (WebRTC AEC3) between the MixAmp's physical mic/speaker, so the Realtime
# API's mic never picks up Parche's own voice from the speaker. See
# orchestrator/asound.conf for the underlying ALSA card/device numbers this
# depends on (card 2 on this Pi — check /proc/asound/cards if that changes).
set -e

# --system: the container runs as root, and PulseAudio's normal per-user mode
# (what --start assumes) refuses to run as root at all. No
# --disallow-module-loading, since we need pactl load-module to work below.
pulseaudio --system --daemonize=true --disallow-exit --exit-idle-time=-1 --log-target=stderr
sleep 2

# Physical hardware, direct ALSA (bypasses the asound.conf "default" combo —
# PulseAudio owns the routing now).
pactl load-module module-alsa-sink device=hw:2,0 sink_name=mixamp_out
pactl load-module module-alsa-source device=hw:2,1 source_name=mixamp_in

# Echo-cancelled virtual pair the app actually talks to. aec_method=webrtc
# uses the same AEC3 algorithm browsers/WebRTC clients use.
pactl load-module module-echo-cancel \
    source_master=mixamp_in sink_master=mixamp_out \
    source_name=echo_cancelled_mic sink_name=echo_cancelled_speaker \
    aec_method=webrtc

exec "$@"
