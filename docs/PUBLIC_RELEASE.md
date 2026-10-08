# 发布 Codex Project Launcher

## 生成发布包

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run release:prepare
```

`release/` 内生成：

- `codex-project-launcher-0.2.6-windows.zip`：解压即可安装或运行的 Windows 使用包。
- `codex-project-launcher-0.2.6-source.zip`：公开源码，包含构建好的插件。
- `SHA256SUMS.txt`：两个文件的 SHA-256 校验值。

发布包使用明确的文件清单，包含隐藏的插件/marketplace 配置、安装器、许可和演示截图，不包含个人入口、令牌、开发临时文件、旧验收记录或本地 Git 历史。打包前会检查必需文件、版本、私人路径和常见凭证标记。

首次从私人开发目录开源时，解压干净源码包到新目录再创建 Git 仓库，保留原开发仓库用于回滚：

```powershell
git init -b main
git add .
git commit -m "Release Codex Project Launcher 0.2.6"
```

不要将个人 `%LOCALAPPDATA%\StartButtons\` 配置或旧开发历史加入公开仓库。

## GitHub Release

仓库：`linsank2005/codex-project-launcher`。在通过检查的源码提交上创建 `v0.2.6` 标签，将 Windows 使用包、源码包和校验文件一起上传到 Release。

公开源码中的 Windows CI 会构建、执行本地测试并验证发布包。原生控制台测试只操作隔离的临时服务，需要 Windows 进程、端口和控制台查询权限；插件宿主加载另用 `node scripts/check-codex.mjs` 验证。

更新版本时同步 package、lockfile、插件 manifest、`src/version.mjs` 和文档中的版本号，重新构建后再生成发布包。内部插件 ID `start-buttons@start-buttons-local` 和数据目录 `StartButtons` 保持稳定。

GitHub 市场跟踪 `main`。每次发布必须将构建好的 `plugins/start-buttons/` 一起提交；用户不执行构建或 npm 安装。更新后验证 Git URL 添加市场、插件缓存中的实际清单启动、旧版本面板切换和个人数据保留，再创建 Release。

采用 MIT 许可证，第三方许可附在 `THIRD_PARTY_NOTICES.txt`。本项目通过 GitHub 分发本地插件，未自动提交到 OpenAI 官方插件目录。
