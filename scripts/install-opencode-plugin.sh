#!/usr/bin/env bash
set -Eeuo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/opencode-plugin"
opencode_user="${OPENCODE_USER:-opencode}"
opencode_home="${OPENCODE_HOME:-$(getent passwd "$opencode_user" | cut -d: -f6)}"
target_dir="${OPENCODE_PLUGIN_TARGET:-$opencode_home/.config/opencode/plugins/chatgpt-web-session-proxy}"

if [[ $EUID -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi
if [[ ! -f "$source_dir/index.ts" || ! -f "$source_dir/package.json" ]]; then
  echo "Plugin source is incomplete: $source_dir" >&2
  exit 1
fi

install -d -m 0750 -o "$opencode_user" -g "$opencode_user" "$target_dir"
install -m 0640 -o "$opencode_user" -g "$opencode_user" "$source_dir/index.ts" "$target_dir/index.ts"
install -m 0640 -o "$opencode_user" -g "$opencode_user" "$source_dir/package.json" "$target_dir/package.json"
echo "Installed OpenCode lifecycle/attachment plugin at $target_dir"
