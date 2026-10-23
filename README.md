# ts6-crier

[Русский](README.ru.md)

A voice announcer bot for TeamSpeak. It joins the server like a normal client
and, on a timer, **whispers a track into every channel at once** — "boss in 30
seconds", "jungle", whatever you need. Controlled by private-message commands.

Works with any TeamSpeak 6 server: your own VPS, one rented from a host, a
friend's. The bot is a separate program; it does not need to run on the server.

- Nothing to install first: Node.js and ffmpeg are bundled.
- Linux (any mainstream distribution, x64 and ARM), Windows, macOS (Apple Silicon).
- Custom sounds are uploaded through TeamSpeak's own file browser.

## Install

### Option 1. Your own VPS, bot runs around the clock

One command on a Linux server (the TeamSpeak machine or any other):

```bash
curl -fsSL https://raw.githubusercontent.com/X4vi3/ts6-crier/main/install.sh | sudo sh
```

The installer puts the bot in `/opt/ts6-crier`, asks four questions (server
address, password, nickname, who may command it) and runs it as a systemd
service that comes back after reboots and crashes.

If TeamSpeak runs on the same machine, the installer notices and offers
`127.0.0.1`.

### Option 2. Windows, run it when you need it

In PowerShell:

```powershell
irm https://raw.githubusercontent.com/X4vi3/ts6-crier/main/install.ps1 | iex
```

A **TS6 Crier** shortcut appears on the desktop. Double-click to start, close
the window to stop. The first start asks for the server address.

Without PowerShell: download `ts6-crier-windows-x64.zip` from
[Releases](https://github.com/X4vi3/ts6-crier/releases), unpack, run
`ts6-crier.exe`. Windows may say "Windows protected your PC" because the file
is not signed with a paid certificate: click "More info" → "Run anyway".

### Option 3. Linux or Mac, run it when you need it

```bash
curl -fsSL https://raw.githubusercontent.com/X4vi3/ts6-crier/main/install.sh | sh
~/ts6-crier/ts6-crier
```

Without `sudo` the installer uses `~/ts6-crier` and runs nothing in the
background; the bot runs while the terminal is open.

### Update and uninstall

To update, run the install command again. Config, the bot's identity, uploaded
sounds and running timers are kept.

```bash
curl -fsSL .../install.sh | sudo sh -s -- --uninstall   # remove the program, keep data
curl -fsSL .../install.sh | sudo sh -s -- --purge       # remove everything
```

## TeamSpeak permissions

The default guest group is enough for the bot to whisper, see channel files
and set its avatar. On a locked-down server give the bot a group that allows:

- whispering (`i_client_whisper_power`);
- browsing and downloading channel files (`i_ft_file_browse_power`,
  `i_ft_file_download_power`) — for `.files` and `.set`;
- an avatar (`i_client_max_avatar_filesize`) — optional.

The bot takes one server slot.

## Commands

Sent **as a private message to the bot**, starting with a **dot**, not a
slash — the TeamSpeak client swallows `/` commands itself.

```
.jungle, .boss   start a schedule (a schedule's name in the config is its command)
.all             start every schedule at once, in sync
.stop            stop everything          .stop jungle   stop one
.restart         stop everything and start over from this second
.status          what is running, who started it, time to the next one

.test <name>     play a track once
.say <text>      speak it with text-to-speech (needs piper, see below)

.files           audio files uploaded to the channels
.set <target> <file> [gong]   use your own audio
.reset <target|all>           back to the audio from the config
.sounds          what plays for each target

.channels        every channel with its id, covered or silent
.mute <id>       silence a channel      .unmute <id>   bring it back
.volume [0-200]  volume
.help
```

When several people send a command, the second one does **not** reset a running
countdown — they are told who started it and when. Starting over takes an
explicit `.restart`.

By default the `Server Admin` server group may command the bot; change it in
`config.yml` under `commands`, or during setup.

## Custom sounds from TeamSpeak

1. Right-click a channel → **Files**, drag an mp3 in.
2. `.files` — the bot lists what it sees.
3. `.set jungle my-voice` — assign it (a unique prefix of the name is enough).
4. `.test jungle` — listen.

Add `gong` to lay a bare voice line over the chime: `.set jungle voice.mp3 gong`.

The file is copied to the bot, so deleting it from the channel breaks nothing.
Every track is normalised to the same loudness. Limit: 30 seconds
(`uploads.max_seconds`).

## Configuration

Everything is in `config.yml` in the bot's folder — `/opt/ts6-crier/config.yml`
on a server, `%LOCALAPPDATA%\ts6-crier\config.yml` on Windows. Restart the bot
after editing it (`sudo systemctl restart ts6-crier`, or close and reopen the
window). `ts6-crier --setup` asks the setup questions again.

Every option is explained in the file's comments. The core of it:

```yaml
schedules:
  boss:
    cycle: 30m            # a 30-minute cycle
    repeat: false         # run it once, then stop
    at:
      - {after: 5m,  voice: marioboss.mp3}   # 5 minutes after the command
      - {after: 15m, voice: marioboss.mp3}

  water:
    every: 20m            # every 20 minutes, forever
    play: water.mp3       # a file in sounds/

combos:                   # firing together -> one merged track instead
  - when: [jungle, boss]
    voice: "marioboss+jungle.mp3"

whisper:
  exclude_channels: [1]   # channel ids the bot stays silent in (see .channels)
```

What an event plays: `play:` a finished track as is, `voice:` a voice line the
bot lays over the chime, `say:` text for text-to-speech.

The bundled example is a 30-minute guild war: jungle at the 25, 20, 15, 10 and
5 minute marks, boss at 25 and 15. `.all` is sent 30 seconds before the war
starts; the tracks say "in 30 seconds".

## Text-to-speech (optional)

`.say` needs [piper](https://github.com/rhasspy/piper). Put it into the bot's
folder:

```
ts6-crier/
  piper/piper             (piper/piper.exe on Windows) — from piper's releases
  voices/en_US-ryan-medium.onnx
  voices/en_US-ryan-medium.onnx.json     — voices: huggingface.co/rhasspy/piper-voices
```

and restart. Without piper everything else works; `.say` is just off.

## Troubleshooting

- **Cannot connect.** Check the address and the voice port (UDP, 9987 by
  default). Rented servers usually have a different port; it is in the host's
  panel.
- **`too many clones already connected`** — an old copy of the bot is still
  on the server. Wait a minute; the server drops it.
- **Commands are refused** — the log says `denied ... your groups: ...`. Give
  yourself a group listed in `admin_groups`, or add yours to the config.
- **`.files` is empty** — the bot may not browse channel files, or the
  channels have passwords.
- **Logs:** `journalctl -u ts6-crier -f` on a server; on Windows, the bot's window.
- **Alpine Linux and very old systems** (glibc older than 2.28, e.g. CentOS 7)
  cannot run the prebuilt binary; build from source there.

## From source

Needs Node.js 22+ and ffmpeg on `PATH`.

```bash
npm ci
npm run build          # TypeScript -> dist/
npm start              # run; config and data live in the project root
npm run package        # archive for this platform -> release/
```

Releasing: push a tag like `v0.2.0`. GitHub Actions builds every platform, runs
an install on Ubuntu against a real TeamSpeak 6 server, and publishes the
release.

## License

[Open Software License 3.0](LICENSE). The TeamSpeak protocol code in
`src/tslib` is a port of TSLib from [TS3AudioBot](https://github.com/Splamy/TS3AudioBot),
which uses the same license; see [src/tslib/NOTICE.md](src/tslib/NOTICE.md).
