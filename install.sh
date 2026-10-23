#!/bin/sh
# ts6-crier installer for Linux (and macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/X4vi3/ts6-crier/main/install.sh | sudo sh
#
# Linux, as root: installs to /opt/ts6-crier and runs it as a systemd service.
# Without root, or on macOS: installs to ~/ts6-crier, nothing runs in the
# background — start it yourself when you need it.
#
# Run it again to update: the program is replaced, your config, identity,
# custom sounds and state are kept.
#
#   sh install.sh --uninstall     remove the service and the program (keeps data)
#   sh install.sh --purge         remove everything, data included
#
# Environment:
#   CRIER_VERSION=v1.2.0   install that release instead of the latest
#   CRIER_DIR=/srv/crier   install somewhere else
#   CRIER_ARCHIVE=file     install from a downloaded archive instead of GitHub
#   CRIER_HOST, CRIER_PORT, CRIER_PASSWORD
#                          skip the questions (for scripted installs); written
#                          into the service, they override config.yml
set -eu

REPO="${CRIER_REPO:-X4vi3/ts6-crier}"
SERVICE=ts6-crier
SVC_USER=ts6crier

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# --- where and how --------------------------------------------------------

OS=$(uname -s)
case "$OS" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) die "unsupported system: $OS (Windows: use install.ps1)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "unsupported CPU: $(uname -m) (supported: x86_64, arm64)" ;;
esac
[ "$PLATFORM" = macos ] && [ "$ARCH" = x64 ] && die "Intel Macs are not supported by the prebuilt release"

ROOT_MODE=0
if [ "$PLATFORM" = linux ] && [ "$(id -u)" = 0 ]; then ROOT_MODE=1; fi
HAVE_SYSTEMD=0
if [ "$ROOT_MODE" = 1 ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then HAVE_SYSTEMD=1; fi

if [ -n "${CRIER_DIR:-}" ]; then
  DIR="$CRIER_DIR"
elif [ "$ROOT_MODE" = 1 ]; then
  DIR=/opt/ts6-crier
else
  DIR="$HOME/ts6-crier"
fi

# --- uninstall ------------------------------------------------------------

case "${1:-}" in
  --uninstall | --purge)
    if [ "$HAVE_SYSTEMD" = 1 ] && [ -f "/etc/systemd/system/$SERVICE.service" ]; then
      systemctl disable --now "$SERVICE" 2>/dev/null || true
      rm -f "/etc/systemd/system/$SERVICE.service"
      systemctl daemon-reload
      say "service removed"
    fi
    if [ "$1" = --purge ]; then
      rm -rf "$DIR"
      if [ "$ROOT_MODE" = 1 ] && id "$SVC_USER" >/dev/null 2>&1; then userdel "$SVC_USER" 2>/dev/null || true; fi
      say "removed $DIR"
    else
      rm -f "$DIR/ts6-crier" "$DIR/ffmpeg" "$DIR/opusscript_native_wasm.wasm"
      say "program removed; config and data kept in $DIR (--purge removes them too)"
    fi
    exit 0
    ;;
  "") ;;
  *) die "unknown option: $1" ;;
esac

# --- download -------------------------------------------------------------

ASSET="ts6-crier-$PLATFORM-$ARCH.tar.gz"
if [ -n "${CRIER_VERSION:-}" ]; then
  URL="https://github.com/$REPO/releases/download/$CRIER_VERSION/$ASSET"
else
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -n "${CRIER_ARCHIVE:-}" ]; then
  cp "$CRIER_ARCHIVE" "$TMP/$ASSET" || die "cannot read $CRIER_ARCHIVE"
elif say "downloading $ASSET" && command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar -o "$TMP/$ASSET" "$URL" || die "download failed: $URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress -O "$TMP/$ASSET" "$URL" || die "download failed: $URL"
else
  die "need curl or wget"
fi
tar -xzf "$TMP/$ASSET" -C "$TMP" || die "cannot unpack $ASSET"
NEW="$TMP/ts6-crier"
[ -x "$NEW/ts6-crier" ] || die "archive has no ts6-crier binary"

# Fail here, before touching an existing install, if the binary cannot run on
# this machine at all (very old glibc, musl-only systems like Alpine).
if ! "$NEW/ts6-crier" --version >/dev/null 2>&1; then
  die "the prebuilt binary does not run on this system (needs glibc 2.28+; Alpine is not supported)"
fi
VERSION=$("$NEW/ts6-crier" --version)

# --- install --------------------------------------------------------------

UPDATING=0
[ -x "$DIR/ts6-crier" ] && UPDATING=1

