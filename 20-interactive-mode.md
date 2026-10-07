# 第二十章 交互界面怎样连接模型、工具与会话

用户按下回车后，模型回答、工具进度、终端输入和配置更新可能交错发生。问题不是怎样画一个聊天框，而是怎样让画面始终对应当前会话，并让用户在执行过程中继续输入、取消和切换视图。本章从第十九章的输入框继续，追踪应用层的状态与生命周期。

## 20.1 源码地图与职责

| 代码 | 主要职责 |
| --- | --- |
| [interactive-mode.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/interactive-mode.ts) | 启动界面、输入路由、事件订阅、命令处理、队列和退出 |
| [tui-renderer.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/tui-renderer.ts) | 创建普通或全屏渲染器，提供稳定的 TUI 引用 |
| [chat-viewport.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/chat-viewport.ts) | 全屏历史滚动区与底部输入区域的布局 |
| [custom-editor.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/custom-editor.ts) | 在通用编辑器上加入应用快捷键与状态边框 |
| [assistant-message.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/assistant-message.ts) | 文本、思考块、流式状态与结束错误 |
| [tool-execution.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/tool-execution.ts) | 工具参数、进度、结果、扩展渲染器与图片 |
| [bash-execution.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/bash-execution.ts) | 用户直接运行命令的流式展示 |
| [footer.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/footer.ts) | 路径、模型、令牌、费用和上下文使用率 |
| [theme.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/theme/theme.ts)、[theme-controller.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/theme/theme-controller.ts) | 主题加载、终端颜色同步与刷新 |
| [system-theme.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/theme/system-theme.ts) | 从终端背景与调色板生成应用颜色 |
| [external-editor.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/external-editor.ts) | 临时提示词文件与外部编辑器进程 |

`InteractiveMode` 把业务操作委托给 `AgentSession` 和 `AgentSessionRuntime`。前者执行提示词、工具、压缩与树导航；后者拥有当前会话并负责替换和销毁。界面类通过 getter 读取 `runtimeHost.session`，所以会话替换后，不必把每个命令处理器里的会话引用全部重写。

但 getter 不是自动取消机制。异步函数若把旧会话保存到局部变量，它仍要检查这个对象是否还是当前会话。后面的模型目录刷新和重新绑定就有这种检查。

## 20.2 一棵组件树，两个终端渲染器

界面按功能保存容器：页头、资源列表、聊天历史、等待输入、状态、编辑器上下方组件、编辑器和页脚。普通模式顺序输出这些组件；全屏模式使用同一批组件组成布局树。

```text
全屏布局
├─ 历史 ScrollView：自动分配剩余高度，默认跟随末尾
│  └─ 页头 + 已加载资源 + 聊天内容
└─ 输入区域 VStack
   ├─ 等待发送的输入
   ├─ 运行状态与扩展组件
   ├─ 编辑器
   └─ 扩展组件与页脚
```

`createChatViewport()` 将历史区设为主要滚动区，最小高度为一行。输入框最小高度为三行；其他底部组件允许收缩到零。终端高度不足时，布局器按收缩规则分配空间，而不是让每个组件独自决定整屏高度。

切换模式时，`switchTuiMode()` 拒绝在存在浮层时切换。然后保存组件、焦点、终端实例和配置；普通模式还保存渲染基线。旧渲染器停止并清除挂载关系，新渲染器接管同一个终端，重新挂载组件并恢复焦点。

已经创建的组件持有 `this.ui`，怎么避免它们继续调用旧渲染器？`createInteractiveTuiReference()` 返回一个 `Proxy`，即拦截对象操作的代理对象。每次读取属性时访问当前渲染器；方法包装器在实际调用时再检查渲染器是否变化，并使用正确对象作为 `this`。

```ts
// 教学示例：保留的方法仍会转发给后来切换的渲染器。
const requestRender = stableUi.requestRender;
switchRenderer();
requestRender();
```

包装器并不只是 `oldRenderer.requestRender.bind(oldRenderer)`。后者会永久绑定旧对象。这里连提前保存的方法也会重新查找；属性写入、`in` 判断和原型查询同样转发。它解决引用稳定性，不提供多个渲染器同时操纵终端的互斥。

## 20.3 启动时先允许输入，再逐步启用功能

`init()` 首先安装信号与终端错误处理器，建立布局并聚焦编辑器，然后启动 TUI。此时只启用清空、退出和启动中提交提示。用户可以输入，若过早按回车，`handleStartupSubmit()` 将文字放回编辑器，并显示启动尚未完成。

