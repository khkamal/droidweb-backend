/**
 * DroidWeb Backend — Fixed version
 */
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const ADB = process.env.ADB_PATH || 'adb';
const ANDROID_VERSION = process.env.ANDROID_VERSION || '13.0';
const ADB_SERIAL = 'emulator-5554';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Bypass ngrok browser warning
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sessions = new Map();

// ── Multer ──
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const appId = uuidv4();
    req.appId = appId;
    // Save original name mapping
    const mapFile = path.join(UPLOAD_DIR, appId + '.name');
    fs.writeFileSync(mapFile, file.originalname);
    cb(null, appId + '.apk');
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── REST ──
app.get('/api/status', (req, res) => {
  adbCmd('get-state', (err, out) => {
    res.json({
      status: 'ok',
      android_version: ANDROID_VERSION,
      ram: '4 GB',
      storage: '8 GB',
      adb_ready: !err && out.trim() === 'device'
    });
  });
});

app.post('/api/upload', upload.single('apk'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No APK' });
  const appId = req.appId || path.basename(req.file.filename, '.apk');
  const origName = req.file.originalname;
  console.log(`[upload] ${origName} → ${appId}`);
  res.json({ app_id: appId, filename: origName, size: req.file.size });
});

app.post('/api/adb', (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'No command' });
  const safe = command.replace(/[;&|`$]/g, '');
  adbCmd(safe, (err, out, stderr) => {
    res.json({ output: out || '', error: stderr || (err ? err.message : null) });
  });
});

app.get('/api/screenshot', (req, res) => {
  adbRaw(`-s ${ADB_SERIAL} exec-out screencap -p`, (err, buf) => {
    if (err) return res.status(500).json({ error: 'Screenshot failed' });
    res.set('Content-Type', 'image/png');
    res.send(buf);
  });
});

// ── WebSocket ──
wss.on('connection', (ws) => {
  const sessionId = uuidv4();
  console.log(`[ws] Session ${sessionId}`);
  sessions.set(sessionId, { ws, streamInterval: null });
  ws.send(JSON.stringify({ type: 'session', id: sessionId }));
  ws.send(JSON.stringify({ type: 'log', text: 'Connected to Android backend', level: 'info' }));

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'launch':        handleLaunch(sessionId, msg.app_id); break;
      case 'stream_only':   startScreenStream(sessionId); break;
      case 'launch_intent': handleIntent(sessionId, msg.pkg, msg.label); break;
      case 'adb_cmd':       handleAdbCmd(msg.cmd, ws); break;
      case 'key':    handleKey(msg.key); break;
      case 'keycode': handleKeycode(msg.code); break;
      case 'text':    handleText(msg.text); break;
      case 'touch':   handleTouch(msg); break;
      case 'adb':     handleAdbCmd(msg.cmd, ws); break;
      case 'restart': wsSend(ws, { type: 'log', text: 'Restart not needed — emulator managed by GitHub Actions', level: 'warn' }); break;
    }
  });

  ws.on('close', () => cleanupSession(sessionId));
});

// ── Launch ──
async function handleLaunch(sessionId, appId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const { ws } = session;

  wsSend(ws, { type: 'log', text: `Launching ${appId.substring(0,8)}...`, level: 'info' });

  const apkPath = path.join(UPLOAD_DIR, appId + '.apk');

  if (fs.existsSync(apkPath)) {
    // APK already installed before? Just launch it
    // Check if we have saved package name
    const pkgFile = path.join(UPLOAD_DIR, appId + '.pkg');
    if (fs.existsSync(pkgFile)) {
      const pkg = fs.readFileSync(pkgFile, 'utf8').trim();
      if (pkg) {
        wsSend(ws, { type: 'log', text: `Launching ${pkg}`, level: 'info' });
        exec(`${ADB} -s ${ADB_SERIAL} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 8000 }, () => {});
        await sleep(2000);
        startScreenStream(sessionId);
        return;
      }
    }
    // First time - install it
    wsSend(ws, { type: 'log', text: 'Installing APK...', level: 'info' });
    await adbInstall(apkPath, ws);
    await sleep(2000);
    const pkg = await adbLaunchApk(apkPath, ws);
    if (pkg) {
      fs.writeFileSync(pkgFile, pkg);
      wsSend(ws, { type: 'pkg', app_id: appId, pkg: pkg });
    }
  } else {
    wsSend(ws, { type: 'log', text: `Streaming current screen`, level: 'info' });
  }

  await sleep(1500);
  startScreenStream(sessionId);
}

