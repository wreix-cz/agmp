# Local Music sync service

A Cloudflare Worker that stores one account's **likes, play counts and playlists**. Audio is not
stored here: the apps transfer files themselves, and the account only carries user state.

- Identity: [Sign in with Freebuff](https://freebuff.com) (`@freebuff/auth`, OIDC + PKCE, no secrets).
- Storage: one D1 database. Tables are created idempotently on the first request (`ensureSchema`),
  because the deployed database has no SQL console.
- Apps authenticate with a per-device bearer token minted by the device-code flow, never with the
  browser session cookie.

## Files

| File | Purpose |
| --- | --- |
| `worker.js` | Worker: pages, device linking, state API |
| `schema.sql` | Same schema, for local `wrangler d1 execute` |
| `wrangler.jsonc` | Local development config (loopback origin + development client ID) |
| `deploy.json` | Sites manifest pointing at the `wrangler --dry-run` bundle |
| `dist/` | Generated bundle — never commit |

## Run locally

```bash
npm install
npx wrangler d1 execute local-music-sync --local --file=schema.sql
npx wrangler dev --port 8787 --ip 127.0.0.1
```

Point the desktop app at it with `LOCAL_MUSIC_SYNC_URL=http://localhost:8787 npm start`. The Android
build uses the constant `ACCOUNT_SERVICE` in `ui/mobile.js`.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/device/start` | none (rate-limited per IP) | start a device-code sign-in |
| POST | `/api/device/poll` | device code | poll for approval; returns the bearer token once |
| POST | `/api/state` | bearer | merge a snapshot, return the merged state |
| POST | `/api/signout` | bearer | revoke the calling device |
| GET | `/link` | browser session | approve a device code |
| POST | `/link/approve` | browser session, same-origin | approve a device code |

Merge rules: likes newest `decision_at` wins (an unlike is a decision with `liked_at = 0`); stat
counters take the max; playlists are last-writer-wins by `updated_at`, with `deleted_at` tombstones.

## Deploy

```bash
npx wrangler deploy --dry-run --outdir dist   # bundle only, no Cloudflare credentials needed
```

Then deploy the site environment with `service/deploy.json`. `FREEBUFF_CLIENT_ID`,
`FREEBUFF_ISSUER` and `APP_ORIGIN` are injected by the platform; the local values in
`wrangler.jsonc` are the development client and are never used in a deployed environment.
