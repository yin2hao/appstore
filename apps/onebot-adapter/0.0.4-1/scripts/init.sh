#!/bin/bash

# Generated from official installation evidence:
# - https://github.com/yin2hao/onebot-adapter/blob/v0.0.1/Dockerfile
# - https://github.com/yin2hao/onebot-adapter/blob/v0.0.1/README.md#在-linux-上运行-docker-镜像
# - https://github.com/yin2hao/onebot-adapter/blob/v0.0.1/main.go

set -euo pipefail

cd "$(dirname "$0")/.."
umask 077
config=config/config.json

if [ ! -e "$config" ]; then
    admin_password=$(od -An -v -tx1 -N 24 /dev/urandom | tr -d '[:space:]')
    webhook_token=$(od -An -v -tx1 -N 32 /dev/urandom | tr -d '[:space:]')
    temp=$(mktemp config/.config.json.XXXXXX)
    trap 'rm -f -- "$temp"' EXIT
    cat > "$temp" <<EOF
{
  "listen": "0.0.0.0:8080",
  "admin_username": "admin",
  "admin_password": "$admin_password",
  "webhook_token": "$webhook_token",
  "data_dir": "/data"
}
EOF
    mv -T -- "$temp" "$config"
fi

test -f "$config"
chmod 600 "$config"
chmod 700 config data
chown 65532:65532 "$config" data
