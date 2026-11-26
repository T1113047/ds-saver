# Security Policy

## 报告漏洞

请不要在公开 issue 里贴 API Key、日志正文或可利用细节。

优先使用 GitHub 仓库的 **Security → Report a vulnerability**（私有 Security Advisory）。若仓库尚未开启该功能，请先开一个不含敏感信息的 issue，说明「需要私下联系」。

我们会在 7 天内确认，并在修复后公布致谢（如果你愿意署名）。

## 插件的安全边界

- `misc` / `rag` / `tree` 默认拒绝读取 `03-密钥`、`.env*`、`auth.json`、私钥、`credentials/`、`secrets/` 等路径。
- 材料命中私钥或 `sk-`、`tp-`、`api_key=` 等模式时中止，不发送给外部模型。
- `rag` 的外部命令只通过 `execFile` 调用，不拼接 shell。
- 插件不自动上传数据；`ctx_report` 只写本地匿名 JSONL，是否提交由用户决定。
- 日志不打印 API Key。

## 密钥配置

密钥只放在环境变量或权限为 `600` 的本地配置文件里，不要提交到仓库：

```sh
export DASHSCOPE_API_KEY=...
export TOKENHUB_API_KEY=...
export MIMO_API_KEY=...
```
