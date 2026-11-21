// Assembles www/ for the Capacitor mobile shell.
//
// player.html stays the single source of truth: it is copied to www/index.html,
// and the current library export plus its audio, cover, and lyrics files are
// bundled so the phone app starts with the same offline library.

import { copyFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'www');

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(outDir, 'library'), { recursive: true });

await copyFile(path.join(root, 'player.html'), path.join(outDir, 'index.html'));
await cp(path.join(root, 'ui'), path.join(outDir, 'ui'), { recursive: true });

let bundledPlaylist = false;
try {
  await copyFile(path.join(root, 'library', 'playlist.json'), path.join(outDir, 'library', 'playlist.json'));
  bundledPlaylist = true;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

for (const assetDir of ['cover', 'lyrics']) {
  try {
    await cp(path.join(root, 'library', assetDir), path.join(outDir, 'library', assetDir), { recursive: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

let audioCount = 0;
let audioBytes = 0;
try {
  const audioDir = path.join(root, 'library', 'audio');
  const entries = await readdir(audioDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  await cp(audioDir, path.join(outDir, 'library', 'audio'), { recursive: true });
  for (const entry of files) {
    const info = await stat(path.join(audioDir, entry.name));
    audioCount += 1;
    audioBytes += info.size;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

console.log(
  'www/ ready: index.html + ui/' +
    (bundledPlaylist ? ' + library/playlist.json' : ' (no library/playlist.json yet)') +
    (audioCount
      ? ` + ${audioCount} audio file(s), ${(audioBytes / (1024 * 1024)).toFixed(1)} MiB`
      : ' (no audio bundled yet)')
);
