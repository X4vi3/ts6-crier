import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/** Where a piece of audio comes from. */
export type Source =
  /** A finished track, played as-is. */
  | { kind: "file"; file: string; label: string }
  /** A bare voice line the bot lays over the bed itself. */
  | { kind: "mix"; bed: string; voice: string; atMs: number; label: string }
  | { kind: "tts"; text: string };

export function sourceLabel(s: Source): string {
  return s.kind === "tts" ? `"${s.text}"` : s.label;
}

/** One spoken moment inside a cycle. */
export interface ScheduleEvent {
  afterMs: number; // offset from the start of the cycle
  source: Source;
}

/**
 * Everything compiles to the same shape: a cycle of length `cycleMs` with one
 * or more events inside it.
 *
 *   every: 5m            -> cycleMs 5m,  one event at offset 0
 *   cycle: 30m + at[...] -> cycleMs 30m, one event per `at` entry
 */
export interface Schedule {
  name: string;
  cycleMs: number;
  events: ScheduleEvent[];
  autostart: boolean;
  /** false = one pass through the cycle, then stop by itself. */
  repeat: boolean;
}

/** When these schedules fire together, play one merged track instead. */
export interface Combo {
  when: string[];
  source: Source;
}

export interface Config {
  server: {
    host: string;
    port: number;
    nickname: string;
    channel?: string;
    serverPassword?: string;
  };
  soundsDir: string;
  /** Bed track every bare voice line is laid over. */
  mix?: { bed: string; voiceAtMs: number; voiceOffsetDb: number };
  /**
   * Files players upload through the TeamSpeak client. `root` is the server's
   * own files/virtualserver_N directory, read straight off disk when the bot
   * runs on the same machine. Without it the bot fetches them over the
   * file-transfer protocol, which works from anywhere.
   */
  uploads: { root: string | null; maxSeconds: number };
  /** Loudness every clip is brought to, so swapping files does not change level. */
  audio: { targetLufs: number | null; maxBoostDb: number };
  tts: {
    binary: string;
    model: string;
    lengthScale?: number;
    maxChars: number;
    /** piper and a voice are both in place; .say is refused otherwise. */
    available: boolean;
  };
  whisper: {
    /** Channel ids the bot stays silent in. */
    excludeIds: number[];
    /** Channel names, for anyone who prefers them. Names are NOT unique. */
    excludeNames: string[];
  };
  commands: {
    prefix: string;
    admins: string[];      // client UIDs
    adminGroups: string[]; // server group names or sgids
    comboWindowMs: number; // both lists empty = everyone may command the bot
  };
  schedules: Record<string, Schedule>;
  combos: Combo[];
}

/** Names that are already commands, so a schedule may not claim them. */
export const RESERVED_NAMES = [
  "start", "stop", "all", "restart", "say", "test", "status", "help",
  "files", "set", "reset", "sounds", "volume", "vol", "channels", "mute", "unmute",
];

/** "30s" | "5m" | "1h" | "90" (bare seconds) -> milliseconds */
export function parseDuration(v: string | number): number {
  if (typeof v === "number") return v * 1000;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) throw new Error(`bad duration: ${v} (use 30s, 5m, 1h)`);
  const n = parseFloat(m[1]);
  switch ((m[2] || "s").toLowerCase()) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
  }
  throw new Error(`bad duration: ${v} (use 30s, 5m, 1h)`);
}

export function humanDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function resolveFile(name: string, where: string, soundsDir: string): string {
  const file = path.resolve(soundsDir, name);
  if (!fs.existsSync(file)) throw new Error(`${where}: file not found: ${file}`);
  return file;
}

/**
 * Resolve what a node plays. Three forms:
 *   play:  file.mp3   finished track, used as-is
 *   voice: file.mp3   bare voice line — the bot lays it over the bed itself
 *   say:   "some text"  synthesised with piper
 */
