# 第二十二章 MCP 怎样把远程工具接入代理

## 22.1 问题：工具不一定在代理进程里

第十章的 `edit` 直接在 Pi 所在机器上修改文件。如果另一个程序提供数据库查询、网页检索或业务操作，代理需要知道它提供哪些工具、怎样发送参数、怎样接收结果，以及断线后哪些操作可以重试。

MCP，即 Model Context Protocol，是本项目用于交换工具、资源和相关消息的协议。理解本章不需要先安装一个 MCP 服务器。可以先把它看成两个程序之间的约定：客户端发一个带编号的请求，服务器返回同一编号的响应；服务器也可以主动发通知或请求。

Pi 有两层实现：独立 [`packages/mcp`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/README.md) 提供协议、传输和 OAuth 登录；[`coding-agent/src/extensions/mcp`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/index.ts) 负责配置发现、连接管理、工具注册、会话提示和终端界面。后者不能被误认为协议本身的保证。

本章描述源码基准支持的协议版本。`LATEST_PROTOCOL_VERSION` 在该提交中是 `2025-11-25`，还接受 `2025-06-18`、`2025-03-26` 和 `2024-11-05`。这不是对教材阅读当天外部协议最新版本的判断。

## 22.2 代码地图

| 层次 | 源码 | 主要职责 |
| --- | --- | --- |
| 消息结构 | [`protocol/types.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/protocol/types.ts)、[`jsonrpc.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/protocol/jsonrpc.ts) | 工具、资源、能力、请求和错误的类型与基础校验 |
| 协议客户端 | [`client.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/client.ts) | 握手、请求编号、超时、取消、分页、服务器请求 |
| 传输接口 | [`transport.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/transports/transport.ts)、[`in-memory.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/transports/in-memory.ts) | 消息事件，以及不经过网络的双端测试传输 |
| 子进程传输 | [`stdio.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/transports/stdio.ts) | 启动程序，通过标准输入输出交换逐行 JSON |
| HTTP 传输 | [`streamable-http.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/transports/streamable-http.ts) | POST、服务器事件流、会话编号、断流续读、认证挑战 |
| 协议认证 | [`oauth`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/oauth/index.ts) | 发现认证服务器、PKCE、令牌交换与刷新、回调 |
| 配置与注册 | [`core/mcp-servers.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/mcp-servers.ts)、[`extensions/mcp/config.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/config.ts) | 配置检查、命名空间、全局与项目信任合并 |
| 应用连接 | [`runtime.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/runtime.ts) | 延迟建连、连接共享、目录刷新、重试规则 |
| 应用工具与资源 | [`tools.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/tools.ts)、[`resources.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/resources.ts) | 远程结果转成代理结果、输出限制、资源工具 |
| 应用认证 | [`oauth.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/oauth.ts) | 凭据文件、跨进程刷新锁、浏览器与手工登录 |
| 生命周期与界面 | [`index.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/index.ts)、[`ui.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/ui.ts)、[`log.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/log.ts)、[`cli.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/cli.ts) | 接入扩展事件、动态暴露、管理界面、日志和命令 |

## 22.3 JSON-RPC：先把消息与运输方式分开

JSON-RPC 是用 JSON 表达远程调用的约定。教学示例中，请求与响应如下：

```json
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"lookup","arguments":{"key":"a"}}}
```

```json
{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"found"}]}}
```

`id` 用来关联请求与响应。两个请求可以同时发出；编号 8 的响应可以先于编号 7 到达。没有 `id`、只有 `method` 的消息是通知，不要求响应。错误响应使用 `error`，不能同时带 `result`。

[`jsonrpc.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/protocol/jsonrpc.ts) 接受字符串或有限数值编号，校验单个消息的基本形状。它没有实现一个通用批量调用调度器。HTTP 收到 JSON 响应数组时会逐项解析，这不等于客户端全面支持 JSON-RPC 批量请求。

传输层只需要实现 `start()`、`send()`、`close()` 和消息、错误、关闭订阅。客户端因此不需要关心当前消息来自子进程的一行字节，还是 HTTP 事件流。

`InMemoryTransport` 用 `structuredClone()` 复制消息，再通过微任务交给另一端。复制可以避免测试双方意外共享同一个可变对象，但不模拟真实网络延迟、认证或操作系统进程管理。

## 22.4 握手与客户端状态

`McpClient` 的状态依次是 `idle → connecting → connected → closed`。同一个实例只能从 `idle` 建连；关闭后要重建客户端，不能重新调用它的 `connect()`。

