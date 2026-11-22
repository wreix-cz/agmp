'use strict';

/* Desktop side of account sync.
 *
 * The renderer never sees the device token: sign-in, token storage and the
 * API calls all happen here, over Electron's own network stack. The session
 * file is encrypted with the OS keychain through safeStorage when available.
 */

const { app, ipcMain, net, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVICE_URL = (process.env.LOCAL_MUSIC_SYNC_URL || 'https://local-music-sync-o7uah6-preview.freebuff.site')
  .replace(/\/+$/, '');

let session = null;

function sessionPath() {
  return path.join(app.getPath('userData'), 'account.json');
}

function readSession() {
  if (session) return session;
  try {
    const payload = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
    const raw = Buffer.from(String(payload.value || ''), 'base64');
    const text = payload.encrypted ? safeStorage.decryptString(raw) : raw.toString('utf8');
    const parsed = JSON.parse(text);
    session = parsed && typeof parsed.token === 'string' ? parsed : null;
  } catch (error) {
    session = null;
  }
  return session;
}

function writeSession(next) {
  session = next;
  try {
    const json = JSON.stringify(next);
    const encrypted = safeStorage.isEncryptionAvailable();
    const value = encrypted
      ? safeStorage.encryptString(json).toString('base64')
      : Buffer.from(json, 'utf8').toString('base64');
    fs.mkdirSync(path.dirname(sessionPath()), { recursive: true });
    fs.writeFileSync(sessionPath(), JSON.stringify({ encrypted: encrypted, value: value }), { mode: 0o600 });
  } catch (error) {
    // The in-memory session still works for this run; the next launch asks again.
  }
}

function clearSession() {
  session = null;
  try { fs.unlinkSync(sessionPath()); } catch (error) { /* already gone */ }
}

function publicSession() {
  const current = readSession();
  return {
    signedIn: Boolean(current && current.token),
    name: current && current.name ? String(current.name) : '',
    lastSyncAt: current && Number(current.lastSyncAt) ? Number(current.lastSyncAt) : 0,
    service: SERVICE_URL
  };
}

async function call(pathname, options) {
  const opts = options || {};
  const headers = { 'Content-Type': 'application/json' };
  const current = readSession();
  if (opts.auth !== false && current && current.token) headers.Authorization = 'Bearer ' + current.token;
  const response = await net.fetch(SERVICE_URL + pathname, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (error) { payload = null; }
  return { status: response.status, payload: payload };
}

function failure(result, fallback) {
  const message = result.payload && result.payload.error ? result.payload.error : fallback;
  return { ok: false, status: result.status, error: message };
}

async function startSignIn() {
  const result = await call('/api/device/start', {
    method: 'POST',
    auth: false,
    body: { name: os.hostname(), platform: 'desktop' }
  });
  if (result.status !== 200 || !result.payload || !result.payload.deviceCode) {
    return failure(result, 'the sync service did not start a sign-in');
  }
  shell.openExternal(result.payload.verificationUrl);
  return {
    ok: true,
    deviceCode: result.payload.deviceCode,
    code: result.payload.code,
    verificationUrl: result.payload.verificationUrl,
    interval: Number(result.payload.interval) || 3,
    expiresIn: Number(result.payload.expiresIn) || 600
  };
}

async function pollSignIn(deviceCode) {
  const result = await call('/api/device/poll', {
    method: 'POST',
    auth: false,
    body: { deviceCode: String(deviceCode || '') }
  });
  if (result.status === 202) return { ok: true, pending: true };
  if (result.status !== 200 || !result.payload || !result.payload.token) {
    return failure(result, 'sign-in was not approved');
  }
  writeSession({
    token: result.payload.token,
    deviceId: result.payload.deviceId || '',
    name: (result.payload.account && result.payload.account.name) || '',
    lastSyncAt: Date.now()
  });
  return { ok: true, pending: false, account: publicSession() };
}

async function pushState(snapshot) {
  const result = await call('/api/state', { method: 'POST', body: snapshot || {} });
  if (result.status !== 200 || !result.payload) return failure(result, 'the sync service refused the update');
  const current = readSession();
  if (current) writeSession(Object.assign({}, current, { lastSyncAt: Date.now() }));
  return { ok: true, state: result.payload, account: publicSession() };
}

async function signOut() {
  try { await call('/api/signout', { method: 'POST' }); } catch (error) { /* token is dropped anyway */ }
  clearSession();
  return { ok: true, account: publicSession() };
}

function registerIpc() {
  ipcMain.handle('account:status', function () { return publicSession(); });
  ipcMain.handle('account:start', function () { return startSignIn(); });
  ipcMain.handle('account:poll', function (event, deviceCode) { return pollSignIn(deviceCode); });
  ipcMain.handle('account:sync', function (event, snapshot) { return pushState(snapshot); });
  ipcMain.handle('account:signout', function () { return signOut(); });
}

module.exports = { registerIpc: registerIpc };
