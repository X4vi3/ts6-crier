import fs from "node:fs";
import path from "node:path";
import { isSea } from "node:sea";

/**
 * Where the bot keeps everything: config, identity, state, sounds, cache.
 *
 * One folder for all of it, so "copy the folder" is a complete backup and an
 * update only ever swaps the program files inside it.
 *
 *   CRIER_HOME set     -> that directory
 *   packaged binary    -> the directory the executable sits in
 *   node dist/crier.js -> the project root (one level above dist/)
 */
function appRoot(): string {
  if (process.env.CRIER_HOME) return path.resolve(process.env.CRIER_HOME);
  if (isSea()) return path.dirname(process.execPath);
  return path.resolve(path.dirname(process.argv[1] ?? "."), "..");
}

export const ROOT = appRoot();

export const CONFIG_PATH = process.env.CRIER_CONFIG || path.join(ROOT, "config.yml");
export const CONFIG_EXAMPLE_PATH = path.join(ROOT, "config.example.yml");
export const CACHE_DIR = process.env.CRIER_CACHE || path.join(ROOT, "cache");
export const STATE_PATH = path.join(ROOT, "state.json");
export const OVERRIDES_PATH = path.join(ROOT, "overrides.json");
export const SETTINGS_PATH = path.join(ROOT, "settings.json");
export const IDENTITY_PATH = path.join(ROOT, "identity.json");
export const AVATAR_PATH = path.join(ROOT, "avatar.png");

const EXE = process.platform === "win32" ? ".exe" : "";

/**
 * A helper program, preferring the copy shipped next to the bot. Release
 * archives carry their own ffmpeg, so nothing has to be installed and the
 * distro does not matter; a source checkout falls back to whatever is on PATH.
 */
function tool(name: string): string {
  for (const dir of [ROOT, path.join(ROOT, "bin")]) {
    const p = path.join(dir, name + EXE);
    if (fs.existsSync(p)) return p;
  }
  return name;
}

export const FFMPEG = tool("ffmpeg");
