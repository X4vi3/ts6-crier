import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { Ts3Client } from "./tslib/client.js";
import { buildCommand } from "./tslib/commands.js";
import { loadOrCreateIdentity } from "./identity-store.js";
import {
  loadConfig,
  humanDuration,
  sourceLabel,
  RESERVED_NAMES,
  type Config,
  type Schedule,
  type Source,
} from "./config.js";
import { renderSource, sourceKey, pcmDurationMs, probeAudio } from "./tts.js";
import { encodePcmFile, peakOf } from "./audio.js";
import {
  listUploadsOnDisk,
  listUploadsRemote,
  findUpload,
  adoptUpload,
  pruneAdopted,
  type Upload,
} from "./uploads.js";
import { FileTransfer } from "./filetransfer.js";
import {
  ROOT,
  CONFIG_PATH,
  CACHE_DIR,
  STATE_PATH,
  OVERRIDES_PATH,
  SETTINGS_PATH,
  IDENTITY_PATH,
  AVATAR_PATH,
  FFMPEG,
} from "./paths.js";
import { needsSetup, runSetup } from "./setup.js";

const DEFAULT_VOLUME = 100; // percent; unchanged unless someone asks for it
const MAX_VOLUME = 200;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const UPLOAD_LIST_TTL_MS = 60_000;

const NL = String.fromCharCode(10);
// Replaced at build time by the release script; a source checkout says "dev".
declare const __CRIER_VERSION__: string | undefined;
const VERSION = typeof __CRIER_VERSION__ === "string" ? __CRIER_VERSION__ : "dev";
const FRAME_MS = 20;
const QUEUE_LIMIT = 6;
const GAP_MS = 400; // silence between two back-to-back announcements

/**
 * Percent -> amplitude, square law. A straight percentage is nearly useless as
 * a volume control: 0..200% spans only -inf..+6 dB, so the bottom half barely
 * quietens and the top half barely adds. Squaring spreads the same slider over
 * roughly 24 dB — 200% lands +12 dB (clearly shouting), 50% lands -12 dB, and
 * single digits fall away to almost nothing.
 */
function gainFor(percent: number): number {
  const v = Math.max(0, percent) / 100;
  return v * v;
}

function log(...a: unknown[]) {
  console.log(new Date().toISOString().replace("T", " ").slice(0, 19), "|", ...a);
}

interface Running {
  timers: NodeJS.Timeout[];
  startedAt: number;
  startedBy: string;
  startedByClid: number;
}

/** A fired event waiting to be turned into audio. `schedule` is null for one-offs. */
interface Pending {
  schedule: string | null;
  source: Source;
}

/** What `/set` recorded: a file adopted into sounds/custom plus how to play it. */
interface StoredOverride {
  file: string;   // relative to soundsDir
  mix: boolean;   // lay it over the bed instead of playing as-is
  origin: string; // name the file had in the TeamSpeak channel
  by: string;
  at: number;
}