// ── Launch by intent (system apps) ──
async function handleIntent(sessionId, pkg, label) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const { ws } = session;
  wsSend(ws, { type: 'log', text: `Opening ${label}...`, level: 'info' });
  exec(`${ADB} -s ${ADB_SERIAL} shell am start -n ${pkg}`, { timeout: 8000 }, (err) => {
    if (err) {
      // Try monkey as fallback
      const pkg2 = pkg.split('/')[0];
      exec(`${ADB} -s ${ADB_SERIAL} shell monkey -p ${pkg2} -c android.intent.category.LAUNCHER 1`, { timeout: 8000 }, () => {});
      wsSend(ws, { type: 'log', text: `Opening ${label} via launcher`, level: 'info' });
    } else {
      wsSend(ws, { type: 'log', text: `${label} opened`, level: 'info' });
    }
  });
  await sleep(1500);
  startScreenStream(sessionId);
}

// ── Screen stream ──
function startScreenStream(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.streamInterval) clearInterval(session.streamInterval);

  let frameCount = 0;
  let errCount = 0;
  wsSend(session.ws, { type: 'log', text: 'Starting screen stream...', level: 'info' });

  // Test screencap first
  exec(`${ADB} -s ${ADB_SERIAL} shell screencap -p /sdcard/test_frame.png`, { timeout: 5000 }, (testErr) => {
    if (testErr) {
      wsSend(session.ws, { type: 'log', text: 'screencap test failed: ' + testErr.message, level: 'error' });
    } else {
      wsSend(session.ws, { type: 'log', text: 'screencap test OK — streaming...', level: 'info' });
    }
  });

  session.streamInterval = setInterval(() => {
    // Use shell screencap save to file then pull — more reliable than exec-out
    const tmpFile = `/tmp/frame_${sessionId}.png`;
    exec(`${ADB} -s ${ADB_SERIAL} shell screencap -p /sdcard/frame.png && ${ADB} -s ${ADB_SERIAL} pull /sdcard/frame.png ${tmpFile}`,
      { timeout: 5000 }, (err) => {
        if (err) {
          errCount++;
          if (errCount % 10 === 1) console.log('[stream] frame error:', err.message);
          // Fallback: try exec-out directly
          exec(`${ADB} -s ${ADB_SERIAL} exec-out screencap -p`, { encoding: 'buffer', timeout: 4000 }, (err2, buf) => {
            if (!err2 && buf && buf.length > 500) sendFrame(buf);
          });
          return;
        }
        // Read the pulled file
        fs.readFile(tmpFile, (readErr, buf) => {
          if (readErr || !buf || buf.length < 200) return;
          sendFrame(buf);
        });
      });

    function sendFrame(buf) {
      const b64 = buf.toString('base64');
      wsSend(session.ws, { type: 'frame', data: b64 });
      if (frameCount === 0) {
        wsSend(session.ws, { type: 'ready' });
        wsSend(session.ws, { type: 'log', text: '✅ Screen streaming started!', level: 'info' });
      }
      frameCount++;
      errCount = 0;
    }
  }, 500); // 2 fps — reliable
}

// ── APK install ──
function adbInstall(apkPath, ws) {
  return new Promise((resolve) => {
    exec(`${ADB} -s ${ADB_SERIAL} install -r "${apkPath}"`, { timeout: 120000 }, (err, out, stderr) => {
      if (err) wsSend(ws, { type: 'log', text: 'Install error: ' + (stderr || err.message), level: 'error' });
      else wsSend(ws, { type: 'log', text: 'APK installed!', level: 'info' });
      resolve();
    });
  });
}

// ── Launch APK — install then find package via pm list ──
async function adbLaunchApk(apkPath, ws) {
  return new Promise((resolve) => {
    // Try aapt2 first (fastest)
    exec(`aapt2 dump packagename "${apkPath}" 2>/dev/null`, { timeout: 6000 }, (err, out) => {
      let pkg = (out || '').trim().split('\n')[0].trim();
      if (pkg && pkg.includes('.')) {
        launchPackage(pkg, ws, resolve);
        return;
      }
      // Try aapt
      exec(`aapt dump badging "${apkPath}" 2>/dev/null`, { timeout: 6000 }, (e2, o2) => {
        const m = (o2||'').match(/package: name='([^']+)'/);
        pkg = m ? m[1] : '';
        if (pkg) {
          launchPackage(pkg, ws, resolve);
          return;
        }
        // Last resort: scan pm list for recently installed package
        wsSend(ws, { type: 'log', text: 'Scanning installed packages...', level: 'info' });
        exec(`${ADB} -s ${ADB_SERIAL} shell pm list packages -3 2>/dev/null`,
          { timeout: 10000 }, (e3, o3) => {
            const lines = (o3||'').trim().split('\n').filter(l => l.startsWith('package:'));
            if (lines.length > 0) {
              // Get last installed (most recent)
              pkg = lines[lines.length - 1].replace('package:', '').trim();
              launchPackage(pkg, ws, resolve);
            } else {
              wsSend(ws, { type: 'log', text: 'APK installed — open it from the Android home screen', level: 'warn' });
              resolve();
            }
          });
      });
    });
  });
}

