const { app, BrowserWindow, dialog, session, shell, systemPreferences } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let windowRef;
let pythonProcess;
let ownsServer = false;
const port = 8000;
const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');

// Keep development data isolated from Electron's shared default profile so a
// stale permission/cache entry from another Electron app cannot affect Pixel.
app.setName('Talking Buddy');
app.setPath('userData', path.join(app.getPath('appData'), 'Talking Buddy'));

function configureMediaPermissions() {
  const allowed = new Set(['media', 'audioCapture']);
  const isLocalOrigin = origin => /^http:\/\/127\.0\.0\.1:8000(?:\/|$)/.test(origin || '');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const origin = webContents.getURL();
    callback(allowed.has(permission) && isLocalOrigin(origin));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    allowed.has(permission) && isLocalOrigin(requestingOrigin || webContents?.getURL() || '')
  );
}

async function requestMicrophoneAccess() {
  // macOS can return a MediaStream track that never produces frames until the
  // native microphone permission has been requested for the Electron app.
  if (process.platform !== 'darwin' || !systemPreferences.askForMediaAccess) return true;
  return systemPreferences.askForMediaAccess('microphone');
}

function pythonCandidates() {
  const venv = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
  return process.platform === 'win32' ? [venv, 'python'] : [venv, 'python3', 'python'];
}
function isServerReady() {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/`, response => { response.resume(); resolve(response.statusCode < 500); });
    request.on('error', () => resolve(false)); request.setTimeout(800, () => { request.destroy(); resolve(false); });
  });
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer() {
  if (await isServerReady()) return;
  for (const python of pythonCandidates()) {
    try {
      pythonProcess = spawn(python, [path.join(root, 'server.py')], { cwd: root, env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: 'inherit' });
      ownsServer = true; pythonProcess.once('error', () => {});
      for (let i = 0; i < 60; i += 1) { if (await isServerReady()) return; if (pythonProcess.exitCode !== null) break; await wait(500); }
      pythonProcess.kill(); pythonProcess = null;
    } catch (_) { /* try the next interpreter */ }
  }
  throw new Error('The local Python service did not start. Check the setup instructions and .venv.');
}

async function createWindow() {
  try { await startServer(); } catch (error) { dialog.showErrorBox('Talking Buddy could not start', error.message); app.quit(); return; }
  windowRef = new BrowserWindow({ width: 1440, height: 950, minWidth: 900, minHeight: 650, title: 'Pixel', backgroundColor: '#eee5c9', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 16 } : undefined, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') } });
  // Links such as "Get Ollama" open in the user's browser, never in an unsandboxed app window.
  windowRef.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  await windowRef.loadURL(`http://127.0.0.1:${port}/desktop`);
  windowRef.on('closed', () => { windowRef = null; });
}
app.whenReady().then(async () => {
  configureMediaPermissions();
  const microphoneGranted = await requestMicrophoneAccess();
  if (!microphoneGranted) {
    dialog.showErrorBox('Microphone access required', 'Allow Talking Buddy to use your microphone in macOS System Settings, then reopen the app.');
    app.quit();
    return;
  }
  return createWindow();
});
app.on('activate', () => { if (!windowRef) createWindow(); });
app.on('before-quit', () => { if (ownsServer && pythonProcess) pythonProcess.kill(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
