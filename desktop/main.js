'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, globalShortcut } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');

// In a packaged build player.html and importer.py are extraResources, and the
// library lives in userData because the app bundle is read-only.
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');

function libraryDir() {
  return app.isPackaged ? path.join(app.getPath('userData'), 'library') : path.join(ROOT, 'library');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav'
};

let mainWindow = null;
let staticServer = null;
let baseUrl = '';
let importProcess = null;
let syncServer = null;
let syncCode = '';
let syncCodeExpires = 0;
const syncTokens = new Map();

/* ------------------------------------------------------------------ *
 * Local library server
 *
 * The window is served over http://127.0.0.1:<random port> instead of
 * file://, so fetch() of playlist.json works and <audio> can stream
 * library/audio/* with range requests. Only the player and library/
 * are reachable; everything else on disk returns 404.
 * ------------------------------------------------------------------ */

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function resolveRequestPath(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname);
  } catch (error) {
    return null;
  }

  if (pathname === '/' || pathname === '/player.html' || pathname === '/index.html') {
    return path.join(ROOT, 'player.html');
  }

  if (pathname.startsWith('/ui/')) {
    const uiDir = path.join(ROOT, 'ui');
    const target = path.resolve(uiDir, '.' + pathname.slice('/ui'.length));
    if (!target.startsWith(uiDir + path.sep)) return null;
    return target;
  }

  if (pathname.startsWith('/library/')) {
    // resolve() collapses "..", so the prefix check below is the real guard.
    const libraryDirPath = libraryDir();
    const target = path.resolve(libraryDirPath, '.' + pathname.slice('/library'.length));
    if (!target.startsWith(libraryDirPath + path.sep)) return null;
    return target;
  }

  return null;
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, function (error, stats) {
    if (error || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const total = stats.size;
    const headers = {
      'Content-Type': contentTypeFor(filePath),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    };
    let start = 0;
    let end = total - 1;
    let status = 200;

    if (total === 0) {
      headers['Content-Length'] = 0;
      res.writeHead(200, headers);
      res.end();
      return;
    }

    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (match[1] === '' && match[2] === '')) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total });
        res.end();
        return;
      }
      if (match[1] === '') {
        start = Math.max(0, total - Number(match[2]));
      } else {
        start = Number(match[1]);
        if (match[2] !== '') end = Math.min(end, Number(match[2]));
      }
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
    }

    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath, { start: start, end: end });
    stream.on('error', function () {
      res.destroy();
    });
    stream.pipe(res);
  });
}