之后的顺序是：

1. 应用主题，等待终端颜色查询完成或超时，再构造页头。
2. 并行确保 `fd` 与 `rg` 可用；下载进度通过已启动的 TUI 显示。
3. 安装完整快捷键与提交处理器。
4. 绑定扩展，让 `session_start` 处理器可以调用交互弹窗。
5. 显示已有会话内容，安装主题与 Git 分支更新通知，完成首帧。
6. 在后台加载其余语法高亮语言。

因此“已经看见输入框”不等于所有资源已初始化。启动顺序把可以提前交付的反馈与需要资源完成的功能分开；它没有把初始化包装成一次全局事务。

`isInitialized` 防止完成启动后再启动，但这里不是共享的 `initializingPromise`。不能据此断言任何两个同时调用 `init()` 的调用者都只会执行一次初始化；正常入口是 `run()` 先等待启动完成，再进入主循环。

`run()` 后台检查模型目录、程序版本、扩展包更新与 tmux 配置。模型目录刷新有 15 秒取消信号，失败保留缓存。`PI_OFFLINE` 被具体路径检查；不能把它理解为任意扩展代码都会因此禁止网络访问。

## 20.4 一个提交有四种去向

编辑器提交时先去除首尾空白，空输入直接返回，再按下面的顺序路由。

| 输入或状态 | 执行路径 |
| --- | --- |
| `/settings`、`/model`、`/tree` 等内置命令 | 调用对应界面或会话操作，通常清空编辑器 |
| `!command` 或 `!!command` | 用户命令执行；`!!` 的结果排除出模型上下文 |
| 正在压缩 | 扩展命令立即执行，其余文字保存到界面的压缩队列 |
| 正在生成 | `session.prompt(text, { streamingBehavior: "steer" })` |
| 空闲普通输入 | 交给主循环等待的回调，或加入 `pendingUserInputs` |

这个顺序有实际意义：内置命令先于“正在生成就加入 steering 队列”的判断，所以不能把所有斜杠命令都解释成发给模型的普通消息。模板和扩展命令还有 `AgentSession.prompt()` 自己的处理规则，见第八、十六章。

主循环反复 `await getUserInput()`，再 `await session.prompt(userInput)`。界面仍由事件循环响应按键。普通输入若在主循环尚未开始等待时抵达，会进入 `pendingUserInputs`，下次取输入时先从数组头部取出。

```text
空闲 Enter → onInputCallback → 主循环开始 prompt
生成中 Enter → prompt(...steer) → 会话 steering 队列
生成中 follow-up 快捷键 → prompt(...followUp) → 会话 follow-up 队列
压缩中 Enter → compactionQueuedMessages → 压缩结束后再交给会话
```

编辑器调用 `onSubmit` 与会话的事件订阅都不能简单视为全局串行器。提交回调是异步函数，但通用编辑器不会等待它才接受下一次按键；会话对公开监听器也不逐个等待其 Promise。某个处理器里的 `await` 只约束该次调用内部的先后，不自动约束后续事件。

## 20.5 快捷键有优先级，取消取决于当前状态

`CustomEditor.handleInput()` 先给扩展快捷键机会，再处理剪贴板快捷键、应用中断和退出，再让显式历史键优先于其他应用动作，最后交给通用编辑器。

中断键遇到补全菜单时，先让父编辑器取消补全；没有补全菜单才调用应用的 `onEscape`。这能避免用户只是想关掉候选列表，却终止正在运行的模型请求。

默认中断处理继续按状态分支：生成中恢复排队输入并请求代理取消；用户命令运行中取消命令；命令输入模式下清空输入；空编辑器下可检测 500 毫秒内的双击 Escape 并打开树或分支选择器。压缩和重试期间则临时替换 `onEscape`，分别调用对应取消方法，结束后恢复原处理器。

清空快捷键与中断不是同一条路径。`handleCtrlC()` 在 500 毫秒内第二次触发时退出，第一次清空编辑器。退出快捷键只有编辑器文本长度为零时才退出；非空时继续交给编辑器处理。这些键的具体绑定来自配置，书中不要求把某个键码硬编码进组件。

状态指示器可以显示在独立状态区，也可以嵌入编辑器上边框。替换指示器之前先 `dispose()` 旧对象，停止其旋转符或倒计时；按种类清除能避免结束一次重试时误删后来显示的工作状态。

## 20.6 事件怎样变成画面

