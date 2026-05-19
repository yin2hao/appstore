#!/bin/sh
set -eu

# Generated from official installation evidence:
# - Dockerfile creates and runs appuser with UID 10001.
# - docker-compose.yml mounts ./data to /home/appuser/.config/myvideos-sync.
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$APP_DIR/data"
chown -R 10001:10001 "$APP_DIR/data"
