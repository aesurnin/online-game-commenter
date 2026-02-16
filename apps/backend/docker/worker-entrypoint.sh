#!/bin/bash
set -e

# Start Xvfb
Xvfb :99 -screen 0 1280x720x24 -ac &
XVFB_PID=$!

# Wait for Xvfb to be ready
sleep 2

# D-Bus (required for PulseAudio in Docker)
mkdir -p /var/run/dbus
dbus-uuidgen > /var/lib/dbus/machine-id 2>/dev/null || true
dbus-daemon --config-file=/usr/share/dbus-1/system.conf --fork 2>/dev/null || true
sleep 1

# Clean PulseAudio state (container restarts need fresh state)
rm -rf /var/run/pulse /var/lib/pulse /root/.config/pulse 2>/dev/null || true

# Start PulseAudio system daemon
pulseaudio -D --exit-idle-time=-1 --system --disallow-exit 2>/dev/null || true
sleep 2

# Create null sink for Chrome output and ffmpeg recording
pactl load-module module-null-sink sink_name=recording sink_properties=device.description=Recording 2>/dev/null || true
pactl set-default-sink recording 2>/dev/null || true

# Run the worker
exec "$@"
