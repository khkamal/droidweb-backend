#!/bin/bash
# ── DroidWeb Start Script (budtmo/docker-android base) ──────────────────────
set -e

echo "=== DroidWeb Backend Starting ==="

# 1. Start the Android emulator (budtmo handles this)
echo "[1/3] Starting Android emulator..."
/opt/android/start.sh &
ANDROID_PID=$!

# 2. Wait for ADB to be ready
echo "[2/3] Waiting for Android to boot (60-90 seconds)..."
export ADB=/opt/android/sdk/platform-tools/adb

MAX_WAIT=180
COUNT=0
while [ $COUNT -lt $MAX_WAIT ]; do
  BOOT=$($ADB shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  if [ "$BOOT" = "1" ]; then
    echo "Android booted!"
    break
  fi
  echo "  Waiting... ${COUNT}s"
  sleep 5
  COUNT=$((COUNT+5))
done

# Unlock screen
$ADB shell input keyevent 82 2>/dev/null || true
$ADB shell input keyevent 4  2>/dev/null || true

# 3. Start Node.js server
echo "[3/3] Starting Node.js backend..."
exec node /app/src/index.js