function startStaticServer() {
  return new Promise(function (resolve, reject) {
    const server = http.createServer(function (req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const filePath = resolveRequestPath(req.url || '/');
      if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      serveFile(req, res, filePath);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/* ------------------------------------------------------------------ *
 * LAN sync server
 *
 * Pairing is deliberately short-lived and the code never grants access to
 * the library by itself. A successful pairing exchanges it for a random
 * bearer token which expires after thirty minutes.
 * ------------------------------------------------------------------ */

function networkAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

function syncHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  }, extra || {});
}

function sendSyncJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, syncHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(body);
}

function readRequestBody(req) {
  return new Promise(function (resolve, reject) {
    let body = '';
    let length = 0;
    req.setEncoding('utf8');
    req.on('data', function (chunk) {
      length += Buffer.byteLength(chunk);
      if (length > 65536) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', function () { resolve(body); });
    req.on('error', reject);
  });
}

function validSyncToken(value) {
  const token = String(value || '');
  const expires = syncTokens.get(token);
  if (!expires || expires < Date.now()) {
    syncTokens.delete(token);
    return false;
  }
  return true;
}

function safeLibraryFile(directory, name) {
  const base = path.resolve(directory);
  const raw = String(name || '');
  if (!raw || raw.includes('\0') || raw !== path.basename(raw)) return null;
  const target = path.resolve(base, raw);
  return target.startsWith(base + path.sep) ? target : null;
}

function syncManifest() {
  const manifestPath = path.join(libraryDir(), 'manifest.json');
  let payload = { tracks: {} };
  try {
    payload = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const records = payload && payload.tracks && typeof payload.tracks === 'object' ? payload.tracks : {};
  const tracks = [];
  Object.keys(records).forEach(function (key) {
    const record = records[key];
    if (!record || !record.fileName) return;
    const audioPath = safeLibraryFile(path.join(libraryDir(), 'audio'), record.fileName);
    if (!audioPath) return;
    let stat;
    try { stat = fs.statSync(audioPath); } catch (error) { return; }
    const item = {
      syncKey: key,
      title: String(record.title || ''),
      artist: String(record.artist || ''),
      duration: Number(record.duration) || 0,
      fileName: path.basename(audioPath),
      sizeBytes: stat.size,
      modifiedAt: Math.floor(stat.mtimeMs)
    };
    for (const field of ['album', 'cover', 'lyrics']) {
      if (record[field]) item[field] = record[field];
    }
    tracks.push(item);
  });
  tracks.sort(function (a, b) { return a.fileName.localeCompare(b.fileName); });
  return { version: 1, generatedAt: new Date().toISOString(), tracks: tracks };
}

async function handleSyncRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, syncHeaders());
    res.end();
    return;
  }
  let parsed;
  try {
    parsed = new URL(req.url || '/', 'http://127.0.0.1');
  } catch (error) {
    sendSyncJson(res, 400, { error: 'invalid URL' });
    return;
  }
  if (parsed.pathname === '/api/sync/pair' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readRequestBody(req) || '{}');
      if (!syncCode || Date.now() > syncCodeExpires || String(payload.code || '') !== syncCode) {
        sendSyncJson(res, 403, { error: 'pairing code refused or expired' });
        return;
      }
      const token = crypto.randomBytes(24).toString('hex');
      syncTokens.set(token, Date.now() + 30 * 60 * 1000);
      sendSyncJson(res, 200, { token: token, expiresAt: syncTokens.get(token) });
    } catch (error) {
      sendSyncJson(res, 400, { error: 'invalid pairing request' });
    }
    return;
  }

  const token = parsed.searchParams.get('token');
  if (!validSyncToken(token)) {
    sendSyncJson(res, 401, { error: 'pairing required' });
    return;
  }
  if (parsed.pathname === '/api/sync/manifest' && req.method === 'GET') {
    try {
      sendSyncJson(res, 200, syncManifest());
    } catch (error) {
      sendSyncJson(res, 500, { error: 'could not read library manifest' });
    }
    return;
  }
  const audioMatch = /^\/api\/sync\/audio\/([^/]+)$/.exec(parsed.pathname);
  if (audioMatch && req.method === 'GET') {
    const filePath = safeLibraryFile(path.join(libraryDir(), 'audio'), decodeURIComponent(audioMatch[1]));
    if (!filePath) {
      sendSyncJson(res, 400, { error: 'invalid audio path' });
      return;
    }
    serveFile(req, res, filePath);
    return;
  }
  const assetMatch = /^\/api\/sync\/asset\/(cover|lyrics)\/([^/]+)$/.exec(parsed.pathname);
  if (assetMatch && req.method === 'GET') {
    const directory = path.join(libraryDir(), assetMatch[1]);
    const filePath = safeLibraryFile(directory, decodeURIComponent(assetMatch[2]));
    if (!filePath) {
      sendSyncJson(res, 400, { error: 'invalid asset path' });
      return;
    }
    serveFile(req, res, filePath);
    return;
  }
  sendSyncJson(res, 404, { error: 'not found' });
}

function startSyncServer() {
  if (syncServer) {
    return Promise.resolve(syncServer);
  }
  syncCode = String(100000 + crypto.randomInt(900000));
  syncCodeExpires = Date.now() + 10 * 60 * 1000;
  syncServer = http.createServer(function (req, res) {
    handleSyncRequest(req, res).catch(function () {
      if (!res.headersSent) sendSyncJson(res, 500, { error: 'sync request failed' });
      else res.destroy();
    });
  });
  return new Promise(function (resolve, reject) {
    syncServer.once('error', function (error) {
      syncServer = null;
      reject(error);
    });
    syncServer.listen(0, '0.0.0.0', function () {
      syncServer.removeAllListeners('error');
      resolve(syncServer);
    });
  });
}

async function getSyncInfo() {
  const server = await startSyncServer();
  if (Date.now() > syncCodeExpires) {
    syncCode = String(100000 + crypto.randomInt(900000));
    syncCodeExpires = Date.now() + 10 * 60 * 1000;
  }
  return {
    address: 'http://' + networkAddress() + ':' + server.address().port,
    code: syncCode,
    expiresAt: syncCodeExpires
  };
}

function stopSyncServer() {
  syncTokens.clear();
  syncCode = '';
  syncCodeExpires = 0;
  if (syncServer) {
    syncServer.close();
    syncServer = null;
  }
}

