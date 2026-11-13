#!/bin/sh
set -eu

# Generated from official installation evidence:
# - https://grafana.com/docs/loki/latest/setup/install/docker/
# - https://github.com/grafana/loki/blob/v3.7.9/cmd/loki/Dockerfile

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
chown -R 10001:10001 "$APP_DIR/data"
