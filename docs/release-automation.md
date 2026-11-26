# 自动发布与 Community Market 部署

DSH Community Market 不执行插件仓库里的脚本，也不接受目录里的版本号。它的安装链路是固定的：

1. 目录来源（如 DSH 1024Store）提供条目的**唯一 npm package 身份**；
2. Market 请求 `https://registry.npmjs.org/<package>/latest`，要求返回同一个 package name、精确稳定版本和 `dsh.bundle.patch`；
3. 用户确认 preview 后，官方插件管理器以精确的 `name@version` 调用 `installBundle`；
4. 管理器负责写入 `dsh.profile.bundles`、恢复失败安装、HMR 应用。

所以“自动化部署”只需要把两件事做成自动的：**npm 发布**和**目录重新同步**。

## 1. GitHub Actions 自动发布

仓库已加 `.github/workflows/release.yml`：推送 `v*` tag 时跑 `check` / `test`，再用 npm Trusted Publishing（OIDC）发布。

一次性配置（npm 网页，只需做一次）：

1. 打开 <https://www.npmjs.com/package/ds-saver/access>；
2. **Trusted Publisher** → GitHub Actions；
3. Repository 填 `T1113047/ds-saver`，Workflow 填 `release.yml`，Environment 留空；
4. 保存后，workflow 里的 `id-token: write` 就能换到短时发布凭据，不再需要 `NPM_TOKEN` 或 OTP。

发版：

```sh
npm version patch --no-git-tag-version   # 或手动改 package.json
npm test
git add -A && git commit -m "release: x.y.z"
git tag vx.y.z
git push origin main --tags
```

workflow 会校验 tag 与 `package.json` 版本一致，再 `npm publish --provenance --access public`。

## 2. 目录同步

- **DSH 1024Store**：合并 `catalog/plugins/*.json` 后会触发 catalog-sync，把条目推到线上并重建 README。条目本身不存 `install` 命令；站点从 npm 是否可解析出 package 身份来生成。`install` 变成 `dsh plugin --profile … add ds-saver` 后，Market 才会把它标为可自动安装；只有 `github:` 目标时保持 browse-only。
- **DSH Hub**：带 `dsh-plugin` GitHub topic 的仓库会被定时同步；发布新 npm 版本后不需要重新提交仓库。
- **dshfind**：adapter 从结构化字段标准化 npm 身份，适合作为第三个来源。

检查：

```sh
curl -s 'https://deepseek1024.com/api/v2/plugins?q=ds-saver' | jq '.plugins[0].install'
# 期望：dsh plugin --profile web add ds-saver
```

如果仍是 `github:T1113047/ds-saver`，说明目录还没重新检测 npm，Market 会保持 browse-only；等下一次 catalog-sync 或按目录维护流程重新同步。

## 3. 当前状态

- npm：`ds-saver@0.4.2` 为 `latest`，`0.4.1` 已因 CRLF 问题 deprecate；
- `package.json` 的 `dsh.bundle.patch` 为 `./cordis.patch.yml`，patch 文件已提交；
- 1024Store 条目已收录（PR #1124），但 `install` 仍显示 GitHub 目标，待 npm 身份同步；
- DSH Hub 依赖 `dsh-plugin` topic 自动同步。

## 4. 验证 Market 自动安装

目录 `install` 变成 npm 包名后：

1. 在 DSH Desktop 打开 Community Market，选 1024Store 来源；
2. 搜索 `ds-saver`，确认出现“安装 preview”，preview 里应显示精确版本（如 `0.4.2`）；
3. 确认安装，Market 会调用插件管理器安装 `ds-saver@0.4.2`；
4. 在 **插件** 页面确认 `ds-saver` 行已启用，再开新会话调用 `tree` / `rag`。

Market 不负责重启 Desktop；如果管理器报告 `restart-required`，按提示重启或让 HMR 应用。
