# 第十六章 扩展怎样加载、拦截事件和控制会话

## 16.1 问题：修改功能不应总要改代理核心

用户可能希望加入一个工具、把特定输入转成另一种提示、拒绝危险命令，或改变工具结果的显示方式。这些需求发生在不同阶段。如果把它们都塞进代理循环，核心代码会同时承担业务规则、界面和第三方适配。

Pi 让扩展通过注册工具、命令、事件处理器和渲染器接入。扩展是一个导出工厂函数的 TypeScript 或 JavaScript 模块。工厂接收 `ExtensionAPI`，注册能力；运行器在相应事件发生时调用处理函数，并提供当前上下文。

一个教学示例只转换输入，不调用模型或工具：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("input", (event) => {
    if (!event.text.startsWith("问:")) return;
    return {
      action: "transform",
      text: `请解释以下代码问题：${event.text.slice(2)}`,
    };
  });
}
```

这里返回的转换结果交给下一位输入处理器，最终成为代理输入。它与 `registerCommand()` 注册一个由用户显式调用的斜杠命令，是不同的入口。

## 16.2 代码地图与三种对象

| 源码 | 核心入口 | 职责 |
| --- | --- | --- |
| [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/extensions/types.ts) | `ExtensionAPI`、`ExtensionContext`、`ToolDefinition`、事件类型 | 定义扩展可用的注册、动作、上下文和结果 |
| [`loader.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/extensions/loader.ts) | `loadExtensionModule()`、`initializeExtension()` | 导入模块、执行工厂、暂存部分注册和管理缓存 |
| [`runner.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/extensions/runner.ts) | `ExtensionRunner`、各 `emitXxx()` | 绑定宿主动作，按事件规则分派处理函数 |
| [`jiti-loader.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/extensions/jiti-loader.ts)、[`jiti-static-loader.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/extensions/jiti-static-loader.ts) | `createJiti` | 按运行环境选择模块加载入口 |
| [`virtual-modules.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/extensions/virtual-modules.ts) | `VIRTUAL_MODULES` | 把扩展导入的 Pi 与 TypeBox API 绑定到宿主模块 |
| [`wrapper.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/extensions/wrapper.ts)、[`tool-definition-wrapper.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts) | `wrapRegisteredTool()`、`wrapToolDefinition()` | 把扩展工具适配成核心 `AgentTool` |
| [`resource-loader.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/resource-loader.ts) | 最终扩展集合 | 发现、来源、替代和冲突；详见第十七章 |
| [`agent-session.ts`](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/agent-session.ts) | 扩展绑定与工具管线 | 把扩展动作落实到会话、模型和历史 |

要区分三个对象。`Extension` 保存某个扩展的 Map 和处理器数组；`ExtensionRuntime` 保存一组扩展共享的宿主动作与注册状态；`ExtensionRunner` 负责事件分派和上下文创建。每个工厂拿到的 API 可以不同，但动作最后委托给共享 runtime。

## 16.3 导入 TypeScript 与宿主模块共享

Node.js 运行时有源码、普通编译输出、捆绑 Node 分发、Bun 二进制和 SEA 等路径。SEA 是把应用装入 Node 可执行程序的部署方式。扩展加载器据此选择 Jiti 的普通或静态入口；Jiti 是能加载、转换模块的工具，不能被当作安全沙箱。

源码 TypeScript 路径使用虚拟模块和 tsconfig 路径解析；嵌入式运行环境使用虚拟模块并限制原生导入尝试；普通 dist 环境主要使用别名。虚拟模块把 Pi 包和 TypeBox 的导入指向宿主已经使用的模块，避免扩展带进另一套独立注册表。

这一版本还接受原有包名别名，并把扩展导入的 `pi-ai` 根入口指向兼容入口。它是当前实现的模块解析行为，不代表新增功能都应继续设计兼容层。

模块默认导出必须是函数。工厂可以同步完成，也可以返回 Promise；加载器会等待工厂结束。一个扩展失败被记录后，仍继续加载后续扩展，结果集合包含成功扩展与错误列表。

扩展运行在宿主进程中，可以导入 Node.js 能力。它与第二十三章 QuickJS 脚本环境不同。扩展作者直接 `writeFile()` 或启动进程时，不会自动经过代理的文件修改队列；要使用同一工具规则，需走会话工具管线。

## 16.4 缓存的是工厂，不是一次会话的注册对象

加载器的缓存 Map 按解析扩展路径保存工厂函数。缓存与规范化工作目录关联，换目录会清空；显式清理也会递增 generation。generation 是一代缓存的编号，用来让较早的异步导入不能在缓存清理后重新写入旧结果。

```text
A 开始导入，记住 generation = 3
reload 清空缓存，generation 变为 4
A 导入完成 → 发现代数值不同 → 不写回 generation 4 的缓存
```

每次需要扩展实例时仍重新执行工厂，建立新的注册 Map。复用工厂不等于复用旧事件处理器集合。工厂导入成功后可进入缓存，后面的工厂执行即使失败，也不自动删除这个工厂缓存。

缓存没有按路径保存“正在导入”的共享 Promise，所以并发缓存未命中不保证只导入一次。Jiti 创建时设置 `moduleCache: false`；这也不能证明所有外部模块副作用都被系统撤销或隔离。

Jiti 与虚拟模块的加载 Promise 有另一份全局懒加载缓存。清理扩展工厂 Map 不会同时清除这些 Promise。需要把不同缓存的对象和生命周期说清楚，不能把 `/reload` 概括为“整个进程重新开始”。

## 16.5 工厂加载的暂存与失败清理

`createExtensionAPI()` 把工厂阶段分成 `loading`、`active`、`failed`。注册工具、命令、处理器等先写当前扩展对象；标志默认值和提供商、MCP、虚拟模型的部分共享状态变化先暂存。

成功执行工厂后，`commit()` 写入尚未设置的标志默认值，应用暂存的共享变更，再把 API 设为 active。工厂失败时，`discard()` 将 API 标为 failed，取消加载阶段记录的事件总线订阅，丢弃仍待提交的变更。

这个设计解决一个具体问题：失败扩展不应轻易留下一个有效的事件总线订阅，继续响应其他扩展消息。但暂存不是对所有副作用的事务。`pi.exec()`、事件总线发消息和扩展自行执行的 Node.js I/O，不会因此回滚；`commit()` 如果在应用若干变更之后抛错，已经应用的变更也没有完整撤销过程。

许多动作在加载期间只是抛错的占位函数，例如发送用户消息、修改会话名或取得当前上下文。注册工具此时有效，`refreshTools()` 只是尚无需刷新宿主的空动作。不能在工厂阶段假设一个运行中的会话已经绑定完成。

## 16.6 bindCore 把 API 接到真实会话

`bindCore()` 把发送消息、追加条目、切换模型、设置活动工具等函数安装到共享 runtime。上下文的模型、信任、取消信号、是否空闲、压缩和工具执行，也由宿主提供。

加载阶段排队的提供商和虚拟模型注册逐项应用；单项出错会发扩展错误，然后继续其他注册。绑定后注册通常立即生效，无须重载。注册 MCP 服务器后发目录变更事件，让负责连接的扩展接手；没有任何扩展处理时则报告“已注册但无人连接”。

这里的 `sendUserMessage()` 和 `sendMessage()` API 返回 `void`。真实异步发送在宿主侧启动，失败通过错误路径报告。`await pi.sendUserMessage()` 不能据此等待模型运行完成。新会话替换后提供的 `withSession` 上下文则有自己的 Promise 形式消息方法，应按相应接口区分。

注册和绑定之间不是把扩展函数全部复制成独立服务。扩展仍共享进程、模型注册表以及所在会话的状态；事件或后台工作要自己管理生命周期。

## 16.7 普通、工具和命令上下文

| 上下文 | 除公共能力外增加什么 | 适用场景 |
| --- | --- | --- |
| `ExtensionContext` | 当前 UI、模式、目录、模型、信任和会话只读视图 | 事件和基础扩展操作 |
| `ExtensionToolContext` | 可调用工具集合、`executeTool()` | 真实工具执行，以及组合其他工具 |
| `ExtensionCommandContext` | 等待空闲、新会话、分支、切换、树导航、重载 | 用户发起的命令 |

工具上下文里的嵌套调用使用父调用编号与递增子编号，通过同一参数准备、检查和拦截管线。普通工具失败、未知工具、检查失败或拦截失败通常返回 `isError: true`，调用者要检查结果；它不是所有失败都让 Promise 拒绝的接口。

取消信号默认继承父工具，可显式覆盖。嵌套调用不会增加一个独立顶层对话工具消息，而是把有大小限制的记录附到父工具结果；详见第八章。

普通上下文的 `sessionManager` 在类型上提供只读视图，运行时交回的仍是宿主对象。只读 TypeScript 接口不等于操作系统权限隔离或深冻结。

没有 UI 时，默认选择返回 `undefined`、确认返回 `false`，状态显示等为空动作。RPC 可以有对话 UI 而没有终端组件，所以应同时理解 `hasUI` 与 `mode`，不能把“有 UI”一律当成“能用 TUI 自定义组件”。

## 16.8 旧上下文为什么必须失效

考虑一个命令：先 `await ctx.newSession()`，再使用旧 `pi` 发消息。如果这份 API 仍绑定旧 runtime，就可能把状态写回已关闭会话。Pi 用失效标记解决这个身份问题。

上下文大多数字段是延迟 getter，每次读取检查运行器是否仍有效。创建命令上下文时，用属性描述符复制这些 getter；如果使用 `{ ...ctx }`，展开会立刻读值并把 getter 变成普通属性，之后就可能绕开失效检查。

新会话、分支或切换后，需要在 `withSession` 中使用传入的新上下文。重载后也不应继续使用旧上下文。runtime 失效同时清理它追踪的事件总线订阅。

失效标记不能中止扩展已启动的任意文件 I/O、定时器和网络操作，也不能清除扩展另存的全部普通对象引用。它保护的是受检查的 API 使用，不是一份通用进程撤销机制。

## 16.9 一次分派按顺序等待，多次分派没有全局锁

事件分派首先复制各扩展当前处理器数组，再按扩展加载顺序和注册顺序逐个 `await`。这个快照解决“处理器在事件中注册或取消另一位处理器”的问题：当前分派继续使用开始时的名单，改变到下一次分派才体现。

```text
开始时名单：[A, B]
A 执行时取消 B、加入 C
当前事件仍执行 A、B
下一事件执行 A、C
```

这里没有覆盖全部 `emit()` 的互斥队列。两个事件如果从不同异步路径同时开始，各自的处理器链仍可以交错。处理器内部共享计数器、缓存或外部文件时，不能因为“同一事件按顺序 await”就假定没有并发。

例如两个处理器任务都读取计数器 1，在 `await` 后写入 2，仍会丢失一次更新。扩展应按具体共享状态采用队列、最新版本检查或持久化锁；不要把事件顺序当成万能互斥。

## 16.10 事件返回值与错误规则对照

| 事件路径 | 多处理器结果规则 | 处理器抛错时 |
| --- | --- | --- |
| 普通生命周期 | 顺序通知，多数返回值忽略 | 通常报告错误后继续 |
| `session_before_*` | 最后有结果者生效；首次 `cancel` 停止 | 报告后继续 |
| `project_trust` | 第一个非 undecided 决定获胜 | 收集错误后继续 |
| `input` | transform 逐次传递，handled 立即停止 | 报告后继续 |
| `tool_call` | 参数可原地修改；首次 block 停止 | 异常直接传播，阻止执行 |
| `user_bash` | 第一个有效替代执行或完整结果获胜 | 报告并重新抛出，不能回退本地执行 |
| `tool_result` | 每个指定字段逐次修改 | 报告后继续 |
| `message_end` | 替换消息依次传递，必须保留 role | 报告后继续 |
| `before_provider_request` | 返回非 undefined 就替换 payload | 报告后继续 |
| `before_provider_headers` | 原地修改 headers，返回值忽略 | 报告后继续，已做的修改可能保留 |
| `cache_warming_decision` | 最后一个 action 覆盖获胜 | 报告后继续 |

普通处理器捕获异常并继续，是为了避免显示、统计等扩展故障把所有会话事件中断。工具调用拦截器可能负责权限判断，异常传播则避免检查失败后继续执行工具。用户命令重定向同样不能在错误后悄悄执行本地命令。

“通常报告后继续”仍有具体边界：`emitError()` 对错误监听器是同步调用，没有给每个错误监听器再包一层隔离。错误监听器自己抛错，也可能终止上层路径。处理器返回类型也没有统一经过完整运行时 schema 校验；类型声明不能代替实际检查。

## 16.11 工具参数拦截：检查后允许修改，不再次校验

工具管线先准备参数、检查 schema，然后发 `tool_call`。处理器可以原地修改 `event.input`，后续处理器看见前面的修改。类型文件明确说明：修改之后不重新做参数校验。

具体例子：原始 `path` 是字符串，第一位处理器把它改成数字，第二位也未阻止，真实工具可能收到与原 schema 不符的数据。扩展修改参数时必须保持工具契约，不能假设系统会再替它检查一遍。

`block` 表示不执行这次工具。`terminate` 是阻止后希望代理停止继续运行的提示，不是立即杀掉其他已执行工具：只有当前批次所有最终工具结果都要求终止时，才采用对应提前结束规则。某次被阻止的调用不能自动撤销同批次其他工具已经产生的效果。

`readOnlyHint`、`idempotentHint` 等注解由工具作者提供，运行器没有验证这些承诺。权限扩展可以参考它们，但判断操作的实际风险仍需要结合参数和工具实现。

## 16.12 工具结果脱敏与结构化数据同步

`emitToolResult()` 创建浅事件副本，依次应用处理器返回的 content、details、structuredContent、isError 和 usage。省略字段通常保留原值。

一个特例很必要：替换 `content` 但未同时返回 `structuredContent` 时，旧结构化结果被删除。否则扩展把文字中的秘密删掉，原始结构化对象仍可能交给后续脚本或模型。

```text
原结果：content = "token=secret"，structuredContent = {token:"secret"}
脱敏处理器：只返回 content = "token=[redacted]"
后续事件：structuredContent 已删除
```

如果扩展确实想保留结构化结果，应同时返回经过检查的结构化值。这个规则不自动检查 `details`、图像或自定义对象中的秘密；脱敏范围要与实际交付路径相符。

修改模型可见结果也不撤销工具本身。比如 edit 已写入磁盘，再把结果标记 `isError`，文件不会因此恢复。

## 16.13 两个 context 事件怎样保护系统提示

模型请求前，运行器先 `structuredClone()` 整份消息，再执行上下文处理器。因此这条转换路径用于本次请求，不直接重写原会话历史。

普通 `context` 只看非 system 消息。若返回的消息列表身份和顺序不变，Pi 保留原来的所有 system 消息位置，保护模型能复用的缓存前缀；列表有删除、重排或替换时，则把当前合成的系统提示与工具状态放到开头，再附上转换后的对话。

检测依据主要是消息引用和数组顺序，不是对整个对象进行深比较。直接修改克隆消息的字段也会保留在本次请求中，但不必因此触发系统消息合并。

之后的 `context_with_system` 看完整消息，包括系统提示和工具声明。其返回按原样采用。如果移除了原来位于开头的 system 消息，会报告错误，但不会自动把它放回来。这个接口给扩展完整控制，也把维护有效提示和工具状态的责任交给扩展。

两种事件不是同义名称。只想裁剪对话时，先理解普通 `context` 的保护行为；需要接管完整请求上下文时，才承担第二种接口的责任。出错前对可变对象做的部分修改也没有统一回滚机制。

## 16.14 请求、提示与边界草稿的其他变换

`before_agent_start` 收到可变的标准化系统提示选项。后续处理器看到前面的字段修改，`systemPrompt` getter 动态渲染当前状态；返回的自定义消息逐个累积。返回完整 `systemPrompt` 则设置强制替换，之后渲染按这个完整值处理，而不只是新增一段普通 section。

`before_provider_request` 更晚，收到适配器构造的底层 payload，返回值本身就是替换 payload。不要误写成返回 `{ payload: ... }` 才生效的统一包裹形式。`before_provider_headers` 则只支持原地修改；返回一份新 headers 不生效，值为 null 的头部处理语义还要由模型适配层落实。

`turn_end` 和 `agent_before_settle` 可以提交会话条目草稿，要求继续一轮运行。运行器在每个处理器之后用宿主提供的 `buildContext()` 验证并预览草稿；后续处理器可以修复前面无效的草稿。最终仍无效时，返回空草稿且不继续。

草稿可包含自定义条目、自定义消息、上下文编辑或压缩条目。它们最后如何保存与投影见第八、十三章。草稿验证不是对工具外部副作用的事务：处理器自行修改磁盘不在这一草稿提交中。

`agent_end` 与 `agent_settled` 也不同。前者表示一次代理循环结束，后面仍可能自动重试、压缩或排队继续；后者表示这些自动后续处理已收敛。扩展统计完整请求结束时，应先辨别自己要观察哪个阶段。

## 16.15 注册冲突不能统一说成先到先得

| 注册类型 | 当前集合中的规则 |
| --- | --- |
| 工具、标志 | 跨扩展同名通常取先加载者 |
| 自定义消息、条目渲染器 | 找到的第一份匹配渲染器 |
| 同一个扩展自己的 Map 注册项 | 相同键可以覆盖前值 |
| 多份同名斜杠命令 | 保留各命令，生成调用后缀，如 `review:1`、`review:2` |
| 扩展快捷键 | 同键后加载者可覆盖；保留的内置动作不能被覆盖 |
| Markdown 转换器 | 按扩展顺序组成列表 |
| 工具渲染解析器 | 按顺序构成调用 `next()` 的链 |

两份 `/review` 存在时，裸 `/review` 不一定是有效扩展调用名；解析器生成后缀，并处理后缀本身的占用。界面应该展示解析后的 `invocationName`，不能只拿原始注册名派发。

快捷键冲突比较的是配置解析后的按键与规范动作 ID，按键名归为小写。部分编辑器全局动作被保留，其余内置动作可由扩展覆盖并产生诊断。不是在这里硬编码某个组合键永远不能用。

工具渲染器解析链允许某个扩展调用 `next()` 包装后续结果，也允许直接选自己的渲染方式；它甚至能显示当前未注册工具的历史调用。显示一个工具行，不等于该工具当前可执行。

## 16.16 工具定义中的五种暴露与执行策略

扩展 `ToolDefinition` 在核心工具字段之外，还包含提示摘要、指南、输出 schema、命名空间、注解、默认活动状态、模型工具展示调整和渲染函数。

`direct` 在活动时直接声明给模型并可嵌套调用；`model-only` 只让模型直接调用；`codemode` 和 `deferred` 注册后可嵌套调用，模型发现方式不同；`hidden` 不可到达。活动工具集合主要表达给模型声明什么，不能简单等同于全部脚本可调用能力。具体集合推导见第八、二十三章。

`prepareLoadout()` 可以修改模型看见的工具描述或隐藏某些声明，而会话仍保留活动状态与历史声明，用于恢复和树导航。模型请求时的外观与会话保存的活动状态因此需要分开追踪。

工具的 `executionMode` 可覆盖默认并行策略，但仍要结合核心代理批次调度和嵌套调用队列理解。它不自动把同路径文件写入变成跨进程事务。工具包装器本身主要复制执行字段、提供上下文，并不额外实现每个自定义工具的锁或输出 schema 验证。

## 16.17 UI 提示与事件总线的生命周期

运行器包装 select、confirm、input、editor、custom 等等待式 UI 方法，用深度计数在第一个提示开始、最后一个提示结束时发事件。事件排入微任务，不直接阻塞 UI 调用。

这个计数也会覆盖重叠的独立提示，不是一个串行对话框锁。界面如何排队或取消仍由具体运行模式实现。不能根据 `ui_prompt_start` 的一对开始结束事件，假定中间只存在一个实际提示。

`pi.events` 是扩展之间的共享事件总线，订阅由 runtime 追踪，失效时取消。它不是会话生命周期处理器的同一个名单，也不自动持久化消息。要保留分支相关状态，应使用自定义会话条目，再按当前分支恢复，而不是仅留在扩展闭包的全局变量中。

## 16.18 实验与修改练习

本章完整阅读扩展类型、加载器、运行器、模块入口与工具包装实现。还从源码原样提取运行器实现，在去掉 TypeScript 类型后以最小宿主对象运行七项隔离检查：输入链与短路、处理器快照、普通异常继续、工具异常传播、结构化结果同步删除、同名命令与工具优先级、旧上下文检查；均通过。

实验没有加载 Jiti、真实扩展包或整个交互界面，没有运行完整扩展集成测试。它验证被执行的方法行为，不替代真实模块解析和会话切换测试。

练习：

1. 为同一个输入注册三个处理器，中间一个返回 handled，预测哪些函数会运行。
2. 权限处理器出错时，为什么不应与普通统计处理器使用同样的容错策略？
3. 修改工具参数后没有二次校验，扩展应在哪些地方保持契约？
4. 为什么复制上下文时属性描述符比对象展开更重要？
5. 一个扩展重载后还有定时器运行，失效 API 能防止什么、不能防止什么？
6. 比较 `context` 与 `context_with_system` 对裁剪系统消息的处理。
7. 如果两个事件并发修改一个扩展的同一文件，应该复用哪一层队列，何时还需要跨进程文件锁？

完成这些轨迹后，再修改扩展系统时，应能指出变化发生在导入、注册、绑定、事件转换、实际副作用还是显示阶段，而不只是在接口列表中增加一个名字。