`subscribeToAgent()` 将会话事件交给 `handleEvent()`。大部分分支同步修改组件，再请求渲染。关键关系如下。

| 事件 | 界面状态变化 |
| --- | --- |
| `message_start(user)` | 新增用户消息，更新待发送输入显示 |
| `message_start(assistant)` | 创建 `streamingComponent`，保存当前助手消息 |
| `message_update` | 重建助手内容；为新出现的工具调用创建组件，已有调用更新参数 |
| `message_end` | 以最终消息更新内容；失败标记待执行工具，成功标记参数完整 |
| `tool_execution_start` | 查找或创建对应工具组件，标记执行开始 |
| `tool_execution_update` | 替换该调用的部分结果 |
| `tool_execution_end` | 写入最终结果，从待执行工具映射中删除 |
| `agent_end` | 停止工作提示与终端进度，清理未完成的流式状态 |
| `agent_settled` | 检查扩展是否请求退出 |

工具组件映射的键是 `toolCallId`，不是工具名称。模型同时调用两次 `read` 时，进度仍归到不同组件。代码执行工具内部的嵌套调用带 `parentToolCallId`，不额外创建顶层行，交给父调用的渲染器展示。

部分工具参数可以在模型还没生成完整 JSON 时就出现。界面先展示“参数正在形成”的状态，`message_end` 成功后才设置 `argsComplete`，以免编辑差异预览误把不完整参数当作最终操作。

助手组件每次 `updateContent()` 清除并重建内部文本组件；它不保存每一个流式片段对应的历史画面。连续思考块合并为一个显示单元，鼠标点击可以覆盖其隐藏状态。包含工具调用的助手消息由独立工具行展示工具内容；纯文字回复还附加终端区域标记，方便支持该协议的终端识别输出区域。

`message_end` 到达界面时，当前消息尚未写入会话日志。这解释了缓存命中提示为什么扫描日志中的上一条助手消息。不能把“画面已经显示最终回答”当作“当前消息已经落盘”的证明。

## 20.7 工具渲染器与工具执行是不同职责

`ToolExecutionComponent` 接收参数与结果，也接收仅用于展示的 `ToolRenderers`。它不会自行调用工具的 `execute()`。这是必要分离：重新绘制画面、改变主题或展开输出，不应该再次修改文件。

渲染上下文包含工具调用 ID、工作目录、参数完整标记、执行开始标记、结果是否仍在更新，以及一个随组件保存的 `state` 对象。扩展可以重用 `lastComponent`，避免每次进度更新都重做昂贵的展示计算。

默认外壳加背景和边距；`renderShell: "self"` 让扩展自己画边框。调用渲染器或结果渲染器抛错时，组件回退到通用展示。这里的 try/catch 包围渲染器调用，不覆盖它返回的自定义组件以后所有 `render()`、定时器与事件回调；不能扩大为“扩展界面永远不会导致崩溃”。

普通结果降级展示默认取前十行。点击结果可展开；工具结果中的图片按数据、MIME 类型与宽度逐张比较，复用仍匹配的 `Image` 对象，让 PNG 转换结果和图片 ID 保持稳定。主题失效重画没有必要再次生成相同图片对象。

用户 `!` 命令的组件使用另一条规则：先应用与模型上下文相同的尾部截断，再默认展示末尾二十行，并按实际宽度控制视觉行数。组件仍保存收到的输出字符串，展示截断不等于其内存有同样的容量上限。

## 20.8 压缩期间的队列为什么独立

压缩会改变后续模型请求使用的历史，因此普通输入不能立即开始另一次请求。界面保存 `{ text, mode }`，其中 `mode` 记录希望 steering 还是 follow-up。待发送区域同时展示会话队列与压缩队列，但二者的所有者不同。

压缩结束时，`flushCompactionQueue()` 先复制这一批输入并清空界面队列。若代理还要重试，将文字分别交给会话的 steering/follow-up 队列。否则先执行第一个普通提示词之前的扩展命令，再启动第一个普通提示词，并把后续输入加入相应会话队列。

启动第一个提示词后，代码不等待整轮生成完成才加入剩余消息。否则它们就无法作为该轮的排队输入。失败时的恢复逻辑会清除会话队列，再把原批次恢复到压缩队列，供用户查看和重试。

这里有明确边界：恢复不是事务回滚，已经执行的扩展命令不会撤销；恢复的是文本批次，而不是所有动作。该函数也没有统一互斥锁；分析重叠提交或恢复时，要继续检查是否已有其他调用向会话队列添加消息，不能仅凭“先复制再清空”断言没有竞争。

