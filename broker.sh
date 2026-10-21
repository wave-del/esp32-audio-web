#!/usr/bin/env bash
set -euo pipefail
BASE="${MQTT_BASE:-$HOME/esp32-mqtt-test}"
export LD_LIBRARY_PATH="$BASE/root/usr/lib/aarch64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
BROKER="$BASE/root/usr/sbin/mosquitto"
SUB="$BASE/root/usr/bin/mosquitto_sub"
PUB="$BASE/root/usr/bin/mosquitto_pub"
HOST=192.168.1.37


running() {
    local pidfile=$1 executable=$2 pid
    [[ -f "$pidfile" ]] || return 1
    pid=$(cat -- "$pidfile")
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    [[ "$(readlink -f "/proc/$pid/exe" 2>/dev/null)" == "$executable" ]]
}

stop_process() {
    local pidfile=$1 executable=$2 pid
    if running "$pidfile" "$executable"; then
        pid=$(cat -- "$pidfile")
        kill "$pid"
        for ((i=0; i<30; i++)); do
            running "$pidfile" "$executable" || break
            sleep 0.1
        done
        if running "$pidfile" "$executable"; then
            echo "Process $pid did not stop; leaving PID file intact" >&2
            return 1
        fi
    fi
    rm -f -- "$pidfile"
}

case "${1:-status}" in
    setup)
        mkdir -p "$BASE/packages" "$BASE/root"
        cd "$BASE/packages"
        apt-get download mosquitto mosquitto-clients libmosquitto1 libcjson1 libdlt2 libwebsockets16 libev4 libcap2
        for package in ./*.deb; do dpkg-deb -x "$package" "$BASE/root"; done
        "$BROKER" -h | head -n 4
        ;;
    start)
        if ! running "$BASE/broker.pid" "$BROKER"; then
            rm -f -- "$BASE/broker.pid"
            cat > "$BASE/mosquitto.conf" <<EOF
listener 1883 $HOST
allow_anonymous true
persistence false
pid_file $BASE/broker.pid
log_dest file $BASE/broker.log
log_type all
connection_messages true
EOF
            "$BROKER" -c "$BASE/mosquitto.conf" -d
            for ((i=0; i<30; i++)); do
                running "$BASE/broker.pid" "$BROKER" && break
                sleep 0.1
            done
            running "$BASE/broker.pid" "$BROKER" || { tail "$BASE/broker.log"; exit 1; }
        fi
        echo "Console MQTT broker: $HOST:1883"
        ;;
    test)
        test_topic="esp32c3/selftest/$$"
        result=$(mktemp "$BASE/selftest.XXXXXX")
        test_pid=''
        trap 'if [[ -n "$test_pid" ]]; then kill "$test_pid" 2>/dev/null || true; fi; rm -f -- "$result"' EXIT
        "$SUB" -h "$HOST" -p 1883 -V mqttv311 -q 1 -t "$test_topic" -C 1 -W 10 > "$result" &
        test_pid=$!
        sleep 0.5
        "$PUB" -h "$HOST" -p 1883 -V mqttv311 -q 1 -t "$test_topic" -m 'hello world'
        wait "$test_pid"
        test_pid=''
        [[ "$(cat "$result")" == 'hello world' ]]
        echo 'PASS: A7S broker publish/subscribe (MQTT 3.1.1, QoS 1)'
        ;;
    stop)
        stop_process "$BASE/broker.pid" "$BROKER"
        echo 'Console MQTT broker stopped'
        ;;
    status)
        if running "$BASE/broker.pid" "$BROKER"; then echo 'Broker running'; else echo 'Broker stopped'; fi
        ;;
    *)
        echo "Usage: $0 {setup|start|test|stop|status}" >&2
        exit 2
        ;;
esac
