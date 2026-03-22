#!/bin/bash
echo "✅ Android is running!"
adb devices

# Start Node.js backend
node src/index.js &
sleep 4
echo "Node.js status:"
curl -s http://localhost:3000/api/status

# Configure and start ngrok with browser warning disabled
ngrok config add-authtoken $NGROK_TOKEN

# Create ngrok config to skip browser warning
cat > /home/runner/.config/ngrok/ngrok.yml << 'NGROKEOF'
version: "2"
authtoken: PLACEHOLDER
tunnels:
  droidweb:
    proto: http
    addr: 3000
    inspect: false
    request_header:
      add:
        - "ngrok-skip-browser-warning: true"
NGROKEOF

# Replace placeholder with real token
sed -i "s/PLACEHOLDER/$NGROK_TOKEN/" /home/runner/.config/ngrok/ngrok.yml

# Start ngrok
ngrok start droidweb &

# Wait for ngrok to be ready
echo "Waiting for ngrok tunnel..."
URL=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  sleep 3
  URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['tunnels'][0]['public_url'])
except:
    print('')
" 2>/dev/null)
  if [ -n "$URL" ]; then
    echo "✅ ngrok tunnel ready!"
    break
  fi
  echo "  Attempt $i/15..."
done

echo ""
echo "========================================"
echo "  ANDROID EMULATOR IS LIVE!"
echo "  URL: $URL"
echo "  Paste this into droidweb.vercel.app"
echo "========================================"

# Test the backend is reachable
echo "Testing backend..."
curl -s "$URL/api/status" -H "ngrok-skip-browser-warning: true" || echo "Backend test done"

# Keep alive for 6 hours
MINS=0
while true; do
  sleep 60
  MINS=$((MINS + 1))
  BOOT=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || echo "?")
  echo "[${MINS}min] Android:$BOOT | URL:$URL"
done
