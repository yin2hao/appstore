#!/bin/sh
set -eu

# Generated from official installation evidence:
# - https://github.com/semaphoreui/semaphore/blob/v2.19.17/deployment/docker/server/Dockerfile

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
chown -R 1001:0 "$APP_DIR/data" "$APP_DIR/config"
