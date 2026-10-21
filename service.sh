#!/usr/bin/env bash
set -euo pipefail
BASE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
NODE="$BASE/runtime/node/bin/node"
export PATH="$BASE/runtime/node/bin:$PATH"
running() {
    [[ -f "$BASE/service.pid" ]] || return 1
    local pid; pid=$(cat "$BASE/service.pid")
    [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$(readlink -f "/proc/$pid/exe" 2>/dev/null)" == "$NODE" ]]
}
case "${1:-status}" in
  setup)
    cd "$BASE"
    mkdir -p runtime
    if [[ ! -x "$NODE" ]]; then
      cd runtime
      curl -fL --retry 2 -o SHASUMS256.txt https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
      archive=$(awk '$2 ~ /^node-v24\..*-linux-arm64.tar.xz$/ {print $2}' SHASUMS256.txt)
      [[ -n "$archive" && "$archive" != *$'\n'* ]]
      curl -fL --retry 2 -o "$archive" "https://nodejs.org/dist/latest-v24.x/$archive"
      awk -v archive="$archive" '$2 == archive' SHASUMS256.txt | sha256sum -c -
      mkdir -p node
      tar -xJf "$archive" --strip-components=1 -C node
      cd "$BASE"
    fi
    "$NODE" --version
    npm ci --omit=dev --no-audit --no-fund
    ;;
  start)
    bash "$BASE/broker.sh" start
    if running; then echo 'Audio web already running'; exit 0; fi
    cd "$BASE"
    nohup "$NODE" src/server.js >> service.log 2>&1 < /dev/null &
    echo $! > service.pid
    sleep 1
    running || { tail service.log; exit 1; }
    echo 'ESP32 console: http://192.168.1.37:8080 | http://100.119.243.21:8080'
    ;;
  stop)
    if running; then
      pid=$(cat "$BASE/service.pid"); kill "$pid"
      for ((i=0; i<40; i++)); do running || break; sleep 0.1; done
      if running; then echo 'Process still stopping; leaving PID file'; exit 1; fi
    fi
    rm -f "$BASE/service.pid"
    bash "$BASE/broker.sh" stop
    echo 'ESP32 console stopped'
    ;;
  status)
    bash "$BASE/broker.sh" status
    if running; then echo 'ESP32 console running: http://192.168.1.37:8080 | http://100.119.243.21:8080'; else echo 'Audio web stopped'; fi
    ;;
  *) echo "Usage: $0 {setup|start|stop|status}"; exit 2 ;;
esac
