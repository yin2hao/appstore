#!/bin/sh
set -eu

# Generated from official installation evidence:
# - https://github.com/prometheus/alertmanager/blob/v0.34.1/Dockerfile
# - prom/alertmanager:v0.34.1 image config User=nobody; image layer /etc/passwd and /etc/group confirm UID/GID 65534:65534

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
chown -R 65534:65534 "$APP_DIR/data"
