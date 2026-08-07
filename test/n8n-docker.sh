#!/usr/bin/env bash
#
# Local n8n in Docker for testing this package.
#
#   ./test/n8n-docker.sh start [webhook-url]   start (or re-create) the container
#   ./test/n8n-docker.sh url <webhook-url>     point n8n at a different public URL
#   ./test/n8n-docker.sh reset [webhook-url]   wipe all n8n data and start clean
#   ./test/n8n-docker.sh stop                  stop and remove the container
#   ./test/n8n-docker.sh status                what is running, and with which URL
#
# WEBHOOK_URL is an environment variable of the container, not a setting inside
# n8n — it cannot be changed in the UI. Changing it means re-creating the
# container, which costs nothing: the data lives in a bind mount next to this
# script, so workflows, credentials and installed community nodes survive.
#
# n8n needs this variable to build the public webhook URLs it registers with
# HalloPetra. Without it, it would register http://localhost:5678/... — a URL
# HalloPetra cannot reach.

set -euo pipefail

CONTAINER=n8n-petra
IMAGE=n8nio/n8n:latest
PORT=5678
DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.n8n-data"
DEFAULT_URL="https://amazingly-supernova-grueling.ngrok-free.dev/"

# Remember the last URL used, so `start` without arguments keeps it
URL_FILE="$DATA_DIR/../.n8n-webhook-url"

current_url() {
	docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
		grep '^WEBHOOK_URL=' | cut -d= -f2- || true
}

resolve_url() {
	if [ -n "${1:-}" ]; then
		# n8n expects a trailing slash
		printf '%s' "${1%/}/"
	elif [ -f "$URL_FILE" ]; then
		cat "$URL_FILE"
	else
		printf '%s' "$DEFAULT_URL"
	fi
}

run_container() {
	local url="$1"
	docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
	mkdir -p "$DATA_DIR"
	printf '%s' "$url" >"$URL_FILE"
	docker run -d \
		--name "$CONTAINER" \
		-p "$PORT:5678" \
		-v "$DATA_DIR:/home/node/.n8n" \
		-e "WEBHOOK_URL=$url" \
		-e N8N_SECURE_COOKIE=false \
		-e N8N_DIAGNOSTICS_ENABLED=false \
		"$IMAGE" >/dev/null
	echo "n8n running at http://localhost:$PORT"
	echo "public webhook URL: $url"
}

case "${1:-start}" in
start | url)
	if [ "${1:-}" = "url" ] && [ -z "${2:-}" ]; then
		echo "usage: $0 url <webhook-url>" >&2
		exit 1
	fi
	run_container "$(resolve_url "${2:-}")"
	echo "data kept in $DATA_DIR"
	;;

reset)
	read -r -p "Delete ALL local n8n data in $DATA_DIR? [y/N] " confirm
	case "$confirm" in
	[yY]*) ;;
	*)
		echo "aborted"
		exit 1
		;;
	esac
	docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
	rm -rf "$DATA_DIR"
	run_container "$(resolve_url "${2:-}")"
	echo "data wiped — set up the owner account again and reinstall the community node"
	;;

stop)
	docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "container removed (data kept)" ||
		echo "no container running"
	;;

status)
	if docker ps --filter "name=$CONTAINER" --format '{{.Names}}' | grep -q .; then
		echo "running at http://localhost:$PORT"
		echo "public webhook URL: $(current_url)"
		echo "data: $DATA_DIR"
	else
		echo "not running"
	fi
	;;

*)
	sed -n '3,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	exit 1
	;;
esac