中断或“取回排队输入”则先清空两个队列，按 steering、follow-up 的顺序合并为编辑器文本，再追加当前未提交的输入。合并之后，原来的队列种类不再保留为结构化数据。带 `abort: true` 时再调用会话取消，但这里不等待取消完成；第七、十一章解释为什么这不等于副作用立即停止。

## 20.9 普通选择器如何识别旧回调

具体例子：模型选择器 A 正在等待目录刷新，用户又打开选择器 B。A 的异步选择完成后调用 `done()`，不能把 B 从编辑区域移除。

`showSelector()` 为每次打开创建一个独立对象 `token`，保存为 `activeSelectorToken`。关闭回调先处置自身资源，再检查 token 是否仍匹配；只有当前选择器才能清空编辑区域并恢复编辑器。替换选择器时还先调用旧选择器的 disposer。

```text
打开 A → 保存 tokenA
打开 B → dispose A → 保存 tokenB
A 完成 → tokenA ≠ tokenB → 不恢复编辑器
B 完成 → tokenB = 当前 token → 恢复编辑器
```

这个机制防止旧关闭动作改变新焦点，但不会撤销 A 已经执行的业务动作。旧 A 在被替换时可能已被处置，迟到的 `done()` 又会调用一次其 disposer，因此清理函数需要能重复调用。

模型范围选择器还保存 `disposed`、取消控制器和 15 秒定时器。刷新完成先检查 `disposed`；取消时既置标记，又发取消信号。前者阻止迟到结果改界面，后者请求停止工作，两者处理不同问题。

扩展的 `select()`、`input()`、`editor()` 使用单独字段与隐藏方法，没有统一复用上述 token，也没有自动串行弹窗队列。先检查已取消信号，安装取消监听，选择或取消时返回值并恢复编辑器；带超时的选择与输入组件通过倒计时触发取消。

因此扩展不能假设两个并行的弹窗 Promise 会自动按顺序显示。旧弹窗的取消回调调用的是当前隐藏方法，可能影响后来显示的同类弹窗；资源重载隐藏旧弹窗，也不代表所有旧 Promise 已经得到结果。这是根据代码可推导的边界，尚未作为真实终端集成实验复现。

## 20.10 自定义组件与编辑器的生命周期

扩展组件按键名保存在编辑器上方或下方的 Map 中。更新同一个键之前处置旧组件。字符串数组组件最多接受十行，再添加截断提示；这个限制是对一次字符串数组输入的限制，不是对所有组件的总高度或自定义工厂输出的全局限制。

替换编辑器时保存旧编辑器的 `getText()`，复制提交和变化回调，以及可选的外观和补全设置。对于符合应用编辑器结构的对象，还复制应用动作处理器。结构判断避免跨模块加载器的 `instanceof` 差异。

注意保存的是 `getText()`，不是总会使用 `getExpandedText()`；第十九章的长粘贴占位符和登记表属于编辑器自身状态，不能断言任何自定义编辑器切换都会完整迁移它们。

`custom()` 支持普通编辑区域和浮层两种方式。局部 `closed` 标记保证同一次关闭只返回一次结果；普通模式恢复开始时保存的文本，浮层模式隐藏浮层，再处置组件。异步工厂也要考虑早完成：如果工厂在返回组件之前已经调用 `done()`，后续组件不会被挂载，该路径不能被视为所有返回资源都有统一处置保证。

资源重置会移除终端输入监听、状态、组件、自定义页头与页脚、补全包装器和自定义编辑器。任意扩展自己创建的进程、网络请求和定时器仍需由扩展自己的生命周期处理；界面容器清空没有这种跨对象回收能力。

## 20.11 会话替换与历史重建

`rebindCurrentSession()` 先保存当前会话对象，解除旧事件订阅，应用新设置和页脚工作目录。某些路径先重建画面并订阅事件，再等待扩展绑定，使扩展启动期间产生的内容能显示。等待结束后，再检查 `this.session !== savedSession`，若期间又发生会话替换，就停止这一轮后续更新。

历史重建使用 `sessionManager.buildContextEntries()`，按当前分支和压缩记录转换成展示条目。助手消息先创建工具行，再用后来遇到的工具结果按调用 ID 配对。自定义会话条目只有注册了对应渲染器才显示。

压缩结束后重建的历史不等于日志中全部条目。模型上下文的压缩条目可能位于上下文开头，而展示要放在相应时间位置。边界压缩的 `entry_appended` 路径还用条目 ID 集合记录已重建过的后续条目，避免随后的通知再次追加相同行。

