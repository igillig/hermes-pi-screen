#!/bin/sh
# Starts a headless PulseAudio instance (module loading — ALSA sink/source +
# module-echo-cancel — is baked into /etc/pulse/system.pa at build time, see
# Dockerfile) so the Realtime API's mic never picks up Parche's own voice from
# the speaker.
set -e

# Clean up leftover state from a previous crashed attempt — `restart:
# unless-stopped` in stack.yml restarts this same container (not a fresh one)
# on failure, and stale PulseAudio runtime files confuse the next start.
rm -rf /var/run/pulse /tmp/pulse-* 2>/dev/null || true

# --system: the container runs as root, and PulseAudio's normal per-user mode
# (what --start assumes) refuses to run as root at all.
pulseaudio --system --daemonize=true --disallow-exit --exit-idle-time=-1 --log-target=stderr
sleep 2

exec "$@"
