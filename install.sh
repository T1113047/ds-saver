#!/usr/bin/env bash
# 兼容入口：默认走一键安装（插件 + skills + 工具 + RAG 模板）
# 只装插件：./install.sh --plugin-only
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/bundle/install.sh" "$@"
