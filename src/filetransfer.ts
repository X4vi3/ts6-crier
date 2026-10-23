import fs from "node:fs";
import net from "node:net";

import type { Ts3Client } from "./tslib/client.js";
import { buildCommand } from "./tslib/commands.js";

/** One file in a channel's file browser. */
export interface RemoteFile {
  cid: number;
  name: string;
  size: number;
  mtime: number; // ms
}

interface Reply {
  rows: Record<string, string>[];
  error: { id: number; msg: string };
}

const REQUEST_TIMEOUT_MS = 10_000;
const TRANSFER_TIMEOUT_MS = 60_000;

/**
 * The TeamSpeak file-transfer protocol, the part a bot needs: list a channel,
 * download a file, upload one. Control goes over the voice connection
 * (ftgetfilelist / ftinitdownload / ftinitupload), the bytes over a plain TCP
 * connection to the server's file-transfer port, opened with a one-time key.
 *
 * This is what lets the bot read uploads without sitting on the server's disk,
 * so it works the same against a rented server as against your own VPS.
 */
export class FileTransfer {
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private client: Ts3Client, private host: string) {}

  /**
   * Send a command and collect the notifications it produces until the
   * server's `error` line with our return_code closes the exchange. Requests
   * are serialised: notifications carry no request id, so two in flight at
   * once could not be told apart.
   */
  private request(
    cmd: string,
    params: Record<string, any>,
    collect: string[],
    until: string[]
  ): Promise<Reply> {
    const run = () =>
      new Promise<Reply>((resolve, reject) => {
        const tag = `ft${++this.seq}`;
        const rows: Record<string, string>[] = [];
        let error: Reply["error"] | null = null;
        let finished = false;
        const done = (fn: () => void) => {
          clearTimeout(timer);
          this.client.off("command", onCommand);
          fn();
        };
        // The server's "ok" may come before or after the notifications it
        // promises — TS6 acknowledges ftinitupload first and sends
        // notifystartupload afterwards. Wait for both, unless it said no.
        const check = () => {
          if (error && (error.id !== 0 || finished)) done(() => resolve({ rows, error: error! }));
        };
        const onCommand = (p: any) => {
          if (collect.includes(p.name)) rows.push(...(p.groups ?? [p.params]));
          if (until.includes(p.name)) finished = true;
          if (p.name === "error" && p.params?.return_code === tag) {
            error = { id: parseInt(p.params.id) || 0, msg: String(p.params.msg ?? "") };
          }
          check();
        };
        const timer = setTimeout(
          () => done(() => reject(new Error(`${cmd}: no answer from the server`))),
          REQUEST_TIMEOUT_MS
        );
        this.client.on("command", onCommand);
        this.client.sendCommand(buildCommand(cmd, { ...params, return_code: tag }));
      });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Files in the top level of one channel. A channel the bot may not browse is empty. */
  async list(cid: number): Promise<RemoteFile[]> {
    const r = await this.request("ftgetfilelist", { cid, cpw: "", path: "/" }, ["notifyfilelist"], [
      "notifyfilelistfinished",
    ]);
    // 1281 "database empty result set" is how the server says "no files".
    if (r.error.id && r.error.id !== 1281) return [];
    return r.rows
      .filter((x) => String(x.type) === "1" && x.name)
      .map((x) => ({
        cid,
        name: x.name,
        size: Number(x.size) || 0,
        mtime: (Number(x.datetime) || 0) * 1000,
      }));
  }

  /** Download one file into `dest`, refusing anything over `maxBytes`. */
  async download(file: RemoteFile, dest: string, maxBytes: number): Promise<void> {
    if (file.size > maxBytes) throw new Error(`file is ${Math.round(file.size / 1024)} KB, too big`);
    const fid = (this.seq % 60000) + 1;
    const r = await this.request(
      "ftinitdownload",
      { clientftfid: fid, name: "/" + file.name, cid: file.cid, cpw: "", seekpos: 0, proto: 1 },
      ["notifystartdownload", "notifystatusfiletransfer"],
      ["notifystartdownload", "notifystatusfiletransfer"]
    );
    if (r.error.id) throw new Error(`server refused the download: ${r.error.msg} (${r.error.id})`);
    const start = r.rows.find((x) => x.ftkey);
    if (!start) {
      const st = r.rows.find((x) => x.msg);
      throw new Error(`server refused the download${st ? `: ${st.msg}` : ""}`);
    }

    const size = Number(start.size) || file.size;
    if (size > maxBytes) throw new Error(`file is ${Math.round(size / 1024)} KB, too big`);

    const data = await this.transfer(start, Buffer.from(start.ftkey, "ascii"), size);
    fs.writeFileSync(dest, data);
  }

  /**
   * Upload `data` to `name` in channel `cid`. Channel 0 is the server's own
   * area — that is where avatars live.
   */
  async upload(cid: number, name: string, data: Buffer): Promise<void> {
    const fid = (this.seq % 60000) + 1;
    const r = await this.request(
      "ftinitupload",
      { clientftfid: fid, name, cid, cpw: "", size: data.length, overwrite: 1, resume: 0, proto: 1 },
      ["notifystartupload", "notifystatusfiletransfer"],
      ["notifystartupload", "notifystatusfiletransfer"]
    );
    if (r.error.id) throw new Error(`server refused the upload: ${r.error.msg} (${r.error.id})`);
    const start = r.rows.find((x) => x.ftkey);
    if (!start) {
      const st = r.rows.find((x) => x.msg);
      throw new Error(`server refused the upload${st ? `: ${st.msg}` : ""}`);
    }
    await this.transfer(start, Buffer.concat([Buffer.from(start.ftkey, "ascii"), data]), 0);
  }

  /**
   * Open the data connection: send the key (plus the payload for an upload),
   * then read `expect` bytes back for a download.
   *
   * The server reports the address it bound to, which behind NAT or a hosting
   * panel is often useless (0.0.0.0, a private range). The host the bot
   * already reached is tried first; the reported one only as a fallback.
   */
  private async transfer(start: Record<string, string>, send: Buffer, expect: number): Promise<Buffer> {
    const port = Number(start.port) || 30033;
    const hosts = [this.host];
    for (const ip of String(start.ip ?? "").split(",").map((s) => s.trim())) {
      if (ip && ip !== "0.0.0.0" && ip !== "::" && !hosts.includes(ip)) hosts.push(ip);
    }

    let last: unknown;
    for (const host of hosts) {
      try {
        return await tcpExchange(host, port, send, expect);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}

function tcpExchange(host: string, port: number, send: Buffer, expect: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let got = 0;
    const sock = net.connect({ host, port });
    const fail = (e: Error) => {
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(TRANSFER_TIMEOUT_MS, () => fail(new Error(`file transfer to ${host}:${port} timed out`)));
    sock.on("error", (e) => fail(new Error(`file transfer to ${host}:${port}: ${e.message}`)));
    sock.on("connect", () => {
      sock.write(send, () => {
        if (!expect) sock.end(); // upload: the server closes once it has it all
      });
    });
    sock.on("data", (d) => {
      chunks.push(d);
      got += d.length;
      if (expect && got >= expect) {
        sock.destroy();
        resolve(Buffer.concat(chunks).subarray(0, expect));
      }
    });
    sock.on("close", () => {
      if (expect && got < expect) reject(new Error(`file transfer cut off at ${got} of ${expect} bytes`));
      else if (!expect) resolve(Buffer.alloc(0));
    });
  });
}