function toSource(
  def: any,
  where: string,
  soundsDir: string,
  mix?: { bed: string; voiceAtMs: number; voiceOffsetDb: number }
): Source {
  const given = ["play", "voice", "say"].filter((k) => def[k] != null);
  if (given.length > 1) throw new Error(`${where}: more than one source: ${given.join(", ")}`);

  if (def.play != null) {
    const name = String(def.play);
    return { kind: "file", file: resolveFile(name, where, soundsDir), label: name };
  }
  if (def.voice != null) {
    const name = String(def.voice);
    const file = resolveFile(name, where, soundsDir);
    // No bed configured: a bare voice line is simply the whole announcement.
    if (!mix) return { kind: "file", file, label: name };
    return { kind: "mix", bed: mix.bed, voice: file, atMs: mix.voiceAtMs, label: name };
  }
  if (def.say != null) return { kind: "tts", text: String(def.say) };
  throw new Error(`${where}: needs "play", "voice" or "say"`);
}

function compileSchedule(
  name: string,
  def: any,
  soundsDir: string,
  mix?: { bed: string; voiceAtMs: number; voiceOffsetDb: number }
): Schedule {
  if (!def || typeof def !== "object") throw new Error(`schedule "${name}": not an object`);

  const hasEvery = def.every != null;
  const hasCycle = def.cycle != null || def.at != null;
  if (hasEvery && hasCycle) {
    throw new Error(`schedule "${name}": cannot have both "every" and "cycle"/"at"`);
  }

  let cycleMs: number;
  let events: ScheduleEvent[];

  if (hasEvery) {
    cycleMs = parseDuration(def.every);
    events = [{ afterMs: 0, source: toSource(def, `schedule "${name}"`, soundsDir, mix) }];
  } else if (hasCycle) {
    if (def.cycle == null) throw new Error(`schedule "${name}": has "at" but no "cycle"`);
    if (!Array.isArray(def.at) || !def.at.length) {
      throw new Error(`schedule "${name}": "at" must be a non-empty list`);
    }
    cycleMs = parseDuration(def.cycle);
    events = def.at.map((e: any, i: number) => {
      if (!e || typeof e !== "object") throw new Error(`schedule "${name}": at[${i}] is not an object`);
      if (e.after == null) throw new Error(`schedule "${name}": at[${i}] has no "after"`);
      const afterMs = parseDuration(e.after);
      if (afterMs >= cycleMs) {
        throw new Error(`schedule "${name}": at[${i}] after=${e.after} is not shorter than cycle=${def.cycle}`);
      }
      return { afterMs, source: toSource(e, `schedule "${name}" at[${i}]`, soundsDir, mix) };
    });
    events.sort((a, b) => a.afterMs - b.afterMs);
  } else {
    throw new Error(`schedule "${name}": needs either "every" or "cycle" + "at"`);
  }

  return { name, cycleMs, events, autostart: !!def.autostart, repeat: def.repeat !== false };
}

