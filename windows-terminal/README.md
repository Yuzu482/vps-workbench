# Remote SSH Windows Terminal 测试版

本机连接管理器通过系统 OpenSSH 连接远端。交互式 shell 使用独立 Windows Terminal；聊天式工作台和任务窗口使用可恢复的非交互任务。程序不接管交互终端输入，不替用户批准权限，也不保存密码、私钥内容或 Codex 登录信息。

Windows Terminal 负责输入法、粘贴和终端协议；项目中内嵌 WebView 的输入来源实验仍是独立实验，不用于此 SSH 路线。远端运行的 Codex 通常由远端网络发出请求，但系统代理、应用配置、登录浏览器或其他本机应用可能走不同路径；这套工具不证明服务商只能看到某个地址。

实现参考：[Windows Terminal 开源项目](https://github.com/microsoft/terminal)负责本机终端交互；[OpenSSH 配置说明](https://man.openbsd.org/ssh_config.5)说明加密保活和断线检测。连接诊断参考 [OpenSSH 的地址尝试代码](https://github.com/openssh/openssh-portable/blob/master/sshconnect.c)，但本项目诊断采用错峰尝试，并不模拟 OpenSSH 的完整连接过程。[Mosh](https://mosh.org/) 提供 IP 漫游和断线恢复的另一种设计，本项目尚未接入，当前 SSH 会话不能因启用保活就自动恢复。

## 启动

项目根目录双击 `Start-RemoteSsh.cmd`，或运行：

```powershell
& 'E:\Projects\Remote\Start-RemoteSsh.ps1'
```

已生成的入口是 `windows-terminal\artifacts\app\RemoteSsh.Manager.exe`。要复制测试版，请复制整个 `app` 目录，不能只复制 exe。运行需要 .NET 10 Desktop Runtime、Windows Terminal（当前用户启用 `wt.exe` 别名）、Windows 系统 OpenSSH 客户端。当前电脑已安装这些依赖。程序目录可包含空格和中文，不支持分号。

重新构建需要 .NET 10 SDK：

```powershell
& .\windows-terminal\Build.ps1
```

本子项目没有第三方 NuGet 依赖，不需要访问包源。旧的 `terminal-bridge\LocalGui` 模拟器、`experiments\terminal-origin` 和原隔离候选继续保留；新入口不使用内嵌终端实验。

## 连接服务器

### 对话工作台

填写连接信息、通过可信渠道核对 `known_hosts` 并勾选确认后，点击“打开对话工作台”。该入口需要无需交互的 SSH 私钥。选择 Codex 或 Claude，填写远端项目目录和预期 VPS 出口 IPv4，明确勾选保存对话及远端输出、附件后发送。每轮先独占创建本机回执，启动请求只发送一次；工作台查询状态，按后端事件展示回复和工具操作。运行中周期性读取已保存输出，显示的是完整事件更新，并非逐字流式输出。

同一对话内，只有上一轮确认结束、输出完整且原生会话 ID 匹配后，才可发送下一轮。Codex 和 Claude 分别使用自己的原生会话，不能直接跨后端继承工具历史。选中已保存会话时，工作台会通过当前 SSH 连接自动查询最近三轮原任务；更早的输出可点击“查询状态”恢复。订阅会话可继续时还会自动检查原生登录状态。这些检查只读取原任务或状态，不会重发模型消息。旧版独立任务回执仍可查询，但不能转换成连续会话。关闭窗口不会停止远端任务。

上一轮运行中或状态未确认时，可以先编辑下一条草稿，但不能发送。不同对话及新建 Codex、Claude API、Claude 订阅的草稿分别保存在当前工作台窗口内；切换时不会带到其他后端，关闭窗口后未发送草稿和附件选择不会保留。为限制内存，所有未发送草稿的附件合计最多 20 MiB。

每轮最多选择 4 个普通文件，每个不超过 5 MiB、总计不超过 20 MiB。PNG、JPEG 和 WebP 图片作为原生图片输入；其他文件作为远端只读文件供模型按需使用，实际能否解析取决于格式和可用工具。附件先通过固定主机密钥的 SSH 上传并核对大小及哈希；上传未确认时该轮不会启动。对话内的附件保留在远端，后续轮次仍可读取，不会自动删除。

本机 `%LOCALAPPDATA%\RemoteSsh\ChatReceipts` 保存会话记录、消息文本、附件名称和每轮回执，不保存附件内容或认证密钥；远端 `~/.remote-ssh-chat/<会话 ID>` 保存附件和会话锁，原生会话由 CLI 保存在自己的配置目录中，任务状态和已捕获输出另行保存在远端任务目录。标准输出与错误输出各最多 256 KiB；截断或状态不明时不能自动继续下一轮。这些记录不会自动删除，不要发送不适合存储在本机或远端的信息。

新建 Codex 对话使用远端用户默认的 `~/.codex` 原生账号和会话目录，要求 `auth.json` 是该用户拥有的 `0600` 普通文件。新建 Claude 对话默认使用订阅原生登录，共用远端用户默认的 `~/.claude` 账号和原生历史；每个工作台对话使用独立的原生会话 ID。两者的账号分别登录，不互通。原生目录必须是用户拥有且不可被其他用户写入的普通目录，不接受符号链接、内部套接字或嵌套挂载。目录若允许所属组写入，仅在该组是当前用户专属主组、没有其他已知成员、身份来源可核对且目录没有扩展或默认 ACL 时允许；每次启动都会重新检查，不修改远端权限。Codex 启动时仍忽略用户配置文件以减少自定义网络配置影响；模型和工具仍可读取挂载的账号配置及历史。

- **订阅（个人自管试验）**：在远端 SSH 终端按“订阅登录步骤”运行原版 `claude auth login`，自行选择 Claude 订阅账号并完成授权。工作台给出的命令用 `env -i` 清除 SSH 等继承环境，并让 CLI 使用远端默认 `~/.claude`。已登录后可直接新建多个对话；发送前自动检查原生登录状态，检查失败不会创建或启动该轮任务回执。也可手动点击“检查订阅登录”。状态响应不包含账号、令牌或验证码，但“已登录”不证明订阅权限、令牌仍有效或模型请求成功。
- **API 密钥（保留路径）**：在 VPS 上以远端用户身份创建 `~/.config/remote-ssh/anthropic-api-key`，内容为密钥，文件必须是该用户拥有的普通文件且权限为 `0600`。本机工作台不接收或保存密钥；远端隔离进程会读取该文件，并通过环境变量交给 Claude CLI。API 使用可能产生费用。

新对话直接使用上述原生账号，无须先完成其他对话或点击复用按钮。不同对话可以使用不同项目与预期出口；设置在首轮发送前保存，未发送时切换或关闭窗口不会保留尚未提交的设置。各对话会话 ID 不同，原生配置和历史文件共用，任务程序及可用工具可以访问它们；这不是不同用户或恶意程序之间的强隔离。同一对话的远端锁会阻止同时提交，不同对话可并行；真实 Claude 订阅的并发令牌刷新尚未验证。

旧对话和回执保留原来的执行方式及配置目录，不会自动迁移到原生共享账号。旧版订阅对话仍可使用原有“复用账号新对话”及目录结构检查；检查发现异常会暂停，保留原数据和回执，不自动重发。自定义 `CODEX_HOME` 或 `CLAUDE_CONFIG_DIR` 不会自动导入，新建原生对话使用上述默认路径。真实 Claude 订阅及 VPS 上的新路径尚未验证。

工作台不会读取或复制账号凭据到本机。原生任务中的 CLI 可读写自身配置与令牌文件；账号历史、配置或项目本身如果含有本机 IP，工具仍可能读取到。

订阅登录命令是在普通 SSH 终端执行的原生程序，不经过模型任务的网络隔离；授权浏览器也走其自身网络。SSH 服务器、浏览器访问的网站及相关网络方可能看到各自连接的来源。订阅模型任务的允许域名包括 `api.anthropic.com` 和 `platform.claude.com`，登录浏览器及其他应用不受此网关控制。检查和隔离都不能保证 IP 不会被识别，也不能保证工作区内容不包含 IP 信息。

Anthropic 允许个人使用未修改的 Claude Code 自行登录，但对第三方产品提供 Claude.ai 登录和代用户使用订阅凭据有明确限制；正式对外交付应根据 [Claude Code 认证与合规说明](https://code.claude.com/docs/en/legal-and-compliance) 确认授权或使用支持的 API 密钥方案。登录及令牌存放机制参见[官方认证文档](https://code.claude.com/docs/en/authentication)。

工作台保留出口检查及进程、网络、宿主日志外层隔离；新原生模式显式挂载 CLI 自身的完整配置与历史，因此这些文件不受历史遮蔽。Codex 默认保留内层只读沙箱，Claude 默认仅启用只读文件工具并拒绝需要交互批准的操作。已知测试 VPS 不允许 Codex 嵌套沙箱，若需执行命令，可明确选择默认关闭的“仅外层隔离”：Codex 内层沙箱会关闭；Claude 则跳过其权限提示，两者均允许写入所选项目。新建对话或切换后端时该选项会重置为关闭，详见下方“非交互任务的隔离模式”。工作台尚无交互式权限提示或远端任务取消；SSH 仍为直连，VPS 和云平台可看到连接来源。

### 隐私启动 Codex

核对主机指纹后点击“隐私启动 Codex”，填入**独立核实的 VPS IPv4 出口地址**，可选填写预期 IPv6 地址。远端需要 Python 3、curl 和 `ip` 命令。它会在 VPS 上清除子进程环境中所有以 `SSH_` 开头的变量（忽略大小写），检查常见代理和服务地址覆盖环境变量，并向 ipify 与 icanhazip 各发起两次 IPv4/IPv6 查询，同时检查 `chatgpt.com` 和 `api.openai.com` 的系统路由。查询服务会看到所连接机器的出口地址；若目标实际上是本机或与本机共享出口，也会暴露该出口地址。进程只报告检查结果，不输出代理值或采集到的地址。

弹窗默认选中“通过本机 SOCKS5 中继连接 VPS”。填写仅监听本机 `127.0.0.1` 的免认证 SOCKS5 端口，以及**独立核实的该中继连接此 VPS 时的实际出口 IP**。示例端口是 7897，请按本机代理配置调整；程序不会替代理选择节点或更改它的规则。系统 OpenSSH 强制经该中继连接并继续严格核对主机密钥，代理失败不会回退直连。SSH 登录后、任何出口采样或 Codex 启动前，远端检查该次 SSH 的来源是否与预期中继地址一致，缺失或不一致则停止。VPS 防火墙也必须只允许该中继的单一地址，否则连接会被拒绝。

**这不是完整的来源隐藏保证。**代理服务本身能看到本机连接来源；若其规则把 VPS 流量设为直连，即使使用 SOCKS5 也可能暴露本机 IP 给 VPS。应独立确认预期中继地址确为所用代理的出口，不能把本机地址误填为中继地址。来源校验发生在 SSH 已连接后，因此不匹配的连接仍可能留在 VPS 日志中。旧 SSH 日志、其他进程、项目文件或提示词中可能早已有本机地址；此交互入口不会隔离或删除它们。托管任务窗口和普通 SSH 终端暂不支持此来源中继。

IPv4 四次采样必须全部等于填写的地址，两个服务域名的 IPv4 系统路由必须能查询。出现代理或常见服务地址覆盖变量、IPv4 不匹配、IPv6 路由状态不确定或检查不完整时不会启动；观察到 IPv6 出口或路由，或填写了预期 IPv6 时，还要求观察到 IPv6 路由且四次 IPv6 查询全部匹配。没有观察到 IPv6 出口和目标路由不代表系统完全禁用了 IPv6。检查通过后直接在远端登录目录启动 Codex，认证仍由 SSH 终端处理。

**检查范围有限：**它不能识别所有透明代理、Codex 配置中的自定义服务、其他 DNS 结果或网络策略，也不能证明某一次 Codex 请求的真实出口、服务商如何处理元数据或账号关联。普通 SSH 终端里手动输入 `codex` 不经过该入口，仍可能继承 `SSH_CONNECTION` 等变量；浏览器和其他本机应用也不受其保护。不要把密码、令牌或地址作为提示词发送。

1. 填写主机/IP、SSH 端口和远端用户名。支持 IPv4、IPv6、主机名及 `domain\user` 形式的用户名。
2. 选择认证方式。密钥模式选择本地私钥，口令在终端里输入；密码模式无需私钥，密码或键盘交互提示也由终端显示。
3. 选择已独立核对过的 `known_hosts` 文件并勾选确认。该文件必须存在。程序始终使用 `StrictHostKeyChecking=yes`，不会自动接受陌生或更换的服务器密钥。
4. 点击“打开 SSH 终端”。管理器的“已请求打开”仅表示启动请求；登录是否成功以终端中的实际 shell 为准。
5. 登录后进入远端项目目录，运行 `codex`。如 Windows SSH 默认进入 CMD，可先输入 `powershell -NoLogo`，再使用 PowerShell 命令。

例子（在远端 Ubuntu shell 中，将路径替换成实际目录）：

```sh
cd /path/to/your/project
codex --version
codex login status
codex
```

远端尚未安装时，按 [OpenAI Codex CLI 说明](https://learn.chatgpt.com/docs/codex/cli) 安装。无浏览器的远端可使用 `codex login --device-auth` 并自行完成浏览器登录；该功能可能需要先在 ChatGPT 安全设置中启用，详见 [OpenAI 认证说明](https://learn.chatgpt.com/docs/auth)。不要在聊天里发送登录码、认证链接或登录缓存；本项目不会复制本机 `~/.codex/auth.json`。ChatGPT 登录按账户和套餐的使用限制计量，API 密钥登录采用不同的 API 计费路径。现有 Ubuntu VPS 的 Codex CLI 0.166.0 已完成设备登录，真实模型在临时目录中的文件读取和写出测试通过，详见 [验证记录](VALIDATION.md)。

设备登录第一次等待的原因尚未确认；重新发起设备授权后，远端终端显示成功，`codex login status` 也确认使用 ChatGPT 登录。未来如果需要重新授权，在远端运行 `codex login --device-auth`，按该次终端提示在浏览器完成设备授权，并以远端终端显示的结果和 `codex login status` 为准。VPS 已停止并解除分配，原 SSH 入站规则已恢复；重新连接前需检查虚拟机状态和允许的来源地址。

2026-11-15 在真实 VPS 上使用远端伪终端完成了两轮自动化 Codex 模型对话；从本机 Windows Terminal 由用户实际操作的交互流程仍需单独验收。两家服务的 IPv4 采样均与预期地址一致，IPv6 查询未取得结果；具体范围见 [验证记录](VALIDATION.md)。

### 非交互运行 Codex

脚本非交互调用 `codex exec` 且不需要额外标准输入时，应使标准输入到达 EOF；否则 Codex 可能一直等待输入，连启动事件都不会出现。Linux 远端示例：

```sh
codex exec --sandbox read-only '概述当前目录' </dev/null
```

从本机通过 SSH 执行无需标准输入的一次性命令时，可以在保留主机密钥检查和认证参数的前提下使用 `ssh -n -T`。如果需要通过管道向 Codex 传入上下文，应在写入完成后关闭标准输入，不能使用 `-n` 或重定向到 `/dev/null`，否则输入不会传入。连接管理器启动的是交互式 `ssh -tt`，需要保持输入，上述无输入设置不适用于它。相关行为见 [OpenAI 非交互模式说明](https://learn.chatgpt.com/docs/non-interactive-mode)。

### 非交互任务的断线恢复

在连接管理器填写目标和密钥、核对并勾选主机指纹后，点击“远端任务与恢复”：

1. 为新任务选择一个**不存在的**本机 JSON 回执路径；回执的父目录必须已存在。若要恢复查询，选择先前的回执。
2. 填写远端程序及参数，每行一个参数；可指定远端工作目录和状态目录。直接填写名为 `codex` 的程序时，必须启用出口检查并填写预期 IPv4，且默认勾选进程、网络和日志隔离；隔离模式还必须填写远端项目目录。其他程序也可选择出口检查。按需勾选保存输出，才能在任务结束后读取检查详情。
3. 点击“开始新任务”。窗口先独占创建回执并刷盘，再发送一次启动请求，随后只读查询状态。已有回执不能在界面中作为新任务启动。
4. 断线或重新打开管理器后，选择原回执并点击“重连并查询状态”。查询会使用新的 SSH 连接，最多重试三次，**不会重新发送启动命令**。需要时可分别读取已保存的标准输出和标准错误。Codex 进程退出码为 0 不代表模型调用的每条命令都成功；需检查实际输出与操作结果。

例如远端程序填 `/home/remoteuser/.local/bin/codex`，工作目录填项目的 Linux 绝对路径，参数区每行依次填写 `exec`、`--json`、`--skip-git-repo-check`、`--sandbox`、`read-only` 和提示词。请按远端实际安装位置及项目权限调整。该方式运行的是非交互 `codex exec`，不是交互式 Codex 终端；需要人工确认的操作不适合此方式。

### 非交互任务的隔离模式

勾选“隔离进程、网络和日志”后，远端使用无特权的 bubblewrap 创建独立进程、网络和挂载命名空间，以及临时 HOME。它只以读写方式挂载所选项目，以只读方式挂载必要的系统程序、库、证书、Codex 可执行文件及其已知的同目录辅助程序和远端用户已有的 `~/.codex/auth.json`；原用户目录、SSH 进程、宿主网络连接表和常见日志目录不直接挂载。bubblewrap 配置隔离网络后，任务以无额外能力的用户运行；隔离建立失败不会退回普通模式。

联网必须经过受限代理，当前只允许 HTTPS CONNECT 到 `chatgpt.com:443` 和 `api.openai.com:443`；其余目标、直连和 DNS 不可用。这可能阻止登录刷新、模型请求、Git、依赖下载或其他网络操作，失败不会自动放宽。仅支持已登录 ChatGPT 的私有常规 `auth.json` 和独立 Linux ELF 版 `codex exec`；不读取宿主 Codex 配置，临时 HOME 中的新会话、配置与缓存不会保留。认证文件对沙箱中的 Codex 及其执行的程序可读，不能当作凭据隔离。启用输出捕获时，任务监督器仍会在宿主状态目录保存截断后的输出。

项目必须是远端用户拥有的现有绝对目录，不能是整个 HOME、系统目录或 `.ssh`、`.codex`、`.local`、`.config` 等私有目录。程序拒绝项目中已有的嵌套挂载、套接字、管道或设备，并将检查限制在 20 万项；并发修改仍存在检查时序风险。项目是**可写**的，模型可读取或更改其中的内容，项目文件和提示词里原有的本机 IP 仍可能被看到。

2026-11-15 的真实测试 VPS 中，隔离版 Codex 通过出口检查并取得模型回复；但默认的内层 bubblewrap 在模型尝试执行命令时被 VPS 拒绝，命令失败。Codex 进程本身仍以 0 退出，因此不能据此判断命令执行成功。

管理器提供默认关闭的“仅用外层隔离”选项，必须先启用进程、网络和日志隔离并填写项目目录。**此选项关闭 Codex 的内层文件系统和网络沙箱，选定项目可写**；程序会显式传入 `--sandbox danger-full-access`，不会自动从默认双层模式切换，也不接受另行指定的沙箱、自动批准或配置覆盖参数。外层 bubblewrap 仍约束进程、网络和挂载，但 Codex 与其执行的程序共享临时 HOME、只读认证文件及代理入口，不能视为凭据或任务内部进程隔离。仅在信任所选项目和任务时使用。真实 VPS 已使用等效参数完成一次临时文件的创建与读取；管理器选项本身只经过本地自动验证。

若任务未勾选保存输出，退出信息不会保存在远端，查询状态仍可看到进程退出码；启用输出捕获前请考虑其敏感内容可能保留在远端状态目录。隔离建立失败不会退回普通模式。

它不隐藏 VPS、代理、SSH 服务和云平台看到的连接来源，也不能消除账号关联、内核漏洞、证书及其他元数据风险。托管任务使用直接 SSH，若需要保护 VPS 自身看不到本机来源，还需另行配置并验证中继。隔离模式需要 `/usr/bin/bwrap`、Python 3 和可用的用户及网络命名空间；原有出口检查还需要 `ip` 和 `curl`。不自动安装软件或修改系统配置。

Windows 本机需要可从 `PATH` 找到的 Python 3、系统 OpenSSH 客户端和无需交互的私钥认证；Linux 远端需要 Python 3。所有新托管任务的子进程都会清除 `SSH_` 环境变量，这可能影响依赖这些变量的程序。出口检查在远端任务中运行，`accepted` 不表示检查已经通过。通过 shell、脚本或其他程序间接启动 Codex 时，程序无法自动识别，需主动勾选检查或传入 `--privacy-ipv4`；命令行直接启动名为 `codex` 的程序时也必须指定该参数。任务脚本使用指定的 `known_hosts` 严格检查服务器密钥，禁用密码提示和 SSH 代理；不能代替需要输入密码、密钥口令、确认提示或交互输入的终端。界面将任务参数通过本机进程的标准输入传递，不把命令写入回执；远端操作系统仍可能向具有相应权限的进程显示运行参数，不要把密码或令牌作为任务参数。

发布目录中的 `RemoteTaskStart.py`、`RemoteTaskStatus.py` 和 `RemoteTask.py` 也可从命令行显式启动和查询非交互任务。

下面的 PowerShell 示例只供替换成实际参数后运行；本机回执父目录和远端工作目录必须已存在，远端 Codex 路径也需按实际安装位置修改。为每项新任务使用新的回执路径：

```powershell
cd E:\Projects\Remote\windows-terminal\artifacts\app
$remoteArgs = @('--host', 'VPS_IP', '--user', 'remoteuser', '--identity', 'C:\path\identity.pem', '--known-hosts', 'C:\path\known_hosts', '--receipt', 'C:\path\task-receipt.json')
python .\RemoteTaskStart.py @remoteArgs --isolate-workspace '/home/remoteuser/project' --capture-output --privacy-ipv4 'VPS_OUTBOUND_IPV4' -- /home/remoteuser/.local/bin/codex exec --json --ephemeral --skip-git-repo-check --sandbox read-only 'Summarize this directory.'
python .\RemoteTaskStatus.py @remoteArgs
python .\RemoteTaskStatus.py @remoteArgs --output
python .\RemoteTaskStatus.py @remoteArgs --stderr
```

若要明确选择仅外层隔离，在上面的启动命令中加入 `--outer-only`，并移除 `--sandbox read-only`；该选项要求 `--isolate-workspace`，使项目可写。不要把它理解为只读模式或凭据隔离。

启动前，客户端将任务 ID、主机、端口、用户和可选状态目录写入本机回执并刷盘，不记录命令、密码或私钥；文件权限由所在 Windows 目录继承。界面只为不存在的回执创建新任务；命令行版本接受已有回执并复用其中的 ID。目标与回执不一致时拒绝发送。启动请求只发送一次，即使 SSH 返回不确定也不会自动重放。断线后使用原回执查询；状态查询最多重试三次，只读取状态，不启动任务。

远端默认把任务记录保存在 `~/.local/state/remote-ssh/tasks`。只要使用同一台服务器、同一远端用户和完整保留的同一个状态目录，相同任务 ID 即使并发提交也最多启动一次；重复提交返回 `already_exists`。不要为了消除未知状态而换 ID 或删除记录：更换服务器、用户、状态目录，删除记录，或任务自身重试，都不在这一保证内。该机制无法追踪此前启动的交互会话，也不保证远端命令的外部事务只发生一次。

`accepted` 只表示已接收启动请求；`running` 表示查询时监督进程与任务进程的身份均可确认；`finished` 及其 `exit_code` 只表示直接启动的进程已退出，不能证明子孙进程或外部操作已经完成。`unknown`、`not_found` 或连接失败都不能证明任务没有运行或可以安全重试，应结合远端状态和操作对象核查；`launch_failed` 表示直接进程未能启动。重启或关闭 VPS 可能中断任务，状态仍可能未知。

默认不保存命令输出；显式指定 `--capture-output` 时，远端分别保存标准输出和标准错误的前 256 KiB，并标记截断；可按上例分别读取。输出可能包含敏感内容，记录和输出会留在远端状态目录，不会自动删除。保留状态记录是阻止同一 ID 重复启动的必要条件。

### 第一次准备 known_hosts

本测试版不提供自动信任登记。可在本机正常终端中用系统 SSH 的首次连接提示登记，但必须先通过 VPS 控制台等独立可信渠道获得服务器指纹，在提示时逐字核对。下面仅为人工操作模板，请替换地址、端口、用户名和路径：

```powershell
& "$env:WINDIR\System32\OpenSSH\ssh.exe" -F NUL -o StrictHostKeyChecking=ask -o 'UserKnownHostsFile="C:/Users/YourUser/.ssh/remote_known_hosts"' -o GlobalKnownHostsFile=NUL -o UpdateHostKeys=no -p 22 -l remoteuser VPS_ADDRESS
```

该路径的父目录应已经存在；选择 `yes` 会写入主机信任记录。`ssh-keyscan` 的结果本身不能证明服务器身份。主机密钥变化时先调查，不要通过关闭校验解决。

私钥及 known_hosts 路径支持空格、中文。拒绝相对路径、通配符、百分号/波浪线等会触发 OpenSSH 展开的路径。若 SSH 报私钥权限过宽，应修正该私钥的访问权限；程序不会修改现有私钥的 ACL。

### 连接与出口 IP 检查

- 管理器的“测试连接”对填写的主机和端口做三次 DNS 与 TCP 检查，展示检查时的目标、解析结果和 TCP 建连耗时。每次最多对 8 个解析地址错峰发起连接，首个成功后取消其他尝试；DNS 和 TCP 分别有超时。如果检查期间修改了目标，会提示重新检查。它不会验证 SSH 主机身份或登录，TCP 探测方式也不等同于 OpenSSH 的地址选择；返回相同地址不证明 IP 长期固定。TCP 探测会在目标服务器产生连接记录。
- SSH 使用 `ServerAliveInterval=30` 和 `ServerAliveCountMax=3`；服务器长时间没有响应时 OpenSSH 会断开。断线不等于远端任务停止，最后的输入可能已部分送达。程序不会自动重连或重发；重新打开后先检查远端任务状态。
- 若需要检查 VPS 的对外地址，将本目录 `Probe-RemoteEgress.ps1` 和 `EgressProbe.psm1` 一同复制到 VPS，再**在 VPS 的 PowerShell 中**运行：

  ```powershell
  .\Probe-RemoteEgress.ps1 -IAmRunningOnVps
  # 例如隔 60 秒采样 10 轮：
  .\Probe-RemoteEgress.ps1 -IAmRunningOnVps -Samples 10 -IntervalSeconds 60
  ```

  脚本会向 ipify 与 Cloudflare 的 IP 查询服务发送 HTTPS 请求，分别采样 IPv4 和 IPv6；服务方能看到发起请求的出口地址。结果只输出在当前终端，不由脚本保存。查询失败标为不完整，不能推断 IPv6 已关闭；两家服务结果不同提示检查代理或路由。脚本使用 PowerShell 自身的网络配置，Codex、登录浏览器以及其他目标可能使用不同代理或线路。
- 对 Ubuntu 等 Linux VPS，将 `Probe-RemoteEgress.py` 复制到远端后运行 `python3 Probe-RemoteEgress.py --on-vps`；使用 `--samples 10 --interval 60` 可以在每轮之间等待 60 秒，共采样 10 轮。需要远端已有 Python 3 和 curl；脚本不会安装软件或修改代理。
- 如已知实际预期的 VPS 出口地址，可以把下面的 `EXPECTED_IPV4` 替换为该地址后运行；如需单独核对 IPv6，可使用 `--expected-ipv6`，也可同时指定两个参数：

  ```sh
  python3 Probe-RemoteEgress.py --on-vps --samples 10 --interval 60 --expected-ipv4 EXPECTED_IPV4
  ```

  查询失败、同一服务的地址变化、同轮服务间不一致或与预期地址不同，脚本都会立即提示并继续采样。所有指定地址的两家服务每轮均成功且匹配时退出码为 `0`；发现不匹配时为 `1`；没有发现不匹配但采样不完整时为 `2`。参数错误也返回非零。只指定 IPv4 不会核对 IPv6；这些结果仅覆盖查询服务收到的请求，不阻断流量，也不证明 Codex、登录浏览器或其他程序走同一路线。未指定预期地址时保留原有退出行为：只要任一查询成功就可能返回 `0`，即使观察到变化或分歧；不能据此认定出口稳定。
- 若暂时不知道预期地址，也可使用 `--require-consistent-ipv4` 和/或 `--require-consistent-ipv6`：所选地址族必须在所有采样轮次中均由两家服务成功返回同一个地址，完全一致退出 `0`，观察到变化或不一致退出 `1`，没有不一致但采样不完整退出 `2`。可与 `--expected-ipv4` / `--expected-ipv6` 一起使用，此时所有指定条件均须满足。短时间一致不代表长期固定，也不证明这个地址是预期出口。
- 在远端启动并登录 Codex。若登录链接在本机浏览器打开，浏览器请求可能使用本机网络；与远端终端本身是两条不同路径。本机的 Codex 应用也不会因为 SSH 而自动使用 VPS 出口。请根据实际部署核查登录和浏览器流量，不要将查询结果当作防泄漏保证，也不要分享登录码或认证链接。
- Azure 的入站公网地址、VPS 实际对外出口和本机公网地址可能不同。静态公网 IP 或 NAT Gateway 等配置需以 Azure 实际网络资源为准；不要只根据一次采样判断已经固定。修改 Azure 网络、开放端口或启动计费资源之前，应先确认当前配置和成本。

## 无 VPS 时的本机体验

双击项目根目录 `Start-LocalSshDemo.cmd`。它会构建测试程序，在 `127.0.0.1` 随机端口启动一次性 SSH 服务，创建临时密钥和对应主机记录，再打开已填好参数的连接管理器。核对这是脚本显示的本机目标后，勾选确认并打开 SSH。

这是模拟 shell，不是 Codex。可以测试：

- 使用真实拼音输入固定文本 `中文输入测试` 后回车，确认 `MOCK-ECHO` 回显一致。
- 输入 `keys`，按右方向键选择拒绝，Tab 检查按键，Enter 单独确认。仅输出模拟标记，不执行任何操作。
- 调整窗口大小，再输入 `size`。
- 输入 `quit` 正常退出；输入 `fail` 模拟非零退出并查看保留的错误。

演示结束会生成 `windows-terminal\artifacts\desktop-verification.json`。它只保存认证、PTY、固定测试标记、尺寸、退出码和清理结果，不保存终端会话正文、密码或私钥。未操作的项目会标记为未观察到；报告不能证明真实拼音组合过程和屏幕显示正确，这两项仍需你确认。

清理记录只覆盖测试服务器、远端测试进程、监听端口和临时密钥。如果 SSH 错误终端停在“按任意键关闭”，请读完错误后按键关闭该窗口。

演示只支持一次连接，退出后重新启动脚本可再次测试。正常结束、Ctrl+C 或 20 分钟超时会清理它创建的服务和临时密钥。不要强制结束整个 Python 进程；任何进程强杀都可能绕过 Python 的文件清理，需检查系统临时目录中的 `remote ssh-*` 目录。管理器关闭不会关闭真实用户会话；演示脚本则会在管理器关闭后清理自己专属的本机测试服务。

## 验证

```powershell
& .\windows-terminal\Test.ps1
```

自动测试使用项目 `.venv-ssh-loopback` 内的 Python、Paramiko 5.1.0 和 cryptography；只连接 127.0.0.1。生成的测试私钥仅授予当前用户访问，结束后删除。测试两端均使用 Windows ConPTY，但服务端为 Paramiko 测试服务器，不能代表真实 Windows OpenSSH 服务端。

若启动脚本报告配置自检失败，具体输出保存在 `windows-terminal\artifacts\configuration-tests.log`。可单独运行 `powershell -NoProfile -File .\windows-terminal\Test.ps1 -CheckOnly` 检查构建和配置；该选项不打开窗口、不启动 SSH 服务。已修复 Windows PowerShell / CMD 使用代码页 936 时误读 OpenSSH UTF-8 路径、使中文路径断言失败的问题。

测试包括配置与系统 SSH 参数解析、认证方式、严格主机密钥、中文传输、Win32 输入模式下的按键、远端尺寸、退出码、错误保留，以及进程/端口/临时密钥清理。程序化中文输入不能代替真实输入法验收；复杂输入法场景以及真实 VPS 上的长期交互和复杂任务仍需单独验证。具体本次结果见 `VALIDATION.md`。

测试还覆盖 TCP 回环的接通/拒绝/取消、SSH 意外断线提示，以及 Windows 和 Linux 出口采样的纯模拟结果；不会在本机测试时请求公网 IP 服务。Linux 脚本的单元测试为 `python -B -m unittest -v Tests\test_remote_egress.py`。

如本机有 WSL Ubuntu 24.04 和 Python 3，可运行 `powershell -NoProfile -File .\windows-terminal\Test.ps1 -ManagedLinux`，追加一次 Windows OpenSSH → 本机临时 SSH 服务 → WSL Linux 的托管任务测试；它会丢弃启动回包并验证只读查询和防重复。使用其他已安装的 WSL 发行版时，可将环境变量 `REMOTE_TEST_WSL_DISTRO` 设为对应名称。测试只使用一次性密钥、回执和临时 Linux 目录，不连接 VPS。

要同时运行管理器窗口组件测试，可使用 `powershell -NoProfile -File .\windows-terminal\Test.ps1 -ManagedLinux -ManagerGui`。它在不激活窗口的离屏环境中检查默认和最小尺寸、按钮状态及任务恢复流程，并将布局图片与测试结果写入 `test-artifacts\manager-gui-auto-*`。该组件测试用固定选择结果代替系统文件选择对话框，不代表已经测试真实鼠标、键盘或原生文件选择窗口。

Windows Terminal 命令行使用官方 `new-tab` 启动程序的机制，参考 [Microsoft 文档](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments)。配置用单个编码参数传递，避免 Windows Terminal 的分号命令分隔规则误解析文件路径；编码不用于加密，参数中没有密码或私钥内容。
