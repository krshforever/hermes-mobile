#!/data/data/com.termux/files/usr/bin/bash
# Hermes Mobile — paste this whole file into Termux. It turns the phone into
# the app's backend: Hermes serve on loopback + SSH ready for remote use.
# At the end it prints a CONNECTION CARD — type those 3 values into the app.
set -eu

SERVE_HOST="127.0.0.1"
SERVE_PORT="9119"
TOKEN_FILE="$HOME/.hermes/.mobile-app-token"
FPRINT="C572 B5FD D1A2 9CCF A9A9 12B6 840B 0848 E139 156D"

say() { printf '\n==> %s\n' "$*"; }

# 1. Architecture gate ---------------------------------------------------------
[ "$(uname -m)" = "aarch64" ] || { echo "needs aarch64 Android (Termux, standard prefix)"; exit 1; }

# 2. Hermes backend (APT canary; stable channel is currently unpublished) ------
if ! command -v hermes >/dev/null 2>&1; then
  say "Installing Hermes backend (needs curl + gnupg)…"
  pkg install -y curl gnupg openssh
  mkdir -p "$PREFIX/etc/apt/keyrings"
  curl -fsSL https://hermes-assets.nousresearch.com/releases/termux/canary/key.asc \
    -o "$PREFIX/etc/apt/keyrings/hermes-agent.asc"
  GOT="$(gpg --show-keys --with-fingerprint "$PREFIX/etc/apt/keyrings/hermes-agent.asc" 2>/dev/null | tr -d ' ' | grep -o '[A-F0-9]\{40\}' | head -1)"
  [ "$GOT" = "$(echo "$FPRINT" | tr -d ' ')" ] || { echo "KEY FINGERPRINT MISMATCH — stopping"; exit 1; }
  printf '%s\n' "deb [signed-by=$PREFIX/etc/apt/keyrings/hermes-agent.asc] https://hermes-assets.nousresearch.com/releases/termux/canary hermes-canary main" \
    > "$PREFIX/etc/apt/sources.list.d/hermes-agent.list"
  pkg update
  # A stale foreign launcher blocks the postinst; back it up, don't delete.
  if [ -f "$PREFIX/bin/hermes" ] && [ ! -L "$PREFIX/bin/hermes" ]; then
    mkdir -p "$HOME/.hermes/launchers-backup"
    cp "$PREFIX/bin/hermes" "$HOME/.hermes/launchers-backup/hermes.pre-apt"
    rm "$PREFIX/bin/hermes"
  fi
  pkg install -y hermes-agent
else
  say "Hermes already installed: $(hermes --version | head -1)"
  command -v sshd >/dev/null 2>&1 || pkg install -y openssh
fi

# 3. SSH (for remote access + CLI parity; same-device app uses loopback) ------
if ! pgrep -f "sshd" >/dev/null 2>&1; then
  say "Starting sshd (port 8022). Set a Termux password when asked, once."
  passwd || true
  sshd
fi

# 4. Backend with a minted session token (the desktop spawner handshake) ------
if [ ! -f "$TOKEN_FILE" ]; then
  python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"
mkdir -p "$HOME/.hermes/logs"
if curl -s -o /dev/null --max-time 3 "http://$SERVE_HOST:$SERVE_PORT/api/status"; then
  say "Backend already running on $SERVE_HOST:$SERVE_PORT"
else
  say "Starting backend…"
  setsid nohup env HERMES_DASHBOARD_SESSION_TOKEN="$TOKEN" \
    hermes serve --host "$SERVE_HOST" --port "$SERVE_PORT" --skip-build \
    > "$HOME/.hermes/logs/serve-mobile.log" 2>&1 < /dev/null &
  for _ in 1 2 3 4 5 6 7 8; do
    sleep 3
    curl -s -o /dev/null --max-time 3 "http://$SERVE_HOST:$SERVE_PORT/api/status" && break
  done
fi

# 5. Keep Android from killing it + survive reboot prompt ----------------------
termux-wake-lock 2>/dev/null || true

# 6. Connection card — type these into Hermes Mobile ---------------------------
IP="$(ip route get 1 2>/dev/null | grep -o -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
USER="$(whoami)"
cat <<CARD

=================== HERMES MOBILE — CONNECTION CARD ===================
Same phone (Termux backend):      http://$SERVE_HOST:$SERVE_PORT
Session token:                    $TOKEN
SSH (this phone, from anywhere):  ssh -p 8022 $USER@${IP:-<this-phone-ip>}
Logs:                             ~/.hermes/logs/serve-mobile.log
Stop backend:                     pkill -f "hermes serve"
NOTE: keep this Termux session alive (termux-wake-lock is on).
Disable Android battery optimization for Termux or the OS will kill it.
=======================================================================
CARD
