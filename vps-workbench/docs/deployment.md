# VPS Workbench 部署教程

适用于 Windows x64 和支持 Linux 命名空间的 x86‑64／ARM64 VPS。发行包为便携应用，解压后即可启动。当前版本为预发行版，先在隔离的数据目录验证，再迁移已有记录。需要自动协助时，可以复制 [安装提示词](installation-prompt.md)。

## 1. 下载和核对文件

从 [GitHub Release](https://github.com/Yuzu482/vps-workbench/releases) 下载同一版本的文件：

| 文件 | 用途 |
| --- | --- |
| `VPS-Workbench-<版本>-win-x64.zip` | Windows 工作台，含 VPS 接入向导及后端包 |
| `VPS-Workbench-Backend-<版本>-linux.tar.gz` | Linux 后端，供手动部署和离线传输 |
| `SHA256SUMS.txt` | 校验两个包及发行附带文档 |
| `DEPLOYMENT.md`、`INSTALL-PROMPT.md` | 部署教程和可复制给模型的提示词 |

拥有仓库访问权限的用户可从发行页下载。Windows PowerShell 中用 `Get-FileHash -Algorithm SHA256 <下载文件路径>` 核对完整哈希。Linux 上可直接核对指定包：

```sh
grep -F '  VPS-Workbench-Backend-0.28.0-dev.11-linux.tar.gz' SHA256SUMS.txt | sha256sum -c -
```

使用其他版本时替换文件名。哈希不一致时重新下载。

## 2. 启动 Windows 工作台

1. 把 ZIP 完整解压到一个新目录，打开其中的 **VPS Workbench.exe**。
2. 首次运行可勾选本机 Codex、Claude Agent SDK 或 Antigravity ACP，应用会下载并校验需要的运行时。只使用 VPS 时，选择「暂只使用 VPS SSH」。
3. 在「设置 → 模型与账号」完成所选执行端的身份配置。本机 Codex 和 Claude Agent SDK 使用对应 API 密钥。Antigravity 走官方 CLI 登录。把密钥填入应用提供的安全入口，登录码在官方流程中输入。
4. 选择「本机 SDK」作为新建位置。先在已授权的只读工作目录建立会话，再用一条短消息和一次追问验证流式回复和续聊。模型试跑会消耗所选账号额度。
5. 使用 VPS SSH 时，Windows 需具备 **.NET 10 Runtime、OpenSSH 客户端和 Python 3.11**。如果应用找不到 Python，可在启动前把 `VPS_WORKBENCH_PYTHON` 设置为对应的 `python.exe` 绝对路径。

默认数据目录为 `%APPDATA%\VPS Workbench`。试用时可先用 PowerShell 启动独立的数据目录：

```powershell
$env:VPS_WORKBENCH_DATA_DIR = Join-Path $env:TEMP ("VPS-Workbench-trial-" + [guid]::NewGuid())
& '.\VPS Workbench.exe'
```

这只影响当前 PowerShell 启动的进程。正常升级前先备份原数据并保留上一版程序目录，确认未结束的操作能查到原回执。旧 DSH 对话可以通过「文件 → 导入 DSH 对话数据」复制到工作台，导入前应等待旧客户端结束写入。

## 3. 用向导从 Windows 配置 VPS

1. 在 Linux VPS 上准备普通 SSH 用户和该用户拥有的项目目录，例如 `/home/alice/vps-workbench-project`。SSH 防火墙规则仅放行自己的来源地址，工作台通过 SSH 使用后端，无需额外开放入口。
2. 在 **设置 → 连接 → VPS SSH** 填入主机、端口、SSH 用户名、VPS 项目目录绝对路径、Windows 的私钥路径和 `known_hosts` 路径，以及预期 VPS 出口 IPv4 和适用的 IPv6。通过 VPS 管理控制台或已有可信记录核对主机指纹后再确认。更换主机或主机密钥时重新核对。
3. 点「保存连接配置」和「测试连接」。检查 SSH 指纹、预期出口、账号和模型目录。检测到运行时缺失时，打开 **VPS 接入向导 → VPS 后端安装**，勾选需要的工具并执行「安装所选执行端」。
4. 向导识别架构并检查 Linux 依赖。Ubuntu／Debian 需要 `python3 bubblewrap iproute2 curl ca-certificates`；Fedora／RHEL 系使用 `iproute`。系统依赖由 VPS 管理员安装。有沙箱错误时，针对该用户核对系统的命名空间和隔离策略。
5. 在「模型与账号」完成 VPS 登录或配置该执行端的密钥。Claude CLI、Claude SDK 和 Antigravity 的登录资格以各提供方和该执行环境为准。安装运行时会保留已有账号、配置和会话。
6. 在账号和模型目录通过后，明确选择是否发起「试跑模型」。通过后再验证第二轮续聊、停止、重开工作台后的历史恢复。若安装或试跑回执不明，查询原回执后再决定下一步。

本机 SDK 和 VPS SSH 各自绑定执行位置、账号和会话。使用 VPS 时，工作台负责经 SSH 提交任务，所选 VPS 执行端向模型服务请求。VPS 预检观测的出口和第三方实际看到的 IP 是两项证据，有代理或双栈时分别核对。

## 4. 在 Linux 手动部署后端

使用未来实际运行模型的普通 SSH 用户。把校验通过的后端归档传到该用户的目录。下面示例只安装 Codex，其他可选执行端为 `claude`、`claude-sdk` 和 `antigravity`。每加一个执行端多写一次 `--provider`。

```sh
tar -xzf VPS-Workbench-Backend-0.28.0-dev.11-linux.tar.gz
cd VPS-Workbench-Backend-0.28.0-dev.11-linux
mkdir -p "$HOME/vps-workbench-project"
python3 -I -B workbench-vps.py verify
python3 -I -B workbench-vps.py doctor --workspace "$HOME/vps-workbench-project"
python3 -I -B workbench-vps.py install --provider codex --workspace "$HOME/vps-workbench-project"
```

先检查两条预检命令的结果，再运行最后一条安装命令。后端使用 Linux 的系统 Python、`bubblewrap` 和可用的用户及网络命名空间。下载运行时需要 VPS 可访问目录中锁定的官方来源。使用已准备的运行时归档时，传入 `--offline-dir /绝对路径/归档目录`。执行器安装到用户自己的目录，确认 SSH 非交互会话的 PATH 能找到 `~/.local/bin` 中的 CLI。

### 常见卡点

| 表现 | 处理 |
| --- | --- |
| SSH 超时或指纹失败 | 检查源 IP 规则、SSH 端口和可信指纹；主机密钥变化后重新校验 |
| 预期出口不符 | 确认 VPS 当前 IPv4／IPv6 和网络策略；保留严格验证 |
| `dependency_missing` 或 `sandbox_unavailable` | 让管理员补齐系统依赖，并核对内核、AppArmor／SELinux 和虚拟化环境 |
| `incompatible_runtime_on_ssh_path` | 检查非交互 SSH PATH 中实际找到的 CLI，修正用户自己的路径 |
| 账号、目录通过但试跑失败 | 核对账号权限、所选模型、额度、回执和服务可达性 |

更多选项见 [Linux 后端参考](../vps-package/README.md)。