class Crier {
  private cfg: Config;
  private client = new Ts3Client();
  private ft: FileTransfer | null = null;
  private uploadCache: { at: number; list: Upload[] } | null = null;
  private connected = false;
  private running = new Map<string, Running>();
  private frames = new Map<string, Buffer[]>(); // source key -> opus frames
  private pending: Pending[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private queue: Source[] = [];
  private draining = false;
  private reconnectDelay = 2000;
  private stopping = false;

  /** Audio assigned from TeamSpeak uploads, overriding what config.yml says. */
  private overrides = new Map<string, StoredOverride>();

  /** Playback volume in percent. Frames are cached per volume, see framesFor. */
  private volume = DEFAULT_VOLUME;

  // Runtime overrides on top of config.whisper. Kept as two explicit sets so
  // config.yml keeps meaning something: a channel muted by command is added
  // here, and a channel un-muted by command wins over the config list.
  private mutedExtra = new Set<number>();
  private unmutedExtra = new Set<number>();

  // Server-side view of who is who, rebuilt on every (re)connect.
  private clientGroups = new Map<number, number[]>(); // clid -> server group ids
  private clientNames = new Map<number, string>(); // clid -> nickname
  private groupNames = new Map<number, string>(); // sgid -> group name

  /**
   * The bot's UID as the SERVER knows it. Not the same as identity.json's uid:
   * tslib derives the TS3-style sha1 UID, while a TS6 server assigns a 32-byte
   * one. The avatar file name is built from the server's version, so it has to
   * be read back off the wire rather than computed locally.
   */
  private myUid = "";

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  // ---------- avatar ----------

  /**
   * TeamSpeak stores a client avatar as internal/avatar_<uid>, where <uid> is
   * every byte of the base64-decoded client UID written as two letters a..p.
   * The client uploads the picture, then advertises it by setting
   * client_flag_avatar to its md5. The file name is only needed for the log:
   * when the upload is refused, the file can still be placed by hand.
   */
  private avatarInfo(uid: string): { md5: string; fileName: string; data: Buffer } | null {
    if (!fs.existsSync(AVATAR_PATH)) return null;
    try {
      const data = fs.readFileSync(AVATAR_PATH);
      const md5 = crypto.createHash("md5").update(data).digest("hex");
      let name = "avatar_";
      for (const b of Buffer.from(uid, "base64")) {
        name += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15));
      }
      return { md5, fileName: name, data };
    } catch (e: any) {
      log("cannot read avatar:", e?.message ?? e);
      return null;
    }
  }

  private async setAvatar(uid: string): Promise<void> {
    const av = this.avatarInfo(uid);
    if (!av) return;
    try {
      await this.ft!.upload(0, "/avatar", av.data);
      log(`avatar uploaded (md5=${av.md5})`);
    } catch (e: any) {
      log(`avatar upload refused: ${e?.message ?? e}`);
      log(`  to set it by hand, copy avatar.png to <ts>/files/virtualserver_1/internal/${av.fileName}`);
    }
    this.client.sendCommand(buildCommand("clientupdate", { client_flag_avatar: av.md5 }));
  }

  // ---------- who is on the server ----------

  /**
   * The bot only ever sees clients in channels it is subscribed to, so after
   * connecting it subscribes to all of them. Without that, a player sitting in
   * another channel sends a command and the bot has no idea what groups they
   * are in.
   */
  private trackProtocol(p: any): void {
    const rows = p.groups ?? [p.params];
    switch (p.name) {
      case "notifyservergrouplist":
        for (const g of rows) {
          const sgid = parseInt(g.sgid);
          if (sgid) this.groupNames.set(sgid, String(g.name ?? ""));
        }
        break;
      case "notifycliententerview":
      case "notifyclientupdated":
        for (const g of rows) {
          const clid = parseInt(g.clid);
          if (!clid) continue;
          if (g.client_nickname) this.clientNames.set(clid, String(g.client_nickname));
          if (clid === this.client.getClientId() && g.client_unique_identifier) {
            this.myUid = String(g.client_unique_identifier);
          }
          if (g.client_servergroups != null) {
            this.clientGroups.set(
              clid,
              String(g.client_servergroups).split(",").map(Number).filter(Boolean)
            );
          }
        }
        break;
      case "notifyclientleftview":
        for (const g of rows) {
          const clid = parseInt(g.clid);
          if (clid) {
            this.clientGroups.delete(clid);
            this.clientNames.delete(clid);
          }
        }
        break;

      case "notifychannelcreated":
        // A brand new channel is not covered by the subscription taken at
        // connect time. Whoever created it is usually standing in it, and an
        // unsubscribed channel makes them invisible — their server groups are
        // forgotten and every command they send is refused. Re-subscribe.
        this.client.sendCommand(buildCommand("channelsubscribeall", {}));
        log("new channel appeared, re-subscribed to all channels");
        break;
    }
  }

  /** May this client run commands? Both lists empty means "anyone". */
  private authorize(clid: number, uid: string): { ok: boolean; detail: string } {
    const { admins, adminGroups } = this.cfg.commands;
    if (!admins.length && !adminGroups.length) return { ok: true, detail: "open to everyone" };
    if (admins.includes(uid)) return { ok: true, detail: "uid is in the admins list" };

    const sgids = this.clientGroups.get(clid);
    if (!sgids) {
      // Fail closed, but say so plainly: this is a "bot has not seen you yet"
      // state, not a real denial, and it fixes itself on the next attempt.
      return { ok: false, detail: "the bot does not know your groups yet" };
    }
    for (const sgid of sgids) {
      const name = this.groupNames.get(sgid) ?? "";
      const match = adminGroups.some(
        (a) => a === String(sgid) || a.toLowerCase() === name.toLowerCase()
      );
      if (match) return { ok: true, detail: `group ${name || sgid}` };
    }
    const mine = sgids.map((s) => this.groupNames.get(s) ?? String(s)).join(", ");
    return { ok: false, detail: `your groups: ${mine || "none"}` };
  }

  // ---------- custom audio assigned from TeamSpeak uploads ----------

  /** Canonical key for a target name: a schedule, or a combo. */
  private targetKey(name: string): string | null {
    const q = name.toLowerCase();
    if (this.cfg.schedules[q]) return q;
    if (q === "combo" && this.cfg.combos.length) return this.cfg.combos[0].when.join("+");
    const c = this.cfg.combos.find((x) => x.when.join("+").toLowerCase() === q);
    return c ? c.when.join("+") : null;
  }

  private targetNames(): string[] {
    return [...Object.keys(this.cfg.schedules), ...this.cfg.combos.map((c) => c.when.join("+"))];
  }

  private overrideSource(key: string): Source | undefined {
    const o = this.overrides.get(key);
    if (!o) return undefined;
    const file = path.resolve(this.cfg.soundsDir, o.file);
    if (!fs.existsSync(file)) {
      log(`override "${key}": file is gone (${o.file}), falling back to config`);
      return undefined;
    }
    if (o.mix && this.cfg.mix) {
      return { kind: "mix", bed: this.cfg.mix.bed, voice: file, atMs: this.cfg.mix.voiceAtMs, label: o.origin };
    }
    return { kind: "file", file, label: o.origin };
  }

  /** What a schedule event actually plays right now. */
  private sourceFor(schedule: string, ev: { source: Source }): Source {
    return this.overrideSource(schedule) ?? ev.source;
  }

  private comboSourceFor(c: { when: string[]; source: Source }): Source {
    return this.overrideSource(c.when.join("+")) ?? c.source;
  }

  loadCustomAudio(): void {
    if (!fs.existsSync(OVERRIDES_PATH)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf-8"));
      for (const [k, v] of Object.entries<any>(raw ?? {})) {
        if (v?.file) this.overrides.set(k, v as StoredOverride);
      }
      if (this.overrides.size) log(`custom audio: ${[...this.overrides.keys()].join(", ")}`);
      else log("custom audio: nothing assigned, all from config");
    } catch (e: any) {
      log("cannot read overrides.json:", e?.message ?? e);
    }
  }

  private saveOverrides(): void {
    try {
      fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(Object.fromEntries(this.overrides), null, 2));
    } catch (e: any) {
      log("cannot save overrides.json:", e?.message ?? e);
    }
  }

  // ---------- audio ----------

  private async framesFor(src: Source): Promise<Buffer[]> {
    // Volume is part of the key: the same clip at a different volume is a
    // different set of Opus frames, but the same PCM on disk.
    const key = `${sourceKey(src, this.cfg)}|v${this.volume}`;
    const cached = this.frames.get(key);
    if (cached) return cached;
    const t0 = Date.now();
    const pcm = await renderSource(src, this.cfg, CACHE_DIR);
    const frames = encodePcmFile(pcm, gainFor(this.volume));
    this.frames.set(key, frames);
    log(
      `prepared ${sourceLabel(src)} -> ${frames.length} frames ` +
        `(${pcmDurationMs(pcm)}ms, ${this.volume}%, ${Date.now() - t0}ms)`
    );
    return frames;
  }

  /** Pre-render everything the config mentions, so a timer never waits on ffmpeg. */
  async prepareAudio(): Promise<void> {
    for (const [name, sch] of Object.entries(this.cfg.schedules)) {
      for (const ev of sch.events) await this.framesFor(this.sourceFor(name, ev));
    }
    for (const combo of this.cfg.combos) await this.framesFor(this.comboSourceFor(combo));
  }

  // ---------- connection ----------

  async connect(): Promise<void> {
    const identity = loadOrCreateIdentity(IDENTITY_PATH);
    log(`bot uid=${identity.uid}`);

    this.clientGroups.clear();
    this.clientNames.clear();
    this.groupNames.clear();

    this.client.removeAllListeners();
    this.client.on("error", (e: any) => log("client error:", e?.message ?? e));
    if (process.env.CRIER_DEBUG) this.client.on("debug", (m: any) => log("debug:", m));
    this.client.on("command", (p: any) => this.trackProtocol(p));
    this.client.on("textMessage", (m: any) => this.onTextMessage(m));
    this.client.on("disconnected", () => {
      if (!this.connected) return;
      this.connected = false;
      log("disconnected from server");
      if (!this.stopping) void this.reconnectLoop();
    });

    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("connect timeout")), 30000);
      this.client.once("connected", () => {
        clearTimeout(to);
        resolve();
      });
      this.client
        .connect({
          host: this.cfg.server.host,
          port: this.cfg.server.port,
          identity,
          nickname: this.cfg.server.nickname,
          serverPassword: this.cfg.server.serverPassword,
          defaultChannel: this.cfg.server.channel,
        })
        .catch((e) => {
          clearTimeout(to);
          reject(e);
        });
    });

    this.connected = true;
    this.reconnectDelay = 2000;
    await sleep(2000); // let the channel list arrive

    // Without this the bot only sees clients sharing its channel, and command
    // authorisation by server group would fail for everyone else.
    this.client.sendCommand(buildCommand("channelsubscribeall", {}));
    await sleep(1500);

    this.ft = new FileTransfer(this.client, this.cfg.server.host);
    this.uploadCache = null;
    await this.setAvatar(this.myUid || identity.uid);

    log(`connected as clid=${this.client.getClientId()}, ${this.client.getChannels().size} channels visible`);
    log(`visible clients: ${this.clientGroups.size}, server groups known: ${this.groupNames.size}`);
    const { admins, adminGroups } = this.cfg.commands;
    log(
      admins.length || adminGroups.length
        ? `commands restricted to groups [${adminGroups.join(", ")}] and ${admins.length} uid(s)`
        : "commands open to everyone"
    );
  }

  private async reconnectLoop(): Promise<void> {
    while (!this.connected && !this.stopping) {
      log(`reconnecting in ${Math.round(this.reconnectDelay / 1000)}s...`);
      await sleep(this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
      try {
        this.client = new Ts3Client();
        await this.connect();
        log("reconnected");
      } catch (e: any) {
        log("reconnect failed:", e?.message ?? e);
      }
    }
  }

  // ---------- combo resolution ----------

  /** True if every schedule of some combo rule is currently running. */
  private comboPossible(): boolean {
    return this.cfg.combos.some((c) => c.when.every((n) => this.running.has(n)));
  }

  /**
   * Fired events are collected for a short window before anything is spoken.
   * If a combo rule's schedules all landed in the same window, their separate
   * tracks are replaced by the single merged one.
   */
  private enqueue(item: Pending): void {
    this.pending.push(item);
    if (this.flushTimer) return;
    const wait = item.schedule && this.comboPossible() ? this.cfg.commands.comboWindowMs : 0;
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.flushTimer = null;
    const batch = this.pending.splice(0);
    for (const src of this.resolveCombos(batch)) {
      if (this.queue.length >= QUEUE_LIMIT) {
        log(`queue full, dropping ${sourceLabel(src)}`);
        continue;
      }
      this.queue.push(src);
    }
    void this.drain();
  }

  private resolveCombos(batch: Pending[]): Source[] {
    const remaining = [...batch];
    const out: Source[] = [];

    for (const combo of this.cfg.combos) {
      for (;;) {
        const used = new Set<number>();
        let complete = true;
        for (const name of combo.when) {
          let found = -1;
          for (let i = 0; i < remaining.length; i++) {
            if (!used.has(i) && remaining[i].schedule === name) {
              found = i;
              break;
            }
          }
          if (found < 0) {
            complete = false;
            break;
          }
          used.add(found);
        }
        if (!complete) break;
        for (const i of [...used].sort((a, b) => b - a)) remaining.splice(i, 1);
        const merged = this.comboSourceFor(combo);
        out.push(merged);
        log(`combo ${combo.when.join(" + ")} -> ${sourceLabel(merged)}`);
      }
    }

    for (const item of remaining) out.push(item.source);
    return out;
  }

  // ---------- speaking ----------

  /** Is the bot silent in this channel? Ids are preferred — names repeat. */
  private isMuted(cid: number, name: string): boolean {
    if (this.unmutedExtra.has(cid)) return false;
    if (this.mutedExtra.has(cid)) return true;
    return this.cfg.whisper.excludeIds.includes(cid) || this.cfg.whisper.excludeNames.includes(name);
  }

  /** Why a channel is silent, for the .channels listing. */
  private muteReason(cid: number, name: string): string {
    if (this.unmutedExtra.has(cid)) return "";
    if (this.mutedExtra.has(cid)) return "muted (command)";
    if (this.cfg.whisper.excludeIds.includes(cid) || this.cfg.whisper.excludeNames.includes(name)) {
      return "muted (config)";
    }
    return "";
  }

  private targetChannels(): number[] {
    const ids: number[] = [];
    for (const [cid, name] of this.client.getChannels()) {
      if (!this.isMuted(cid, name)) ids.push(cid);
    }
    return ids;
  }

  /** Every channel with its id, so the operator can pick ids for the config. */
  private cmdChannels(): string {
    const all = [...this.client.getChannels().entries()].sort((a, b) => a[0] - b[0]);
    const lines = [`Channels (${all.length}), announcements go to ${this.targetChannels().length}:`];
    for (const [cid, name] of all) {
      const reason = this.muteReason(cid, name);
      lines.push(`  ${String(cid).padStart(3)}  ${name.padEnd(24)} ${reason || "covered"}`);
    }
    lines.push(`${this.cfg.commands.prefix}mute <id> / ${this.cfg.commands.prefix}unmute <id> to change it`);
    return lines.join(NL);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.stopping) {
        const src = this.queue.shift()!;
        await this.speak(src);
        if (this.queue.length) await sleep(GAP_MS);
      }
    } finally {
      this.draining = false;
    }
  }

  private async speak(src: Source): Promise<void> {
    if (!this.connected) {
      log(`skip ${sourceLabel(src)}: not connected`);
      return;
    }

    let frames: Buffer[];
    try {
      frames = await this.framesFor(src);
    } catch (e: any) {
      log(`cannot prepare ${sourceLabel(src)}:`, e?.message ?? e);
      return;
    }
    if (!frames.length) return;

    const targets = this.targetChannels();
    if (!targets.length) {
      log(`skip ${sourceLabel(src)}: no target channels`);
      return;
    }

    const t0 = Date.now();
    try {
      // Drift-corrected pacing: each frame is due at a fixed offset from the
      // start, so one slow tick does not push every later frame back.
      const start = Date.now();
      for (let i = 0; i < frames.length; i++) {
        this.client.sendVoiceWhisper(frames[i], targets);
        const wait = start + (i + 1) * FRAME_MS - Date.now();
        if (wait > 0) await sleep(wait);
      }
      this.client.sendVoiceWhisperStop(targets);
      log(`played ${sourceLabel(src)} -> ${targets.length} channels, ${frames.length} frames in ${Date.now() - t0}ms`);
    } catch (e: any) {
      log("whisper failed:", e?.message ?? e);
    }
  }

  // ---------- scheduling ----------

  private nextFire(startedAt: number, afterMs: number, cycleMs: number): number {
    let t = startedAt + afterMs;
    const now = Date.now();
    if (t <= now) t += Math.ceil((now - t + 1) / cycleMs) * cycleMs;
    return t;
  }

  private describe(sch: Schedule): string {
    if (sch.events.length === 1 && sch.events[0].afterMs === 0) {
      return `every ${humanDuration(sch.cycleMs)}`;
    }
    const parts = sch.events.map((e) => humanDuration(e.afterMs));
    const mode = sch.repeat ? "repeating" : "single pass";
    return `cycle ${humanDuration(sch.cycleMs)} (${mode}), announcements at ${parts.join(", ")}`;
  }

  private static mmss(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  /** Who started a running schedule, when, and what it will say next. */
  private runningInfo(name: string): string {
    const r = this.running.get(name);
    const sch = this.cfg.schedules[name];
    if (!r || !sch) return "";
    const ago = (Date.now() - r.startedAt) / 1000;
    const next = Math.min(...sch.events.map((ev) => this.nextFire(r.startedAt, ev.afterMs, sch.cycleMs)));
    return `started by ${r.startedBy} ${Crier.mmss(ago)} ago, next in ${Crier.mmss((next - Date.now()) / 1000)}`;
  }

  start(name: string, by: string, byClid = 0, startedAt = Date.now()): string {
    const sch = this.cfg.schedules[name];
    if (!sch) return `no such schedule: ${name}`;
    // Refuse rather than restart: a second player must not silently reset a
    // timer someone else already aligned to the war clock.
    if (this.running.has(name)) {
      const p = this.cfg.commands.prefix;
      return `"${name}" is already running — ${this.runningInfo(name)}. Leaving it alone. To start over: ${p}restart`;
    }

    const rec: Running = {
      timers: [], startedAt, startedBy: by, startedByClid: byClid,
    };
    this.running.set(name, rec);

    const now = Date.now();
    for (const ev of sch.events) {
      const fire = () => this.enqueue({ schedule: name, source: this.sourceFor(name, ev) });

      // Timers are placed against the ORIGINAL origin, not "now". That is what
      // lets a restart mid-war pick the schedule back up on the same beat
      // instead of shifting every announcement by the downtime.
      let due = startedAt + ev.afterMs;
      while (due < now) due += sch.cycleMs;

      const first = setTimeout(() => {
        if (this.running.get(name) !== rec) return; // stopped while we waited
        fire();
        if (!sch.repeat) return; // single pass: no follow-up interval
        const again = setInterval(() => {
          if (this.running.get(name) !== rec) {
            clearInterval(again);
            return;
          }
          fire();
        }, sch.cycleMs);
        rec.timers.push(again);
      }, Math.max(0, due - now));
      rec.timers.push(first);
    }

    if (!sch.repeat) {
      // The war is over when the cycle is over — take ourselves off the board
      // instead of quietly starting a second round.
      const done = setTimeout(() => {
        if (this.running.get(name) !== rec) return;
        for (const t of rec.timers) clearTimeout(t);
        this.running.delete(name);
        this.saveState();
        log(`"${name}" finished its cycle, stopped by itself`);
        this.announceFinished(rec);
      }, Math.max(0, startedAt + sch.cycleMs - now));
      rec.timers.push(done);
    }

    this.saveState();
    log(`started "${name}" (${this.describe(sch)}) by ${by}`);

    const lines = [`started: ${name} — cycle ${humanDuration(sch.cycleMs)}`];
    for (const ev of sch.events) {
      lines.push(`  in ${humanDuration(ev.afterMs)} — ${sourceLabel(ev.source)}`);
    }
    return lines.join("\n");
  }

  /** Tell whoever started it that the bot has gone quiet on purpose. */
  private announceFinished(rec: Running): void {
    if (this.running.size) return; // something else is still going
    if (!rec.startedByClid) return;
    const p = this.cfg.commands.prefix;
    void this.reply(rec.startedByClid, `cycle finished, announcements stopped. Start again: ${p}all`);
  }

  /**
   * Start everything in one tick. Cycles then share an origin, which is what
   * makes the combo rules actually trigger — started minutes apart, the two
   * schedules run on independent clocks and never land together.
   */
  startAll(by: string, byClid = 0): string {
    const p = this.cfg.commands.prefix;
    const names = Object.keys(this.cfg.schedules);
    const already = names.filter((n) => this.running.has(n));
    const missing = names.filter((n) => !this.running.has(n));
    const listRunning = () => already.map((n) => `${n} — ${this.runningInfo(n)}`).join("\n  ");

    if (already.length && !missing.length) {
      return `everything is already running:\n  ${listRunning()}\nLeaving it alone. To start over: ${p}restart`;
    }

    if (already.length) {
      // Starting only the missing ones would give them a different cycle
      // origin, so combos would never line up again. Make the choice explicit
      // instead of quietly producing a broken schedule.
      return [
        `already running:\n  ${listRunning()}`,
        `Not starting ${missing.join(", ")} on its own — it would run off a different clock and the merge would break.`,
        `To start over: ${p}restart — stops everything and starts from this second.`,
      ].join("\n");
    }

    for (const name of missing) this.start(name, by, byClid);
    const lines = [`started together: ${missing.join(", ")}`];
    for (const c of this.cfg.combos) {
      lines.push(`when ${c.when.join(" + ")} coincide, ${sourceLabel(c.source)} plays`);
    }
    return lines.join("\n");
  }

  /** Explicit "start over" reset: everything stops and starts from now. */
  restartAll(by: string, byClid = 0): string {
    const had = [...this.running.keys()];
    for (const [, r] of this.running) for (const t of r.timers) clearTimeout(t);
    this.running.clear();
    for (const name of Object.keys(this.cfg.schedules)) this.start(name, by, byClid);
    log(`restart by ${by} (was running: ${had.join(", ") || "nothing"})`);

    const lines: string[] = [];
    if (had.length) lines.push(`stopped: ${had.join(", ")}`);
    lines.push(`started over: ${Object.keys(this.cfg.schedules).join(", ")}`);
    for (const c of this.cfg.combos) {
      lines.push(`when ${c.when.join(" + ")} coincide, ${sourceLabel(c.source)} plays`);
    }
    return lines.join("\n");
  }

  stop(name: string): string {
    if (name === "all") {
      const n = this.running.size;
      for (const [, r] of this.running) for (const t of r.timers) clearTimeout(t);
      this.running.clear();
      this.saveState();
      log(`stopped all (${n})`);
      return n ? `stopped: ${n}` : "nothing to stop";
    }
    const r = this.running.get(name);
    if (!r) return `"${name}" is not running`;
    for (const t of r.timers) clearTimeout(t);
    this.running.delete(name);
    this.saveState();
    log(`stopped "${name}"`);
    return `stopped: ${name}`;
  }

  status(): string {
    const lines: string[] = [];
    lines.push(this.running.size ? `Running (${this.running.size}):` : "Nothing is running.");

    for (const [name, r] of this.running) {
      const sch = this.cfg.schedules[name];
      const tail = sch.repeat ? "repeating" : `ends in ${Crier.mmss((r.startedAt + sch.cycleMs - Date.now()) / 1000)}`;
      lines.push(
        `  ${name} — cycle ${humanDuration(sch.cycleMs)}, ${tail}; started by ${r.startedBy} ${Crier.mmss((Date.now() - r.startedAt) / 1000)} ago`
      );
      // Sorted by when it will actually happen — config order reads as nonsense
      // once the cycle has wrapped around.
      const upcoming = sch.events
        .map((ev) => ({ at: this.nextFire(r.startedAt, ev.afterMs, sch.cycleMs), ev }))
        .filter((x) => sch.repeat || x.at <= r.startedAt + sch.cycleMs)
        .sort((a, b) => a.at - b.at);
      if (!upcoming.length) lines.push(`     no more announcements`);
      for (const { at, ev } of upcoming) {
        lines.push(`     in ${Crier.mmss((at - Date.now()) / 1000)} — ${sourceLabel(ev.source)}`);
      }
    }

    if (this.comboPossible()) {
      for (const c of this.cfg.combos) {
        if (c.when.every((n) => this.running.has(n))) {
          lines.push(`Merge active: ${c.when.join(" + ")} -> ${sourceLabel(c.source)}`);
        }
      }
    }

    const idle = Object.keys(this.cfg.schedules).filter((n) => !this.running.has(n));
    if (idle.length) lines.push(`Not running: ${idle.join(", ")}`);
    lines.push(`Channels covered: ${this.targetChannels().length}`);
    return lines.join("\n");
  }

  private helpText(): string {
    const p = this.cfg.commands.prefix;
    const lines = ["Commands:"];
    for (const [name, sch] of Object.entries(this.cfg.schedules)) {
      lines.push(`  ${p}${name} — ${this.describe(sch)}`);
    }
    lines.push(`  ${p}all — start everything at once, in sync (the merge needs this)`);
    for (const c of this.cfg.combos) {
      lines.push(`      when ${c.when.join(" + ")} coincide -> ${sourceLabel(c.source)}`);
    }
    lines.push(`  ${p}stop — stop everything`);
    lines.push(`  ${p}stop <name> — stop one`);
    lines.push(`  ${p}restart — stop everything and start over from this second`);
    lines.push(`  ${p}test <name|combo> — play a track once`);
    if (this.cfg.tts.available) lines.push(`  ${p}say <text> — synthesise and speak it (robot voice)`);
    lines.push(`  ${p}status — what is running and how long until the next one`);
    lines.push(`  ${p}files — audio files uploaded to the channels`);
    lines.push(`  ${p}set <target> <file> [gong] — assign your own audio`);
    lines.push(`  ${p}reset <target|all> — restore the audio from config`);
    lines.push(`  ${p}sounds — what plays for each target`);
    lines.push(`  ${p}channels — every channel with its id and whether it is covered`);
    lines.push(`  ${p}mute <id> / ${p}unmute <id> — silence a channel or bring it back`);
    lines.push(`  ${p}volume [0-${MAX_VOLUME}] — bot volume (now ${this.volume}%)`);
    return lines.join("\n");
  }

  /** One-off playback for checking that a track sounds right. */
  /** Must go through the overrides — otherwise /test plays the old sound and
   *  the operator concludes their upload did not take. */
  private testSource(what: string): Source | null {
    const sch = this.cfg.schedules[what];
    if (sch) return this.sourceFor(what, sch.events[0]);
    const combo =
      what === "combo"
        ? this.cfg.combos[0]
        : this.cfg.combos.find((c) => c.when.join("+") === what);
    return combo ? this.comboSourceFor(combo) : null;
  }

  // ---------- volume ----------

  loadVolume(): void {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      const v = Number(raw?.volume);
      if (Number.isFinite(v) && v >= 0 && v <= MAX_VOLUME) this.volume = Math.round(v);
      for (const c of raw?.mutedExtra ?? []) if (Number.isFinite(c)) this.mutedExtra.add(Number(c));
      for (const c of raw?.unmutedExtra ?? []) if (Number.isFinite(c)) this.unmutedExtra.add(Number(c));
      log(`volume: ${this.volume}%`);
      if (this.mutedExtra.size) log(`muted by command: ${[...this.mutedExtra].join(", ")}`);
      if (this.unmutedExtra.size) log(`unmuted by command: ${[...this.unmutedExtra].join(", ")}`);
    } catch (e: any) {
      log("cannot read settings.json:", e?.message ?? e);
    }
  }

  private saveSettings(): void {
    try {
      fs.writeFileSync(
        SETTINGS_PATH,
        JSON.stringify(
          {
            volume: this.volume,
            mutedExtra: [...this.mutedExtra],
            unmutedExtra: [...this.unmutedExtra],
          },
          null,
          2
        )
      );
    } catch (e: any) {
      log("cannot save settings.json:", e?.message ?? e);
    }
  }

  /**
   * How loud the announcements actually are. Reported in LUFS rather than as a
   * peak percentage: every clip is normalised to one level, so the peak is far
   * below full scale by design and quoting it just looks alarming.
   */
  private async levelReport(): Promise<string> {
    const target = this.cfg.audio.targetLufs;
    const lines: string[] = [];

    if (target != null) {
      const eff = target + 20 * Math.log10(gainFor(Math.max(this.volume, 1)));
      lines.push(
        this.volume === 0
          ? "  silent"
          : `  level ${eff.toFixed(1)} LUFS (every track normalised to ${target})`
      );
    }

    // Clipping can only appear if someone pushed the volume above 100.
    if (this.volume > 100) {
      const seen = new Set<string>();
      let peak = 0;
      const check = async (src: Source) => {
        const k = sourceKey(src, this.cfg);
        if (seen.has(k)) return;
        seen.add(k);
        try {
          peak = Math.max(peak, peakOf(await renderSource(src, this.cfg, CACHE_DIR), gainFor(this.volume)));
        } catch {
          /* a missing file is reported elsewhere */
        }
      };
      for (const [name, sch] of Object.entries(this.cfg.schedules)) {
        for (const ev of sch.events) await check(this.sourceFor(name, ev));
      }
      for (const c of this.cfg.combos) await check(this.comboSourceFor(c));
      if (peak >= 1) lines.push("  peak hits the ceiling — it will clip, turn it down");
    }
    return lines.join(NL);
  }

  private async cmdVolume(arg: string, by: string): Promise<string> {
    const p = this.cfg.commands.prefix;

    if (!arg) {
      const rep = await this.levelReport();
      return [
        `volume is ${this.volume}%`,
        rep,
        `change it: ${p}volume 60   (0 = silent, 100 = normal, 200 = shouting)`,
      ].filter(Boolean).join("\n");
    }

    const v = Number(arg.replace("%", ""));
    if (!Number.isFinite(v) || v < 0 || v > MAX_VOLUME) {
      return `volume is a number from 0 to ${MAX_VOLUME}, not "${arg}"`;
    }

    const was = this.volume;
    this.volume = Math.round(v);
    if (this.volume === was) return `volume is already ${was}%`;

    // Everything cached was encoded at the old volume; drop it and rebuild now
    // so the next announcement is not the one that pays for re-encoding.
    this.frames.clear();
    this.saveSettings();
    try {
      await this.prepareAudio();
    } catch (e: any) {
      log("re-encode after volume change failed:", e?.message ?? e);
    }
    log(`volume ${was}% -> ${this.volume}% by ${by}`);

    const rep = await this.levelReport();
    const loud = this.volume > 100 ? "  above 100% it may start to clip" : "";
    return [
      `volume: ${was}% -> ${this.volume}%`,
      rep,
      loud,
      `listen: ${p}test ${Object.keys(this.cfg.schedules)[0]}`,
    ].filter(Boolean).join("\n");
  }

  // ---------- .mute / .unmute ----------

  /**
   * Resolve what the operator typed into a channel id. Ids win; a name is
   * accepted only when it is unambiguous, because channel names repeat
   * (two "Room 1" under different parents) and silently muting the wrong one would be invisible.
   */
  private resolveChannel(arg: string): { cid: number } | { error: string } {
    const q = arg.trim();
    if (!q) return { error: "" };

    if (/^\d+$/.test(q)) {
      const cid = parseInt(q);
      if (!this.client.getChannels().has(cid)) {
        return { error: `no channel with id ${cid}. See ${this.cfg.commands.prefix}channels` };
      }
      return { cid };
    }

    const hits = [...this.client.getChannels().entries()].filter(
      ([, name]) => name.toLowerCase() === q.toLowerCase()
    );
    if (!hits.length) return { error: `no channel named "${q}". See ${this.cfg.commands.prefix}channels` };
    if (hits.length > 1) {
      return {
        error: `"${q}" matches ${hits.length} channels: ${hits.map(([c]) => c).join(", ")} — use the id`,
      };
    }
    return { cid: hits[0][0] };
  }

  private cmdMute(arg: string, mute: boolean, by: string): string {
    const p = this.cfg.commands.prefix;
    const word = mute ? "mute" : "unmute";

    if (!arg) {
      const lines = [`usage: ${p}${word} <channel id>    (see ${p}channels)`];
      if (this.mutedExtra.size) lines.push(`  muted by command: ${[...this.mutedExtra].join(", ")}`);
      if (this.unmutedExtra.size) lines.push(`  unmuted by command: ${[...this.unmutedExtra].join(", ")}`);
      return lines.join(NL);
    }

    const r = this.resolveChannel(arg);
    if ("error" in r) return r.error;
    const { cid } = r;
    const name = this.client.getChannels().get(cid) ?? String(cid);

    if (this.isMuted(cid, name) === mute) {
      return mute
        ? `${cid} "${name}" is already muted`
        : `${cid} "${name}" is not muted`;
    }

    if (mute) {
      this.mutedExtra.add(cid);
      this.unmutedExtra.delete(cid);
    } else {
      this.unmutedExtra.add(cid);
      this.mutedExtra.delete(cid);
    }
    this.saveSettings();
    log(`${word} ${cid} "${name}" by ${by}`);

    return [
      mute ? `muted ${cid} "${name}"` : `unmuted ${cid} "${name}"`,
      `announcements now go to ${this.targetChannels().length} channel(s)`,
    ].join(NL);
  }

  // ---------- /files, /set, /reset ----------

  /**
   * What players have uploaded. Straight off disk when the bot shares a
   * machine with the server and was told where the files live, otherwise over
   * the file-transfer protocol — which is slow enough on a big server (one
   * request per channel) that the answer is reused for a minute.
   */
  private async uploads(fresh = false): Promise<Upload[]> {
    const root = this.cfg.uploads.root;
    if (root && fs.existsSync(root)) return listUploadsOnDisk(root);
    if (!this.ft) return [];
    if (!fresh && this.uploadCache && Date.now() - this.uploadCache.at < UPLOAD_LIST_TTL_MS) {
      return this.uploadCache.list;
    }
    const list = await listUploadsRemote(this.ft, [...this.client.getChannels().keys()]);
    this.uploadCache = { at: Date.now(), list };
    return list;
  }

  private async cmdFiles(): Promise<string> {
    const p = this.cfg.commands.prefix;
    const ups = await this.uploads(true);
    if (!ups.length) {
      return [
        "no audio files in the channels.",
        "Upload one in the TeamSpeak file browser: right-click a channel -> Files -> drag it in.",
        `Then ${p}files to see it here.`,
      ].join("\n");
    }
    const chans = this.client.getChannels();
    const lines = ["Uploaded files:"];
    for (const u of ups.slice(0, 15)) {
      const where = chans.get(u.channel) ?? `channel ${u.channel}`;
      lines.push(`  ${u.name} — ${Math.round(u.size / 1024)} KB, in "${where}"`);
    }
    if (ups.length > 15) lines.push(`  ...and ${ups.length - 15} more`);
    lines.push(`Assign: ${p}set <${this.targetNames().join("|")}> <file> [gong]`);
    return lines.join("\n");
  }

  private async cmdSet(args: string[], by: string): Promise<string> {
    const p = this.cfg.commands.prefix;
    const targets = this.targetNames();

    if (args.length < 2) {
      return [
        `usage: ${p}set <${targets.join("|")}> <file> [gong]`,
        "  gong — lay the voice over the chime; without it the file plays as-is",
        `What is uploaded: ${p}files`,
      ].join("\n");
    }

    const key = this.targetKey(args[0]);
    if (!key) return `unknown target "${args[0]}". Available: ${targets.join(", ")}, combo`;

    const wantMix = args.slice(2).some((a) => /^(gong|mix)$/i.test(a));
    if (wantMix && !this.cfg.mix) return "no chime configured (mix section), gong is unavailable";

    const found = findUpload(await this.uploads(), args[1]);
    if (!found.length) return `file "${args[1]}" not found. See ${p}files`;
    if (found.length > 1) return `"${args[1]}" matches several: ${found.map((f) => f.name).join(", ")}`;
    const up = found[0];

    // Adopt first, then verify it really renders. A half-applied override that
    // throws at announcement time would be silent failure during a war.
    const slug = key.replace(/[^a-z0-9]+/gi, "_");
    let rel: string;
    try {
      rel = await adoptUpload(up, this.cfg.soundsDir, slug, this.ft, MAX_UPLOAD_BYTES);
    } catch (e: any) {
      return `could not fetch "${up.name}": ${e?.message ?? e}`;
    }
    const adopted = path.resolve(this.cfg.soundsDir, rel);
    const discard = () => fs.rmSync(adopted, { force: true });

    let probe;
    try {
      probe = await probeAudio(adopted);
    } catch (e: any) {
      discard();
      return `"${up.name}" is not readable as audio: ${e?.message ?? e}`;
    }
    if (probe.seconds > this.cfg.uploads.maxSeconds) {
      discard();
      return `"${up.name}" is ${probe.seconds.toFixed(1)}s long, the limit is ${this.cfg.uploads.maxSeconds}s`;
    }

    const prev = this.overrides.get(key);
    this.overrides.set(key, { file: rel, mix: wantMix, origin: up.name, by, at: Date.now() });

    const src = this.overrideSource(key);
    try {
      if (!src) throw new Error("file missing after the copy");
      const frames = await this.framesFor(src);
      this.saveOverrides();
      pruneAdopted(this.cfg.soundsDir, slug);
      log(`set "${key}" -> ${up.name}${wantMix ? " +gong" : ""} by ${by}`);
      const dur = ((frames.length * FRAME_MS) / 1000).toFixed(1);
      return [
        `done: ${key} now plays "${up.name}"${wantMix ? " over the chime" : ""}, ${dur}s`,
        `Listen: ${p}test ${args[0]}`,
      ].join("\n");
    } catch (e: any) {
      if (prev) this.overrides.set(key, prev);
      else this.overrides.delete(key);
      discard();
      return `could not process "${up.name}": ${e?.message ?? e}`;
    }
  }

  private cmdReset(what: string): string {
    const p = this.cfg.commands.prefix;
    if (!what) return `what to reset: ${p}reset <${this.targetNames().join("|")}|all>`;
    if (what.toLowerCase() === "all") {
      const n = this.overrides.size;
      this.overrides.clear();
      this.saveOverrides();
      log(`reset all custom audio (${n})`);
      return n ? `reset ${n} assignment(s), everything plays from config` : "already all from config";
    }
    const key = this.targetKey(what);
    if (!key) return `unknown target "${what}"`;
    if (!this.overrides.delete(key)) return `"${key}" has no custom file anyway`;
    this.saveOverrides();
    log(`reset "${key}"`);
    return `${key} plays from config again`;
  }

  private cmdSounds(): string {
    const lines = [`Currently playing (volume ${this.volume}%):`];
    for (const [name, sch] of Object.entries(this.cfg.schedules)) {
      const o = this.overrides.get(name);
      const tag = o ? `custom, set by ${o.by}` : "from config";
      lines.push(`  ${name}: ${sourceLabel(this.sourceFor(name, sch.events[0]))}  (${tag})`);
    }
    for (const c of this.cfg.combos) {
      const key = c.when.join("+");
      const o = this.overrides.get(key);
      const tag = o ? `custom, set by ${o.by}` : "from config";
      lines.push(`  ${key}: ${sourceLabel(this.comboSourceFor(c))}  (${tag})`);
    }
    return lines.join("\n");
  }

  // ---------- commands ----------

  /**
   * One command per reply, never one per line. The server's antiflood counts
   * commands (block at 150 points, 5 shed per tick), and a nine-line /help sent
   * line by line is enough to get the bot muted halfway through answering.
   */
  private async reply(clid: number, text: string): Promise<void> {
    const MAX = 900;
    const chunks: string[] = [];

    if (text.length <= MAX) {
      chunks.push(text);
    } else {
      let cur = "";
      for (const line of text.split("\n")) {
        if (cur && cur.length + line.length + 1 > MAX) {
          chunks.push(cur);
          cur = line;
        } else {
          cur = cur ? cur + "\n" + line : line;
        }
      }
      if (cur) chunks.push(cur);
    }

    for (let i = 0; i < chunks.length; i++) {
      if (i) await sleep(400);
      this.client.sendCommand(buildCommand("sendtextmessage", { targetmode: 1, target: clid, msg: chunks[i] }));
    }
  }

  private onTextMessage(m: any): void {
    const msg = String(m.msg ?? "").trim();
    const prefix = this.cfg.commands.prefix;
    if (!msg.startsWith(prefix)) return;

    const invokerId = parseInt(m.invokerid);
    const invokerName = String(m.invokername ?? "?");
    const invokerUid = String(m.invokeruid ?? "");
    if (invokerId === this.client.getClientId()) return; // never react to ourselves

    const auth = this.authorize(invokerId, invokerUid);
    if (!auth.ok) {
      log(`denied "${msg}" from ${invokerName} (${invokerUid}): ${auth.detail}`);
      const need = this.cfg.commands.adminGroups.join(", ");
      void this.reply(
        invokerId,
        `bot commands are limited to group ${need ? `"${need}"` : "admins"} — ${auth.detail}`
      );
      return;
    }

    const body = msg.slice(prefix.length);
    const rawCmd = body.split(/\s+/)[0] ?? "";
    const cmd = rawCmd.toLowerCase();
    const rest = body.slice(rawCmd.length).trim();
    const args = rest.split(/\s+/).filter(Boolean);
    const arg = args[0]?.toLowerCase() ?? "";
    log(`command "${cmd}${rest ? " " + rest : ""}" from ${invokerName}`);

    // A schedule name is its own command: /jungle, /boss
    if (this.cfg.schedules[cmd]) {
      void this.reply(invokerId, this.start(cmd, invokerName, invokerId));
      return;
    }

    switch (cmd) {
      case "all":
        void this.reply(invokerId, this.startAll(invokerName, invokerId));
        break;

      case "start":
        if (!arg || arg === "all") void this.reply(invokerId, this.startAll(invokerName, invokerId));
        else void this.reply(invokerId, this.start(arg, invokerName, invokerId));
        break;

      case "stop":
        // Bare /stop means "stop", not a usage nag — the war can end early and
        // nobody wants to be told about argument syntax at that moment.
        void this.reply(invokerId, this.stop(arg || "all"));
        break;

      case "restart":
        void this.reply(invokerId, this.restartAll(invokerName, invokerId));
        break;

      case "test": {
        if (!arg) {
          const names = [...Object.keys(this.cfg.schedules), ...(this.cfg.combos.length ? ["combo"] : [])];
          void this.reply(invokerId, `what to play: ${names.map((n) => prefix + "test " + n).join(", ")}`);
          break;
        }
        const src = this.testSource(arg);
        if (!src) {
          void this.reply(invokerId, `nothing to play under the name "${arg}"`);
          break;
        }
        void this.reply(invokerId, `playing ${sourceLabel(src)}`);
        this.enqueue({ schedule: null, source: src });
        break;
      }

      case "say": {
        if (!this.cfg.tts.available) {
          void this.reply(invokerId, "text-to-speech is not installed on this bot (see README: piper)");
          break;
        }
        if (!rest) {
          void this.reply(invokerId, `type what to say: ${prefix}say Radio check`);
          break;
        }
        if (rest.length > this.cfg.tts.maxChars) {
          void this.reply(invokerId, `too long: ${rest.length} characters, max ${this.cfg.tts.maxChars}`);
          break;
        }
        void this.reply(invokerId, `saying: "${rest}"`);
        this.enqueue({ schedule: null, source: { kind: "tts", text: rest } });
        break;
      }

      case "status":
        void this.reply(invokerId, this.status());
        break;

      case "files":
        void this.cmdFiles().then(
          (r) => this.reply(invokerId, r),
          (e) => this.reply(invokerId, `cannot list files: ${e?.message ?? e}`)
        );
        break;

      case "set":
        void this.cmdSet(args, invokerName).then(
          (r) => this.reply(invokerId, r),
          (e) => this.reply(invokerId, `could not set it: ${e?.message ?? e}`)
        );
        break;

      case "reset":
        void this.reply(invokerId, this.cmdReset(arg));
        break;

      case "sounds":
        void this.reply(invokerId, this.cmdSounds());
        break;

      case "channels":
        void this.reply(invokerId, this.cmdChannels());
        break;

      case "mute":
        void this.reply(invokerId, this.cmdMute(rest, true, invokerName));
        break;

      case "unmute":
        void this.reply(invokerId, this.cmdMute(rest, false, invokerName));
        break;

      case "volume":
      case "vol":
        void this.cmdVolume(arg, invokerName).then((r) => this.reply(invokerId, r));
        break;

      case "help":
        void this.reply(invokerId, this.helpText());
        break;

      default:
        void this.reply(invokerId, `unknown command "${cmd}". ${prefix}help`);
    }
  }

  // ---------- state across restarts ----------

  private saveState(): void {
    try {
      const active = [...this.running.entries()].map(([name, r]) => ({
        name,
        startedAt: r.startedAt,
        startedBy: r.startedBy,
      }));
      fs.writeFileSync(STATE_PATH, JSON.stringify({ active }, null, 2));
    } catch (e: any) {
      log("cannot save state:", e?.message ?? e);
    }
  }

  /**
   * Pick up whatever was running before the process stopped, on the same beat.
   * A restart in the middle of a war must not cost the operator the rest of it.
   */
  restoreState(): void {
    if (!fs.existsSync(STATE_PATH)) return;
    try {
      const { active } = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
      const now = Date.now();

      for (const entry of active ?? []) {
        // Older state files held plain names with no start time.
        const name = typeof entry === "string" ? entry : entry?.name;
        const sch = name ? this.cfg.schedules[name] : undefined;
        if (!sch) continue;

        const startedAt = typeof entry === "object" && Number.isFinite(entry?.startedAt)
          ? Number(entry.startedAt)
          : now;
        const by = (typeof entry === "object" && entry?.startedBy) || "restore";

        if (!sch.repeat && startedAt + sch.cycleMs <= now) {
          log(`"${name}": cycle already ended, not resuming`);
          continue;
        }

        const ago = Math.round((now - startedAt) / 1000);
        this.start(name, by, 0, startedAt);
        log(`resumed "${name}" on its original clock (started ${ago}s ago by ${by})`);
      }
      if (this.running.size) log(`resumed after restart: ${[...this.running.keys()].join(", ")}`);
    } catch (e: any) {
      log("cannot restore state:", e?.message ?? e);
    }
  }

  autostart(): void {
    for (const [name, sch] of Object.entries(this.cfg.schedules)) {
      if (sch.autostart && !this.running.has(name)) this.start(name, "autostart");
    }
  }

  shutdown(): void {
    this.stopping = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const [, r] of this.running) for (const t of r.timers) clearTimeout(t);
    try {
      this.client.disconnect();
    } catch {
      /* already gone */
    }
  }
}

