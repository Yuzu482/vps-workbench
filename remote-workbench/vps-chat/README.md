# DSH VPS 对话

在 DSH Desktop 打开「VPS 对话」，选择「新对话」并发送消息。选择同一会话继续追问，或从左侧会话列表重新打开历史。Enter 发送，Shift+Enter 换行。若发送结果待确认，用「查询原任务」查看原轮次。

左侧「本地项目」读取 DSH 已登记的工作区。选择项目后，新对话和新设计自动归入该项目。要归类已有会话，打开该会话并用标题旁的项目选择框。旧会话从「未归类」开始，分类关联保存在本机，按 VPS 连接与会话 ID 区分。选择项目只筛选会话记录，本地工作区信息留在 DSH。

「VPS 设置 → 账号」在已核对指纹的默认 VPS 上打开 ChatGPT、Claude、Claude API Console 和 Google 官方账号页面。Codex、Claude 订阅和 Antigravity 登录窗口会在 VPS 上启动指定的官方 CLI。Claude 订阅 SDK 与订阅终端使用同一 VPS 用户的 Claude Code 配置。使用 Claude API 时，可以在 VPS 窗口输入并确认保存一把 API 密钥，位置是该用户的 `~/.config/remote-ssh/anthropic-api-key`。

VPS 校验出口后才会打开画面。DSH 通过 SSH 收取画面并传送键盘和鼠标操作。官网窗口每次使用独立的临时浏览器配置。普通 VPS 家目录下，官网窗口使用当前用户私有的内存文件系统。关闭窗口后，VPS 清理该会话的浏览器配置。网页需要 Firefox snap、TigerVNC、xauth 和 x11-utils。

执行端登录和密钥窗口需要当前 VPS 用户的 LUKS2 加密家目录、xterm 和对应的 CLI。请在同一 VPS 窗口的浏览器中打开 CLI 打印的登录地址。远程显示使用仅当前 SSH 用户可读写的 Unix 套接字。

助手回复支持 Markdown 标题、列表、表格和代码块。代码块的「复制代码」只复制块内代码。「复制回复」复制整条回复的 Markdown 原文。外部图片引用显示为文字。

输入卡片会随多行草稿展开。底栏左侧是模式和设计资料，右侧是上下文圆环、模型和发送操作。悬停圆环可查看 VPS 报告的 token 用量和上下文窗口。点击「模型」先打开思考强度滑条，再点击面板上的模型名称展开 VPS 模型列表。选择作用于下一条普通消息。「模式」在对话与设计之间切换，已有历史时会打开新会话。尚未发送的草稿可带到所选模式。生成中发送的补充仍属于当前轮次。

使用 Codex 时，助手回复会随 VPS 的增量事件更新。点击「停止生成」后，面板会等待该轮的停止结果，并保留已经收到的回复。回执暂时不明时，可用「查询原任务」核对同一轮。

使用 Codex 时，点「新建设计」，描述原型的用途、画板和页面流程。原型可以包含最多六块画板。生成完成后，可以切换画板、预览桌面和移动宽度、缩放画布，并点击原型里的跳转按钮体验流程。

设计会话可在「对话」「并排」「画布」之间切换。回复中的「查看画板」打开对应版本。并排时可拖动分隔条，或聚焦后使用方向键调整对话宽度。窄窗用「对话」和「画布」切换。F6 在工作台可见区域间移动焦点，Shift+F6 向前移动。

生成中出现「发送补充」时，可以输入文字后点击该按钮或按 Enter，把修改要求发给 VPS 上正在运行的原轮次。每条最多 1,200 字符，每轮最多六条。消息下方会显示排队、送达或待确认状态。发送结果待确认时，点击「查询原任务」核对。若轮次在输入期间结束，可点击「作为新一轮发送」继续。勾选的设计资料随下一轮的完整消息发送。

在「编辑画布」中选择图层，可拖动、调整大小、对齐、调整文字和样式，也可以添加文字、形状及批注。改动保存在本机的 DSH Desktop 配置中，切换回旧版本可继续查看该版本的编辑。可以在画布中撤销或重做本次打开时的编辑。

在设计输入栏点击「添加设计资料」，或从画布打开「设计资料」。可以导入 `DESIGN.md`，或保存为可在其他设计中使用的本机设计系统。支持文字、UTF-8 前端源文件和最多两张 PNG、JPEG、WebP 图片。勾选的设计系统、参考资料、画布修改和批注会显示在输入栏，并随下一条完整消息发送到同一 VPS Codex 线程。

画布的「导出」菜单提供 HTML、ZIP、PDF 和 PPTX。HTML 可离线浏览设计和画板跳转。ZIP 包含逐画板 HTML、项目清单、可运行预览和工程交接说明。PDF 和 PPTX 将每块画板按桌面布局渲染为一张图片，每块画板占一页或一张幻灯片。