export function loadConfig(configPath: string): Config {
  const raw = YAML.parse(fs.readFileSync(configPath, "utf-8")) || {};
  const root = path.dirname(path.resolve(configPath));
  const soundsDir = path.resolve(root, raw.sounds_dir ?? raw.soundsDir ?? "sounds");

  const mix = raw.mix
    ? {
        bed: resolveFile(String(raw.mix.bed ?? ""), '"mix.bed"', soundsDir),
        voiceAtMs: parseDuration(raw.mix.voice_at ?? raw.mix.voiceAt ?? "0s"),
        voiceOffsetDb: Number(raw.mix.voice_offset_db ?? raw.mix.voiceOffsetDb ?? 0),
      }
    : undefined;

  // Environment wins over the file, so a container or a service unit can point
  // the same config at a different server without editing it.
  const env = process.env;
  const cfg: Config = {
    server: {
      host: env.CRIER_HOST || raw.server?.host || "127.0.0.1",
      port: Number(env.CRIER_PORT || raw.server?.port || 9987),
      nickname: env.CRIER_NICKNAME || raw.server?.nickname || "Crier",
      channel: env.CRIER_CHANNEL || raw.server?.channel || undefined,
      serverPassword: env.CRIER_PASSWORD || raw.server?.password || undefined,
    },
    soundsDir,
    mix,
    uploads: {
      root: raw.uploads?.root ? path.resolve(root, String(raw.uploads.root)) : null,
      maxSeconds: Number(raw.uploads?.max_seconds ?? raw.uploads?.maxSeconds ?? 30),
    },
    audio: {
      targetLufs:
        raw.audio?.target_lufs === null || raw.audio?.target_lufs === false
          ? null
          : Number(raw.audio?.target_lufs ?? raw.audio?.targetLufs ?? -43),
      maxBoostDb: Number(raw.audio?.max_boost_db ?? raw.audio?.maxBoostDb ?? 12),
    },
    tts: (() => {
      const binary = path.resolve(root, String(raw.tts?.binary ?? `piper/piper${process.platform === "win32" ? ".exe" : ""}`));
      const model = raw.tts?.model ? path.resolve(root, String(raw.tts.model)) : firstVoice(path.join(root, "voices"));
      return {
        binary,
        model,
        lengthScale: raw.tts?.length_scale ?? raw.tts?.lengthScale,
        maxChars: Number(raw.tts?.max_chars ?? 200),
        available: fs.existsSync(binary) && !!model && fs.existsSync(model),
      };
    })(),
    whisper: (() => {
      const raw2 = raw.whisper?.exclude_channels ?? raw.whisper?.excludeChannels ?? [];
      const list = (Array.isArray(raw2) ? raw2 : [raw2]).map((x: any) => String(x).trim()).filter(Boolean);
      return {
        excludeIds: list.filter((x) => /^\d+$/.test(x)).map(Number),
        excludeNames: list.filter((x) => !/^\d+$/.test(x)),
      };
    })(),
    commands: {
      // Not "/": the TeamSpeak client swallows slash commands itself.
      prefix: raw.commands?.prefix ?? ".",
      admins: (raw.commands?.admins ?? []).map(String),
      adminGroups: (raw.commands?.admin_groups ?? raw.commands?.adminGroups ?? []).map(String),
      comboWindowMs: parseDuration(raw.commands?.combo_window ?? "150ms"),
    },
    schedules: {},
    combos: [],
  };

  for (const [name, def] of Object.entries<any>(raw.schedules ?? {})) {
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      throw new Error(`schedule "${name}": names may only use a-z, 0-9, _ and -`);
    }
    if (RESERVED_NAMES.includes(name.toLowerCase())) {
      throw new Error(`schedule "${name}": that name is a built-in command`);
    }
    cfg.schedules[name] = compileSchedule(name, def, soundsDir, mix);
  }

  const combos = raw.combos ?? [];
  if (!Array.isArray(combos)) throw new Error(`"combos" must be a list`);
  cfg.combos = combos.map((c: any, i: number) => {
    if (!Array.isArray(c?.when) || c.when.length < 2) {
      throw new Error(`combos[${i}]: "when" must list at least two schedules`);
    }
    for (const n of c.when) {
      if (!cfg.schedules[n]) throw new Error(`combos[${i}]: no schedule named "${n}"`);
    }
    return { when: c.when.map(String), source: toSource(c, `combos[${i}]`, soundsDir, mix) };
  });
  // Match the most specific rule first when several could apply.
  cfg.combos.sort((a, b) => b.when.length - a.when.length);

  if (!Object.keys(cfg.schedules).length) throw new Error("the config has no schedules");

  const allSources: Source[] = [
    ...Object.values(cfg.schedules).flatMap((s) => s.events.map((e) => e.source)),
    ...cfg.combos.map((c) => c.source),
  ];
  if (allSources.some((x) => x.kind === "tts")) {
    if (!fs.existsSync(cfg.tts.binary)) throw new Error(`piper not found: ${cfg.tts.binary} (schedules with "say:" need it)`);
    if (!cfg.tts.model || !fs.existsSync(cfg.tts.model)) throw new Error(`piper voice not found: ${cfg.tts.model || "voices/*.onnx"}`);
  }

  return cfg;
}

/** Any piper voice dropped into voices/, so enabling TTS is "put a file there". */
function firstVoice(dir: string): string {
  try {
    const f = fs.readdirSync(dir).filter((x) => x.endsWith(".onnx")).sort()[0];
    return f ? path.join(dir, f) : "";
  } catch {
    return "";
  }
}
