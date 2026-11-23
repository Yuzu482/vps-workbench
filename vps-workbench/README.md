# VPS 工作台

Windows 独立应用。「VPS SSH」和「本机 SDK」共用对话、项目资源库、设计画布、工作流和设置。两种位置各自绑定配置、执行端和会话回执。

[部署教程](docs/deployment.md) · [交给模型的安装提示词](docs/installation-prompt.md)

## 启动与导入

打开发行目录中的 **VPS Workbench.exe**。整个发行目录可以复制到其他位置。运行需要 Windows x64。VPS SSH 使用 .NET 10 Runtime、Windows OpenSSH 和 Python 3.11。Python 默认检测当前用户的 Python 3.11 安装目录，也可通过 VPS_WORKBENCH_PYTHON 指定完整的 python.exe 路径。

- 从「设置 → 连接」保存 VPS SSH 配置并核对主机指纹，或为本机 SDK 登记工作目录和模型。
- 在顶部「本地项目 → 添加目录…」登记目录。应用本机保存归类关系。
- 首次使用可在 VPS SSH 历史中从「文件 → 导入 DSH 对话数据…」选择原来的 vps-chat-workbench 数据目录。导入会复制连接预设、已存对话、回执和中继配置。导入前请等原工作台完成写入。两个工作台随后各自维护本机记录。

独立应用的数据默认保存在 **%APPDATA%\VPS Workbench**。本机项目、界面偏好和设计画布编辑由独立应用保存。设置和项目列表分别使用 `preferences.json.bak` 和 `projects.json.bak` 保存最近成功提交的副本。启动时可从有效备份恢复，并保留损坏的原文件。原 DSH 的项目列表、设计草稿和界面偏好单独保存在原客户端。

标题栏左侧提供会话侧栏与「文件」「编辑」「项目」菜单。留白处用于拖动窗口，右侧沿用 Windows 窗口按钮。上下方向键选择菜单项，左右方向键切换栏目，按 Esc 返回触发按钮。

左下角可切换 VPS 执行端或打开「设置」。登录入口、检查状态和模型配置位于「模型与账号」。侧栏上方可新建聊天，输入栏内的模式菜单用于切换对话和设计。

会话列表里的项目文件夹可展开。通过侧栏或「项目」菜单打开项目资源库，可按本地项目和资源类型筛选当前执行端已保存的画板、代码块和内嵌图片，并打开来源会话。画板打开时会恢复对应版本和画板。

在设计工作台选择子版，再点「对比来源版本」。两栏共用缩放倍率，按画板查看新增、移除和修改。图层变化会标在预览与列表上，样式表等整体变化在画板级提示。可从任一侧勾选画板，按勾选顺序带入本机新版本。原型连线随两端画板一起带入。新版本可编辑、导出和继续对比，使用模型 Fork 时请选择模型生成的版本。

在对话消息里选中文字后右键选择「添加到对话」。引用在输入框上方显示为一行，可移除，随下一条新消息发送。会话右键可复制对话链接，消息右键可复制轮次链接，或一起复制所选文字和链接。链接只包含定位原记录所需的标识。可从「文件 → 打开对话链接…」粘贴打开，也可手动将 Windows 链接关联到当前程序。另一 Agent 需要内容时，可粘贴明确选中的文字。

按 `Ctrl+K` 或点标题栏的放大镜打开本地全局搜索。搜索已保存的消息和回复、项目、画板正文与版本、工作流，以及本机已读取过的产物名称和小型文本预览。结果按本机 SDK 或 VPS SSH 配置分组。点击结果可在本机查看命中的记录。消息和画板可进入原会话或画布，工作流可打开编辑页，产物可回到原运行阶段。搜索使用本机保存的快照，不连接 VPS 或调用模型。没有缓存的远端产物需要先从原运行读取。

输入栏的「访问权限」提供「仅浏览」和「VPS 执行」。仅浏览时可读取本机历史和资源，发起远端操作需切换为 VPS 执行。Codex 和 Antigravity 可对之后发送的消息选用执行端默认、强制只读或隔离项目文件。强制只读挂载原项目，隔离项目文件挂载空的只读目录。其他执行端按各自的沙箱或终端权限运行。