握手按以下顺序执行：

1. 先订阅传输事件，避免启动后第一条消息丢失。
2. 调用传输的 `start()`。
3. 发送 `initialize`，包含协议版本、客户端信息和能力。
4. 校验服务器信息、能力和返回版本，并把版本交给传输。
5. 发送 `notifications/initialized`。
6. 最后把状态设为 `connected`。

在此之前，普通 `request()` 不可用。内部握手请求单独允许在 `connecting` 中发送。任何一步失败都会关闭客户端并抛出错误。

客户端默认处理服务器发来的 `ping`；如果配置了工作目录根列表，还处理 `roots/list`。其他服务器请求需要显式注册处理函数，否则返回“方法不存在”。类型中列出某种能力，并不代表 Pi 默认实现了该能力的所有行为。

根目录在协议中是客户端提供的上下文信息，不能替代服务器自身的文件访问权限检查。

## 22.5 并发请求的核心是 pending 表

[`requestInternal()`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/client.ts) 分配递增编号，并把每个请求的完成函数、失败函数、计时器和取消监听器放入 `pending` 表。先登记，再调用 `transport.send()`，这样快速响应也能找到等待者。

```text
pending[7] = 请求 A 的 resolve/reject、timer、signal
pending[8] = 请求 B 的 resolve/reject、timer、signal

收到 response(8) → 删除 pending[8] → 只完成 B
收到 response(7) → 删除 pending[7] → 只完成 A
```

这里没有一个“所有请求依次执行”的全局锁。请求可以并发，服务器决定自己的执行方式。传输的 `send()` 完成也不是“业务操作已经执行完毕”：对于标准输入输出，它主要表示写入回调完成；对于 HTTP 事件流，它可能表示已开始消费响应流。

响应到达时，客户端先删除登记、清理计时器和监听器，再完成 Promise。连接关闭会拒绝所有待响应请求，并取消正在处理的服务器请求。关闭通知只触发一次。

传输发出错误事件时，客户端只是报告错误；真正的传输关闭才统一拒绝等待者。因此一行无效日志不会自动摧毁所有其他请求。取消之后到达的旧响应也不会重新完成调用，它会被报告为“未知请求编号”。

## 22.6 超时、进度和取消的保证

独立客户端默认请求超时是 30 秒；代理集成默认配置是 60 秒。`onProgress` 存在时，客户端在请求 `_meta` 中加入 `progressToken`，并建立进度编号到请求编号的映射。收到对应进度通知后，会重新启动该请求的超时计时器。

具体例子：请求超时设为 60 秒，服务器每 30 秒报告一次进度。请求可以运行超过一分钟，因为每次进度都会续期。这个超时约束的是等待进度或结果的间隔，不能当成整个操作的最长执行时间。非正数或非有限的超时值在客户端层不启动计时器；代理配置只检查正数，不能推导为所有配置都受有限总时长限制。

取消或超时时，客户端执行：删除待响应项、拒绝本地 Promise，然后尽力发送 `notifications/cancelled`。握手的 `initialize` 不发送取消通知。

需要区分三种事实：

| 事实 | 本实现能否据此保证 |
| --- | --- |
| 本地调用者不再等待该结果 | 可以，Promise 已拒绝 |
| 服务器知道客户端想取消 | 只有通知成功送达时；发送是尽力而为 |
| 服务器停止执行且撤销已产生的修改 | 不能；取决于服务器是否协作及业务实现 |

HTTP 的单个请求取消不会直接中断传输共享的 `fetch`。传输自己的 AbortController 面向整个连接。服务器请求处理函数收到的取消信号也只是一种协作约定；处理函数忽略它时，仍可能继续运行并返回。

这与第十一章的文件队列、第十二章的子进程终止是不同层次的机制。不要把“调用已取消”写成“所有外部效果已回滚”。

## 22.7 工具目录和结果：协议成功不等于工具成功

`listTools()` 按 `nextCursor` 连续取页，直到无后续游标。客户端记录已用游标，重复游标立即报错；页数上限为 1000，防止错误服务器让客户端无休止取页。资源与资源模板采用同一类分页逻辑。

这些结果检查主要验证必要外形，例如工具名和输入 schema 是对象，并没有对全部嵌套内容做完整协议 schema 校验。泛型 `request<Result>()` 也只是 TypeScript 类型表达，不能自动验证远程 JSON。

