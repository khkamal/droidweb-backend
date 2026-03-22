/**
 * DroidWeb Backend
 * Node.js server that:
 *  - Receives APK uploads
 *  - Launches Android-x86 via QEMU
 *  - Streams screen via MJPEG → WebSocket base64 frames
 *  - Forwards ADB / touch / key events
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { spawn, exec } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const ADB = process.env.ADB_PATH || 'adb';
const EMULATOR = process.env.EMULATOR_PATH || 'emulator';
const AVD_NAME = process.env.AVD_NAME || 'droidweb_avd';
const ANDROID_VERSION = process.env.ANDROID_VERSION || '13.0';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Bypass ngrok browser warning
app.use((req, res, next) => { res.setHeader("ngrok-skip-browser-warning", "true"); next(); });

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ── In-memory sessions ────────────────────────────────────────────────────────
const sessions = new Map(); // sessionId → { ws, emulatorProcess, streamInterval }

// ── Multer upload ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const appId = uuidv4();
    req.appId = appId;
    cb(null, appId + '.apk');
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (req, file, cb) => {
    cb(null, file.originalname.endsWith('.apk'));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REST ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Health / status
app.get('/api/status', (req, res) => {
  checkAdb((adbOk) => {
    res.json({
      status: 'ok',
      android_version: ANDROID_VERSION,
      ram: '2 GB',
      storage: '8 GB',
      adb_ready: adbOk,
      active_sessions: sessions.size
    });
  });
});

// Upload APK
app.post('/api/upload', upload.single('apk'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No APK file received' });
  const appId = req.appId || path.basename(req.file.filename, '.apk');
  console.log(`[upload] APK received: ${req.file.originalname} → ${appId}`);
  res.json({ app_id: appId, filename: req.file.originalname, size: req.file.size });
});

// ADB command
app.post('/api/adb', (req, res) => {
  const { command, session_id } = req.body;
  if (!command) return res.status(400).json({ error: 'No command' });
  // Basic sanitization
  const safe = command.replace(/[;&|`$]/g, '');
  exec(`${ADB} ${safe}`, { timeout: 10000 }, (err, stdout, stderr) => {
    res.json({
      output: stdout || '',
      error: stderr || (err ? err.message : null)
    });
  });
});

// Screenshot
app.get('/api/screenshot', (req, res) => {
  exec(`${ADB} exec-out screencap -p`, { encoding: 'buffer', timeout: 8000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Screenshot failed' });
    res.set('Content-Type', 'image/png');
    res.send(stdout);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const sessionId = uuidv4();
  console.log(`[ws] New connection — session ${sessionId}`);

  sessions.set(sessionId, { ws, streamInterval: null, emulatorProcess: null });
  ws.send(JSON.stringify({ type: 'session', id: sessionId }));
  ws.send(JSON.stringify({ type: 'log', text: 'Session started', level: 'info' }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const session = sessions.get(sessionId);

    switch (msg.type) {
      case 'launch':
        handleLaunch(sessionId, msg.app_id, msg.app_id);
        break;
      case 'key':
        handleKey(sessionId, msg.key);
        break;
      case 'touch':
        handleTouch(sessionId, msg);
        break;
      case 'restart':
        restartEmulator(sessionId);
        break;
      default:
        console.log(`[ws] Unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    console.log(`[ws] Session ${sessionId} closed`);
    cleanupSession(sessionId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EMULATOR CONTROL
// ─────────────────────────────────────────────────────────────────────────────

async function handleLaunch(sessionId, appId, appName) {
  const session = sessions.get(sessionId);
  if (!session) return;
  wsSend(session.ws, { type: 'log', text: `Launching ${appName || appId}...`, level: 'info' });

  // Check if emulator is already running
  checkAdb(async (adbOk) => {
    if (!adbOk) {
      // Start emulator first
      wsSend(session.ws, { type: 'log', text: 'Starting Android emulator...', level: 'info' });
      await startEmulator(sessionId);
      await sleep(30000); // Wait for boot
    }

    // Install APK if it's a UUID (real upload) not a demo key
    const apkPath = path.join(UPLOAD_DIR, appId + '.apk');
    if (fs.existsSync(apkPath)) {
      wsSend(session.ws, { type: 'log', text: 'Installing APK...', level: 'info' });
      await adbInstall(apkPath, session.ws);
      await sleep(3000);
      await adbLaunchApk(apkPath, session.ws);
    } else {
      // Built-in demo app key
      wsSend(session.ws, { type: 'log', text: `Opening ${appId}...`, level: 'info' });
      adbLaunchBuiltin(appId, session.ws);
    }

    // Start streaming screen
    startScreenStream(sessionId);
  });
}

function startEmulator(sessionId) {
  return new Promise((resolve) => {
    const session = sessions.get(sessionId);
    if (!session) return resolve();

    const proc = spawn(EMULATOR, [
      '-avd', AVD_NAME,
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      '-wipe-data',
      '-memory', '2048',
      '-cores', '2'
    ]);

    session.emulatorProcess = proc;

    proc.stdout.on('data', (d) => {
      const line = d.toString().trim();
      if (line) wsSend(session.ws, { type: 'log', text: line, level: 'system' });
    });
    proc.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) wsSend(session.ws, { type: 'log', text: line, level: 'warn' });
    });
    proc.on('spawn', resolve);
    proc.on('error', (err) => {
      wsSend(session.ws, { type: 'log', text: 'Emulator error: ' + err.message, level: 'error' });
      resolve();
    });
  });
}

function startScreenStream(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Stop existing stream
  if (session.streamInterval) clearInterval(session.streamInterval);

  let frameCount = 0;
  session.streamInterval = setInterval(() => {
    exec(`${ADB} exec-out screencap -p`, { encoding: 'buffer', timeout: 3000 }, (err, stdout) => {
      if (err || !stdout || stdout.length < 100) return;
      const b64 = stdout.toString('base64');
      wsSend(session.ws, { type: 'frame', data: b64 });
      if (frameCount === 0) {
        wsSend(session.ws, { type: 'ready' });
      }
      frameCount++;
    });
  }, 200); // 5 fps — good for free tier
}

function adbInstall(apkPath, ws) {
  return new Promise((resolve) => {
    exec(`${ADB} install -r "${apkPath}"`, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        wsSend(ws, { type: 'log', text: 'Install error: ' + stderr, level: 'error' });
      } else {
        wsSend(ws, { type: 'log', text: 'APK installed successfully', level: 'info' });
      }
      resolve();
    });
  });
}

async function adbLaunchApk(apkPath, ws) {
  // Get package name from APK using aapt
  return new Promise((resolve) => {
    exec(`aapt dump badging "${apkPath}" | grep package | awk -F\' '/package: name/{print $2}'`,
      { timeout: 10000 }, (err, stdout) => {
        const pkg = stdout.trim();
        if (!pkg) { resolve(); return; }
        wsSend(ws, { type: 'log', text: `Launching ${pkg}`, level: 'info' });
        exec(`${ADB} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, resolve);
      });
  });
}

function adbLaunchBuiltin(appId, ws) {
  const intents = {
    calculator: 'com.android.calculator2/.Calculator',
    settings:   'com.android.settings/.Settings',
    browser:    'com.android.browser/.BrowserActivity',
    terminal:   'jackpal.androidterm/.Term',
    files:      'com.android.documentsui/.FilesActivity',
    camera:     'com.android.camera2/.CaptureActivity',
    maps:       'com.google.android.maps/.MapsActivity',
  };
  const intent = intents[appId];
  if (intent) {
    exec(`${ADB} shell am start -n ${intent}`, (err) => {
      wsSend(ws, { type: 'log', text: err ? `Cannot open ${appId}` : `Opened ${appId}`, level: err ? 'warn' : 'info' });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INPUT HANDLING
// ─────────────────────────────────────────────────────────────────────────────

function handleKey(sessionId, key) {
  const keyMap = {
    back:       'KEYCODE_BACK',
    home:       'KEYCODE_HOME',
    recent:     'KEYCODE_APP_SWITCH',
    volumeup:   'KEYCODE_VOLUME_UP',
    volumedown: 'KEYCODE_VOLUME_DOWN',
    menu:       'KEYCODE_MENU',
    rotate:     'KEYCODE_ROTATE',
  };
  if (key === 'screenshot') {
    takeScreenshot(sessionId); return;
  }
  const kcode = keyMap[key];
  if (kcode) exec(`${ADB} shell input keyevent ${kcode}`);
}

function handleTouch(sessionId, msg) {
  if (msg.gesture === 'tap') {
    exec(`${ADB} shell input tap ${msg.x} ${msg.y}`);
  } else if (msg.gesture === 'swipe') {
    exec(`${ADB} shell input swipe ${msg.x} ${msg.y} ${msg.x2} ${msg.y2} 300`);
  }
}

function takeScreenshot(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  exec(`${ADB} exec-out screencap -p`, { encoding: 'buffer', timeout: 5000 }, (err, stdout) => {
    if (!err && stdout) {
      wsSend(session.ws, { type: 'screenshot', data: stdout.toString('base64') });
      wsSend(session.ws, { type: 'log', text: 'Screenshot captured', level: 'info' });
    }
  });
}

function restartEmulator(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.streamInterval) clearInterval(session.streamInterval);
  if (session.emulatorProcess) session.emulatorProcess.kill();
  session.emulatorProcess = null;
  wsSend(session.ws, { type: 'log', text: 'Emulator restarted', level: 'warn' });
  wsSend(session.ws, { type: 'restart' });
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

function checkAdb(cb) {
  exec(`${ADB} get-state`, { timeout: 3000 }, (err, stdout) => {
    cb(!err && stdout.trim() === 'device');
  });
}

function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    if (session.streamInterval) clearInterval(session.streamInterval);
    if (session.emulatorProcess) session.emulatorProcess.kill('SIGTERM');
  }
  sessions.delete(sessionId);
}

function wsSend(ws, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`DroidWeb backend running on port ${PORT}`);
  console.log(`Android version: ${ANDROID_VERSION}`);
  console.log(`Upload dir: ${UPLOAD_DIR}`);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  sessions.forEach((_, id) => cleanupSession(id));
  server.close(() => process.exit(0));
});
