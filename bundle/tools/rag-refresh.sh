#!/usr/bin/env bash
# 本地索引 RAG 统一入口
#
# 为什么必须从工作区根运行：
#   opencode-rag 的 indexing.includeDirs 按 cwd 锚定，且只过滤目录。
#   在别的目录运行 index 可能只扫到入口文件，并把其余条目当成 stale 删除。
#   本脚本会先 cd 到 $DS_SAVER_WORKSPACE 再执行。
#
# 用法：
#   rag-refresh.sh            # 同步脱敏镜像 -> 残留扫描 -> 建索引 -> 摘要
#   rag-refresh.sh --check    # 只读自检：镜像残留 + 源/镜像一致性 + 库摘要
#   rag-refresh.sh --sync     # 只同步镜像（含残留扫描），不建索引
#
# 环境变量：
#   DS_SAVER_WORKSPACE  工作区根（默认当前目录）
#   DS_SAVER_TOOLS      工具目录（默认 <ws>/本地索引/99-工具）
#   DS_SAVER_RAG_BIN    opencode-rag 可执行文件（默认从 PATH 查找）
#   DS_SAVER_RAG_STORE  RAG store 目录（默认 ~/.local/share/opencode-rag/local-index）
set -euo pipefail

WS="${DS_SAVER_WORKSPACE:-$(pwd)}"
TOOLS="${DS_SAVER_TOOLS:-$WS/本地索引/99-工具}"
STORE="${DS_SAVER_RAG_STORE:-$HOME/.local/share/opencode-rag/local-index}"
RAG_BIN="${DS_SAVER_RAG_BIN:-$(command -v opencode-rag || true)}"
PYTHON="${DS_SAVER_PYTHON:-python3}"

usage() {
  cat >&2 <<'EOF'
用法：
  rag-refresh.sh            # 同步脱敏镜像 -> 残留扫描 -> 建索引 -> 摘要
  rag-refresh.sh --check    # 只读自检：镜像残留 + 源/镜像一致性 + 库摘要
  rag-refresh.sh --sync     # 只同步镜像（含残留扫描），不建索引
环境变量：DS_SAVER_WORKSPACE / DS_SAVER_TOOLS / DS_SAVER_RAG_BIN / DS_SAVER_RAG_STORE / DS_SAVER_PYTHON
EOF
  exit "${1:-2}"
}

mode="${1:-refresh}"
case "$mode" in -h|--help|help) usage 0 ;; esac

[[ -d "$WS" ]] || { echo "错误：工作区不存在 $WS（设置 DS_SAVER_WORKSPACE）" >&2; exit 2; }
[[ -f "$TOOLS/rag-emb-sync.py" ]] || { echo "错误：找不到 $TOOLS/rag-emb-sync.py" >&2; exit 2; }
if [[ "$mode" != "--sync" && "$mode" != "sync" ]]; then
  [[ -n "$RAG_BIN" && -x "$RAG_BIN" ]] || { echo "错误：找不到 opencode-rag（设置 DS_SAVER_RAG_BIN 或 npm i -g opencode-rag-plugin）" >&2; exit 2; }
fi

# includeDirs 依赖 cwd，必须先切到工作区根
cd "$WS"

case "$mode" in
  --check|check)
    "$PYTHON" "$TOOLS/rag-emb-sync.py" --check
    "$PYTHON" "$TOOLS/rag-emb-sync.py" --check-sync
    "$RAG_BIN" status | sed -n '/^Store path:/,$p' | grep -E 'Store path|Manifest entries|Last indexed|Up-to-date|Pending|Indexed chunks|Expected chunks|Orphan chunks'
    ;;
  --sync|sync)
    "$PYTHON" "$TOOLS/rag-emb-sync.py"
    ;;
  refresh|"")
    "$PYTHON" "$TOOLS/rag-emb-sync.py"
    "$RAG_BIN" index
    "$RAG_BIN" status | sed -n '/^Store path:/,$p' | grep -E 'Store path|Manifest entries|Last indexed|Up-to-date|Pending|Indexed chunks|Expected chunks|Orphan chunks'
    entries="$("$PYTHON" -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["files"]))' "$STORE/manifest.json")"
    if [[ "$entries" -lt 1 ]]; then
      echo "错误：索引条目为 $entries，扫描范围可能错误；请检查 cwd 与 includeDirs。" >&2
      exit 1
    fi
    echo "完成：manifest ${entries} 条。"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    ;;
esac
