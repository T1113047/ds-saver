#!/usr/bin/env bash
# ds-saver 一键安装：插件 + skills + 工具 + RAG 组件（不碰密钥）
set -euo pipefail

VERSION="0.4.0"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PREFIX="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/ds-saver"
WORKSPACE="${DS_SAVER_WORKSPACE:-$PWD}"
DRY=0
PLUGIN_ONLY=0
NO_RAG=0
ASSUME_YES=0
LINK=0
TS="$(date +%Y%m%d-%H%M%S)"

usage() {
  cat <<'EOF'
用法：install.sh [选项]

  --workspace DIR   工作区根（写入 rag-refresh 包装器，默认当前目录）
  --prefix DIR      OpenCode 配置目录（默认 $XDG_CONFIG_HOME/opencode）
  --data DIR        工具与数据目录（默认 $XDG_DATA_HOME/opencode/ds-saver）
  --plugin-only     只装 OpenCode 插件（含运行所需副本），不装 skills/工具/RAG
  --link            开发模式：插件 shim 指向当前仓库，改代码即时生效
  --no-rag          跳过 RAG 组件检测与配置模板
  --yes             允许自动执行 npm i -g（默认只打印命令）
  --dry-run         只打印将要做什么，不写文件
  -h, --help        显示本帮助

环境变量：DS_SAVER_WORKSPACE / DS_SAVER_PYTHON / DS_SAVER_RAG_BIN
EOF
}

say() { printf '%s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

detect_rag() {
  local c
  if [ -n "${DS_SAVER_RAG_BIN:-}" ] && [ -x "${DS_SAVER_RAG_BIN}" ]; then
    printf '%s' "$DS_SAVER_RAG_BIN"; return 0
  fi
  c="$(command -v opencode-rag || true)"
  if [ -n "$c" ]; then printf '%s' "$c"; return 0; fi
  for c in /opt/node22/bin/opencode-rag "$HOME/.local/bin/opencode-rag" /usr/local/bin/opencode-rag; do
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  if command -v npm >/dev/null 2>&1; then
    c="$(npm prefix -g 2>/dev/null)/bin/opencode-rag"
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  fi
  return 1
}

write_wrapper() {
  local wrapper="$DATA/bin/rag-refresh" tmp
  tmp="$(mktemp)"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'export DS_SAVER_WORKSPACE="${DS_SAVER_WORKSPACE:-%s}"\n' "$WORKSPACE"
    printf 'export DS_SAVER_TOOLS="${DS_SAVER_TOOLS:-%s/tools}"\n' "$DATA"
    [ -n "${RAG_BIN:-}" ] && printf 'export DS_SAVER_RAG_BIN="${DS_SAVER_RAG_BIN:-%s}"\n' "$RAG_BIN"
    printf 'exec "%s/tools/rag-refresh.sh" "$@"\n' "$DATA"
  } > "$tmp"
  if [ -f "$wrapper" ] && cmp -s "$tmp" "$wrapper"; then
    say "  已是最新 $wrapper"
  else
    backup_path "$wrapper"
    run mkdir -p "$DATA/bin"
    run cp "$tmp" "$wrapper"
    run chmod 755 "$wrapper"
    say "  安装 $wrapper"
  fi
  rm -f "$tmp"
}

run() {
  if [ "$DRY" = 1 ]; then printf '  [dry] %s\n' "$*"; else "$@"; fi
}

backup_path() {
  local p="$1"
  [ -e "$p" ] || return 0
  local b="$p.bak.$TS"
  if [ "$DRY" = 1 ]; then
    printf '  [dry] 备份 %s -> %s\n' "$p" "$b"
  else
    cp -pR "$p" "$b"
    printf '  备份 %s -> %s\n' "$p" "$b"
  fi
}

