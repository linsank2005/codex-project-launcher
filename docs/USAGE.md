# 使用与排错

## 手动安装插件

推荐下载 Windows 使用包并双击 `安装插件.cmd`。也可以在解压目录的 PowerShell 中运行：

```powershell
codex plugin marketplace add .
codex plugin add start-buttons@start-buttons-local
```

安装后新建 Codex 聊天，输入“使用 Codex Project Launcher 打开项目启动台”。这两个内部标识沿用旧版本，个人配置目录也保持不变。

发布到 GitHub 后也可添加仓库 marketplace：

```powershell
codex plugin marketplace add linsank2005/codex-project-launcher --ref main
codex plugin add start-buttons@start-buttons-local
```

需支持本地插件和 MCP Apps 的 Codex 版本。宿主不渲染嵌入面板时，打开工具返回的本地链接。插件提供打开、读取、保存、移除、启动、停止和重启七个工具。

官方机制见 [OpenAI 插件打包与 marketplace 文档](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli)。本项目在 Windows 上验证了自带安装器和 CLI 的插件加载；不同宿主的原生侧栏呈现可能不同。

## 启动入口

- 脚本默认在入口文件所在目录执行；快捷方式保留自身配置的工作目录。
- 命令模式需要填写项目目录；面板先进入该目录，再执行保存的原命令。
- 启动文件每次读取当前内容；运行中的代码是否热更新由原项目决定。
- 卡片上的地址和操作回执已精简，完整入口仍保留在编辑窗口中。

## 状态检查

| 状态 | 含义 |
| --- | --- |
| 运行中 | 已核验入口的业务进程或服务身份；不代表业务功能全部健康。 |
| 启动中 | 启动器正在准备；暂时禁止重复启动。 |
| 未运行 / 未连接 | 没有检测到匹配的业务进程，或配置的服务地址暂不可访问。点击状态查看具体原因。 |
| 待确认 | 证据不足，不能断定已经启动或停止。 |
| 连接中断 | 无法读取面板最新状态，不表示业务服务已关闭。 |

面板可见时每 5 秒检查，也可手动刷新。HTTP 检查地址只接受本机 `http://127.0.0.1:端口/`、`http://localhost:端口/` 或 IPv6 回环地址，不跟随重定向；单纯收到 HTTP 响应不会被当作项目归属证据。

地址被其他项目占用时会阻止重复启动。启动关联保存在本机，每次按 PID 和创建时间重新核验；失效记录或空终端不代表业务仍在运行。

## 停止与重启

停止默认核验独立终端和其中的进程，再发送正常 Ctrl+C。无法核验归属、存在多个独立业务终端或原项目不响应时，请在原窗口退出。

需要专用退出方式时，在编辑中的“停止方式”填写原项目实际提供的 PowerShell 停止命令。执行命令后仍需确认业务进程退出；重启只有在停止成功后才再次启动，不会强制结束进程。GUI / URL 或另行管理的后台服务不保证可统一停止。

## 本地数据与更新

默认数据目录为 `%LOCALAPPDATA%\StartButtons\`：

- `projects.json`：个人入口配置。
- `launches.json`：本机启动关联和最近操作记录。
- `runtime.json`：面板地址和调用令牌。

备份时复制数据目录；这些文件不要上传公开仓库。也可使用 `START_BUTTONS_DATA_DIR` 指定独立数据目录、`START_BUTTONS_PORT` 指定端口，端口为 `0` 时自动分配。

更新包解压到固定位置，重新运行安装器；刷新网页或重新打开嵌入面板。若同一版本的缓存被占用，关闭面板、重启 Codex 后重试。关闭或更新面板不会停止业务项目。

配置或运行记录损坏时原文件会保留并报错。先关闭面板并备份，再恢复配置；仅运行记录损坏时，移开 `launches.json` 可重建关联，项目列表仍保留。
