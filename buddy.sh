#!/usr/bin/env bash
# Talking Buddy service control.
#
#   ./buddy.sh start             Ollama (if needed) + voice server, in the background
#   ./buddy.sh start --desktop   ... then open the Electron app (it reuses this server)
#   ./buddy.sh stop              stop the voice server and Ollama
#   ./buddy.sh stop --keep-ollama  stop the voice server, leave Ollama running
#   ./buddy.sh restart [--desktop]
#   ./buddy.sh status
#
# Logs and PID files live in .run/ (gitignored). Nothing here touches another
# project's processes: a process is only stopped when it is this project's
# server.py or an Ollama instance this script launched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.run"
SERVER_PID_FILE="$RUN_DIR/server.pid"
OLLAMA_PID_FILE="$RUN_DIR/ollama.pid"
SERVER_LOG="$RUN_DIR/server.log"
OLLAMA_LOG="$RUN_DIR/ollama.log"
DESKTOP_LOG="$RUN_DIR/desktop.log"
DEFAULT_PORT=8000

mkdir -p "$RUN_DIR"

if [ -x "$ROOT/.venv/bin/python" ]; then
  PY="$ROOT/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="$(command -v python3)"
else
  echo "No Python found. Create the environment first:" >&2
  echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

configured_port() {
  [ -f "$ROOT/config.yaml" ] || return 0
  awk '/^server:/{inside=1; next} /^[^[:space:]]/{inside=0} inside && /^[[:space:]]+port:/{gsub(/[^0-9]/, "", $2); print $2; exit}' \
    "$ROOT/config.yaml"
}

PORT="$(configured_port)"
[ -n "${PORT:-}" ] || PORT="$DEFAULT_PORT"

server_up() { curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; }
ollama_up() { curl -fsS --max-time 2 "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; }
ollama_down() { ! ollama_up; }

wait_for() { # label tries predicate
  local label="$1" tries="$2" predicate="$3" i
  for ((i = 0; i < tries; i++)); do
    if "$predicate" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not become ready in ${tries}s" >&2
  return 1
}

is_our_server() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -q "server\.py"
}

is_ollama_process() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -qi "ollama"
}

port_holder() {
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

start_ollama() {
  if ollama_up; then
    echo "Ollama      : already running"
    return 0
  fi
  echo "Ollama      : starting"
  if [ -d "/Applications/Ollama.app" ]; then
    open -a Ollama
  elif command -v ollama >/dev/null 2>&1; then
    nohup ollama serve >>"$OLLAMA_LOG" 2>&1 &
    echo $! >"$OLLAMA_PID_FILE"
  else
    echo "Ollama is not installed. Get it from https://ollama.com" >&2
    return 1
  fi
  wait_for "Ollama" 45 ollama_up || return 1
  echo "Ollama      : ready"
}

start_server() {
  if server_up; then
    echo "Voice server: already running on http://127.0.0.1:$PORT"
    return 0
  fi
  echo "Voice server: starting on http://127.0.0.1:$PORT"
  cd "$ROOT"
  nohup "$PY" server.py >>"$SERVER_LOG" 2>&1 &
  echo $! >"$SERVER_PID_FILE"
  if ! wait_for "Voice server" 60 server_up; then
    echo "--- last lines of $SERVER_LOG ---" >&2
    tail -20 "$SERVER_LOG" >&2 || true
    kill "$(cat "$SERVER_PID_FILE" 2>/dev/null || echo 0)" 2>/dev/null || true
    rm -f "$SERVER_PID_FILE"
    return 1
  fi
  echo "Voice server: ready"
}

start_desktop() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not installed; open http://127.0.0.1:$PORT in a browser instead." >&2
    return 1
  fi
  if [ ! -d "$ROOT/node_modules/electron" ]; then
    echo "Electron is not installed. Run: npm install" >&2
    return 1
  fi
  echo "Desktop     : opening the app (quit it with Cmd+Q)"
  cd "$ROOT"
  nohup npm run desktop >>"$DESKTOP_LOG" 2>&1 &
}