树导航在弹窗等待后重新检查状态。若用户确认导航时模型仍在生成，先恢复排队输入并等待代理取消；然后再次检查是否正在压缩，避免把另一操作的状态区替换掉。保存标签与切换树叶仍委托给会话日志层，见第十三、十四章。

## 20.12 页脚缓存与主题更新

页脚显示累计费用与令牌时扫描全部会话条目，包括压缩前消息、工具计费、压缩、分支总结和缓存预热；上下文百分比则取当前会话上下文。累计费用和当前上下文长度不能使用同一个简单求和公式。

`FooterComponent.getSessionStats()` 用会话对象、会话 ID、树叶 ID、条目数量和负责上下文窗口的模型对象识别缓存。这样每帧不必扫描全部日志。`invalidate()` 在这个组件中是空操作；它依赖这些缓存键变化，而不是每次调用 invalidate 都重新计算。

主题使用语义颜色，如 `toolPendingBg`、`mdHeading` 和 `thinkingHigh`。`Theme` 创建时预计算 ANSI 前缀；空字符串表示使用终端默认前景或背景。主题变量可引用其他变量，解析用已访问集合检测循环，缺失变量明确抛错。

主题实例通过 `globalThis` 上的共享符号存放，代理读取当前实例，让 Node 与扩展加载器拿到一致主题。主题 JSON 的完整验证可以注入，验证器在 [theme-json.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/theme/theme-json.ts) 中与常用主题逻辑分离；没有注入时只有基本形状检查。不能把 TypeScript 类型断言当作完整运行时验证。

`InteractiveThemeController` 的颜色查询默认等待 100 毫秒。超时不是宣布终端永不回复；迟到颜色还能应用。新回复缺失的字段保留上次值，同样的颜色则跳过重建。背景颜色优先决定明暗，其次是终端明暗报告、`COLORFGBG`，最后默认暗色。

自动主题设置写成 `lightTheme/darkTheme`，只允许一个分隔斜杠与两个非空名称。终端明暗变化时重选主题并重新查询颜色。直接给内存主题实例时停止自动同步，避免用户自定义的主题被后续回复替换。

`system` 主题先按表面依赖顺序生成面板，再生成文字颜色。它使用 OKLab 明度目标曲线、调色板色相和 OKHSL 饱和度；不可满足全部目标时以二分寻找尽量小的约束放宽。正文颜色还按代码里的 4.5 对比度目标调整。无背景回复时降级到 ANSI 调色板和默认颜色；这不是所有终端实际显示均通过可访问性审计的声明。

主题文件监听有 100 毫秒防抖，保存启动监听时的主题名称，定时执行时再次比较。文件暂时缺失或 JSON 编辑到一半时保留最后成功主题。它监听的是用户主题目录中对应文件，不能说所有注册资源路径都会被自动实时监听。

`ThemedText` 在失效后调用构建函数重建带颜色的字符串。普通 `Text` 若创建时已拼接旧颜色，单纯重新渲染并不会替换字符串里的旧颜色；这正是两种组件并存的原因。

## 20.13 剪贴板与外部编辑器

右键粘贴先保存当时的焦点对象，异步读取剪贴板后再次检查焦点是否相同，才向它发送带边界的粘贴序列。用户期间打开另一个弹窗时，旧粘贴不会误插入新焦点。

编辑器剪贴板动作按文件路径、图片、文本的顺序尝试。文件路径拒绝控制字符，命令模式下做 shell 单引号转义；图片写成临时文件并插入路径。这条路径与右键粘贴的焦点检查不同，不能将二者的保护机制混为一谈。

外部编辑器处理的是提示词草稿：创建独立临时目录，写入 `prompt.md`，停止 TUI 后以继承终端的方式启动编辑器，等待退出码为零才读回，去除 BOM 与末尾一个换行，最后尽力删除临时目录并重新启动 TUI。

这里使用异步 `spawn()`，避免 Windows 同步进程调用仍占用控制台输入缓冲，与编辑器争抢输入。命令字符串仅按空格拆开；它不是理解引号和转义的完整 shell 解析器。独立临时目录减少不同编辑动作的文件名冲突，但界面没有因此获得任意重叠外部编辑器操作的互斥锁。

## 20.14 退出为什么有多条路径