copy_if_changed() {
  local src="$1" dst="$2" mode="${3:-644}"
  run mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    printf '  已是最新 %s\n' "$dst"
    return 0
  fi
  backup_path "$dst"
  run cp "$src" "$dst"
  run chmod "$mode" "$dst"
  printf '  安装 %s\n' "$dst"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) [ $# -ge 2 ] || die "--workspace 需要目录"; WORKSPACE="$2"; shift 2 ;;
    --workspace=*) [ -n "${1#*=}" ] || die "--workspace 需要目录"; WORKSPACE="${1#*=}"; shift ;;
    --prefix) [ $# -ge 2 ] || die "--prefix 需要目录"; PREFIX="$2"; shift 2 ;;
    --prefix=*) [ -n "${1#*=}" ] || die "--prefix 需要目录"; PREFIX="${1#*=}"; shift ;;
    --data) [ $# -ge 2 ] || die "--data 需要目录"; DATA="$2"; shift 2 ;;
    --data=*) [ -n "${1#*=}" ] || die "--data 需要目录"; DATA="${1#*=}"; shift ;;
    --plugin-only) PLUGIN_ONLY=1; shift ;;
    --link) LINK=1; shift ;;
    --no-rag) NO_RAG=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看）" ;;
  esac
done

abspath() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$PWD" "$1" ;;
  esac
}
WORKSPACE="$(abspath "$WORKSPACE")"
PREFIX="$(abspath "$PREFIX")"
DATA="$(abspath "$DATA")"
[ -d "$WORKSPACE" ] || die "工作区不存在：$WORKSPACE"
case "$WORKSPACE$DATA" in
  *'"'*|*'$'*|*'`'*) die '路径不能包含双引号、$ 或反引号（rag-refresh 包装器限制）' ;;
esac

[ -f "$SRC/index.js" ] || die "找不到 $SRC/index.js，请在解压后的包根目录运行"
command -v node >/dev/null 2>&1 || die "未找到 node；需要 Node >=20"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR 太旧；需要 >=20"
command -v python3 >/dev/null 2>&1 || say "提示：未找到 python3。ctx_* 计量工具需要 Python 3.9+；Debian/Ubuntu 用 apt install python3，macOS 用 brew install python3。"

say "ds-saver $VERSION 一键安装"
DEFAULT_PREFIX="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
if [ "$PREFIX" != "$DEFAULT_PREFIX" ]; then
  say "  注意：使用非默认配置目录；请确保 OpenCode 的 XDG_CONFIG_HOME 与你传入的 --prefix 一致。"
fi
say "  包目录   $SRC"
say "  配置目录 $PREFIX"
say "  数据目录 $DATA"
say "  工作区   $WORKSPACE"
[ "$DRY" = 1 ] && say "  模式     dry-run（不写文件）"

# 1. OpenCode 插件 shim
step 1/5 "OpenCode 插件"
node --check "$SRC/index.js" >/dev/null 2>&1 || die "index.js 语法检查失败"
[ -f "$SRC/dsh/index.js" ] && { node --check "$SRC/dsh/index.js" >/dev/null 2>&1 || die "dsh/index.js 语法检查失败"; }
PLUGIN_ROOT="$PREFIX/plugins/ds-saver"
PLUGIN_PKG="$PLUGIN_ROOT/pkg"
PLUGIN_DST="$PLUGIN_ROOT/index.js"
if [ "$LINK" = 1 ]; then
  TARGET="$SRC/index.js"
  say "  模式：link（shim 指向仓库，改代码即时生效）"
