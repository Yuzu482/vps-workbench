# VPS Workbench Windows 累计更新

此包面向 Windows x64 标准版，更新到 `0.28.0-dev.12` 的累计修正版。适用基线包括 `0.28.0-dev.11` 正式发布版、同版本的 OAuth QA 修正版，以及 `update.json` 列出的早期 `0.28.0-dev.12` 标准版。版本相同的构建以清单中的 WebRevision 区分。首次安装和个人订阅版需使用对应的完整包。

## 本次包含

- SSH 连接预检、工作台设置及 Claude OAuth 登录窗口的修复，包括远程光标、剪贴板和授权链接交接。
- Claude Agent SDK、Claude API 和 Antigravity ACP 的设计工作台接入，沿用原执行端、会话和版本分支。
- VPS 订阅额度读取、上下文数据接入和输入栏悬浮占用卡。实际读数取决于对应执行端回报。

本次附带标准版的本机运行组件。现有设置、项目、会话和凭据沿用原数据目录。已有 VPS 的执行请求按原 SSH 路径运行，这次更新无需重启或重新部署 VPS。首次使用尚未配置的执行端时，继续通过接入向导检查对应 CLI、SDK、登录和依赖。

## 安装

1. 在 PowerShell 中运行 `Get-FileHash -Algorithm SHA256 .\VPS-Workbench-0.28.0-dev.12-Windows-Cumulative-Update.zip`，对照随包提供的 SHA‑256。
2. 完整解压 ZIP，等工作台正在运行的任务结束。若从便携目录启动工作台，先关闭该窗口。
3. 双击 `Install.cmd`。如果更新器未自动找到受支持的版本，输入包含原版 `VPS Workbench.exe` 的目录。
4. 更新器会核对基线和目标文件，启动新版并更新开始菜单快捷方式。等待出现工作台窗口。

## 回退

更新前的程序保留在 `%LOCALAPPDATA%\VPS Workbench\Releases`。退出新版后，可以直接运行原便携目录或原版本目录中的 `VPS Workbench.exe`。同版本覆盖时，原版在名称含 `-previous-` 的目录中，选择本次更新创建的目录。现有用户数据继续使用原数据目录。
