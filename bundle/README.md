# ds-saver 一键安装包

把四样东西装到一起：**OpenCode/DSH 插件 + 检索与归档 skills + 计量/索引工具 + RAG 组件模板**。安装器不会写入任何密钥，也不会覆盖你的现有配置——只写模板，改动前先备份。

## 30 秒版

```sh
git clone https://github.com/T1113047/ds-saver.git
cd ds-saver
DS_SAVER_WORKSPACE=/path/to/your/workspace ./bundle/install.sh
```

然后：

```sh
cp ~/.config/opencode/ds-saver.example.json ~/.config/opencode/ds-saver.json
# 填入至少一个便宜模型的 apiKey
```

新开一个 OpenCode 会话，问一句“用 tree 看下当前目录”。能返回目录树就算通了。

## 装了什么

| 组件 | 安装位置 | 作用 |
|---|---|---|
| OpenCode 插件 | `~/.config/opencode/plugins/ds-saver/index.js`（shim）+ `pkg/`（运行副本） | `tree` / `rag` / `misc` / `handoff` / `ctx_*` |
| 三个 skill | `~/.config/opencode/skills/<name>/SKILL.md` | `local-index-rag`、`opencode-rag`、`make-decision` |
| 工具脚本 | `~/.local/share/opencode/ds-saver/tools/` | `ctx-usage.py`、`session-metrics.py`、`session-forecast.py`、`index-rebuild.py`、`rag-emb-sync.py`、`rag-refresh.sh` |
| 刷新包装器 | `~/.local/share/opencode/ds-saver/bin/rag-refresh` | 固定工作区根，避免 index 扫错目录 |
| RAG 模板 | `~/.config/opencode/opencode-rag.example.json` | 复制后填 key 才生效 |

安装器**不**做这些事：不写 `ds-saver.json` / `opencode-rag.json` 实体、不读密钥、不改 `AGENTS.md`、不自动发布。

## 前置依赖

- Node.js >= 20
- Python 3.9+（`ctx_*` 计量工具用；只有 `python` 的机器会自动回退）
- 可选：`opencode-rag-plugin`（RAG 向量检索）
- 可选：DSH >= `0.2.2-rc.5`（只影响 DSH 端）

## 选项

```sh
./bundle/install.sh --help

--workspace DIR   工作区根（写进 rag-refresh 包装器，默认当前目录）
--prefix DIR      OpenCode 配置目录（默认 ~/.config/opencode）
--data DIR        工具目录（默认 ~/.local/share/opencode/ds-saver）
--plugin-only     只装插件（含运行副本），不装 skills/工具/RAG
--link            开发模式：shim 指向当前仓库，改代码即时生效
--no-rag          跳过 RAG 检测与模板
--yes             允许自动执行 npm i -g
--dry-run         只打印，不写文件
```

Windows（Git Bash）下可以直接传 `--prefix 'C:\Users\you\.config\opencode'`；安装器会归一化路径，shim 写成 `file:///C:/...`，Node/OpenCode 可直接加载。不要用 WSL 的 `bash.exe` 装 Windows 侧目录，除非 OpenCode 也跑在同一 WSL 里。

## 便宜模型配置

`misc` 和 `rag(filter=true)` 需要一个便宜模型。三种方式任选：

```sh
# 方式一：配置文件（推荐，600 权限）
cp ~/.config/opencode/ds-saver.example.json ~/.config/opencode/ds-saver.json

# 方式二：环境变量
export DASHSCOPE_API_KEY=...
export TOKENHUB_API_KEY=...
export MIMO_API_KEY=...
```

默认顺序是混元 Hy4 Flash → MiMo V2.6 Flash → Qwen3.8 Flash，前一个失败自动回退。不配也能用 `tree` / `rag`（基础行匹配）/ `handoff`；`misc` 会报缺 key，`rag(filter=true)` 会回退原始命中。

## RAG 组件

```sh
# 1. 安装（安装器检测不到时会打印这条命令）
npm i -g opencode-rag-plugin@2.13.8

# 2. 全局配置
cp ~/.config/opencode/opencode-rag.example.json ~/.config/opencode/opencode-rag.json
# 填入 embedding.apiKey

# 3. 工作区（可选）：只索引脱敏镜像
cat > .opencode/opencode-rag.json <<'JSON'
{
  "indexing": { "includeDirs": [".rag-sanitized"], "includeExtensions": [".md"] },
  "openCode": {
    "readOverride": false,
    "injectSystemPrompt": false,
    "autoIndex": { "enabled": false }
  }
}
JSON

# 4. 同步镜像并建索引
~/.local/share/opencode/ds-saver/bin/rag-refresh
```

`rag-refresh` 必须先切到工作区根再跑：`opencode-rag` 的 `includeDirs` 按 cwd 锚定，在错误目录执行可能把索引清空。包装器已经替你固定了 `DS_SAVER_WORKSPACE`。

## DSH

```sh
# npm 发布后
dsh plugin --profile <profile> add ds-saver

# 现在：用一键包复制出的运行副本（不依赖 clone 目录）
dsh plugin --profile <profile> add ~/.config/opencode/plugins/ds-saver/pkg

# 或开发时直接指向源码目录
dsh plugin --profile <profile> add /path/to/ds-saver
```

DSH 端提供 `misc` / `tree` / `rag` / `handoff`；`ctx_status` / `ctx_forecast` / `ctx_calibrate` / `ctx_report` 依赖 OpenCode 会话库，DSH 不注册。DSH 版 `misc` 不支持 `paths`，材料放进 `material`。

## 验证清单

| 检查 | 命令 / 动作 | 期望 |
|---|---|---|
| 插件注册 | 新会话问“用 tree 看当前目录” | 返回目录树 |
| 行匹配检索 | 问“用 rag 找 README 里的安装” | 返回 `文件:行号: 摘要` |
| 便宜模型 | `misc` 传 5 行日志 | 返回一行结论 |
| 计量 | `ctx_status` | 返回上下文/缓存/成本 |
| 交接 | `handoff` | 生成 `.handoff/*.md` |
| RAG 索引 | `rag-refresh --check` | manifest 条数 > 0 |

## 目录与回滚

```
<repo>/bundle/
├── install.sh          # 一键入口
├── skills/             # 三个 skill 的通用版
├── tools/              # 可移植工具脚本
└── config/             # 示例配置（无密钥）
```

安装器会把插件运行所需的 `index.js`、`scripts/`、`bundle/tools/` 复制到 `~/.config/opencode/plugins/ds-saver/pkg/`，装完不再依赖 clone 目录。开发时用 `--link` 可改回指向仓库。

安装器覆盖任何文件前都会保留 `<原文件>.bak.<时间戳>`。回滚就是把 `.bak.*` 改回原名；卸载则删除上面表格里的五处位置，以及残留的 `.bak.*` 和两个 `.example.json`。

## 安全边界

- 密钥只通过环境变量或 600 权限的配置文件提供，安装器不读、不写、不回显。
- `misc` 发给外部模型前会拒绝 `03-密钥`、`.env*`、`auth.json`、私钥等路径，并检查 `sk-` / `tp-` / `api_key=` 等模式。
- `tree` / `rag` 默认拒绝敏感路径；`misc` 的 `agent` 模式只读文件，不跑 shell。
