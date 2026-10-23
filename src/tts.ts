import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config, Source } from "./config.js";
import { FFMPEG } from "./paths.js";

const run = promisify(execFile);

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_SAMPLES = 960; // 20 ms @ 48 kHz
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // s16le

function stamp(file: string): string {
  const st = fs.statSync(file);
  return `${file}|${st.size}|${st.mtimeMs}`;
}

/** Stable cache key for a source. Re-recording a file invalidates its entry. */
export function sourceKey(src: Source, cfg: Config): string {
  const h = crypto.createHash("sha1");
  // The loudness target is baked into the cached PCM, so it belongs in the key.
  h.update(`lufs|${cfg.audio.targetLufs ?? "off"}|`);
  if (src.kind === "tts") {
    h.update(`tts|${src.text}|${cfg.tts.model}|${cfg.tts.lengthScale ?? ""}`);
  } else if (src.kind === "mix") {
    h.update(`mix|${stamp(src.bed)}|${stamp(src.voice)}|${src.atMs}`);
  } else {
    h.update(`file|${stamp(src.file)}`);
  }
  return h.digest("hex").slice(0, 16);
}

/** Normalise any audio file to the raw PCM the Opus encoder expects. */
async function toPcm(inputPath: string, pcmPath: string): Promise<void> {
  const tmp = `${pcmPath}.tmp`;
  // apad rounds the tail up so the last 20 ms frame is whole rather than clipped.
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-af", "apad=pad_dur=0.05",
    "-f", "s16le", "-acodec", "pcm_s16le",
    "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS),
    tmp,
  ]);
  fs.renameSync(tmp, pcmPath);
}

export interface Probe {
  seconds: number;
  channels: number;
}

/**
 * Decode the first audio stream once and read what ffmpeg reports about it.
 * Done with ffmpeg alone rather than ffprobe so release archives carry one
 * helper binary instead of two; decoding the whole file also rejects anything
 * that is broken past its header.
 */
export async function probeAudio(file: string): Promise<Probe> {
  let stderr: string;
  try {
    ({ stderr } = await run(FFMPEG, ["-hide_banner", "-nostdin", "-i", file, "-map", "0:a:0", "-f", "null", "-"]));
  } catch (e: any) {
    throw new Error(/does not contain any stream|matches no streams/i.test(String(e?.stderr)) ? "no audio in it" : "not an audio file");
  }
  const text = String(stderr);
  const stream = text.match(/Stream #\d+:\d+.*?: Audio: [^\n]*?, \d+ Hz, ([^,\n]+)/);
  if (!stream) throw new Error("not an audio file");
  const layout = stream[1].trim();
  const n = layout.match(/^(\d+) channels/);
  const channels = layout === "mono" ? 1 : layout === "stereo" ? 2 : n ? parseInt(n[1]) : 2;

  const hms = (h: string, m: string, s: string) => parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
  const times = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const dur = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = times.length
    ? hms(...(times[times.length - 1].slice(1, 4) as [string, string, string]))
    : dur
      ? hms(dur[1], dur[2], dur[3])
      : 0;
  if (!(seconds > 0)) throw new Error("zero duration");
  return { seconds, channels };
}

async function channelCount(file: string): Promise<number> {
  try {
    return (await probeAudio(file)).channels;
  } catch {
    return 1;
  }
}

/**
 * Lay a bare voice line over the bed, the way the finished tracks were built by
 * hand: bed from zero, voice entering at `atMs`, the two summed.
 *
 * Two settings carry the whole result:
 *  - `normalize=0`, because amix otherwise halves every input and the mix comes
 *    out quieter than the hand-made originals;
 *  - an explicit `pan` for a mono voice line. Left to itself ffmpeg upmixes
 *    mono to stereo at 1/sqrt(2) per channel to preserve power, which lands the
 *    voice 3 dB below where it was mixed by hand. Copying the channel outright
 *    keeps unity gain.
 */
async function mixToPcm(
  bed: string,
  voice: string,
  atMs: number,
  pcmPath: string,
  voiceOffsetDb = 0
): Promise<void> {
  const tmp = `${pcmPath}.tmp`;
  const delay = Math.max(0, Math.round(atMs));
  const toStereo = (await channelCount(voice)) === 1 ? "pan=stereo|c0=c0|c1=c0," : "";

  // Match the voice to the bed before laying it on top, so the voice-to-chime
  // balance is the same in every announcement. Recordings arrive at whatever
  // level they were exported at — leaving that untouched makes one line sit
  // forward and another sit back for no reason the listener can see.
  let balance = "";
  const bedLufs = await measureLufs(bed, false);
  const voiceLufs = await measureLufs(voice, false);
  if (bedLufs != null && voiceLufs != null && voiceLufs > -70) {
    const db = bedLufs + voiceOffsetDb - voiceLufs;
    if (Math.abs(db) >= 0.2) balance = `volume=${db.toFixed(2)}dB,`;
  }
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", bed,
    "-i", voice,
    "-filter_complex",
    `[1:a]${balance}${toStereo}adelay=${delay}|${delay}[v];` +
      `[0:a][v]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[m];` +
      `[m]apad=pad_dur=0.05[a]`,
    "-map", "[a]",
    "-f", "s16le", "-acodec", "pcm_s16le",
    "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS),
    tmp,
  ]);
  fs.renameSync(tmp, pcmPath);
}