## 连接与数据

0.22.0 的工作台 SSH 连接要求本机回环 SOCKS5 中继。启用前先核实中继只能走指定的外部出口，并确认该出口可访问 VPS 的 SSH 端口。将中继端口和 VPS 应看到的中继 IPv4 写入 `$DSH_HOME/vps-chat-workbench/ssh-relay.json`，示例为 `{"version":1,"socksPort":10808,"expectedSshSource":"192.0.2.8"}`。每条 SSH 连接保留主机密钥校验，VPS 确认来源地址后才会接收聊天数据或启动账号浏览器。配置缺失、中继不可用或来源错误时，SSH 操作失败。中继接受的目标端口仍受 VPS 的现有入站规则约束。

工作台通过 Windows OpenSSH 连接 VPS，并按 `known_hosts` 验证服务器。模型请求由 VPS 上的 Codex 或 Claude Code 发出。每轮启动前在 VPS 检查预期公网出口、服务路由和代理环境。隔离或出口检查失败时，本轮无法启动。回复下的「查看运行详情」展示已捕获的检查结果。

打开面板时，工作台可加载 `$DSH_HOME/vps-chat-workbench/default-target.json` 中已核对的目标。预设包含名称、连接设置及其 `targetId`。主机指纹或绑定的连接设置发生变化时，面板会要求重新核对。也可在「VPS 设置」选执行端并填写 SSH 主机、端口、用户、Windows 私钥与 `known_hosts` 文件路径、VPS 项目目录和预期出口。

Codex 使用 VPS 上已有的 ChatGPT 登录，通过只读沙箱里的 App Server 标准输入输出传递事件。Claude Code（API）读取 VPS 上权限为 `0600` 的 `~/.config/remote-ssh/anthropic-api-key`，项目工具限 `Read`、`Glob`、`Grep`。在 VPS 上先挂载属于该用户的 LUKS2 加密家目录。API 凭据和账号查看器的临时浏览器资料都必须位于家目录的同一加密设备。「模型」可选 Claude Code 官方别名 Sonnet、Opus、Haiku，或沿用 VPS 的默认模型。别名由 VPS 上的 Claude Code 解析，实际可用性由 API 项目决定。工作台显示该次 CLI 会话报告的模型。使用个人 Claude 订阅时，在「远端原生终端」中运行以本人账号登录的官方 Claude Code。

会话文本、近期回复和回执保存在本机 `vps-chat-workbench`，原生线程保存在 VPS。Windows 端需要 .NET 10、系统 OpenSSH 和 Python 3.11。VPS 端需要所选的原生 CLI、Python 3、`curl`、`ip`、`bwrap`，以及可用的用户和网络命名空间。

「Claude（订阅 SDK）」是个人工作台的独立执行端，使用与 Codex 相同的会话列表、Markdown 消息和停止按钮。VPS 上的官方 Claude Code 读取本人完成的 Claude 登录。SDK 预览仅提供聊天，该执行端关闭工具调用。Node.js 和 `@anthropic-ai/claude-agent-sdk` 0.3.311 安装在 VPS 用户的 `~/.dsh-claude-sdk` 下，Node 执行文件位于 `runtime/bin/node`。订阅会话和 API 会话分别保留自己的记录。

「Antigravity」从「VPS 设置 → 执行端」勾选。该执行端使用官方 Linux `agy acp` 处理新对话，支持文本流式回复、停止生成、续聊和模型选择。使用 `agy acp --login` 在 VPS 上完成交互式登录，登录时将 `HOME` 指向 `~/.dsh-antigravity/home`。两个目录应由 VPS 用户所有，权限为 `0700`。在同一 VPS 用户的 `~/.dsh-antigravity/hosts.json`（`0600`）中，用 `{"hosts":[...]}` 列出已核实的 Google 登录和模型服务域名。执行器验证 VPS 出口，限制到这些 HTTPS 域名，并以只读方式挂载项目目录。登录资料与原生会话映射均保存在 VPS。 [Antigravity ACP 文档](https://antigravity.google/docs/cli/acp)

## 构建

在此目录运行 `npm ci --ignore-scripts`，再运行 `pwsh -NoProfile -File ./Build.ps1`。构建产物 `dist/` 中的压缩包解开后，可将 `package` 目录作为 DSH 的本地插件来源。可用 `-PrebuiltHelperDirectory` 复用已验证版本的对话执行组件。账号画面使用 noVNC 1.7.0，源码见 [noVNC v1.7.0](https://github.com/novnc/noVNC/tree/v1.7.0)。