正常交互退出先用 `isShuttingDown` 防止重复进入，关闭主题自动同步，最多等待一秒排空输入，停止 TUI，然后处置运行时与扩展，最后显示恢复会话的命令并退出。先停界面再让扩展清理，是为了避免扩展清理又请求刷新最终画面。

SIGTERM/SIGHUP 路径则先处置运行时，再尝试恢复终端。原因是终端可能已断开：如果先写恢复序列导致 EIO，程序可能在扩展清理之前就不得不退出。

标准输出或错误输出出现 EIO、EPIPE、ENOTCONN 时走紧急退出，结束追踪的子进程，不再尝试正常终端恢复，退出码为 129。未捕获异常在终端仍可用时则尽力停止 TUI，恢复原始模式与光标，记录崩溃并退出。这些路径没有提供所有第三方异步清理一定完成的保证。

POSIX 挂起还需要保活定时器与 SIGCONT 回调：先停止 TUI，再向进程组发 SIGTSTP；继续运行时恢复 TUI并强制重画。Windows 路径提示不支持挂起。这里管理的是控制台所有权与进程生命周期，与第十一章的文件修改锁是不同资源。

## 20.15 模型目录刷新如何共享工作，又独立取消

问题：启动流程、`/model` 与 `/models` 都可能要求刷新同一运行时的模型目录。若每个界面各发一次请求，会重复工作；若任何一个弹窗取消都取消所有请求，又会影响仍在等待的界面。

[model-catalog-refresh.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/model-catalog-refresh.ts) 用 `WeakMap<ModelRuntime, ActiveRefresh>` 保存进行中的刷新。弱引用映射不会仅因保存键就永久保留运行时。每个记录包含共享 Promise、共享取消控制器和等待者计数。

```text
A 开始刷新 → 建立共享请求，等待者 = 1
B 请求刷新 → 复用共享 Promise，等待者 = 2
A 取消等待 → A 的 Promise 结束，等待者 = 1，请求继续
B 也离开 → 等待者 = 0，向共享请求发送取消信号
```

每个等待者用自己的 signal 与共享 Promise 竞争。清理共享映射前还比较记录身份，避免旧请求结束时删除后来建立的记录。底层刷新不响应取消时，包装 Promise 可以结束，实际请求仍可能继续；这个协调器不能强制终止任意提供商代码。

[model-selector.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/model-selector.ts) 先展示可用目录快照，再后台刷新，默认限时十五秒。关闭时设置 `closed`、清除定时器并取消自己的等待；更新画面前检查关闭状态。搜索时把提供商信息放在匹配文本前面，避免查询提供商时被模型 ID 中相似片段主导；空搜索优先保留当前模型位置。

[scoped-models-selector.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts) 用 `null` 表示全部可用模型，用字符串数组表示显式、有顺序的选择。暂时不可用的已配置 ID 仍保留显示与顺序，避免一次目录失败就把配置删掉。主控制器记下用户是否已改过选择；刷新回来后，不用旧配置覆盖这些交互修改。

更改选择立即更新当前会话；保存快捷键才写默认设置。两者不能混为一谈。代码将“没有可用的显式选中模型”映射为 `session.setScopedModels([])`，而空会话范围表示没有范围过滤，不能按字面解释成禁止所有模型。选择器的保存回调也不等待磁盘提交确认；设置持久化仍按第十五章的机制执行。

## 20.16 会话列表：加载身份、缓存与删除

[session-selector.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/session-selector.ts) 分别保存当前工作目录和全部目录的列表、加载控制器。切换范围只改变当前展示；另一范围可以继续加载并更新自己的缓存。

`loadScope()` 先拒绝同一范围重复启动，再建立控制器。进度、成功和失败回调都检查 `isActive()`：对应字段是否仍等于这次控制器。取消加载先发取消信号，再清空控制器字段；即使底层忽略信号，迟到结果也过不了身份检查。

搜索输入、列表进度与选择位置也会交错。用户已移动过选择时，`setSessions()` 尽量按会话路径保留选中项；尚未交互时可以采用新列表的默认位置。这里的“身份”是路径或对象，不是把一切异步工作塞进同一个锁。

[session-selector-search.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/session-selector-search.ts) 将会话 ID、名称、消息文本和工作目录拼成搜索文本。普通词逐个模糊匹配，所有词都要满足；双引号包围的短语按连续文本匹配；`re:` 使用忽略大小写的正则表达式。无效正则不匹配。这个正则路径没有执行时间上限，不能宣称它能安全处理任意复杂的表达式。