else
  TARGET="$PLUGIN_PKG/index.js"
  copy_if_changed "$SRC/index.js" "$PLUGIN_PKG/index.js" 644
  copy_if_changed "$SRC/package.json" "$PLUGIN_PKG/package.json" 644
  copy_if_changed "$SRC/cordis.patch.yml" "$PLUGIN_PKG/cordis.patch.yml" 644
  copy_if_changed "$SRC/dsh/index.js" "$PLUGIN_PKG/dsh/index.js" 644
  for f in "$SRC"/scripts/*.py; do
    [ -f "$f" ] || continue
    copy_if_changed "$f" "$PLUGIN_PKG/scripts/$(basename "$f")" 644
  done
  for f in "$SRC"/bundle/tools/*; do
    [ -f "$f" ] || continue
    mode=644
    case "$f" in *.sh) mode=755 ;; esac
    copy_if_changed "$f" "$PLUGIN_PKG/bundle/tools/$(basename "$f")" "$mode"
  done
fi
SHIM="$(mktemp)"
printf 'export { default } from "%s";\n' "$TARGET" > "$SHIM"
if [ -f "$PLUGIN_DST" ] && cmp -s "$SHIM" "$PLUGIN_DST"; then
  say "  已是最新 $PLUGIN_DST"
else
  backup_path "$PLUGIN_DST"
  run mkdir -p "$(dirname "$PLUGIN_DST")"
  run cp "$SHIM" "$PLUGIN_DST"
  say "  安装 $PLUGIN_DST"
fi
rm -f "$SHIM"

if [ "$PLUGIN_ONLY" = 1 ]; then
  step 2/5 "跳过 skills / 工具 / RAG（--plugin-only）"
  say ""
  say "完成。重启 OpenCode 或新开会话后生效。"
  exit 0
fi

# 2. skills
step 2/5 "Skills（全局）"
for d in "$SRC"/bundle/skills/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  copy_if_changed "$d/SKILL.md" "$PREFIX/skills/$name/SKILL.md" 644
done

RAG_BIN="$(detect_rag || true)"

# 3. 工具脚本
step 3/5 "工具脚本"
for f in ctx-usage.py index-rebuild.py rag-emb-sync.py; do
  copy_if_changed "$SRC/bundle/tools/$f" "$DATA/tools/$f" 644
done
for f in session-metrics.py session-forecast.py; do
  copy_if_changed "$SRC/scripts/$f" "$DATA/tools/$f" 644
done
copy_if_changed "$SRC/bundle/tools/rag-refresh.sh" "$DATA/tools/rag-refresh.sh" 755

write_wrapper

# 4. 配置模板（不写真实配置、不碰密钥）
step 4/5 "配置模板"
copy_if_changed "$SRC/bundle/config/ds-saver.example.json" "$PREFIX/ds-saver.example.json" 600
if [ "$NO_RAG" = 0 ]; then
  copy_if_changed "$SRC/bundle/config/opencode-rag.example.json" "$PREFIX/opencode-rag.example.json" 600
fi

# 5. RAG 组件
step 5/5 "RAG 组件"
if [ "$NO_RAG" = 1 ]; then
  say "  已跳过（--no-rag）"
else
  if [ -n "$RAG_BIN" ] && [ -x "$RAG_BIN" ]; then
    say "  已检测到 $RAG_BIN"
  elif [ "$ASSUME_YES" = 1 ] && command -v npm >/dev/null 2>&1; then
    say "  未检测到 opencode-rag，执行 npm i -g opencode-rag-plugin@2.13.8"
    run npm install -g opencode-rag-plugin@2.13.8
    if [ "$DRY" = 0 ]; then
      RAG_BIN="$(detect_rag || true)"
      [ -n "$RAG_BIN" ] && { say "  已安装 $RAG_BIN"; write_wrapper; }
    fi
  else
    say "  未检测到 opencode-rag。稍后执行："
    say "    npm i -g opencode-rag-plugin@2.13.8"
    say "  或设置 DS_SAVER_RAG_BIN 指向已有可执行文件。"
  fi
  if [ -f "$PREFIX/opencode-rag.json" ]; then
    say "  已有 $PREFIX/opencode-rag.json（未改动）"
  else
    say "  下一步：cp $PREFIX/opencode-rag.example.json $PREFIX/opencode-rag.json"
    say "          然后填入 embedding.apiKey（密钥不要提交到 Git）"
  fi
fi

say ""
say "安装完成。下一步："
say "  1) 便宜模型（misc / rag filter）："
say "     cp $PREFIX/ds-saver.example.json $PREFIX/ds-saver.json 并填 apiKey"
say "  2) 验证插件：新开 OpenCode 会话，问一句“用 tree 看下当前目录”"
say "  3) 建索引：$DATA/bin/rag-refresh"
DSH_PKG="$PLUGIN_PKG"
[ "$LINK" = 1 ] && DSH_PKG="$SRC"
say "  4) DSH：dsh plugin --profile <profile> add $DSH_PKG"
say "  5) 完整说明：$SRC/bundle/README.md"
say ""
say "回滚：所有被覆盖的文件都保留为 <原文件>.bak.$TS"