Codex 转场的 01 字层按窗口像素准备一次，展开与主题替换由同一个时间轴控制。Claude 染色对扩散前沿使用模糊滤镜，细枝和液滴用矢量路径和局部渐变绘制。

Antigravity 的周期表随可用宽高等比缩放。转场中调整窗口大小时，工作台直接显示切换后的完整界面。

可从「文件 → Language / 界面语言」或「设置 → 应用偏好 → 外观」切换简体中文和英语。选择即时保存，对 VPS SSH 和本机 SDK 共用。首批覆盖主界面、对话、常用设置、搜索与接入向导。模型输出、会话正文和项目名称保留原文。

## 本机 SDK

标题栏下方的两个位置按钮用于打开各自的历史。「新建位置」决定下一次从侧栏点新建对话时使用哪个位置。紧凑设计画布可从「文件」菜单访问这些操作。设置里的位置按钮只切换配置页。已存在的会话沿用创建时的配置，VPS 会话的 SSH 指纹和中继要求继续生效。

在「设置 → 连接 → 本机 SDK → 本机配置」登记 Windows 上的只读工作目录、模型和推理档位，并可指定新聊天默认配置。Codex 使用官方 SDK 和 CLI 0.166.0。在「模型与账号」保存有权使用的本机 OpenAI API 密钥，也可通过可信启动器注入 `VPS_WORKBENCH_LOCAL_CODEX_API_KEY`。连接页的「测试本机配置」核对本机运行文件、凭据配置和内置模型目录，「试跑模型」使用已选配置检查实际响应。

本机 Codex 请求使用官方 OpenAI API 端点和 Windows 网络。子进程使用私有 Codex 状态、受限环境与 Windows 只读沙箱。系统级管理策略继续适用。本机配置、SDK 原生线程与回执在工作台数据目录的 `local-sdk/` 中，凭据只在本机进程中传递。SSH 连接与导入继续使用原有会话目录。

本机支持流式 Markdown、停止、重新打开历史、项目分类、资源导出、画板版本与分支、提示词模板和 Agent 预设。对话可选择 Codex 模型、推理档位和输出详略。个人和项目自动记忆按本机配置启用，提炼模型可单独选择。停止会取消本机 SDK 流，缺少终态回执时可查询原轮。

本机 Codex 工作流可在阶段中选择不同模型。已授权的工作目录文件和附件以资料提供，阶段回复可以从产物列表下载。MCP 使用已有的本机 HTTP 服务，注册时填写回环地址和允许调用的工具。启用前核对服务的实际权限。

### 本机 Claude Agent SDK 和 Antigravity ACP

在「设置 → 连接 → 本机 SDK → 注册本机配置」选择执行端和只读工作目录。登记后可从侧栏执行端菜单切换。Claude 和 Antigravity 使用账号默认模型，聊天、补充指令和工具审批复用工作台界面。设计画布、工作流和自动记忆继续使用本机 Codex 配置。

