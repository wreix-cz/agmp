/* Local Music sync service.
 *
 * Holds only user state (likes, play counts, playlists) for one Freebuff
 * account. Audio never leaves the device, so there is no object storage here.
 *
 * Two ways to authenticate:
 *   - the browser on this origin (Sign in with Freebuff session cookie), used
 *     to approve a device from the /link page;
 *   - a per-device bearer token minted after that approval, used by the
 *     desktop and Android apps.
 */

import { createFreebuffAuth, isSameOriginRequest } from '@freebuff/auth';

const MAX_LIKES = 20000;
const MAX_STATS = 20000;
const MAX_PLAYLISTS = 500;
const MAX_PLAYLIST_REFS = 5000;
const CODE_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 3;
const DEVICE_CODES_PER_HOUR = 12;

let auth;
let schemaReady = false;

/** Idempotent schema bootstrap: the deployed database has no SQL console. */
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, sub TEXT NOT NULL, name TEXT, platform TEXT,
      token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      last_seen_at INTEGER, revoked_at INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS device_codes (
      device_code TEXT PRIMARY KEY, user_code TEXT NOT NULL, name TEXT, platform TEXT,
      ip_hash TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      approved_at INTEGER, approved_sub TEXT, token_issued_at INTEGER)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS device_codes_ip ON device_codes (ip_hash, created_at)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS likes (
      sub TEXT NOT NULL, ref TEXT NOT NULL, liked_at INTEGER NOT NULL,
      decision_at INTEGER NOT NULL, PRIMARY KEY (sub, ref))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS stats (
      sub TEXT NOT NULL, ref TEXT NOT NULL, plays INTEGER NOT NULL DEFAULT 0,
      skips INTEGER NOT NULL DEFAULT 0, seconds INTEGER NOT NULL DEFAULT 0,
      last_played_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sub, ref))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS playlists (
      sub TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT,
      updated_at INTEGER NOT NULL, deleted_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (sub, id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS playlist_items (
      sub TEXT NOT NULL, playlist_id TEXT NOT NULL, ref TEXT NOT NULL,
      PRIMARY KEY (sub, playlist_id, ref))`)
  ]);
  schemaReady = true;
}

function getAuth(env) {
  if (!auth) {
    auth = createFreebuffAuth({
      clientId: env.FREEBUFF_CLIENT_ID,
      issuer: env.FREEBUFF_ISSUER,
      baseUrl: env.APP_ORIGIN,
      // Loopback only: the local wrangler server runs on http.
      allowInsecureLocalhost: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.APP_ORIGIN)
    });
  }
  return auth;
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store'
    }
  });
}

function html(status, body) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest))
    .map(function (byte) { return byte.toString(16).padStart(2, '0'); })
    .join('');
}

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer).map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
}

function userCode() {
  const digits = new Uint32Array(1);
  crypto.getRandomValues(digits);
  return String(100000 + (digits[0] % 900000));
}

function cleanText(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max) : text;
}

function cleanRef(value) {
  const text = cleanText(value, 300);
  return text && !text.includes('\0') ? text : '';
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.round(number), 9007199254740991) : (fallback || 0);
}

async function deviceFromRequest(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(header);
  if (!match) return null;
  const hash = await sha256(match[1]);
  const row = await env.DB.prepare(
    'SELECT id, sub, name, platform, revoked_at FROM devices WHERE token_hash = ?'
  ).bind(hash).first();
  if (!row || row.revoked_at) return null;
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return row;
}

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

function linkPage(user, code, message) {
  const signedIn = Boolean(user);
  const signinHref = '/auth/freebuff/signin?returnTo=' + encodeURIComponent('/link?code=' + encodeURIComponent(code || ''));
  const body = `
    <h1>Local Music account</h1>
    ${message ? `<p class="msg">${escapeHtml(message)}</p>` : ''}
    ${signedIn
      ? `<p>Signed in as <strong>${escapeHtml(user.name || user.email || 'your Freebuff account')}</strong>.</p>
         <form method="post" action="/link/approve">
           <label for="code">Device code shown in the app</label>
           <input id="code" name="code" value="${escapeHtml(code || '')}" inputmode="numeric" autocomplete="one-time-code" required>
           <button type="submit">Connect this device</button>
         </form>`
      : `<p>Sign in with your Freebuff account, then approve the code from the app.</p>
         <p><a class="button" href="${escapeHtml(signinHref)}">Sign in with Freebuff</a></p>`}
    <p class="hint">Audio files stay on your devices. This account only carries likes, play counts and playlists.</p>
  `;
  return html(200, page(body));
}

function page(body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local Music account</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0b0d12; color: #eef1f7;
         font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif }
  main { width: min(92vw, 30rem); background: #141824; border: 1px solid #232a3b;
         border-radius: 18px; padding: 1.75rem; box-shadow: 0 24px 60px rgba(0,0,0,.45) }
  h1 { margin: 0 0 1rem; font-size: 1.35rem }
  a { color: #8fb4ff }
  .button { display: inline-block; padding: .7rem 1rem; border-radius: 10px;
            background: #5b8cff; color: #06101f; font-weight: 650; text-decoration: none }
  label { display: block; margin: 1rem 0 .4rem; font-size: .85rem; color: #a9b3c8 }
  input { width: 100%; box-sizing: border-box; padding: .7rem .8rem; border-radius: 10px;
          border: 1px solid #2c3448; background: #0d1119; color: inherit; font: inherit; letter-spacing: .18em }
  button { margin-top: 1rem; width: 100%; padding: .8rem 1rem; border: 0; border-radius: 10px;
           background: #5b8cff; color: #06101f; font: inherit; font-weight: 700; cursor: pointer }
  .msg { background: #1d2536; border-left: 3px solid #5b8cff; padding: .7rem .9rem; border-radius: 8px }
  .hint { margin-top: 1.5rem; font-size: .82rem; color: #8892a8 }
</style></head>
<body><main>${body}</main></body></html>`;
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

async function readState(env, sub) {
  const [likes, stats, playlists, items] = await Promise.all([
    env.DB.prepare('SELECT ref, liked_at, decision_at FROM likes WHERE sub = ?').bind(sub).all(),
    env.DB.prepare('SELECT ref, plays, skips, seconds, last_played_at FROM stats WHERE sub = ?').bind(sub).all(),
    env.DB.prepare('SELECT id, name, created_at, updated_at, deleted_at FROM playlists WHERE sub = ?').bind(sub).all(),
    env.DB.prepare('SELECT playlist_id, ref FROM playlist_items WHERE sub = ?').bind(sub).all()
  ]);
  const byPlaylist = new Map();
  for (const row of items.results || []) {
    if (!byPlaylist.has(row.playlist_id)) byPlaylist.set(row.playlist_id, []);
    byPlaylist.get(row.playlist_id).push(row.ref);
  }
  return {
    likes: (likes.results || []).map(function (row) {
      return { ref: row.ref, likedAt: row.liked_at, at: row.decision_at };
    }),
    stats: (stats.results || []).map(function (row) {
      return { ref: row.ref, plays: row.plays, skips: row.skips, seconds: row.seconds, lastPlayedAt: row.last_played_at };
    }),
    playlists: (playlists.results || []).map(function (row) {
      return {
        id: row.id,
        name: row.name,
        createdAt: row.created_at || '',
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
        refs: byPlaylist.get(row.id) || []
      };
    })
  };
}

/** Merge the client's snapshot into D1 and return the merged account state. */
async function mergeState(env, sub, incoming) {
  const statements = [];
  const now = Date.now();

  const likes = Array.isArray(incoming.likes) ? incoming.likes.slice(0, MAX_LIKES) : [];
  for (const item of likes) {
    const ref = cleanRef(item && item.ref);
    if (!ref) continue;
    const likedAt = integer(item.likedAt, 0);
    const at = integer(item.at, 0);
    if (!at) continue;
    statements.push(env.DB.prepare(
      `INSERT INTO likes (sub, ref, liked_at, decision_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (sub, ref) DO UPDATE SET
         liked_at = excluded.liked_at, decision_at = excluded.decision_at
       WHERE excluded.decision_at > likes.decision_at`
    ).bind(sub, ref, likedAt, at));
  }

  const stats = Array.isArray(incoming.stats) ? incoming.stats.slice(0, MAX_STATS) : [];
  for (const item of stats) {
    const ref = cleanRef(item && item.ref);
    if (!ref) continue;
    statements.push(env.DB.prepare(
      `INSERT INTO stats (sub, ref, plays, skips, seconds, last_played_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (sub, ref) DO UPDATE SET
         plays = MAX(stats.plays, excluded.plays),
         skips = MAX(stats.skips, excluded.skips),
         seconds = MAX(stats.seconds, excluded.seconds),
         last_played_at = MAX(stats.last_played_at, excluded.last_played_at)`
    ).bind(sub, ref, integer(item.plays), integer(item.skips), integer(item.seconds), integer(item.lastPlayedAt)));
  }

  // Playlists are last-writer-wins by updatedAt. Reading the stored stamps
  // first means a stale snapshot from an offline device cannot rewrite the
  // items of a playlist that has already moved on.
  const stored = await env.DB.prepare('SELECT id, updated_at FROM playlists WHERE sub = ?').bind(sub).all();
  const storedAt = new Map();
  for (const row of stored.results || []) storedAt.set(row.id, row.updated_at);

  const playlists = Array.isArray(incoming.playlists) ? incoming.playlists.slice(0, MAX_PLAYLISTS) : [];
  for (const item of playlists) {
    const id = cleanText(item && item.id, 120);
    if (!id) continue;
    const updatedAt = integer(item.updatedAt, now);
    if (storedAt.has(id) && updatedAt <= storedAt.get(id)) continue;
    storedAt.set(id, updatedAt);
    const name = cleanText(item.name, 200) || 'Playlist';
    const deletedAt = integer(item.deletedAt, 0);
    const refs = Array.isArray(item.refs)
      ? Array.from(new Set(item.refs.map(cleanRef).filter(Boolean))).slice(0, MAX_PLAYLIST_REFS)
      : [];
    statements.push(env.DB.prepare(
      `INSERT INTO playlists (sub, id, name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (sub, id) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at
       WHERE excluded.updated_at > playlists.updated_at`
    ).bind(sub, id, name, cleanText(item.createdAt, 40), updatedAt, deletedAt));
    if (deletedAt) {
      statements.push(env.DB.prepare(
        'DELETE FROM playlist_items WHERE sub = ? AND playlist_id = ?'
      ).bind(sub, id));
      continue;
    }
    statements.push(env.DB.prepare(
      'DELETE FROM playlist_items WHERE sub = ? AND playlist_id = ?' +
      (refs.length ? ' AND ref NOT IN (' + refs.map(function () { return '?'; }).join(', ') + ')' : '')
    ).bind(sub, id, ...refs));
    for (const ref of refs) {
      statements.push(env.DB.prepare(
        'INSERT OR IGNORE INTO playlist_items (sub, playlist_id, ref) VALUES (?, ?, ?)'
      ).bind(sub, id, ref));
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return readState(env, sub);
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function handleApi(request, env, url) {
  if (url.pathname === '/api/device/start' && request.method === 'POST') {
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const ipHash = (await sha256(ip)).slice(0, 32);
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM device_codes WHERE ip_hash = ? AND created_at > ?'
    ).bind(ipHash, Date.now() - 60 * 60 * 1000).first();
    if (Number(recent && recent.total) >= DEVICE_CODES_PER_HOUR) {
      return json(429, { error: 'too many pairing attempts, try again later' });
    }
    const body = await request.json().catch(function () { return {}; });
    const code = userCode();
    const deviceCode = randomHex(32);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_codes (device_code, user_code, name, platform, ip_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(deviceCode, code, cleanText(body.name, 80), cleanText(body.platform, 20), ipHash, now, now + CODE_TTL_MS).run();
    await env.DB.prepare('DELETE FROM device_codes WHERE expires_at < ?')
      .bind(now - CODE_TTL_MS).run();
    return json(200, {
      deviceCode: deviceCode,
      code: code,
      verificationUrl: env.APP_ORIGIN + '/link?code=' + encodeURIComponent(code),
      interval: POLL_INTERVAL_SECONDS,
      expiresIn: Math.floor(CODE_TTL_MS / 1000)
    });
  }

  if (url.pathname === '/api/device/poll' && request.method === 'POST') {
    const body = await request.json().catch(function () { return {}; });
    const deviceCode = cleanText(body.deviceCode, 80);
    if (!deviceCode) return json(400, { error: 'deviceCode is required' });
    const row = await env.DB.prepare(
      'SELECT * FROM device_codes WHERE device_code = ?'
    ).bind(deviceCode).first();
    if (!row) return json(404, { error: 'unknown device code' });
    if (row.token_issued_at) return json(410, { error: 'this device code has already been used' });
    if (row.expires_at < Date.now()) return json(410, { error: 'this device code has expired' });
    if (!row.approved_at || !row.approved_sub) return json(202, { status: 'pending', interval: POLL_INTERVAL_SECONDS });

    const token = randomHex(32);
    const deviceId = randomHex(12);
    const now = Date.now();
    // Claim the code first: two concurrent polls must not mint two devices.
    const claimed = await env.DB.prepare(
      'UPDATE device_codes SET token_issued_at = ? WHERE device_code = ? AND token_issued_at IS NULL'
    ).bind(now, deviceCode).run();
    if (!claimed.meta || claimed.meta.changes !== 1) {
      return json(410, { error: 'this device code has already been used' });
    }
    await env.DB.prepare(
      'INSERT INTO devices (id, sub, name, platform, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(deviceId, row.approved_sub, row.name, row.platform, await sha256(token), now, now).run();
    const account = { name: row.name || '', platform: row.platform || '' };
    return json(200, { status: 'approved', token: token, deviceId: deviceId, account: account });
  }

  const device = await deviceFromRequest(request, env);
  if (!device) return json(401, { error: 'sign in required' });

  if (url.pathname === '/api/state' && request.method === 'POST') {
    const body = await request.json().catch(function () { return null; });
    if (!body || typeof body !== 'object') return json(400, { error: 'invalid state payload' });
    const merged = await mergeState(env, device.sub, body);
    return json(200, merged);
  }

  if (url.pathname === '/api/signout' && request.method === 'POST') {
    await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND sub = ?')
      .bind(Date.now(), device.id, device.sub).run();
    return json(200, { ok: true });
  }

  return json(404, { error: 'not found' });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const signedIn = getAuth(env);
  try {
    await ensureSchema(env);
  } catch (schemaError) {
    return json(503, { error: 'the sync database is not ready yet' });
  }

  if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);

  if (url.pathname === '/link') {
    const user = await signedIn.getUser(request);
    return linkPage(user, cleanText(url.searchParams.get('code'), 12), '');
  }

  if (url.pathname === '/link/approve' && request.method === 'POST') {
    if (!isSameOriginRequest(request, env.APP_ORIGIN)) return json(403, { error: 'cross-origin request refused' });
    const user = await signedIn.getUser(request);
    if (!user) return html(401, page('<h1>Sign in required</h1><p><a href="/auth/freebuff/signin?returnTo=%2Flink">Sign in with Freebuff</a></p>'));
    const form = await request.formData().catch(function () { return null; });
    const code = cleanText(form && form.get('code'), 12);
    const row = await env.DB.prepare(
      'SELECT device_code, expires_at, approved_at FROM device_codes WHERE user_code = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(code).first();
    if (!row) return linkPage(user, code, 'That code is not known. Start again from the app.');
    if (row.expires_at < Date.now()) return linkPage(user, code, 'That code has expired. Start again from the app.');
    if (row.approved_at) return linkPage(user, code, 'That code was already approved.');
    await env.DB.prepare('UPDATE device_codes SET approved_at = ?, approved_sub = ? WHERE device_code = ?')
      .bind(Date.now(), user.sub, row.device_code).run();
    return html(200, page(`
      <h1>Device connected</h1>
      <p>Return to Local Music. It will finish signing in within a few seconds.</p>
      <p class="hint">Audio stays on your devices; only likes, play counts and playlists sync.</p>
    `));
  }

  if (url.pathname === '/') {
    const user = await signedIn.getUser(request);
    return html(200, page(`
      <h1>Local Music sync</h1>
      ${user
        ? `<p>Signed in as <strong>${escapeHtml(user.name || user.email || 'your account')}</strong>.</p>`
        : '<p>This service carries likes, play counts and playlists between the Local Music desktop and Android apps.</p><p><a class="button" href="/auth/freebuff/signin?returnTo=%2F">Sign in with Freebuff</a></p>'}
      <p class="hint">Audio files are never uploaded.</p>
    `));
  }

  return html(404, page('<h1>Not found</h1><p><a href="/">Local Music sync</a></p>'));
}

let wrapped;

export default {
  fetch(request, env) {
    if (!wrapped) {
      const instance = getAuth(env);
      wrapped = instance.wrap(function (req) { return handleRequest(req, env); });
    }
    return wrapped(request, env);
  }
};
