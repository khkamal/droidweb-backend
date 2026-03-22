#!/bin/bash
# ── DroidWeb Start Script ────────────────────────────────────────────────────
echo "=== DroidWeb Backend Starting ==="

# Find ADB
ADB=$(which adb 2>/dev/null || find / -name "adb" -type f 2>/dev/null | head -1)
export ADB
echo "ADB: $ADB"

# 1. Start Node.js IMMEDIATELY
echo "[1/3] Starting Node.js on port ${PORT:-3000}..."
node /app/src/index.js &
NODE_PID=$!

# 2. Start Android using budtmo built-in launcher
echo "[2/3] Starting Android emulator via budtmo..."
/root/start.sh &

# 3. Wait for boot
echo "[3/3] Waiting for Android boot..."
MAX_WAIT=240
COUNT=0
while [ $COUNT -lt $MAX_WAIT ]; do
  BOOT=$($ADB -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  if [ "$BOOT" = "1" ]; then
    echo "Android booted!"
    $ADB -s emulator-5554 shell input keyevent 82 2>/dev/null || true
    $ADB -s emulator-5554 shell input keyevent 4  2>/dev/null || true
    break
  fi
  echo "  Waiting... ${COUNT}s"
  sleep 5
  COUNT=$((COUNT+5))
done

wait $NODE_PID
