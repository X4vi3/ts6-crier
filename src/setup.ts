import fs from "node:fs";
import readline from "node:readline/promises";
import YAML from "yaml";

import { CONFIG_EXAMPLE_PATH } from "./paths.js";

/**
 * First-run setup: a handful of questions in the terminal, written into
 * config.yml. Everything else keeps the defaults from config.example.yml, so
 * "download, run, answer four questions" is the whole install for most people.
 *
 * Re-running with --setup edits an existing config.yml in place — comments,
 * schedules and the rest of it survive, only the answered fields change.
 */

const RU = /^ru/i.test(process.env.LANG || process.env.LC_ALL || Intl.DateTimeFormat().resolvedOptions().locale);

const T = RU
  ? {
      title: "Настройка ts6-crier",
      intro: "Пара вопросов, и бот готов. Enter — оставить значение в [скобках].",
      host: "Адрес сервера TeamSpeak (например ts.example.com или 1.2.3.4:9987)",
      hostBad: "Не понял адрес. Пример: ts.example.com или 1.2.3.4:9987",
      password: "Пароль сервера (Enter — без пароля)",
      nickname: "Ник бота",
      channel: "Канал, где бот будет сидеть (Enter — канал по умолчанию)",
      admins: 'Какая серверная группа может командовать ботом ("-" — все)',
      saved: "Сохранено:",
      next: "Остальные настройки (расписания, звуки, каналы) — в этом же файле.",
      noTty:
        "Нет config.yml. Запусти бота в терминале, он спросит адрес сервера,\n" +
        "или скопируй config.example.yml в config.yml и поправь руками.",
      noExample: "Не найден config.example.yml рядом с ботом:",
    }
  : {
      title: "ts6-crier setup",
      intro: "A few questions and the bot is ready. Enter keeps the value in [brackets].",
      host: "TeamSpeak server address (e.g. ts.example.com or 1.2.3.4:9987)",
      hostBad: "Could not read that address. Example: ts.example.com or 1.2.3.4:9987",
      password: "Server password (Enter for none)",
      nickname: "Bot nickname",
      channel: "Channel the bot sits in (Enter for the default channel)",
      admins: 'Server group allowed to command the bot ("-" for everyone)',
      saved: "Saved:",
      next: "Everything else (schedules, sounds, channels) is in the same file.",
      noTty:
        "No config.yml. Run the bot in a terminal and it will ask for the server,\n" +
        "or copy config.example.yml to config.yml and edit it.",
      noExample: "config.example.yml not found next to the bot:",
    };

export function needsSetup(configPath: string): boolean {
  return !fs.existsSync(configPath);
}

/**
 * Accepts what people actually paste: a bare host, host:port, [v6]:port, or a
 * ts3server:// / teamspeak:// link copied from a website.
 */
export function parseAddress(input: string): { host: string; port: number } | null {
  let s = input.trim();
  if (!s) return null;

  const link = s.match(/^(?:ts3server|teamspeak|ts):\/\/([^/?#]+)(?:[/?]([^#]*))?/i);
  if (link) {
    const q = new URLSearchParams(link[2]?.replace(/^\//, "").replace(/^\?/, "") ?? "");
    const p = Number(q.get("port"));
    const inner = parseAddress(link[1]);
    if (!inner) return null;
    return { host: inner.host, port: p > 0 && p < 65536 ? p : inner.port };
  }

  let port = 9987;
  const v6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    s = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else {
    const hp = s.match(/^([^:\s]+):(\d+)$/);
    if (hp) {
      s = hp[1];
      port = Number(hp[2]);
    }
  }
  if (!(port > 0 && port < 65536)) return null;
  if (!/^[\w.\-:]+$/.test(s)) return null;
  return { host: s, port };
}

export async function runSetup(configPath: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(T.noTty);
    return false;
  }

  const editing = fs.existsSync(configPath);
  const source = editing ? configPath : CONFIG_EXAMPLE_PATH;
  if (!fs.existsSync(source)) {
    console.error(T.noExample, CONFIG_EXAMPLE_PATH);
    return false;
  }
  const doc = YAML.parseDocument(fs.readFileSync(source, "utf-8"));
  const get = (p: string[]) => {
    const v = doc.getIn(p);
    return v == null ? "" : String(v);
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def = ""): Promise<string> => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };

  try {
    console.log(`\n=== ${T.title} ===\n${T.intro}\n`);

    // An installer that knows a TeamSpeak server runs on this very machine
    // passes it in, so the obvious answer is one Enter away.
    const curHost = editing ? get(["server", "host"]) : process.env.CRIER_SETUP_HOST || "";
    const curPort = get(["server", "port"]) || "9987";
    const hostDef = curHost ? (curPort === "9987" ? curHost : `${curHost}:${curPort}`) : "";
    let addr: { host: string; port: number } | null = null;
    while (!addr) {
      addr = parseAddress(await ask(T.host, hostDef));
      if (!addr) console.log(T.hostBad);
    }

    const password = await ask(T.password, editing ? get(["server", "password"]) : "");
    const nickname = await ask(T.nickname, get(["server", "nickname"]) || "Crier");
    const channel = await ask(T.channel, get(["server", "channel"]));
    const groups = doc.getIn(["commands", "admin_groups"]) as any;
    const groupDef = groups?.items?.length ? String(groups.items[0]?.value ?? groups.items[0]) : "Server Admin";
    const admins = await ask(T.admins, groupDef);

    doc.setIn(["server", "host"], addr.host);
    doc.setIn(["server", "port"], addr.port);
    doc.setIn(["server", "nickname"], nickname);
    if (channel) doc.setIn(["server", "channel"], channel);
    else doc.deleteIn(["server", "channel"]);
    if (password) doc.setIn(["server", "password"], password);
    else doc.deleteIn(["server", "password"]);
    doc.setIn(["commands", "admin_groups"], admins === "-" ? [] : [admins]);

    fs.writeFileSync(configPath, doc.toString(), { mode: 0o640 });
    console.log(`\n${T.saved} ${configPath}\n${T.next}\n`);
    return true;
  } finally {
    rl.close();
  }
}
