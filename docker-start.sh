#!/bin/bash
# ── DroidWeb Start Script ────────────────────────────────────────────────────

echo "=== DroidWeb Backend Starting ==="

export ADB=/opt/android/sdk/platform-tools/adb

# 1. Start Node.js IMMEDIATELY so Render detects the port
echo "[1/3] Starting Node.js backend on port ${PORT:-3000}..."
node /app/src/index.js &
NODE_PID=$!

# 2. Start Android emulator in background
echo "[2/3] Starting Android emulator in background..."
/opt/android/start.sh &

# 3. Wait for Android to boot then unlock screen
echo "[3/3] Waiting for Android to boot..."
MAX_WAIT=180
COUNT=0
while [ $COUNT -lt $MAX_WAIT ]; do
  BOOT=$($ADB shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  if [ "$BOOT" = "1" ]; then
    echo "Android booted successfully!"
    $ADB shell input keyevent 82 2>/dev/null || true
    $ADB shell input keyevent 4  2>/dev/null || true
    break
  fi
  echo "  Waiting for Android... ${COUNT}s"
  sleep 5
  COUNT=$((COUNT+5))
done

# Keep container alive
wait $NODE_PID
