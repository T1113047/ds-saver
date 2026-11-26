#!/bin/sh
# 把 ds-saver 挂到 OpenCode 的插件目录（只建 shim，不改其它配置）
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
DST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/ds-saver"

if [ ! -f "$SRC/index.js" ]; then
  echo "找不到 $SRC/index.js" >&2
  exit 1
fi

mkdir -p "$DST"
cat > "$DST/index.js" <<EOF
export { default } from "$SRC/index.js";
EOF

echo "installed: $DST/index.js -> $SRC/index.js"
echo "OpenCode 会自动热重载插件；若不生效，执行 opencode service restart"