// ---------- entry point ----------

/** ffmpeg does all the audio work; without it nothing can be played. */
async function checkFfmpeg(): Promise<void> {
  try {
    await promisify(execFile)(FFMPEG, ["-hide_banner", "-version"]);
  } catch {
    throw new Error(
      `ffmpeg not found (looked for ${FFMPEG}). Release archives ship it next to the bot; ` +
        "from source, install ffmpeg and make sure it is on PATH."
    );
  }
}

/**
 * Started by double-click, the console window closes the moment the process
 * exits, taking the error with it. Hold it open until Enter.
 */
async function holdWindow(): Promise<void> {
  if (!process.stdin.isTTY || process.platform !== "win32") return;
  process.stdout.write("\nPress Enter to close this window.");
  await new Promise((r) => process.stdin.once("data", r));
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--setup") || needsSetup(CONFIG_PATH)) {
    const ok = await runSetup(CONFIG_PATH);
    if (!ok) {
      await holdWindow();
      process.exitCode = 1;
      return;
    }
    if (args.includes("--setup")) return;
  }

  log(`ts6-crier ${VERSION}, home ${ROOT}`);
  await checkFfmpeg();
  const cfg = loadConfig(CONFIG_PATH);
  log(`config: ${Object.keys(cfg.schedules).length} schedule(s), ${cfg.combos.length} combo(s), server ${cfg.server.host}:${cfg.server.port}`);
  log(`commands: ${Object.keys(cfg.schedules).map((n) => cfg.commands.prefix + n).join(", ")} + ${RESERVED_NAMES.map((n) => cfg.commands.prefix + n).join(", ")}`);
  if (!cfg.uploads.root) log("uploads: fetched over file transfer");
  else if (fs.existsSync(cfg.uploads.root)) log(`uploads: read from disk, ${cfg.uploads.root}`);
  else log(`uploads: ${cfg.uploads.root} not found, fetched over file transfer instead`);
  if (!cfg.tts.available) log("text-to-speech: not installed, .say is off");

  const crier = new Crier(cfg);
  // Custom audio first: prepareAudio must render what will actually play,
  // not the config defaults it is about to override.
  crier.loadCustomAudio();
  crier.loadVolume();
  await crier.prepareAudio();
  await crier.connect();
  crier.restoreState();
  crier.autostart();
  log("ready");

  const bye = () => {
    log("shutting down");
    crier.shutdown();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
})().catch(async (e) => {
  log("FATAL:", e?.message ?? e);
  await holdWindow();
  process.exit(1);
});