/**
 * Turn a source into raw 48 kHz stereo PCM on disk, reusing the cache.
 * Finished files are transcoded, bare voice lines are mixed onto the bed,
 * TTS goes through piper first.
 */
export async function renderSource(src: Source, cfg: Config, cacheDir: string): Promise<string> {
  const key = sourceKey(src, cfg);
  const pcmPath = path.join(cacheDir, `${key}.pcm`);
  if (fs.existsSync(pcmPath) && fs.statSync(pcmPath).size > 0) return pcmPath;

  fs.mkdirSync(cacheDir, { recursive: true });

  if (src.kind === "file") {
    await toPcm(src.file, pcmPath);
    await normalise(pcmPath, cfg);
    return pcmPath;
  }

  if (src.kind === "mix") {
    await mixToPcm(src.bed, src.voice, src.atMs, pcmPath, cfg.mix?.voiceOffsetDb ?? 0);
    await normalise(pcmPath, cfg);
    return pcmPath;
  }

  const wavPath = path.join(cacheDir, `${key}.wav`);
  const piperArgs = ["--model", cfg.tts.model, "--output_file", wavPath];
  if (cfg.tts.lengthScale != null) piperArgs.push("--length_scale", String(cfg.tts.lengthScale));

  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      cfg.tts.binary,
      piperArgs,
      { cwd: path.dirname(cfg.tts.binary), maxBuffer: 1 << 24 },
      (err) => (err ? reject(new Error(`piper failed: ${err.message}`)) : resolve())
    );
    child.stdin?.end(src.text + "\n", "utf-8");
  });

  if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size === 0) {
    throw new Error(`piper produced no audio for ${JSON.stringify(src.text)}`);
  }

  await toPcm(wavPath, pcmPath);
  fs.unlinkSync(wavPath);
  await normalise(pcmPath, cfg);
  return pcmPath;
}

/**
 * Integrated loudness of a raw PCM file, in LUFS. Measured rather than guessed:
 * recorded announcements arrive anywhere from -8 to -17 LUFS, which is 9 dB of
 * swing the listener hears as "this one is shouting".
 */
async function measureLufs(pcmPath: string, raw = true): Promise<number | null> {
  try {
    const input = raw
      ? ["-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-i", pcmPath]
      : ["-i", pcmPath];
    const { stderr } = await run(FFMPEG, [
      "-hide_banner", "-nostdin",
      ...input,
      "-af", "loudnorm=print_format=json",
      "-f", "null", "-",
    ]);
    const m = String(stderr).match(/"input_i"\s*:\s*"(-?[\d.]+)"/);
    const v = m ? parseFloat(m[1]) : NaN;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Scale a PCM file in place so it lands on the target loudness. */
function scalePcm(pcmPath: string, gain: number): void {
  const buf = fs.readFileSync(pcmPath);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    let v = Math.round(buf.readInt16LE(i) * gain);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    buf.writeInt16LE(v, i);
  }
  fs.writeFileSync(pcmPath, buf);
}

/**
 * Bring a rendered clip to the configured loudness. Done by measuring and
 * applying a flat gain rather than with loudnorm's one-pass mode, which
 * compresses dynamics and pumps on clips this short.
 */
async function normalise(pcmPath: string, cfg: Config): Promise<void> {
  const target = cfg.audio.targetLufs;
  if (target == null) return;
  const measured = await measureLufs(pcmPath);
  if (measured == null || measured < -70) return; // silence or unmeasurable

  let db = target - measured;
  if (db > cfg.audio.maxBoostDb) db = cfg.audio.maxBoostDb; // never shout to fill a gap
  const gain = Math.pow(10, db / 20);
  if (Math.abs(db) < 0.2) return;
  scalePcm(pcmPath, gain);
}

export function pcmDurationMs(pcmPath: string): number {
  return Math.round((fs.statSync(pcmPath).size / (SAMPLE_RATE * CHANNELS * 2)) * 1000);
}