无搜索的 threaded 排序按父会话路径建立树，以各子树最新活动时间排序；有搜索时采用匹配结果列表。它与 `/tree` 的“同一日志内部的条目树”不是同一个结构。

删除先经过确认，并拒绝删除选择器打开时的当前会话。实现先同步尝试 `trash`，失败后使用 `unlink()`；后者是永久删除。成功后更新两个缓存，再取消旧扫描并重新加载。不存在把删除、扫描和界面刷新合成磁盘事务的步骤。改名则由主控制器打开该日志并追加 `session_info`，仍受第十三章的追加日志边界约束。

普通选择或取消路径清除状态定时器并取消扫描；但这个组件没有统一 `dispose()`，主控制器也没有为它提供 disposer。不能把模型选择器的完整取消清理保证推广到每个选择器被其他界面替换的场景。异步改名和删除同样没有因界面关闭而自动回滚的保证。

## 20.17 日志树怎样过滤而不丢失导航关系

[tree-selector.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/tree-selector.ts) 先用显式栈遍历条目树，优先排列包含当前树叶的分支。显式栈替代深层递归，避免很长的会话链耗尽函数调用栈。连续的单子节点链尽量保持平直，分叉点再增加缩进。

过滤会隐藏中间条目。例如 `用户 A → 工具结果 B → 用户 C` 在“只显示用户”模式下变成 `A → C`。`recalculateVisualStructure()` 为每个可见条目沿原父链寻找最近可见祖先，建立 `visibleParentMap` 和 `visibleChildrenMap`，再重算连接线。它只重建展示关系，没有改写日志中的 `parentId`。

当前选择消失时，沿原父链寻找最近可见条目；找不到则选择最后一个可见项。折叠使用条目 ID 集合隐藏后代，改变搜索或过滤模式会清除折叠。快捷键可以移动到可见分支段起点，导航依据的是过滤后的映射。

“全部”模式也不是逐条展示每个日志记录：`usage` 始终隐藏，无文字且正常结束的纯工具调用助手条目通常也隐藏，当前树叶例外。树搜索使用小写、按空白分词的包含匹配，与会话列表的模糊、短语和正则搜索不同。

很深的分支会占满横向空间。水平视口保留左侧两列选择标记，只在选中条目的内容起点太靠右时平移主体，并按终端列裁剪。复制取完整文本；显示与搜索中的消息提取通常只取前二百个 JavaScript 字符。显示长度、搜索范围和复制内容因此不同。

标签编辑先更新本地树对象，再调用保存回调；这不是“等待落盘成功后才改画面”的事务式界面。父组件负责日志写入，修改后下一次过滤才能重新计算标签相关筛选。

## 20.18 设置菜单与资源开关的提交边界

[settings-selector.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/settings-selector.ts) 主要负责选项、当前值和回调。改变一个布尔值会立即调用对应回调；设置菜单自身没有统一保存事务。主题子菜单是局部例外：可以预览固定主题或明暗配对，取消时恢复进入菜单时的主题设置，确认时才向外返回选定值。

[settings-submenu.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/settings-submenu.ts) 的分步菜单用上下文对象保存已选值，后一步选项可以依赖前一步。例如先选模型，再按该模型支持的思考等级生成候选。完成回调接收上下文副本；回调没有被统一 `await`，所以不能将“菜单回到上一步”视为异步业务提交完成。

[config-selector.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/config-selector.ts) 按来源、作用域和资源类型分组扩展、技能、模板和主题。全局模式写资源启用或禁用模式；项目模式有 `inherit`、`load`、`unload` 三种状态。继承意味着采用全局资源状态，不等于强制启用。

覆盖继承的本地包时，项目配置可以建立 `autoload: false` 的包条目，只指定需覆盖的资源；去除全部过滤且该条目仅用于覆盖时，再去除这个条目。匹配资源时使用规范化路径作为键，包内模式使用相对包根的路径。这个界面改的是配置，真正加载哪些模块仍由第十七章的资源解析、信任和重载流程决定。

登录界面的 [login-dialog.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/login-dialog.ts) 还拥有自己的取消控制器，取消会拒绝当前输入等待者。它只保存一个输入 resolver，不提供并行提示队列。输入组件是普通可见输入，提交后还会显示提交文字；不能把它当作通用的密码遮罩组件。

## 20.19 原生剪贴板：工作线程、互斥与迟到结果

JavaScript 的异步函数不会自动让原生同步 API 变得异步。[clipboard.h](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/tui/native/clipboard.h) 为每次操作分配 job，创建 N-API 异步工作与 Promise：工作线程执行操作，主线程完成回调才创建 JavaScript 字符串或 Buffer，结算 Promise 并释放内存。工作线程不能调用 N-API。

