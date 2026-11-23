# Windows 增量更新

此补丁适用于 Windows x64 的 **0.28.0-dev.11 正式发布包**和此前的 **0.28.0-dev.11 OAuth QA 修正版**。它更新 Windows 工作台到 **0.28.0-dev.12**，保留旧版程序和现有设置、项目及会话。

1. 如需核对下载，在 PowerShell 对 ZIP 运行 `Get-FileHash -Algorithm SHA256 .\VPS-Workbench-0.28.0-dev.12-Windows-Patch.zip`，对照发布页的 `SHA256SUMS.txt`。
2. 解压整个 ZIP。结束正在运行的任务。如果原来直接从解压目录启动，请先关闭该便携版。
3. 双击 `Install.cmd`，按提示继续。若此前用的是便携版且工作台没有自动找到它，请填写**包含 VPS Workbench.exe 的原目录**。
4. 更新会校验旧版与补丁文件、启动新版，并加入 Windows 开始菜单中的「VPS Workbench」。

Claude 登录窗口加入了双向剪贴板、后备光标和 Firefox 授权链接交接，同时支持简体中文和英语。这一版继续使用已有 VPS 后端。内嵌登录仍要求对应 VPS 用户使用 LUKS2 加密家目录。

## 回退

退出新版后，重新打开原便携目录里的 `VPS Workbench.exe`，或在 `%LOCALAPPDATA%\VPS Workbench\Releases` 中打开原来的版本。现有用户数据仍保存在原数据目录。
