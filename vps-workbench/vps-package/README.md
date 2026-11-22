# VPS Workbench Linux 后端包

此安装包包含现有 SSH 执行器源码、宿主检查和可选运行时。独立工作台继续使用各自随附的 SSH 执行器，并按原协议发送任务、停止信号和回执查询。已配对的主机指纹、预期出口、网络策略和会话不受安装器管理。安装器在当前 VPS 用户的目录中工作，无需启动常驻服务。

## 选择系统

| 系统 | 依赖适配 |
| --- | --- |
| Ubuntu、Debian 及 apt 系衍生发行版 | 建议 `python3 bubblewrap iproute2 curl ca-certificates` |
| Fedora、RHEL、Rocky、AlmaLinux 及 dnf 系衍生发行版 | 建议 `python3 bubblewrap iproute curl ca-certificates` |
| 其他 glibc Linux | 安装同等系统依赖并以实际预检为准 |

x86‑64 和 ARM64 使用同一个包，安装器选择对应的官方运行时。需要 glibc 2.28 以上、通过 SSH 的 `PATH` 可找到的系统 Python 3.9 以上、`/usr/bin/bwrap` 和可用的 Linux 用户、挂载、PID、IPC、UTS 和网络命名空间。SELinux、AppArmor、VPS 内核和容器策略都可能影响沙箱启动。按当前发行版的配置为已授权的程序解决问题，再运行预检。Windows Server 和 macOS 目标需要通过 Linux 虚拟机或独立 Linux 主机运行这套执行器。Alpine 的 musl 基础镜像需要另行适配。

Ubuntu 24.04 的 AppArmor 用户命名空间限制详见 [Ubuntu 24.04 发布说明](https://documentation.ubuntu.com/release-notes/24.04/)。发行版包名可参照 [Debian bubblewrap](https://packages.debian.org/bookworm/bubblewrap)、[Fedora bubblewrap](https://packages.fedoraproject.org/pkgs/bubblewrap/bubblewrap/) 和 [Fedora iproute](https://packages.fedoraproject.org/pkgs/iproute/iproute/)。

## 在 VPS 上准备

从可信分发位置取得压缩包及同名 `.sha256`。使用以后运行模型的普通 SSH 用户，解压在其可读目录。以下文件名的版本号与工作台发布版一致。

```sh
sha256sum -c VPS-Workbench-Backend-0.28.0-dev.8-linux.tar.gz.sha256
tar -xzf VPS-Workbench-Backend-0.28.0-dev.8-linux.tar.gz
cd VPS-Workbench-Backend-0.28.0-dev.8-linux
python3 -I -B workbench-vps.py verify
python3 -I -B workbench-vps.py doctor
```

`doctor` 输出系统、CPU、建议的包管理器命令、缺失项和沙箱状态。探针进入现有隔离层，检查只读目录、独立网络命名空间、系统 CA 及 SSH 环境变量的隐藏情况。当前源码会在 Fedora 和 RHEL 系的沙箱内只读挂载系统 CA 文件。模型任务继续使用独立 HOME、授权工作目录和原来的 HTTPS 域名限制。`dependency_missing` 由管理员通过原有包管理工具补齐，`sandbox_unavailable` 需要检查 VPS 的内核和隔离策略。`account` 始终显示 `unchecked`，登录和出口由工作台接入向导检查。

## 安装所选执行端

```sh
python3 -I -B workbench-vps.py install --provider codex --provider claude --provider antigravity
python3 -I -B workbench-vps.py doctor --workspace "$HOME/vps-workbench-project"
```

可重复传 `--provider`，可选 `codex`、`claude`（Claude CLI，供 API 或现有终端使用）、`claude-sdk`（另外准备 VPS 的 Node 和 Claude Agent SDK）和 `antigravity`。`install` 也可以只保存后端包。可用 `--workspace /absolute/project` 选择当前用户拥有的已有目录。安装器只在实际隔离探针通过后落盘，可安全重跑，遇到已有工具或配置会保留原件并报告各项结果。

运行时来自锁定的官方地址，完整性校验后只取需要的文件。离线安装时，把 [runtime-catalog.json](runtime-catalog.json) 中所选架构的原始归档放进一个目录，再传入 `--offline-dir /absolute/artifacts`。Claude SDK 还需要通用 SDK 归档、同架构 Claude CLI 和 Node 归档。

安装文件保存在 `~/.local/share/vps-workbench/`，新 CLI 通过 `~/.local/bin` 查找。确认 SSH 的非交互 `PATH` 能找到它们。如果已有 npm 脚本等不兼容的同名命令在 SSH 的 `PATH` 中优先，安装会报告 `incompatible_runtime_on_ssh_path`。核对并调整该用户的路径后重试。Claude SDK 继续使用现有执行器要求的 `~/.dsh-claude-sdk`。Antigravity 使用 `~/.dsh-antigravity/home` 作为独立登录目录。管理员可在明确核对服务地址后为所选 Antigravity 配置传入多个 `--agy-host`，安装器按现有白名单规则验证，遇到不同的旧清单会保留它。

## 接入账号与桌面

在 VPS 用户环境中按执行端的官方流程登录。Antigravity 可在专用目录启动官方 CLI。

```sh
HOME="$HOME/.dsh-antigravity/home" "$HOME/.local/bin/agy" acp --login
```

公开分发时，Claude Agent SDK 的凭据须遵循 Anthropic 对第三方集成的规定。安装 SDK 只准备运行时及其受控目录，订阅资格、登录方式和模型额度由提供方决定。内嵌的图形账号页和旧订阅终端仍随对应的桌面兼容包分发，具有单独的依赖。 [Claude Agent SDK 认证](https://code.claude.com/docs/en/agent-sdk/overview) · [Antigravity ACP](https://antigravity.google/docs/cli/acp)

在桌面打开「设置 → 连接 → VPS SSH」，填入此用户、工作目录、已确认的主机指纹和预期 VPS 出口。接入向导可检查账号和目录，模型试跑由用户单独启动。新安装本身不会试跑模型。升级和回退时保留已有账户、工作目录与回执。错误时可修正依赖后重新执行同一命令，安装器会逐一检查已有的组件。

## 从源码构建

在仓库根目录运行 `python vps-workbench/vps-package/build.py --revision <Git提交哈希>`。Linux 上可用 `python3`。输出位于 `vps-workbench/dist/vps-backend/`，包括一个 `.tar.gz` 和校验文件。相同源码与提交产生相同归档。归档包含 Workbench 的执行器及安装工具。各供应方原生软件按需获取，账号凭据和已有服务器数据始终保存在用户原目录。