远程工具失败有两种不同表现：

```text
JSON-RPC error → client.callTool() 拒绝
result.isError = true → client.callTool() 正常返回一个工具结果
```

第二种表示传输与方法调用已经成功，失败发生在工具业务中。代理集成再把 `isError` 转成自己的工具失败标记。第二十三章的脚本调用会收到带 `isError` 的结构化对象，调用者应主动检查它；不能只依靠 `try/catch` 判断所有工具是否成功。

`readOnlyHint`、`destructiveHint` 等工具注解是服务器提供的提示。Pi 可以转交这些提示，但它们不是操作权限检查，也不是业务只读性的证明。

## 22.8 标准输入输出传输：按行分帧，不按 read 事件分帧

`StdioTransport` 用 `cross-spawn` 启动命令，把 JSON 加换行写入子进程标准输入，从标准输出收集逐行消息。一般按命令和参数直接启动；Windows 的命令包装是平台适配细节。

问题是一次 `data` 事件可能只包含半个 JSON，也可能包含三个完整 JSON；一个中文字符的 UTF-8 字节也可能被拆到两次事件中。因此实现保留 Buffer，找到换行后才把完整行转为文本、解析 JSON。空行忽略，行尾允许 CRLF。

```text
第一次读取：{"jsonrpc":"2.0","id":
第二次读取：7,"result":{}}\n{"jsonrpc":...

先拼接字节，再按换行解析；第二条未完成消息继续留在缓冲区。
```

单行或未换行缓冲区上限是 16 MiB。解析失败、标准输出混入普通日志、超长行都会报告错误；这些情况不等于连接立即关闭。日志应写标准错误。标准错误保留最多 64 KiB 尾部用于诊断，实时回调仍可接收当次内容。

关闭过程先结束输入，让服务器自行退出；在宽限时间后发送终止信号，再安排强制终止。非 Windows 系统通过进程组尝试处理子孙进程，Windows 使用相应的 `taskkill` 路径。进程退出时会清理定时器，因此不能据此保证所有忽略终止信号的后代最终都被杀死。

标准输入输出只描述本地进程运输方式。启动命令、继承环境和当前目录仍会影响实际权限。项目 MCP 配置的信任要求正是因为配置可以启动程序，而不只是提供静态文字。

## 22.9 HTTP 和 SSE：断流续读不同于重复调用

HTTP 传输把消息 POST 到配置 URL，接受普通 JSON 或 `text/event-stream` 响应。SSE，即 Server-Sent Events，是服务器持续发送文本事件的格式：空行结束一个事件，多个 `data:` 行合并为事件数据，`id:` 可用于续读，`retry:` 可给出重连等待时间。

[`consumeSseStream()`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/transports/streamable-http.ts) 用流式 TextDecoder 保留跨块字符，处理 CRLF、注释、多行数据和结尾剩余事件。待解析单行或事件的数据受 16 MiB 上限约束。SSE 的这个上限不自动适用于普通 JSON HTTP 响应；后者调用 `response.json()` 读取整个响应。

服务器给出的会话编号被保存，后续请求附带会话与协议版本头。完成初始化通知后，客户端还会打开后台 GET 流接收服务器消息；GET 返回 405 时，视为服务器不提供这个通道。

某个 POST 响应流在对应响应到达前断开，如果已经有事件编号，传输会用 `Last-Event-ID` 发 GET，尝试续读服务器保留的事件。这个过程没有再次发送原来的 `tools/call`。没有事件编号时，无法这样续读，会让对应请求失败。

默认重连采用递增等待，起始约一秒、常规上限三十秒，并有限制的连续失败次数；服务器的 `retry:` 提示可以改变等待时间。持续收到事件会重置重连失败计数，因此不能把重连次数限制解释为整条长连接的绝对寿命。事件编号也没有在客户端形成去重事务，续读不能被称作“恰好执行一次”。

认证挑战最多触发一次重试：第一次 401，或带 `insufficient_scope` 的相应 403，交给认证提供者处理，再带新令牌重新发送。同一轮第二次失败不继续循环。普通网络错误和 5xx 不是 HTTP `send()` 对所有 POST 的自动重发依据。

连接关闭会中断共享请求，并尽力发送 DELETE 结束服务器会话。DELETE 失败被忽略；客户端关闭不证明服务器状态已经清除。

## 22.10 配置合并、命名空间和暴露方式

