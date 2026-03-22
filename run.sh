#!/bin/bash
echo "✅ Android is running!"
adb devices

# Start Node.js backend
node src/index.js &
sleep 4
echo "Node.js status:"
curl -s http://localhost:3000/api/status

# Start ngrok
ngrok config add-authtoken $NGROK_TOKEN
ngrok http 3000 &

# Wait for ngrok to be ready
echo "Waiting for ngrok..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tunnels'][0]['public_url'])" 2>/dev/null)
  if [ -n "$URL" ]; then
    break
  fi
  echo "  Attempt $i..."
done

echo ""
echo "========================================"
echo "  ANDROID EMULATOR IS LIVE!"
echo "  URL: $URL"
echo "  Paste this into droidweb.vercel.app"
echo "========================================"

# Keep alive for 6 hours
MINS=0
while true; do
  sleep 60
  MINS=$((MINS + 1))
  BOOT=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || echo "?")
  echo "[${MINS}min] Android:$BOOT | URL:$URL"
done