Claude 使用官方 TypeScript Agent SDK 0.3.296 和对应 Windows x64 CLI。在「模型与账号」输入本机 Anthropic API 密钥，或由可信启动器提供 `VPS_WORKBENCH_LOCAL_CLAUDE_API_KEY`。补充使用 SDK 流式输入。SDK 若把补充交给后续响应，回执会显示「已在后续响应生效」。 [Claude SDK 流式输入](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

Antigravity 使用官方 Windows CLI，可由工作台按需安装。也可通过可信启动器提供 `VPS_WORKBENCH_LOCAL_AGY_EXE` 和对应的 `VPS_WORKBENCH_LOCAL_AGY_SHA256`。在「模型与账号」选择配置并点击「在本机登录 Antigravity」。连接检查显示运行文件状态，服务接入以用户主动触发的试跑为准。 [Antigravity CLI 接入](https://antigravity.google/docs/ide/extensions/acp/)

原生账号数据和会话回执按执行位置、后端与配置绑定。工具审批只允许本轮读取所选目录中的合规普通文件。拒绝、取消或失去原回执时保留对应状态。真实 Windows 安全边界与账号出口需在接入时单独验证。

### 项目接入与验收流程

从 Git 检出工作台后，在仓库根目录运行以下命令。依赖缓存齐全时，三条 `npm ci` 命令均可追加 `--offline`。

```powershell
npm ci --ignore-scripts --prefix vps-workbench
npm ci --ignore-scripts --prefix remote-workbench/vps-chat
npm ci --ignore-scripts --prefix dsh-terminal-workbench/client/browser-test
npm run verify:local-agents --prefix vps-workbench
npm run preview:local-agents --prefix vps-workbench
```

验证入口检查三种本机执行端的会话绑定、线程恢复、补充与审批，并用浏览器夹具走一遍真实界面操作。预览在 `http://127.0.0.1:47828/` 登记三个演示配置，默认打开本机 Claude。发送「请等待补充并演示审批」可检查补充输入和审批卡。演示数据临时保存，模型回复由离线夹具生成。

Codex 和 Claude 的 SDK 与 Windows CLI 版本由锁文件和打包检查固定。Antigravity ACP 的执行文件及 SHA-256 由可信本机启动器提供，工作台逐次校验。实际账号配置及会话随各自的数据目录复用。API 密钥、登录目录和会话记录保存在各自的执行环境。需要验证 Windows 包时，可按「构建」部分暂存候选和运行桌面回归。

## VPS 连接

「设置 → 连接 → VPS SSH」提供独立的「保存连接配置」和「测试连接」。预检依次核对 SSH 与主机指纹、预期 VPS 出口、账号与模型目录。「接入向导」复用这些检查，并提供额外 Agent 资源检查。账号操作在 VPS 上打开。需要确认模型服务时，点「试跑模型」来发送一轮独立的诊断对话。试跑消耗所选账号的额度。结果不明时，可用「查询原回执」核对。

在「VPS 接入向导」开始检查后，「VPS 后端安装」会通过已核对主机指纹的 SSH 连接识别系统、架构和前置依赖。勾选需要的执行端，再点「安装所选执行端」。运行时由 VPS 下载并校验，安装只使用当前 SSH 用户的权限，已有登录、配置和会话继续使用。状态不明时，重新检查后点「查询原安装」。安装完成后可重新检查账号和模型目录。Linux 依赖与系统要求见 [VPS 后端安装说明](vps-package/README.md)。

可以选一个已有的 Agent，核对它引用的 MCP 脚本、提示词模板和记忆模式。检查结束后可直接运行「接入示例 · 读书会活动页」。示例用选定的执行端和模型，使用内置角色与独立上下文，运行两阶段的小型文字任务。实际的模型响应和订阅权限以该次运行结果为准。

「模型与账号」按 VPS 执行端管理模型、推理强度和账号。「应用偏好 → 按执行端覆盖」管理执行端的界面与交互偏好。各页的重置操作仅作用于对应的设置。

独立应用继续验证 SSH 指纹和 VPS 出口。未启用中继的直连预设走兼容执行桥。配置 `conversations/ssh-relay.json` 时启用中继。独立版在同一数据目录记录中继要求，重启和导入后继续检查配置。配置缺失、无效或中继不可用时，远端操作会停止并显示错误。

模型账号、订阅凭据与 API 密钥由 VPS 环境管理。「执行端」的独立设置会说明各工具支持的工作台功能。Claude 原生订阅终端和 Claude 订阅 SDK 在工具配置中分别提供。Claude API 使用中继执行时，需要满足现有中继执行桥的 LUKS2 存储校验。

流式回复复用相同的会话快照。状态查询遇到临时断连时会自动重试原任务，消息发送保持原来的操作记录。较长的回复在 Web Worker 中解析 Markdown，界面以最新收到的内容为准。设计模式缓存当前版本的画板，编辑只重建受到影响的画板。

新建 Antigravity 对话使用 VPS 上的官方 `agy acp`。用 Antigravity 专用配置登录 Google 后，可以在工作台查看流式回复、停止生成和续聊。可用的思考档位由 ACP 会话提供。既有 Antigravity 对话沿用其原来的会话绑定。项目文件保持只读，工作流继续使用阶段的文件授权和专用输出目录。 [Antigravity ACP 文档](https://antigravity.google/docs/cli/acp)

Antigravity 聊天生成时可以补充指令。针对已挂载只读工作区的普通文件读取和目录查看，工作台核对工具及目标后自动允许一次。命令、写入、网络、MCP、敏感路径及无法核对的操作继续显示工具审批，可允许一次或拒绝。手动审批与补充指令使用原轮次的回执核对。等待审批时可以保留草稿或停止本轮，处理审批并恢复生成后可以继续补充。

在画板上右键选择「迭代此图层」，也可从图层批注发起迭代。发送时保存当前画板版本，回复完成后仅将通过检查的文字与样式属性应用到该图层，并在版本图中创建子版本。修改布局或添加其它组件时可使用「迭代此画板」。校验未通过且原图层仍可用时，可点「按校验反馈重试」，在原图层范围内编辑草稿后发送。画板的编辑和批注按版本保存，受本机数据大小限制。

## Agent 预设

在「设置 → Agent 与工具 → Agent 预设」新建或编辑角色。每个预设由「执行端」和「角色指令」模块组成，按需添加「输出规范」，例如要求用表格列出结论和证据。可以使用执行端默认模型，也可以从当前 VPS 读取目录后选择指定模型。Antigravity 的模型目录来自 VPS 上已登录的 ACP 会话。

在工作流中选中阶段，从「套用 Agent 预设」选择已保存的角色。工作台把模块组合成该阶段的执行端、模型和指令，可以继续自定义该阶段，再点「保存工作流」。输出规范会附加到角色指令，共用阶段指令的 1200 字符上限。修改预设后，重新套用即可将新配置用于阶段。

旧版预设会在读取时换成模块格式。首次保存预设变更会写入新版记录并保留旧版记录。模块配置由工作台内置解析器处理，模型执行和权限检查由原有 VPS 通道负责。

在预设或工作流的「Agent 资源」里可选择已启用的 MCP 服务、提示词模板和记忆模式。MCP 服务适用于 Codex 和 Antigravity 阶段，并绑定其执行端和 VPS。提示词模板按选中的版本和标题加入该阶段的指令。套用预设会复制选项，之后可在阶段内调整。阶段开始时会核对选中的资源是否仍然可用。

## 跨执行端工作流

需要本机与 VPS 协同时，在工作流各节点填写「执行位置」「执行配置」和模型。混合运行支持已登记的本机 Codex、Claude Agent SDK、Antigravity ACP 和已保存的 VPS SSH 连接。本机 Claude 与 Antigravity 节点沿用对应账号的默认模型，在独立会话与私有任务目录中接收简报、获准交接和阶段附件，并交付文本。启动时填写任务、验收标准和约束，逐条确认跨配置连线允许传递的字段。已确认但未勾字段的连线只等待上游完成。

在本机 Claude 或 Antigravity 阶段的「阶段文件授权」中选取附件，并保存工作流。只向明确授权的阶段提供快照，每阶段最多 8 个、共 512 KiB。支持 UTF-8 文本和 PNG、JPEG、WebP 图片。ACP 图片需要执行端声明支持。其他二进制格式会标为无法读取。盲审继续使用启动时填写的证据。跨配置连线只传经确认的文本字段，接收阶段需要附件时须单独授权。

在「设置 → Agent 与工具 → MCP 服务器」为本机 Claude 或 Antigravity 配置登记并启用已有的回环 HTTP MCP 服务。然后在节点的「阶段 MCP 工具授权」逐项选择。工作台在本机为每轮建立独立入口，按阶段筛选工具目录并校验每次调用。暂停、停止或撤销授权后入口拒绝新的调用。跨配置连线只传已确认的文本字段。盲审继续只使用指定证据。

本机 Claude 和 Antigravity 工作流目前支持 Streamable HTTP 工具。ACP 需要声明 HTTP MCP 能力，并使用工作台的严格审批配置。MCP 服务自身的文件、网络和外部操作权限由该服务管理。

混合运行默认使用独立上下文，关闭自动记忆读写。「盲审」仅接收固定任务简报、阶段指令和本次填写的证据。阶段各自保有账号、文件授权和运行回执。结果不明时用「查询并继续」核对原回执，配置变化会暂停相应分支。

填写简报并确认交接范围后，可点「模拟运行」查看各阶段的模拟输入。预演使用本地示例输出，无需调用模型或创建运行回执。正式运行后，从「最近的混合运行」展开阶段详情，查看授权资料、已校验的获准交接字段、原会话和轮次 ID，并从同一卡片进入产物。

「查看运行历史」可打开之前结束的混合运行及其原产物。工作台最多保留 30 条归档，归档总量上限 5 MiB，达到上限时从最早的归档开始清理。阶段明确失败后可选择「重试阶段」，工作台会先核对原回执、工作流版本、模型与执行配置。重试建立新运行，复用成功的阶段，给失败阶段和可继续的下游步骤分配新回执。结果待确认的阶段仍通过「查询并继续」处理。

从侧栏打开「工作流」。点击卡片可编辑该阶段的名称、执行端、模型和角色指令。选中阶段后点「添加阶段」可接续该阶段，点「添加独立阶段」可创建一个没有输入的阶段。将一个阶段的输出端口拖到另一个阶段的输入端口，即可添加依赖。也可以依次点击两个端口。在阶段设置里可移除连线。原有顺序流程会按原顺序显示成一条链，链式流程仍可用拖动或上移、下移调整顺序。

在每个阶段的「阶段文件授权」添加相对于 VPS 项目目录的文件路径，或选择本地附件。本机保存附件快照，只有获准的阶段会将这些快照交给 VPS。授权绑定该阶段的远端目标、执行端和工作目录，每个阶段派发前会复核已保存的授权。

远端文件在阶段工作目录保留相对路径，附件位于 `/attachments`，两者均只读。每个阶段拥有独立可写的 `/output`，容量为 256 MiB。阶段结束时，VPS 启动器把普通文件保存到该次运行的产物目录。产物保存路径只在工作台显示，阶段看到的输出挂载是 `/output`。空清单提供空工作目录。前序阶段仍按流程图传递文字结果，文件产物归各自阶段所有。每阶段可授权最多 16 个远端文件，单文件最多 32 MiB，合计最多 64 MiB。本地附件最多 8 个，合计最多 512 KiB。

在最近运行的阶段结果中选择「查看产物」，即可通过原 VPS 连接分页查看文件名和大小。最大 1 MiB 的 UTF-8 文本可以直接预览，较大的产物可以分段读取后下载。阶段结果也会显示 VPS 的保存目录。

阶段看到的是 `/workspace` 中的授权文件快照。清单之外的文件和其他任务的输出不在该文件树中，查找时返回文件不存在。SDK 进程使用独立的环境和进程列表，`SSH_CONNECTION` 等 SSH 环境变量留在外层连接进程。

每个工作流可包含 1 至 8 个阶段。模型从阶段执行端的模型目录中选择。运行 Antigravity 工作流前，可在 VPS 的专用配置中准备私有文件 `~/.dsh-antigravity/workflow-credentials.json`，用 `files` 数组列出供阶段读取的凭据文件相对路径，路径以专用登录目录 `~/.dsh-antigravity/home` 为基准。

选择已保存的工作流，输入任务，再点「开始运行」。满足依赖的阶段最多同时运行两个。每阶段在同一 VPS 连接上建立独立会话，收到原始任务、阶段指令和所有直接上游的回复。将两个分支连到同一个汇总阶段时，汇总会等两个分支都完成。超过上下文上限的交接内容会截短。上游失败会跳过依赖它的阶段，独立分支仍可完成。

「暂停运行」暂停派发后续阶段。「停止运行」会锁住后续派发并向正在运行的阶段发出停止请求。关闭应用后，可以用「查询并继续」分别核对已发出阶段的原回执。模型调用使用已有工作台 VPS 通道和访问权限。

含「共享记忆」阶段的工作流可在启动时选择记忆项目或个人记忆。该阶段沿用所选范围的记忆开关，开启自动记忆时会检索并从已完成的回复提炼。每个阶段也可使用「独立上下文」，关闭该阶段的共享记忆读取和提炼。与其它阶段相连时，上游回复仍会按流程图传入。自动提炼使用同一 VPS 上的 Codex。

「在聊天中创建」和「在聊天中编辑」会打开一段配置对话。描述想要的流程或修改后，点回复下方的「审阅工作流配置」。在提案流程图中逐阶段查看模型和职责，确认后点「保存提案」。提案保存采用原配置的版本号校验，遇到更新后的旧提案需重新询问。

聊天配置协议使用单个 `vps-workflow` 代码块，包含 `{"name":"工作流名称","stages":[{"id":"s1","name":"阶段名称","provider":"codex","model":"","instruction":"阶段职责"}],"edges":[]}`。连线使用 `{"from":"s1","to":"s2"}` 引用阶段 ID。桌面通过 `changeWorkflows({op:'save', id, revision, draft})` 按用户确认写入。新建时 `revision` 为 `null`，修改时使用发起编辑时的版本。保存和运行由各自的界面动作触发。

## MCP、提示词模板与记忆

在「设置 → Agent 与工具 → MCP 服务器」为当前执行端添加并启用服务 ID。Codex 对话和选用 Codex 或 Antigravity 的工作流阶段可从 VPS 当前 SSH 用户的 `~/.config/vps-workbench/mcp/<ID>.py` 加载 Python stdio 服务。工作流只加载该 Agent 选中且仍启用的服务。注册目录与脚本应由该用户所有，目录权限为 `0700`，脚本权限为 `0600`。脚本在 VPS 的阶段隔离环境内启动。可将 [example_mcp.py](extensions/example_mcp.py) 保存为 `workbench-status.py`，用服务 ID `workbench-status` 测试 `workbench_status` 工具。

在「设置 → Agent 与工具 → 提示词模板」导入 JSON 清单，确认内容并启用。输入栏的「提示词模板」会把选择的模板插入草稿。

```json
{
  "schema": 1,
  "id": "design-review",
  "name": "设计审查",
  "version": "1.0.0",
  "description": "用于审查游戏和视觉设计稿件",
  "prompts": [
    { "title": "检查设计稿", "text": "请检查这个稿件的视觉层级、可读性和素材规范，并给出修改建议。" }
  ]
}
```

在「设置 → 记忆」开启「个人自动记忆」，未归类的普通聊天会自动积累和引用长期偏好。开关一次设置，笔记按 VPS 连接分别保存。项目聊天使用各自的项目设置和笔记。

需要跨工具复用项目决定时，在同一设置页选择项目，开启「自动项目记忆」。个人和项目记忆均由该 VPS 上的 Codex 在独立后台任务中提炼，消耗该 VPS 的 Codex 用量。笔记及来源保存在本机，Codex、Claude API、Claude Agent SDK 和 Antigravity 可在同一连接和允许的范围内引用。对「沿用刚才的设置」之类的简短追问，检索可结合本会话最近一条已完成的用户请求。

需要单独探索时，在输入栏的「会话记忆」选择「独立上下文」。已有会话会保留并另开新会话，关闭该会话的自动记忆读写。生成的笔记可查看来源、编辑、停用或删除。手动记忆和「随消息发送手动记忆」仍可用于原有 Codex 路线。原生订阅终端使用自己的会话界面。

## 界面预览与批注

在此目录运行 `npm run preview`，用 Codex 内置浏览器打开 `http://127.0.0.1:47823/`。点击浏览器工具栏的 **Annotate**，选中控件或框选区域，写下想要的改动，再在对话中提交。预览覆盖工作台菜单、项目和会话、设置、设计画布和订阅终端。连接、对话及终端内容由模拟数据提供。Windows 系统对话框和第三方账户网页在各自的实际环境中验收。

浏览器预览与 Windows 桌面版共用前端构建。修改前端源文件后，预览会自动刷新。修改预览服务或模拟接口后，重启预览进程以载入新的接口。确认改动后运行 `npm run sync:desktop`，它会先构建并核对界面资源，再正常关闭和重新打开本机版本。发布保存在 `%LOCALAPPDATA%\VPS Workbench\Releases`，同版本的旧安装目录会保留为备份。桌面版继续使用原有数据目录。

预览的 `/__preview/revision` 和桌面包的 `resources/app/desktop/web/revision.json` 记录同一个界面指纹。需要先验收完整安装包时，可用 `pwsh -File ./Sync-Local.ps1 -StageOnly` 构建，再用 `-StagedDirectory` 安装该次验收的产物。安装时可传 `-ExpectedWebRevision` 来核对指定的预览版本。

## 发布版的可选本机组件

给新用户准备 Windows x64 便携包时，在 `Build.ps1` 或 `Sync-Local.ps1 -StageOnly` 加上 `-OnDemandRuntimes`。运行解压后的 `VPS Workbench.exe`，首次启动可勾选 Codex、Claude Agent SDK、Antigravity ACP，再点击「安装所选组件」。也可以选择「暂只使用 VPS SSH」，日后从「设置 → 连接 → 本机 SDK」添加。

工作台从固定的 npm 包和 Google 下载地址获取对应版本，校验 SHA-512，随后在自己数据目录中安装组件，并为每个新执行端建立一份只读本机配置。运行时文件在数据目录的 `components` 下，分别按执行端和版本保存。已有配置及历史按原身份继续使用。产品包自身保留 SSH 桥和原来的 VPS 连接入口。

安装后在「模型与账号」连接账号。Codex 和 Claude Agent SDK 使用各自的本机 API 密钥。同一执行端的所有本机配置使用该执行端的密钥。应用内填写的密钥通过 Windows 的系统加密保存在 `local-credentials`，可信启动器仍可注入原来的环境变量。Antigravity 通过每个本机配置的官方 CLI 登录窗口连接 Google 账号。登录和模型试跑都由用户主动发起。 [Claude Agent SDK 认证](https://code.claude.com/docs/en/agent-sdk/overview) [Antigravity ACP 安装和登录](https://antigravity.google/docs/cli/acp)

运行 `npm run preview:components` 可在 `http://127.0.0.1:47829/` 验收首次安装和跳过流程。该预览使用模拟安装和账号。

更新本机 SDK 版本时，同时更新锁定归档、对应的暂存布局和 `desktop/component-catalog.mjs` 中的目录摘要。离线包回归使用锁定的四份 npm 归档。在 `VPS_WORKBENCH_TEST_EXE` 指定按需安装版，在 `VPS_WORKBENCH_TEST_COMPONENT_ARCHIVES` 指定归档目录，然后运行 `npm run test:desktop:components`。

## 构建

从仓库根目录分别运行 `npm ci --ignore-scripts --prefix vps-workbench` 和 `npm ci --ignore-scripts --prefix remote-workbench/vps-chat`，再运行 `pwsh -File ./vps-workbench/Build.ps1`。构建使用同一工作区的共享组件和 `windows-terminal` 运行时源码。脚本校验缓存的 Electron 44.7.0 归档及两份兼容执行器归档。`Build.ps1` 和 `Sync-Local.ps1 -StageOnly` 都可通过 `-ElectronZip`、`-CompatibilityArchive` 和 `-SubscriptionArchive` 指定归档路径。Codex SDK、Windows CLI 及平台包完整性由 npm lockfile 固定，包内保留许可证与原生资源声明。

个人 Windows 构建可用 `Build.ps1 -PersonalClaudeSubscription` 启用本机 Claude 个人订阅。启动 `dist/VPS-Workbench-<版本>-win-x64-personal` 中的程序，在「设置 → 连接 → 本机 SDK」注册 Claude Agent SDK 配置时选择「Claude 个人订阅」，再从账号页打开官方 Claude Code 登录窗口。登录完成后检查此配置的登录状态，可另行发起模型试跑。Claude Code 管理登录凭据，每个订阅配置有独立的登录目录和会话。个人构建默认使用 `%APPDATA%\VPS Workbench Personal`。正常构建使用 API Key 认证。个人使用及对外发布的认证边界见 [Claude Agent SDK 订阅说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) 和 [第三方认证规则](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)。

发布输出在 `dist/VPS-Workbench-<版本>-win-x64`。DSH 插件由原来的 remote-workbench/vps-chat/Build.ps1 单独打包。运行 npm test 检查独立本机状态、导入、接口授权、订阅终端回执与界面预览。运行 npm run test:desktop 验证打包窗口和工作台交互。

VPS 后端独立打包。运行 `python vps-workbench/vps-package/build.py --revision <Git提交哈希>`，产物位于 `vps-workbench/dist/vps-backend/`。同一归档适用于满足运行条件的 Linux x86‑64 与 ARM64。分别检查宿主和安装选中的执行端，步骤见 [VPS 后端安装说明](vps-package/README.md)。

离线回归接入向导与 Windows 安装桥时，用 `VPS_WORKBENCH_TEST_EXE` 指定候选包中程序的绝对路径，用 `VPS_WORKBENCH_TEST_PYTHON` 指定本机 Python 可执行文件的绝对路径，然后运行 `npm run test:desktop:backend --prefix vps-workbench`。

验收暂存包时，将 `VPS_WORKBENCH_TEST_EXE` 指向暂存目录中的可执行文件再运行桌面测试。测试使用隔离的数据目录、模拟回复与只读沙箱探针。启用前记录当前版本的可执行文件和数据目录，等任务完成或确认可按原回执查询后，保留旧版本目录和数据的本机备份。需要回滚时，先关闭候选版并另外保留启用后产生的记录，再从旧版目录启动；需要恢复旧数据快照时，可先将其复制到单独目录并通过 `VPS_WORKBENCH_DATA_DIR` 启动旧版核对。

## Git 与历史版本

客户端后续优化记录在 [客户端优化待办](docs/client-roadmap.md)。

`v0.27.1` 是工作台源码的 Git 基线。后续改动使用分支和提交记录。正式版用对应 Git 标签关联源码和 GitHub Release 中的 Windows 安装包。

`history-2026-11-22` 的 `history-catalog.json` 列出了迁入 GitHub 的旧正式版、阶段构建和原始 ZIP。安装目录共有的文件在归档里保存一份，每个版本的目录结构及文件校验值独立保留。下载全部 `history-*` 附件后，可在仓库根目录执行以下命令。恢复的目标路径应当尚未创建。

```powershell
gh release download history-2026-11-22 --repo Yuzu482/vps-workbench --pattern 'history-*' --dir .release-history
python vps-workbench/tools/restore_history.py .release-history --list
python vps-workbench/tools/restore_history.py .release-history --verify
python vps-workbench/tools/restore_history.py .release-history --restore VPS-Workbench-0.27.0-win-x64 .release-history/restored-0.27.0
```

桌面测试所需的 Playwright 依赖可通过 `npm ci --ignore-scripts --prefix dsh-terminal-workbench/client/browser-test` 安装。构建所需的两个固定版本兼容包位于同一历史 Release，可用 `gh release download history-2026-11-22 --repo Yuzu482/vps-workbench --pattern '*.tgz' --dir .release-inputs` 下载，再用 `-CompatibilityArchive` 和 `-SubscriptionArchive` 指定。Electron 归档继续由 `Build.ps1` 固定版本和 SHA-256。
