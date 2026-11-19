#!/usr/bin/env bash
set -Eeuo pipefail

service_name="${CHATGPT_PROXY_SERVICE:-chatgpt-web-session-proxy.service}"
target_dir="${CHATGPT_PROXY_TARGET:-/opt/chatgpt-web-session-proxy}"
backup_root="${CHATGPT_PROXY_BACKUP_ROOT:-/var/backups/chatgpt-web-session-proxy}"
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
stage_dir="$(mktemp -d "${target_dir}.stage.XXXXXX")"
rollback_dir="${target_dir}.rollback-${timestamp}"
backup_file="${backup_root}/chatgpt-web-session-proxy-${timestamp}.tar.gz"
opencode_plugin_dir="${OPENCODE_PLUGIN_TARGET:-/home/opencode/.config/opencode/plugins/chatgpt-web-session-proxy}"
opencode_plugin_backup="${backup_root}/opencode-plugin-${timestamp}.tar.gz"
switched=0
plugin_switched=0

cleanup() {
  if [[ -n "$stage_dir" && "$stage_dir" == "${target_dir}.stage."* && -d "$stage_dir" ]]; then
    rm -rf -- "$stage_dir"
  fi
}

rollback() {
  local exit_code=$?
  trap - ERR
  if (( switched )) && [[ -d "$rollback_dir" ]]; then
    systemctl stop "$service_name" || true
    if [[ -d "$target_dir" ]]; then
      mv -- "$target_dir" "${target_dir}.failed-${timestamp}"
    fi
    mv -- "$rollback_dir" "$target_dir"
    systemctl start "$service_name" || true
    echo "Deployment failed; restored $target_dir from $rollback_dir" >&2
  fi
  if (( plugin_switched )); then
    rm -rf -- "$opencode_plugin_dir"
    if [[ -f "$opencode_plugin_backup" ]]; then
      install -d -m 0750 -o opencode -g opencode "$(dirname "$opencode_plugin_dir")"
      tar -C "$(dirname "$opencode_plugin_dir")" -xzf "$opencode_plugin_backup"
      chown -R opencode:opencode "$opencode_plugin_dir"
    fi
    systemctl restart opencode.service || true
    echo "Deployment failed; restored the previous OpenCode integration plugin." >&2
  fi
  exit "$exit_code"
}

trap cleanup EXIT
trap rollback ERR

if [[ $EUID -ne 0 ]]; then
  echo "Run this deployment script as root." >&2
  exit 1
fi

if [[ ! -d "$target_dir" ]]; then
  echo "Target directory does not exist: $target_dir" >&2
  exit 1
fi

git_safe=(git -c "safe.directory=$source_dir" -C "$source_dir")

if [[ -n "$("${git_safe[@]}" status --porcelain)" ]]; then
  echo "Refusing to deploy a dirty source tree: $source_dir" >&2
  exit 1
fi

commit="$("${git_safe[@]}" rev-parse HEAD)"
mkdir -p -- "$backup_root"
tar -C "$(dirname "$target_dir")" -czf "$backup_file" "$(basename "$target_dir")"
if [[ -d "$opencode_plugin_dir" ]]; then
  tar -C "$(dirname "$opencode_plugin_dir")" -czf "$opencode_plugin_backup" "$(basename "$opencode_plugin_dir")"
fi
echo "Backup: $backup_file"

"${git_safe[@]}" archive --format=tar HEAD | tar -xf - -C "$stage_dir"
cd "$stage_dir"
npm ci
npm test
npm run typecheck
npm run build
printf '%s\n' "$commit" > .deployed-git-commit

grep -q 'response-markdown.js' dist/src/browser.js
grep -q 'responseMarkdown' dist/src/browser.js

systemctl stop "$service_name"
mv -- "$target_dir" "$rollback_dir"
switched=1
mv -- "$stage_dir" "$target_dir"
stage_dir=""
chown -R root:root "$target_dir"
chmod -R u=rwX,go=rX "$target_dir"
systemctl start "$service_name"

for _ in {1..30}; do
  health_code="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:4153/health || true)"
  if systemctl is-active --quiet "$service_name" && [[ "$health_code" == 200 || "$health_code" == 401 ]]; then
    bash "$target_dir/scripts/install-opencode-plugin.sh"
    plugin_switched=1
    systemctl restart opencode.service
    opencode_ready=0
    for _ in {1..30}; do
      opencode_code="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:4096/ || true)"
      if systemctl is-active --quiet opencode.service && [[ "$opencode_code" == 200 || "$opencode_code" == 401 ]]; then
        opencode_ready=1
        break
      fi
      sleep 1
    done
    if (( ! opencode_ready )); then
      echo "OpenCode did not become healthy after installing the integration plugin." >&2
      exit 1
    fi
    switched=0
    plugin_switched=0
    echo "Deployed commit $commit"
    echo "Rollback copy: $rollback_dir"
    systemctl --no-pager --full status "$service_name"
    exit 0
  fi
  sleep 1
done

echo "Service did not become healthy after deployment." >&2
systemctl --no-pager --full status "$service_name" >&2 || true
exit 1