代理读取用户代理目录中的 `mcp.json`，再读取受信任项目的 `.pi/mcp.json`。同名项目配置通常完整替换全局配置；只有启用状态或暴露方式的特殊覆盖，可以保留已有连接参数。项目层不能配置全局 OAuth 或认证提供者字段。

服务器名允许字母、数字、下划线和短横线。命名空间把短横线归一化为下划线，所以 `my-server` 与 `my_server` 不能同时作为独立服务器名出现：否则生成的工具名会冲突。

教学配置如下；文件使用严格 JSON，没有注释语法：

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.invalid/mcp",
      "exposure": "codemode"
    }
  }
}
```

暴露方式控制模型和脚本怎样发现工具：

| 方式 | 实际含义 |
| --- | --- |
| `direct` | 工具直接进入模型当前工具集合 |
| `codemode` | 可供脚本调用，通常通过代码执行说明发现 |
| `deferred` | 延迟发现，由工具搜索等路径激活 |
| `hidden` | 隐藏工具；不应被解释为服务器已经停止运行 |

默认方式是 `codemode`。服务器级方式还能被 `toolExposure` 覆盖：精确工具名优先，然后按配置顺序匹配带 `*` 的模式。通配模式不会自动按照“最具体”排序。

暴露方式是会话中的可见性与调用路径控制。真正的远程业务授权仍由服务器和凭据决定。配置中的环境、头部和命令参数也可能引用本地值或命令结果，项目能否信任必须结合第十七章的资源信任规则理解。

配置写入读整个 JSON、修改字段，再用同步写文件保存，保留原有缩进。这里没有第十五章凭据后端那样的文件锁，也没有临时文件加 rename 的原子替换。根据实现可推导：两个进程同时修改不同服务器配置仍可能互相覆盖，写入中断也不能获得事务恢复保证。

## 22.11 延迟建连、工具刷新和重试规则

[`McpServerConnection`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/extensions/mcp/runtime.ts) 共享一个正在建连的 Promise。多个调用同时请求客户端时，复用该 Promise，而不是各自启动一个服务器；连接已关闭后则创建新客户端。这是应用连接层的重建，不是同一个 `McpClient` 实例重新握手。

HTTP 握手遇到部分暂时性故障会按 250 毫秒、一秒等待，最多尝试三次。标准输入输出不使用这组握手重试。建连后，工具列表按服务器能力获取；资源和模板发现失败可转为空列表，连接仍可能成立。

实际操作的重试要分开看：

| 情况 | 应用层行为 | 原因与边界 |
| --- | --- | --- |
| 普通工具调用发生暂时性 HTTP 故障 | 不自动按这一理由重发 | 服务器可能已经产生修改，重复调用可能重复副作用 |
| 只读资源操作发生符合条件的暂时性 HTTP 错误 | 可重连后再尝试一次 | 这里限于指定 HTTP 错误路径，并非所有异常都重试 |
| 服务器返回会话失效错误 | 新建连接后重试一次，包括工具调用 | 依赖服务器以会话失效表示该会话不能执行请求的约定 |
| 需要用户认证 | 标记认证需求，提示登录 | 不在普通工具调用中随意开启浏览器登录 |

目录变更通知会重新取工具或资源。发布结果前检查客户端身份，防止旧连接刷新覆盖新连接。但是同一个客户端上的多次刷新没有单调版本号：如果旧刷新后完成，仍可能覆盖较新刷新结果。这是根据异步执行顺序可推导的边界，不是已运行的竞态复现。

工具名通常是 `mcp__服务器__工具`。非法字符被清理，长度超过 64 或清理后冲突时附加 SHA-256 的短摘要并截断前缀。对于同一批已知重名工具，先预计算冲突，避免简单依赖列表顺序。

扩展 API 不能直接注销已有工具，所以删除的远程工具会重新注册成隐藏状态。会话当前活动工具集合也要同步调整，不能只换一个描述字符串。

## 22.12 第一次提示为什么有时等待服务器

MCP 扩展在会话开始后异步加载运行时并建立配置连接，让交互界面有机会先显示。生命周期使用代数值区分新旧启动，避免旧异步加载在会话切换后发布到新状态。

第一次提示主要等待配置为直接暴露的服务器，整体等待上限约十秒；间接工具不必阻塞第一次提示。系统提示加入受长度限制的服务器说明，展示已连接、待连接或需要认证等状态。

调用 `codemode` 时，扩展还会检查脚本文本。如果出现 `ALL_TOOLS`、搜索或描述工具的相关名称，会等待尚未完成的服务器发现；明确出现某个归一化命名空间时，可能只等待该服务器。它是字符串启发式，不是 JavaScript 语法分析：注释可能触发等待，计算出来的名称也可能未被识别。

`tool_search` 和三个资源工具的发现等待更广。这组工具前置等待使用调用信号取消，没有统一套用第一次提示的十秒限制。第二十三章脚本的 `timeout_ms` 在随后进入脚本执行时才生效，不能据此限制前置 MCP 发现阶段。

这说明“看见界面”“发现远程工具”“脚本开始运行”是三个不同阶段，不能用一个计时器名称概括。

## 22.13 结果怎样进入模型，资源怎样落地

服务器结果可以包含文本、图像、资源链接、内嵌资源和结构化数据。独立协议包的转换函数会保留支持的文本与图像，用占位文字表示不直接支持的音频或二进制内容；内容为空时可把结构化结果转为格式化 JSON。

代理集成进一步执行输出管理：模型文本合计超过约 20 KiB 时，保留中间截断后的预览，将完整内容写入随机临时文件，权限设为 `0600`。图像作为单独内容项保留，不由这个文本限额限制。

结构化脚本结果保留原始 MCP `CallToolResult`，只是去掉顶层 `_meta`；这不等于递归删除全部元数据。嵌套内容的附加字段仍可能存在，脚本结果也没有模型文本预览的同一截断。

资源链接默认只告诉模型资源名称和 URI，不会因为看见链接就自动获取资源。需要显式调用资源读取工具。文本类型的资源可解码为文字，其他二进制资源可能写成受权限限制的临时文件。

资源列表工具可指定服务器和游标取一页，也可汇总全部服务器。汇总用 `Promise.allSettled()`，一个服务器失败时仍返回其他服务器的结果，并附带错误列表。这样的部分失败结果不会自动标记成整个工具失败。

读取资源必须指定服务器和 URI。工具说明要求先从列表发现资源，但执行代码没有以当前列表建立 URI 白名单；实际可读取哪些 URI，由服务器决定。UI 应用相关资源在列表中被过滤，也不能据此推导成服务器侧访问控制。

## 22.14 OAuth：浏览器登录解决什么问题

OAuth 是让客户端获取服务器访问令牌的认证流程。最基本的轨迹是：发现授权服务器 → 获得客户端信息 → 在浏览器授权 → 收到授权码 → 用授权码换访问令牌 → 请求资源。访问令牌过期后，可能用刷新令牌换新访问令牌。

PKCE 是把授权请求与兑换请求绑定起来的机制。Pi 生成随机 `verifier`，计算 SHA-256 后的 `challenge`，授权请求发 challenge，兑换时提交 verifier。拦到授权码的第三方没有 verifier，不能只凭该码按同一流程兑换。另一个随机 `state` 用于把浏览器回调关联到本次登录，避免把无关回调当作成功。

[`discovery.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/oauth/discovery.ts) 发现受保护资源元数据和授权服务器元数据，并校验资源归属、发行者信息等。[`flow.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/mcp/src/oauth/flow.ts) 检查支持的流程、注册客户端或使用配置客户端、交换和刷新令牌。不能因为存在 URL 检查函数，就声称每个可配置 URL 都经历同样严格的检查；不同入口的验证规则不同。

核心流程对失效客户端或失效刷新令牌允许有限的一次清理再尝试；不是无上限的认证循环。权限不足时可以合并旧权限与挑战权限，发起更高权限授权，但普通运行时刷新不会自行开启新的用户登录。

本地回调服务器默认监听 `127.0.0.1` 的系统分配端口，按 `state` 找待完成登录，并检查预期路径、授权码和错误。已知 state 的回调会先从等待表移除；因此错误路径的同一 state 回调也可能消耗这次等待，不能无限重试该回调。关闭服务器会拒绝其剩余等待者。

代理还支持用户粘贴重定向地址。它检查地址的 origin、路径和 state，再取 code，与浏览器回调竞争完成。获胜后清理另一条等待路径。整个登录还涉及动态端口是否允许、已注册客户端能否复用、发行者返回参数和配置的客户端元数据，不能只用“打开浏览器并取一个字符串”概括。

## 22.15 凭据刷新有两种锁，登录退出仍有竞态边界

代理把 MCP 凭据保存到 `mcp-auth.json`，复用第十五章的 `FileAuthStorageBackend`。凭据键包含服务器命名空间与规范化 URL；相同 URL 的不同服务器名仍可有独立账号状态。全文件锁保护“读取最新文件、修改一个凭据键、保存整个文件”，防止不同服务器的写入互相覆盖。

但仅锁保存还不够。考虑两个 Pi 进程使用同一个一次性刷新令牌：

```text
A 读旧 refresh_token R
B 也读到 R
A 用 R 换到 R2 并保存
B 再用 R 刷新，服务器可能拒绝，或产生另一次轮换
```

应用层因此增加按凭据键派生文件名的刷新锁，把“重新读取凭据 → 判断别人是否已刷新 → 联网刷新 → 保存新凭据”放在同一锁内。进入锁后发现访问令牌已经变化，就复用新状态，不再刷新旧令牌。

同一个认证提供者还共享 `refreshing` Promise，使该实例内并发刷新复用结果。文件锁面向不同进程；Promise 面向一个提供者实例；凭据后端的文件锁面向单次文件更新。三者保护范围不同。

刷新锁的 stale 参数约 20 秒，重试间隔约 100 毫秒，并由锁库处理续期。该路径的锁受损回调没有终止正在进行的刷新，释放失败也被忽略。网络请求使用约 15 秒的单次超时，不是整个登录或刷新流程的总时限。自定义存储后端且未提供锁目录时，没有默认的这层跨进程刷新锁。

临近过期约三十秒时，有刷新令牌的提供者会尝试刷新；失败后可能继续使用存储里的旧访问令牌，交给下一次认证挑战处理。没有刷新令牌时也不能凭空生成新访问令牌。

需要把最后一个边界写清楚：登录与退出并未统一获取这把刷新锁。根据实现可推导，某个已开始的刷新在退出后保存结果，可能重新写回凭据；并发新登录也可能被较旧的刷新保存覆盖。全文件写入锁防止文件内容损坏，不能自动解决这些业务状态先后问题。

独立包的存储提供者还按 Promise 串行更新状态；这个队列只属于该实例，写入失败会让链上的后续操作继续失败。它不等于多进程凭据事务。

## 22.16 管理命令、日志和界面

`mcp add`、`remove` 修改配置；`list` 不只是读配置文字，它会连接启用的服务器、发现目录，再关闭连接。因此列出一个标准输入输出服务器可能实际启动本地程序。登录命令执行 OAuth 流程，不能在没有真实服务器和用户授权时被视为一个普通静态检查。

管理界面订阅连接和目录状态变化，更新列表时尽量保留当前选择，结束后清理订阅。快捷键走可配置键位体系。即使服务器尚未连接，历史工具调用也可使用 MCP 名称的后备渲染路径显示。

日志是尽力追加与轮转：大小约超过 5 MiB 时尝试改名为上一份日志。大小缓存主要统计该实例自己的追加，轮转也没有多进程互斥；所以这是诊断策略，不是全局严格容量或原子日志事务。

## 22.17 已核验什么，怎样练习

本章完整阅读独立 MCP 包的源码与测试，以及代理 MCP 扩展和服务器注册实现。使用仓库实际 `McpClient` 与内存传输运行了七项无网络实验，均通过：握手、乱序响应关联、进度续期、取消通知与迟到响应、工具 `isError`、重复分页游标、连接关闭与不可复用客户端。

这些实验没有调用付费模型，没有启动外部服务器，也没有执行完整 Vitest 套件。标准输入输出、HTTP、OAuth 测试的断言已阅读，但不能因此写成这些集成测试已经运行通过。

练习：

1. 为什么必须先把请求放入 `pending`，再调用 `send()`？画出反过来时快速响应丢失的轨迹。
2. 同一连接的两个请求，一个取消、另一个继续运行，需要清理哪些不同状态？
3. 服务器每十秒报告进度，客户端超时三十秒。这个工具能否运行五分钟？依据在哪里？
4. 分别解释 SSE 续读、HTTP 认证重试、应用资源重试和业务工具重发的不同含义。
5. 为什么锁住 `mcp-auth.json` 的保存，仍不足以保护刷新令牌轮换？
6. 为什么配置写入、目录刷新和登录退出不能直接继承凭据刷新锁的并发保证？

带着这些问题再读第二十三章，就能理解脚本并发调用远程工具时，哪一层负责等待、哪一层负责取消，以及哪一层仍可能产生不可撤销的外部效果。