/* ------------------------------------------------------------------ *
 * Importer bridge
 * ------------------------------------------------------------------ */

function pythonCommand() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function sendImportEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('import:event', payload);
}

function spawnImporter(args) {
  if (importProcess) return { started: false, code: 'busy', reason: 'an import is already running' };
  const child = spawn(pythonCommand(), args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PYTHONUNBUFFERED: '1',
      LOCAL_MUSIC_LIBRARY: libraryDir()
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  importProcess = child;

  let finished = false;
  function finish(payload) {
    if (finished) return;
    finished = true;
    importProcess = null;
    sendImportEvent(Object.assign({ type: 'done' }, payload));
  }

  function forward(stream) {
    child[stream].setEncoding('utf8');
    child[stream].on('data', function (chunk) {
      String(chunk).split(/\r?\n/).forEach(function (line) {
        if (line.trim()) sendImportEvent({ type: 'line', stream: stream, line: line });
      });
    });
  }

  forward('stdout');
  forward('stderr');

  child.on('error', function (error) {
    finish({ code: null, signal: null, error: 'could not run ' + pythonCommand() + ' (' + error.message + ')' });
  });
  child.on('close', function (code, signal) {
    finish({ code: code, signal: signal || null, error: null });
  });

  return { started: true };
}

function startImport(link) {
  const args = ['importer.py'];
  if (typeof link === 'string' && link.trim()) {
    const value = link.trim();
    if (value.length > 2048) return { started: false, code: 'invalid', reason: 'that link is too long' };
    if (!/^(https?:\/\/|spotify:)/i.test(value)) {
      return { started: false, code: 'invalid', reason: 'paste a full playlist link that starts with https://' };
    }
    // spawn() without a shell, so the link is a single argv entry, never a command.
    args.push(value);
  } else if (app.isPackaged) {
    // The bundle is read-only; point the file-based import at the writable library.
    args.push('--input', path.join(libraryDir(), 'songs.txt'));
  }
  return spawnImporter(args);
}

function retryFailedImports() {
  return spawnImporter(['importer.py', '--retry-failed']);
}

function runImporter(args, stdin) {
  return new Promise(function (resolve) {
    const child = spawn(pythonCommand(), args, {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PYTHONUNBUFFERED: '1',
        LOCAL_MUSIC_LIBRARY: libraryDir()
      }),
      stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', function (chunk) { stdout += chunk; });
    child.stderr.on('data', function (chunk) { stderr += chunk; });
    if (stdin != null) {
      child.stdin.end(stdin);
    }
    child.on('error', function (error) {
      resolve({ ok: false, reason: error.message });
    });
    child.on('close', function (code) {
      resolve({
        ok: code === 0,
        reason: code === 0 ? '' : (stderr.trim().split(/\r?\n/).pop() || stdout.trim().split(/\r?\n/).pop() || 'importer exited with code ' + code)
      });
    });
  });
}

function deleteTrack(key) {
  const value = String(key || '').trim();
  if (!value || value.length > 300 || /[\\/\x00]/.test(value)) {
    return Promise.resolve({ ok: false, reason: 'invalid track key' });
  }
  return runImporter(['importer.py', '--remove', value]);
}

function attachLyrics(key, content) {
  const value = String(key || '').trim();
  const text = typeof content === 'string' ? content : '';
  if (!value || value.length > 300 || /[\\/\x00]/.test(value)) {
    return Promise.resolve({ ok: false, reason: 'invalid track key' });
  }
  if (!text.trim()) {
    return Promise.resolve({ ok: false, reason: 'lyrics file is empty' });
  }
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
    return Promise.resolve({ ok: false, reason: 'lyrics file is too large (maximum 2 MiB)' });
  }
  return runImporter(['importer.py', '--attach-lyrics', value], text);
}

function storageInfo() {
  const root = path.join(libraryDir(), 'audio');
  let size = 0;
  try {
    fs.readdirSync(root).forEach(function (name) {
      const target = safeLibraryFile(root, name);
      if (!target) return;
      try { size += fs.statSync(target).size; } catch (error) { /* file disappeared */ }
    });
  } catch (error) {
    return { size: 0 };
  }
  return { size: size };
}

function cancelImport() {
  if (!importProcess) return { cancelled: false };
  importProcess.kill('SIGINT');
  return { cancelled: true };
}

/* ------------------------------------------------------------------ *
 * Online recommendations
 *
 * importer.py --recommend prints a JSON list of related tracks (YouTube Music
 * radio for the newest library entries). It is a separate, short-lived process
 * so a slow search can never block the import bridge or the UI.
 * ------------------------------------------------------------------ */