if [ "$HAVE_SYSTEMD" = 1 ] && [ "$UPDATING" = 1 ]; then
  systemctl stop "$SERVICE" 2>/dev/null || true
fi

mkdir -p "$DIR/sounds"
# The program itself is always replaced...
for f in ts6-crier ffmpeg opusscript_native_wasm.wasm config.example.yml README.md README.ru.md LICENSE THIRD-PARTY-NOTICES.txt; do
  [ -e "$NEW/$f" ] && cp -f "$NEW/$f" "$DIR/$f"
done
# ...but sounds and the avatar only when missing: someone may have replaced
# gong.mp3 with their own, and an update must not quietly undo that.
for f in "$NEW"/sounds/*; do
  [ -f "$f" ] || continue
  [ -e "$DIR/sounds/$(basename "$f")" ] || cp "$f" "$DIR/sounds/"
done
[ -e "$DIR/avatar.png" ] || cp "$NEW/avatar.png" "$DIR/avatar.png" 2>/dev/null || true
chmod 755 "$DIR/ts6-crier" "$DIR/ffmpeg"

if [ "$UPDATING" = 1 ]; then say "updated to $VERSION in $DIR"; else say "installed $VERSION in $DIR"; fi

# --- first-time configuration ---------------------------------------------

if [ ! -f "$DIR/config.yml" ]; then
  if [ -n "${CRIER_HOST:-}" ]; then
    # Scripted install: the service carries the address, config stays default.
    cp "$DIR/config.example.yml" "$DIR/config.yml"
  elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
    # A TeamSpeak server on this very machine is the likely target; offer it.
    if pgrep -x tsserver >/dev/null 2>&1 || pgrep -x ts3server >/dev/null 2>&1; then
      export CRIER_SETUP_HOST=127.0.0.1
    fi
    # stdin is this script when piped from curl; questions go to the terminal.
    CRIER_HOME="$DIR" "$DIR/ts6-crier" --setup </dev/tty >/dev/tty 2>&1 || die "setup did not finish"
  else
    cp "$DIR/config.example.yml" "$DIR/config.yml"
    warn "no terminal to ask questions in: edit $DIR/config.yml (server address) before starting"
  fi
fi

# --- run ------------------------------------------------------------------

if [ "$HAVE_SYSTEMD" = 1 ]; then
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    NOLOGIN=$(command -v nologin || echo /bin/false)
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --home-dir "$DIR" --no-create-home --shell "$NOLOGIN" "$SVC_USER"
    else
      adduser -S -H -h "$DIR" -s "$NOLOGIN" "$SVC_USER"
    fi
  fi
  chown -R "$SVC_USER:" "$DIR"
  chmod 640 "$DIR/config.yml"

  ENV_LINES=""
  for v in CRIER_HOST CRIER_PORT CRIER_PASSWORD; do
    eval "val=\${$v:-}"
    # shellcheck disable=SC2154
    [ -n "$val" ] && ENV_LINES="${ENV_LINES}Environment=\"$v=$val\"
"
  done

  # ProtectHome would hide the bot from itself if it lives under /home.
  PROTECT_HOME=yes
  case "$DIR" in /home/* | /root/*) PROTECT_HOME=no ;; esac

  cat >"/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=ts6-crier voice announcer for TeamSpeak
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$DIR
Environment=CRIER_HOME=$DIR
${ENV_LINES}ExecStart=$DIR/ts6-crier
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=$PROTECT_HOME
ReadWritePaths=$DIR

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"
  sleep 6
  if systemctl is-active --quiet "$SERVICE"; then
    say "running. Log of the first seconds:"
  else
    warn "the service did not stay up. Log:"
  fi
  journalctl -u "$SERVICE" -n 15 --no-pager -o cat || true
  cat <<EOF

  Logs:         journalctl -u $SERVICE -f
  Restart:      systemctl restart $SERVICE
  Settings:     $DIR/config.yml   (then restart)
  Reconfigure:  sudo CRIER_HOME=$DIR $DIR/ts6-crier --setup && sudo chown $SVC_USER: $DIR/config.yml && sudo systemctl restart $SERVICE
  Update:       run this installer again

  In TeamSpeak, send the bot a private message: .help
EOF
else
  cat <<EOF

  Start it:     $DIR/ts6-crier
  Settings:     $DIR/config.yml
  Update:       run this installer again

  It runs while that terminal is open. In TeamSpeak, send the bot a private message: .help
EOF
  [ "$PLATFORM" = linux ] && [ "$ROOT_MODE" = 0 ] && echo "  (Run the installer with sudo to have it start with the machine instead.)"
fi
