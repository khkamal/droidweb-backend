#!/bin/bash
# ── DroidWeb Docker Startup Script ──────────────────────────────────────────
set -e

echo "=== DroidWeb Backend Starting ==="

# 1. Start virtual display (needed for emulator even in headless mode)
echo "[1/4] Starting virtual display..."
Xvfb :1 -screen 0 1080x1920x24 &
export DISPLAY=:1
sleep 2

# 2. Start Android emulator
echo "[2/4] Starting Android emulator (this takes ~60 seconds)..."
emulator \
  -avd "${AVD_NAME:-droidweb_avd}" \
  -no-window \
  -no-audio \
  -no-boot-anim \
  -no-snapshot \
  -gpu swiftshader_indirect \
  -memory 2048 \
  -cores 2 \
  &

EMULATOR_PID=$!
echo "Emulator PID: $EMULATOR_PID"

# 3. Wait for ADB device to be ready
echo "[3/4] Waiting for Android to boot..."
MAX_WAIT=120
COUNT=0
while [ $COUNT -lt $MAX_WAIT ]; do
  BOOT_STATUS=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  if [ "$BOOT_STATUS" = "1" ]; then
    echo "Android booted successfully!"
    break
  fi
  echo "  Waiting... (${COUNT}s / ${MAX_WAIT}s)"
  sleep 5
  COUNT=$((COUNT + 5))
done

if [ $COUNT -ge $MAX_WAIT ]; then
  echo "WARNING: Emulator boot timeout — continuing anyway"
fi

# Unlock screen
adb shell input keyevent 82 2>/dev/null || true
adb shell input keyevent 4  2>/dev/null || true

# 4. Start Node.js backend
echo "[4/4] Starting DroidWeb Node.js backend..."
exec node /app/src/index.js