function launchPackage(pkg, ws, resolve) {
  if (!pkg) {
    wsSend(ws, { type: 'log', text: 'APK installed — streaming screen', level: 'warn' });
    resolve(''); return;
  }
  wsSend(ws, { type: 'log', text: `Launching ${pkg}...`, level: 'info' });
  exec(`${ADB} -s ${ADB_SERIAL} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`,
    { timeout: 10000 }, (err) => {
      if (err) wsSend(ws, { type: 'log', text: 'Launch error: ' + err.message, level: 'error' });
      else wsSend(ws, { type: 'log', text: `${pkg} launched!`, level: 'info' });
      resolve(pkg);
    });
}

// ── Builtin apps ──
function adbLaunchBuiltin(appId, ws) {
  const intents = {
    calculator: 'com.android.calculator2/.Calculator',
    settings:   'com.android.settings/.Settings',
    files:      'com.android.documentsui/.FilesActivity',
    camera:     'com.android.camera2/.CaptureActivity',
  };
  const intent = intents[appId];
  if (intent) {
    exec(`${ADB} -s ${ADB_SERIAL} shell am start -n ${intent}`, (err) => {
      wsSend(ws, { type: 'log', text: err ? `Cannot open ${appId}` : `Opened ${appId}`, level: err ? 'warn' : 'info' });
    });
  } else {
    wsSend(ws, { type: 'log', text: `Unknown app: ${appId}`, level: 'warn' });
  }
}

// ── Input ──
function handleKey(key) {
  const map = {
    back:       'KEYCODE_BACK',
    home:       'KEYCODE_HOME',
    recent:     'KEYCODE_APP_SWITCH',
    volumeup:   'KEYCODE_VOLUME_UP',
    volumedown: 'KEYCODE_VOLUME_DOWN',
    menu:       'KEYCODE_MENU',
    screenshot: 'KEYCODE_SYSRQ',
    rotate:     'KEYCODE_ROTATE_90',
  };
  const k = map[key];
  if (k) exec(`${ADB} -s ${ADB_SERIAL} shell input keyevent ${k}`);
}

function handleKeycode(code) {
  // Direct keycode from keyboard input
  exec(`${ADB} -s ${ADB_SERIAL} shell input keyevent ${code}`);
}

function handleText(text) {
  // Type text character — escape special chars for shell
  const escaped = text.replace(/[\\$`"'&|;<>(){}!#]/g, '\\$&').replace(/ /g, '%s');
  exec(`${ADB} -s ${ADB_SERIAL} shell input text "${escaped}"`);
}

function handleTouch(msg) {
  if (msg.gesture === 'tap') {
    exec(`${ADB} -s ${ADB_SERIAL} shell input tap ${msg.x} ${msg.y}`);
  } else if (msg.gesture === 'swipe') {
    const dur = msg.dur || 300;
    exec(`${ADB} -s ${ADB_SERIAL} shell input swipe ${msg.x} ${msg.y} ${msg.x2} ${msg.y2} ${dur}`);
  }
}

function handleAdbCmd(cmd, ws) {
  if (!cmd) return;
  const safe = cmd.replace(/[;&|`$]/g, '');
  exec(`${ADB} -s ${ADB_SERIAL} ${safe}`, { timeout: 15000 }, (err, out, stderr) => {
    wsSend(ws, { type: 'log', text: out || stderr || (err ? err.message : 'done'), level: err ? 'error' : 'info' });
  });
}

// ── Utils ──
function adbCmd(cmd, cb) { exec(`${ADB} -s ${ADB_SERIAL} ${cmd}`, { timeout: 8000 }, cb); }
function adbRaw(args, cb) { exec(`${ADB} ${args}`, { encoding: 'buffer', timeout: 8000 }, cb); }
function wsSend(ws, data) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(data)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function cleanupSession(id) {
  const s = sessions.get(id);
  if (s && s.streamInterval) clearInterval(s.streamInterval);
  sessions.delete(id);
}

server.listen(PORT, () => {
  console.log(`DroidWeb backend running on port ${PORT}`);
  console.log(`ADB serial: ${ADB_SERIAL}`);
});
