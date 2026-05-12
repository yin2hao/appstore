#!/bin/bash
# Create a new app version directory from Renovate's docker-compose update
# while restoring the old version directory from the previous commit.

set -euo pipefail

app_name=$1
old_version=$2

app_dir="apps/$app_name"
old_dir="$app_dir/$old_version"

if [[ ! -d "$old_dir" ]]; then
  echo "Version directory not found: $old_dir" >&2
  exit 1
fi

# Find the docker-compose file under apps/$app_name/$old_version.
# 1Panel app versions should have exactly one.
mapfile -t docker_compose_files < <(find "$old_dir" -type f -name docker-compose.yml)

if [[ ${#docker_compose_files[@]} -eq 0 ]]; then
  echo "No docker-compose.yml found under $old_dir" >&2
  exit 1
fi

if [[ ${#docker_compose_files[@]} -gt 1 ]]; then
  echo "Expected one docker-compose.yml under $old_dir, found ${#docker_compose_files[@]}" >&2
  exit 1
fi

docker_compose_file=${docker_compose_files[0]}

# Assume the app version comes from the first service image.
first_service=$(yq -r '.services | keys | .[0]' "$docker_compose_file")
image=$(SERVICE_NAME="$first_service" yq -r '.services[strenv(SERVICE_NAME)].image' "$docker_compose_file")

image_without_digest=${image%@*}
image_name=${image_without_digest%:*}
image_last_path=${image_without_digest##*/}

# Only apply changes if the image has a tag in <image>:<version> format.
if [[ "$image_last_path" != *":"* || "$image_name" == "$image_without_digest" ]]; then
  echo "Image has no tag, skipping: $image"
  exit 0
fi

version=${image_without_digest##*:}

# Trim the "v" prefix.
trimmed_version=${version/#"v"}
new_dir="$app_dir/$trimmed_version"

if [[ "$trimmed_version" == "$old_version" ]]; then
  echo "Version is unchanged: $old_version"
  exit 0
fi

if ! base_ref=$(git rev-parse --verify HEAD^); then
  echo "Cannot restore $old_dir because HEAD^ does not exist" >&2
  exit 1
fi

if ! git cat-file -e "$base_ref:$old_dir" >/dev/null 2>&1; then
  echo "Cannot restore $old_dir because it does not exist in HEAD^" >&2
  exit 1
fi

if [[ -e "$new_dir" ]]; then
  echo "New version directory already exists, keep it unchanged: $new_dir"
else
  cp -a "$old_dir" "$new_dir"
fi

# Renovate edits the existing version directory. Keep that edited copy as the
# new version, then restore the old version data from before Renovate's commit.
git restore --source="$base_ref" --worktree -- "$old_dir"