Linux 的 [clipboard-worker.h](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/tui/native/linux/src/clipboard-worker.h) 又分两层。一个 Node 工作线程最多等待三秒；真正的 X11 读取由私有、分离的线程执行。`worker_mutex` 保护 busy、waiting、finished 和结果交接；条件变量等待期间释放互斥量，让私有线程能报告完成。

```text
调用 A → busy = true → 私有线程读 X11 → Node 工作线程有界等待
调用 B → 发现 busy → 返回 unavailable，不再启动读取线程
A 等待超时 → waiting = false，busy 保留
私有线程迟到 → 释放结果内存，busy = false
```

保留 busy 是必要的：旧读取尚未结束，若立即复用同一个结果槽，会被迟到线程覆盖。这里超时并没有杀掉线程，也没有无限创建替代线程。[linux-platform-x11.c](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/tui/native/linux/src/linux-platform-x11.c) 为目标发现、回复和分块传输共用两秒截止时间，累计数据最多五十 MiB；连接与刷新仍是私有线程中的库调用，不能把这一传输截止时间扩大成所有原生调用绝对按时返回的保证。

Windows 原生后端在工作线程里打开系统剪贴板，失败最多重试十次，每次间隔五毫秒；写入创建同线程拥有的窗口，并把成功交给系统的文本内存所有权留给系统。读取图片优先 PNG，否则将 DIB 加上 BMP 文件头，之后由应用层转换。macOS 后端使用系统 pasteboard，支持文本、图片与文件 URL。这些系统所有权与内存规则，与 Linux 的私有线程互斥不是同一机制。

应用层 [clipboard-image.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/clipboard-image.ts) 特意区分 `undefined`（后端不可用）和 `null`（后端成功但没有图片）。Wayland 成功返回空时，不继续读取可能陈旧的 X11 图片；WSL 另有 Windows 图片回退。命令回退由 [clipboard-command.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/clipboard-command.ts) 限制时间与输出容量，使用 `settled` 防止超时、错误与退出事件重复结算。

复制文本先等待直接写入，再按需要发送 OSC 52 终端序列，避免同次调用的两条写入路径互相争抢。OSC 52 只证明发送了序列，不能验证终端已更新剪贴板；单次路径的顺序也不等于所有并行复制调用有全局锁。

## 20.20 动画也必须服从组件生命周期

[armin.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/armin.ts) 将每两个纵向像素合成一个半块字符，定时修改网格，以网格版本和宽度缓存渲染；完成或 `dispose()` 时停止定时器。

全屏 [easter-egg-3d.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/modes/interactive/components/easter-egg-3d.ts) 把已绘制屏幕解析成带颜色的字形单元，用每个盲文字符的八个点绘制方块模型。光线与方块面求交，深度缓冲选择最近的面；复用缓冲区，只清理上帧脏区域，并量化颜色减少终端转义序列。动画是浮层，底下的会话仍继续运行。定时器不保活进程，退出完成或超过一秒未被渲染时结束。

按需加载入口在导入前截取屏幕；真正播放函数等待终端颜色后再次检查浮层状态。这个再次检查处理“等待期间另一个弹窗打开”的竞争，不能只检查等待之前的画面状态。

## 20.21 核验与练习

已在本次源码基准上提取实际的 TUI 引用函数与选择器方法，做了五组不依赖真实终端的小型检查：当前方法接收对象、提前保存的方法在切换后转发、属性与原型转发、旧选择器完成不覆盖新选择器、当前选择器完成恢复编辑器。检查通过。模型请求、真实剪贴板和终端集成没有在这些实验中执行。

1. 模型同时调用两个同名工具，为什么组件映射必须用调用 ID？
2. 按一次中断键，怎样判断是关闭补全、取消模型、取消压缩还是清空命令输入？
3. 选择器身份检查为何能防止旧关闭回调，却不能回滚已执行的模型切换？
4. 压缩失败后恢复文字批次，为什么不能称作扩展副作用的事务回滚？
5. 主题设置为终端自动明暗配对，颜色查询超时后收到回复，会有哪些状态更新？
6. 外部编辑器为什么需要停止 TUI？独立临时文件解决了哪些冲突，又没有解决哪些冲突？
7. 分别画出正常退出、SIGHUP 退出和终端 EIO 退出的清理顺序，解释差异。
