import fs from "node:fs";
import path from "node:path";

import type { FileTransfer, RemoteFile } from "./filetransfer.js";

const AUDIO_EXT = new Set([".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".flac", ".wma"]);

export interface Upload {
  /** Absolute path inside the TeamSpeak file store, when read off disk. */
  path?: string;
  /** Where to fetch it from, when read over the file-transfer protocol. */
  remote?: RemoteFile;
  /** File name as the uploader sees it in the client. */
  name: string;
  /** Channel id the file was uploaded to, or 0 for the server-wide area. */
  channel: number;
  size: number;
  mtime: number;
}

/**
 * Everything audio-shaped a player has uploaded through the TeamSpeak file
 * browser. The bot only ever reads here — the directory belongs to the
 * teamspeak user and the bot is in its group with read access only.
 */
export function listUploadsOnDisk(root: string): Upload[] {
  const out: Upload[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root).filter((d) => d.startsWith("channel_"));
  } catch {
    return out; // no access or no such directory — the caller reports it
  }

  for (const dir of dirs) {
    const channel = parseInt(dir.slice("channel_".length)) || 0;
    const full = path.join(root, dir);
    let entries: string[];
    try {
      entries = fs.readdirSync(full);
    } catch {
      continue; // a channel directory we cannot read; skip it quietly
    }
    for (const name of entries) {
      if (!AUDIO_EXT.has(path.extname(name).toLowerCase())) continue;
      const p = path.join(full, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        out.push({ path: p, name, channel, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function isAudioName(name: string): boolean {
  return AUDIO_EXT.has(path.extname(name).toLowerCase());
}

/**
 * The same listing fetched over the file-transfer protocol, one channel at a
 * time. Channels the bot may not browse (passwords, permissions) are skipped.
 */
export async function listUploadsRemote(ft: FileTransfer, channels: number[]): Promise<Upload[]> {
  const out: Upload[] = [];
  for (const cid of channels) {
    let files: RemoteFile[];
    try {
      files = await ft.list(cid);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!isAudioName(f.name)) continue;
      out.push({ remote: f, name: f.name, channel: cid, size: f.size, mtime: f.mtime });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Find an uploaded file by name. Matching is case-insensitive and accepts a
 * unique prefix, because typing a full name into a TeamSpeak chat box is
 * miserable. Returns every candidate so the caller can complain precisely.
 */
export function findUpload(uploads: Upload[], query: string): Upload[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = uploads.filter((u) => u.name.toLowerCase() === q);
  if (exact.length) return exact;
  const stem = uploads.filter((u) => u.name.toLowerCase().replace(/\.[^.]+$/, "") === q);
  if (stem.length) return stem;
  return uploads.filter((u) => u.name.toLowerCase().startsWith(q));
}

/**
 * Copy an upload into the bot's own sounds directory. The bot must not depend
 * on a file staying in the TeamSpeak store — a player can delete it from the
 * channel at any moment.
 */
export async function adoptUpload(
  up: Upload,
  soundsDir: string,
  target: string,
  ft: FileTransfer | null,
  maxBytes: number
): Promise<string> {
  const dir = path.join(soundsDir, "custom");
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(up.name).toLowerCase() || ".mp3";
  const name = `${target}-${Date.now()}${ext}`;
  const dest = path.join(dir, name);
  if (up.path) {
    fs.copyFileSync(up.path, dest);
  } else if (up.remote && ft) {
    await ft.download(up.remote, dest, maxBytes);
  } else {
    throw new Error("no way to fetch this file");
  }
  return path.join("custom", name); // relative to soundsDir
}

/** Drop older adopted files for a target, keeping the newest few. */
export function pruneAdopted(soundsDir: string, target: string, keep = 3): void {
  const dir = path.join(soundsDir, "custom");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith(`${target}-`));
  } catch {
    return;
  }
  files
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(keep)
    .forEach(({ f }) => {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* already gone */
      }
    });
}