stop_server() {
  local pid="" holder=""
  if [ -f "$SERVER_PID_FILE" ]; then
    pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"
  fi
  if is_our_server "$pid"; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$SERVER_PID_FILE"
    echo "Voice server: stopped (pid $pid)"
    return 0
  fi
  rm -f "$SERVER_PID_FILE"

  holder="$(port_holder)"
  if [ -z "$holder" ]; then
    echo "Voice server: not running"
    return 0
  fi
  if is_our_server "$holder"; then
    kill "$holder" 2>/dev/null || true
    echo "Voice server: stopped (pid $holder)"
  else
    echo "Voice server: port $PORT is held by pid $holder, which is not this project's server; leaving it alone" >&2
  fi
}

stop_ollama() {
  local mode="${1:-}" pid="" holder=""
  if [ "$mode" = "--keep-ollama" ]; then
    echo "Ollama      : left running (--keep-ollama)"
    return 0
  fi
  if ! ollama_up && [ ! -f "$OLLAMA_PID_FILE" ]; then
    echo "Ollama      : not running"
    return 0
  fi

  # Quit the menu-bar app first, otherwise it can restart the server we stop next.
  if [ "$(uname -s)" = "Darwin" ]; then
    osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
    sleep 1
  fi

  if [ -f "$OLLAMA_PID_FILE" ]; then
    pid="$(cat "$OLLAMA_PID_FILE" 2>/dev/null || true)"
    rm -f "$OLLAMA_PID_FILE"
  fi
  if ! is_ollama_process "$pid"; then
    # Resolve the process that owns Ollama's port and verify it really is Ollama.
    holder="$(lsof -nP -tiTCP:11434 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    pid="$holder"
  fi
  if is_ollama_process "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi

  if wait_for "Ollama shutdown" 15 ollama_down; then
    echo "Ollama      : stopped"
  else
    echo "Ollama      : still answering on 127.0.0.1:11434; quit it from the menu bar icon" >&2
  fi
}

print_status() {
  local pid=""
  if ollama_up; then
    echo "Ollama      : running  http://127.0.0.1:11434"
  else
    echo "Ollama      : stopped"
  fi

  if server_up; then
    pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"
    echo "Voice server: running  http://127.0.0.1:$PORT${pid:+  (pid $pid)}"
    curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/voice/preflight" 2>/dev/null |
      "$PY" -c 'import json, sys
data = json.load(sys.stdin)
checks = data.get("checks", [])
ready = sum(1 for c in checks if c.get("ready"))
print("  preflight :", "ready" if data.get("ready") else "not ready", "({}/{} checks)".format(ready, len(checks)))
for check in checks:
    if not check.get("ready"):
        print("  missing   :", check.get("label"), "-", check.get("detail"))' 2>/dev/null ||
      echo "  preflight : unavailable"
  else
    echo "Voice server: stopped"
  fi

  if pgrep -f "talking_buddy.*[Ee]lectron" >/dev/null 2>&1; then
    echo "Desktop     : running"
  else
    echo "Desktop     : not running"
  fi
}

usage() {
  printf '%s\n' \
    "Usage: ./buddy.sh <command> [option]" \
    "" \
    "  start [--desktop]     start Ollama (if needed) and the voice server;" \
    "                        --desktop also opens the Electron app" \
    "  stop [--keep-ollama]  stop the voice server and Ollama;" \
    "                        --keep-ollama leaves Ollama running" \
    "  restart [--desktop]   stop, then start again" \
    "  status                show what is running and the voice preflight"
}

start_all() {
  start_ollama
  start_server
  if [ "${1:-}" = "--desktop" ]; then
    start_desktop
  fi
  echo
  print_status
}

stop_all() {
  stop_server
  stop_ollama "${1:-}"
  if [ "${1:-}" != "--keep-ollama" ]; then
    echo "Desktop     : close the window (Cmd+Q) if it is open"
  fi
}

case "${1:-}" in
  start)
    shift
    start_all "${1:-}"
    ;;
  stop)
    shift
    stop_all "${1:-}"
    ;;
  restart)
    shift
    stop_all "${1:-}"
    start_all "${1:-}"
    ;;
  status)
    print_status
    ;;
  *)
    usage
    exit 1
    ;;
esac