function fetchRecommendations(limit) {
  return new Promise(function (resolve) {
    const count = String(Math.max(1, Math.min(Number(limit) || 12, 30)));
    let child;
    try {
      child = spawn(pythonCommand(), ['importer.py', '--recommend', count], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { LOCAL_MUSIC_LIBRARY: libraryDir() }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ ok: false, reason: 'could not run ' + pythonCommand() + ' (' + error.message + ')' });
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(function () { child.kill('SIGTERM'); }, 90000);

    function finish(payload) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', function (chunk) { out += chunk; });
    child.stderr.on('data', function (chunk) { err += chunk; });
    child.on('error', function (error) {
      finish({ ok: false, reason: 'could not run ' + pythonCommand() + ' (' + error.message + ')' });
    });
    child.on('close', function (code) {
      if (code !== 0) {
        const lines = err.trim().split(/\r?\n/).filter(Boolean);
        finish({ ok: false, reason: lines.length ? lines[lines.length - 1] : 'recommendation helper exited with code ' + code });
        return;
      }
      try {
        const picks = JSON.parse(out.trim() || '[]');
        finish({ ok: true, picks: Array.isArray(picks) ? picks : [] });
      } catch (error) {
        finish({ ok: false, reason: 'could not read the recommendation list' });
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Window and menu
 * ------------------------------------------------------------------ */

function sendMenuAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('menu:action', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    isMac ? { role: 'appMenu' } : null,
    {
      label: 'File',
      submenu: [
        { label: 'Import new songs', accelerator: 'CmdOrCtrl+I', click: function () { sendMenuAction('import'); } },
        { label: 'Cancel import', accelerator: 'CmdOrCtrl+.', click: cancelImport },
        { type: 'separator' },
        { label: 'Reload playlist', accelerator: 'CmdOrCtrl+Shift+R', click: function () { sendMenuAction('reload'); } },
        { label: 'Open library folder', accelerator: 'CmdOrCtrl+L', click: function () { shell.openPath(libraryDir()); } },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ].filter(Boolean);

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerMediaShortcuts() {
  [
    ['MediaPlayPause', 'togglePlay'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'previous']
  ].forEach(function (entry) {
    try { globalShortcut.register(entry[0], function () { sendMenuAction(entry[1]); }); } catch (error) { /* unavailable on this desktop */ }
  });
}

async function createWindow() {
  if (!staticServer) staticServer = await startStaticServer();
  baseUrl = 'http://127.0.0.1:' + staticServer.address().port + '/';

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 360,
    minHeight: 520,
    title: 'Local Music',
    backgroundColor: '#0a0d13',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      additionalArguments: ['--local-music-base=' + baseUrl]
    }
  });

  mainWindow.once('ready-to-show', function () {
    if (mainWindow) mainWindow.show();
  });
  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', function (event, url) {
    if (url.startsWith(baseUrl)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  await mainWindow.loadURL(baseUrl + 'player.html');
}

function reportFatal(error) {
  dialog.showErrorBox('Local Music could not start', String(error && error.stack ? error.stack : error));
  app.quit();
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

ipcMain.handle('import:start', function (event, link) { return startImport(link); });
ipcMain.handle('import:retry-failed', function () { return retryFailedImports(); });
ipcMain.handle('import:cancel', function () { return cancelImport(); });
ipcMain.handle('recommend:fetch', function (event, limit) { return fetchRecommendations(limit); });
ipcMain.handle('library:open', function () { return shell.openPath(libraryDir()); });
ipcMain.handle('library:delete', function (event, key) { return deleteTrack(key); });
ipcMain.handle('library:attach-lyrics', function (event, key, content) { return attachLyrics(key, content); });
ipcMain.handle('library:storage-info', function () { return storageInfo(); });
ipcMain.handle('sync:info', function () { return getSyncInfo(); });

app.setName('Local Music');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', function () {
    if (importProcess) importProcess.kill('SIGINT');
    if (staticServer) staticServer.close();
    globalShortcut.unregisterAll();
    stopSyncServer();
  });

  app.whenReady().then(function () {
    // Packaged builds start with no library folder at all.
    fs.mkdirSync(libraryDir(), { recursive: true });
    buildMenu();
    registerMediaShortcuts();
    return createWindow();
  }).then(function () {
    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(reportFatal);
    });
  }).catch(reportFatal);
}
