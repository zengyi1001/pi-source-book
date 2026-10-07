# 第三十章 遥测、安装归因与错误诊断

一个请求失败时，会话日志能回答“模型与工具说了什么”，却未必适合回答“操作从哪里开始、哪一步结束、哪一层失败”。遥测把一次操作表示为可嵌套记录；错误报告则组织诊断材料。二者与模型 usage、会话日志、终端输出不是同一种数据。

当前项目的 `packages/telemetry` 提供后端无关接口、无操作实现和内存参考实现。不能仅因 AI 请求选项包含 `telemetryContext`，就声称所有提供商已经自动生成并上传调用链。应用另有明确实现的安装上报、提供商归因头、崩溃日志和用户错误报告，本章逐条说明。

## 30.1 代码地图与数据来源

| 功能 | 代码 | 数据与用途 |
| --- | --- | --- |
| 遥测契约与类型推导 | `packages/telemetry/src/index.ts` | Span、属性、事件和 schema |
| 默认无操作上下文 | `packages/telemetry/src/noop.ts` | 执行业务回调，不记录数据 |
| 内存记录 | `packages/telemetry/src/memory.ts` | 测试及本地查看父子关系、结束顺序 |
| 适配器一致性 | `packages/telemetry/src/testing/conformance.ts` | 回调、状态、复制与被动记录约定 |
| 安装开关 | `packages/coding-agent/src/core/telemetry.ts` | 配置与 PI_TELEMETRY 的优先级 |
| 提供商归因 | `packages/coding-agent/src/core/provider-attribution.ts` | 合并特定提供商请求头 |
| 安装请求 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | `reportInstallTelemetry` |
| 崩溃记录 | `packages/coding-agent/src/core/crash-log.ts` | 本地最近错误与通知标记 |
| 错误报告 | `packages/coding-agent/src/core/bug-report.ts`、`bug-report-upload.ts` | 元数据、诊断、可选会话与摘要 |

模型 token 与价格累计已经在第五、八、二十六章讨论。它们是业务记录，不会因为 Span 状态为 ok 就自动变成真实账单核对结果。

## 30.2 Span 是什么

Span 表示一次有开始和结束的操作记录。它可以保存属性，例如提供商名称；可以追加事件，例如重试；可以启动明确以自己为父的子 Span。

教学简化代码：

```ts
await context.startSpan({ name: "edit" }, async (editSpan) => {
  await editSpan.startSpan({ name: "read-file" }, async () => {
    return await readFile();
  });
  editSpan.addEvent("replacement-selected", { count: 1 });
  await writeFile();
});
```

这个例子只演示接口，不表示 Pi 的编辑工具当前已有这些埋点。业务回调返回或拒绝时，参考实现才结束该 Span；如果回调只启动后台 Promise 而不等待，Span 会在背景工作完成前结束。

当前记录没有开始时间、持续时间或事件时间戳字段。内存实现记录的是开始顺序、父 ID 和结束序号。若要做耗时分析，需要具体后端增加相应能力，不能从名称“遥测”推导它已经存在。

## 30.3 为什么父子关系显式传递

假设操作 A 和 B 同时运行，各自请求模型。如果用一个全局变量保存“当前 Span”，A 暂停等待网络后，B 会改写变量，A 后续工具可能被错误归到 B。

本包把父上下文放在对象中。`parent.startSpan` 的闭包捕获 parent 的记录；根 `context.startSpan` 没有父 ID。没有全局“当前请求”变量，也不依靠 AsyncLocalStorage 自动寻找父操作。

```text
根 A ─┬─ 子 A1，先开始、后结束
      └─ 子 A2，后开始、先结束
根 B ─── 子 B1
```

IDs 在同步接纳时递增。每个回调可以并发等待；代码没有把全部 Span 回调放进一个串行队列。结束时才分配 endSequence，因此 A2 的结束序号可以小于 A1，而它们的 parentId 都仍是 A。

父子关系不等于结构化并发：父 Span 不自动加入所有子 Promise。读者要显式 await 子操作，才能得到“父结束前子已结束”的执行顺序。

## 30.4 开始回调不能因遥测关闭而消失

`NOOP_TELEMETRY_CONTEXT` 是冻结的共享对象。`startSpan` 立即调用业务回调，再用 Promise.resolve 包装结果；同步抛出转换为 Promise 拒绝，原拒绝值保持不变。addEvent、setAttributes、setStatus 都不做事，也不读取其参数。

这解决一个必要问题：关闭记录以后，程序应继续完成读取、工具执行和模型请求。无操作上下文关闭的是记录能力，不是业务回调。callback 返回的对象也不被复制或替换。

内存实现创建记录失败时回退到这套无操作行为。因此不可枚举的属性、抛错 getter 或错误对象检查失败，不应仅因遥测记录就让本来可执行的业务消失。这个被动性约定不等于 arbitrary 业务错误都被吞掉；callback 抛出的错误仍按原值返回给调用者。

## 30.5 内存实现的状态与结束

`InMemoryTelemetryContext` 每个实例独立维护 spans、nextSpanId 和 nextEndSequence。开始时保存 name、复制后的属性、空事件、默认 ok、settled=false。

callback 同步返回后通过 Promise 结算；异步回调在 Promise 完成后结算。没有显式状态时，失败自动设置 error，Error 对象提取 name/message，其他拒绝值只记录 error 状态。

显式 `setStatus` 最后一次成功设置的值优先。例子：

```text
setStatus(ok)
callback 随后抛出 Error
  → 业务 Promise 拒绝
  → Span 保留显式 ok
```

所以 Span.status 不是业务 Promise 是否成功的强制镜像。这个契约让应用能表达自己选择的诊断状态，也要求记录调用者正确使用它。返回 `{ok:false}` 本身不构成 JavaScript 抛错；想记录错误就应显式设置 error。

setter 在记录已经 settled 后直接返回。结束后借用旧 span 启动子操作，则使用无操作上下文：业务回调仍会执行，但没有新的内存记录。这防止迟到事件继续修改已经结束的记录，不能防止迟到业务操作本身。

## 30.6 属性复制与“原子更新”的具体范围

属性只支持 string、number、boolean 及这些类型的一维数组。内存实现复制数组，跳过 undefined。setAttributes 在临时副本里合并，完整复制成功后才替换记录；某个值不可读取而抛错时，本次合并没有部分采用。

例如已有 `{phase:"start"}`，更新包含 `{phase:"end", tags:不可读取数组}`。复制 tags 失败后，保留原来的 phase=start。事件属性也先复制成功才追加事件，失败不留下空事件。

getSpans 按开始顺序返回分离的快照，重新复制属性数组、事件和状态。修改快照不会改变内部记录。readonly 类型只是编译期约束，这里真正隔离外部修改的是复制。

这个“原子”是同步内存赋值范围的保证，不是跨进程事务、数据库提交或网络发送事务。属性也没有通用运行时 schema 校验；JavaScript 调用者越过类型约束传入其他结构时，不能依赖复制算法替代完整验证。

## 30.7 Schema 如何约束 TypeScript 调用

schema 为 Span 声明开始必需属性、结束可选属性、事件与属性闭集、允许父类型，以及 sensitive 和 cardinality 元信息。cardinality 指某个属性可能出现多少不同值：固定提供商名称通常较少，请求 ID 通常很多。

`defineTelemetrySchema` 返回原对象，没有转换或运行时验证。`createTypedSpanStarter` 从一个或多个 schema 推导每个 Span 的专属签名，利用映射类型、条件类型和重载集合关联名称与属性。

例如 operation 要求 kind=read/write，request 要求 provider。TypeScript 会拒绝给 request 传 kind、传未知事件、漏掉必需属性，或组合含重复 Span 名的 schema。若 Span 名是尚未收窄的联合类型，也要先根据名称分支才能保持属性关联。

运行时 starter 只调用上下文的 startSpan，并为 child callback 绑定新的 starter。schema 参数不被读取。因此 sensitive 不会自动触发脱敏，parents 不会自动阻止错误父关系，cardinality 不会自动限流；这些元信息需要具体记录、校验或导出后端采用。

## 30.8 当前接线与后端边界

AI 的 StreamOptions 有可选 telemetryContext，simple options 转换会转交它。完整源码检索中，生产 startSpan 的实际实现与 typed starter 位于 telemetry 包；不能据可选字段承诺每个模型适配器已经记录请求 Span。

本包没有云端 collector、HTTP exporter、采样器、持久队列、容量上限、自动脱敏或刷新上传定时器。内存 spans 随实例生命周期保留，创建大量记录会持续占用内存。默认 NOOP 不提供录制功能，也不自动初始化导出服务。

未来装配一个后端时，应保持回调只调用一次、业务结果保持原值、记录错误不替代业务错误，并明确生命周期和容量边界。一致性用例能核验部分接口契约，但不会替它证明联网传输、后台 flush 或隐私策略。

## 30.9 安装上报开关如何解释环境变量

`isInstallTelemetryEnabled` 在 PI_TELEMETRY 存在时使用环境变量，未设置才读 SettingsManager。精确 `1` 或不区分大小写的 true/yes 开启；其他值，包括空字符串和未识别文本，都关闭。代码没有 trim，所以带空格的字符串不自动当成 true。

设置中的 enableInstallTelemetry 默认 true。交互界面在首次记录版本或发现新的 changelog 条目时，调用安装上报；已有会话消息的恢复路径跳过该 changelog 初始化流程。上报是一个版本参数 GET 到 `https://pi.dev/api/report-install`，带 Pi User-Agent，5 秒取消超时，成功与失败都不阻塞界面，也没有持久补发队列。

这一调用读取 PI_OFFLINE 的真值，因此空字符串与任意非空字符串行为不同；其他模块可能检查变量是否定义，教材不会把全部环境开关统一成一个布尔解析规则。

## 30.10 归因请求头与会话请求头

启用安装遥测时，应用可以给 OpenRouter、Nvidia NIM 和 Cloudflare 模型请求加入应用来源头。它们随模型请求发送给目标提供商，不是 Span exporter。

合并顺序先放会话头，再放默认归因头，再按顺序 Object.assign 调用者提供的各组头。后面的同名键可以覆盖前面的值。模型判断有的使用 provider ID，有的用精确 hostname；OpenRouter 的另一判断是 baseUrl 子串，因此不能把所有目标识别都称为严格 origin 校验。

Opencode 的 `x-opencode-session` 和 `x-opencode-client` 来自独立的会话头逻辑，不经过安装遥测开关。关闭安装上报，不应被解释成删除所有业务请求中的会话标识。

SettingsManager 还分别保存默认关闭的 analytics 偏好、首次 opt-in 创建的 trackingId，以及首次使用创建的全局 deviceId。这些字段存在不证明某个 analytics 上传器已经实现。deviceId 忽略项目配置，避免所有克隆者从仓库配置取得同一个安装身份；它的写入行为遵守第十五章设置保存边界。

## 30.11 崩溃日志为什么只尽力保存

`recordCrash` 同步读取并写回 `crashes.json`，最多保留 5 条记录，包含时间、版本、错误类型、message、stack、会话文件和 cwd。整个过程包在 catch 中，记录失败返回 undefined，避免正在崩溃时再被日志错误阻断。

`takeUnnotifiedCrash` 从新到旧找七天内尚未通知的记录，并尝试把所有未通知记录标成 notified。写回失败会允许下一次再次显示通知。stack 中扩展路径匹配是辅助定位，按源路径或包目录判断并去重，不证明扩展一定是根本原因。

这个 JSON 文件没有另一个跨进程锁或原子替换协议。两进程同时读、追加、写回可能覆盖对方的记录；它也不是可靠审计日志。时间与 message 的读取校验较宽松，不应将它当成输入不可信复杂文档时的完整 schema 验证器。

## 30.12 错误报告收集哪些材料

`collectBugReportMetadata` 组织版本、运行时、平台、终端信息、模型与提供商配置、扩展来源、设置和用户 hint。环境变量部分列举 PI_ 名称，不导出其值；shell 只留名称，模型与提供商 headers 只列名称。设置剔除 trackingId 和 deviceId。

`collectBugReportDiagnostics` 扫描会话条目，选择带 diagnostics、error/aborted 或 errorMessage 的 assistant 记录，保留条目 ID、时间、模型、stop reason 和诊断；不复制一般聊天 content。它也能附上崩溃记录。

这只说明字段选择，不保证错误文本里没有文件内容或秘密。errorMessage、stack、用户 hint、扩展错误与路径仍是自由文本；“不收集聊天 content”与“所有输出都已脱敏”是两个不同结论。

报告文件固定含 report.json、diagnostics.json，还可包含 session.jsonl 和 summary.md。第十三章解释会话日志的敏感内容与分支，第二十章解释界面的报告选择流程。

## 30.13 脱敏算法的能力与限制

`redactJsonValue` 通过 JSON.stringify replacer 识别看起来像 apiKey、secret、token、password、authorization、cookie 等属性名，先把 camelCase 转成下划线形式再匹配。对字符串尝试 URL 解析：去掉 username/password，并替换秘密样式的查询参数。嵌套协议前缀也会递归处理。

例如 `{apiKey:"abc"}` 会替换属性值，带 `?token=abc` 的 URL 会替换查询值。然而普通字符串 `"the token is abc"` 没有字段键或可解析 URL 结构，算法不会保证将其移除。JSON 中的循环、自定义 toJSON 或不适合 JSON 的值也仍受 JSON.stringify 的通常限制。

因此这是结构化元数据的启发式脱敏，不是通用内容识别器。sensitive schema 元信息也没有自动连接到这个 replacer。

## 30.14 不附会话仍可能调用模型生成摘要

用户可选择不附完整 session，而生成问题摘要。`generateBugReportSummary` 从最近消息向前选择，目标预算约模型窗口的 60%，序列化为 user prompt，请当前模型生成 Markdown 报告，输出上限最多 4096 token。

选择循环至少接纳最新一条消息，所以一条特别大的消息仍可能超过估算预算；预算是估算，不是先切成精确 token 后的严格上限。请求不提供工具，响应若包含 toolCall、空文本、取消或总结失败则拒绝。

指令要求模型不要输出文件内容或秘密，但指令不构成确定性脱敏。更重要的是：不附 session 文件给报告接收方，并不等于生成摘要时没有把选中会话内容交给模型提供商。分析数据去向必须区分这两个阶段。

## 30.15 ZIP 导出与上传共用同一文件列表

`bugReportFiles` 是 ZIP 与上传的共同入口，减少两条交付路径内容不一致。ZIP 写入由本地归档工具完成；上传把这些文件作为 multipart FormData 发送到 Radius gateway 的 `/v1/bug-reports`。

有 token 时加 Bearer 头，没有时可以匿名上传。成功要求 HTTP ok、JSON ok=true 且 bug_report.id 是字符串，否则组装错误文本。upload 函数使用调用者 AbortSignal，没有独立默认超时，也没有持久重试或自动幂等去重。

这里描述的是已实现的报告能力。本次教材编写只读取代码和运行无网络实验，没有创建真实报告、上传内容或调用摘要模型。

## 30.16 已核验的契约与练习

本章运行了 telemetry 源码中 9 个后端无关一致性用例，并补充三组实验：输入/事件/快照数组复制，无操作上下文对不可读取数据的被动性，以及 typed starter 只做编译期 schema 推导。通过 Node 直接导入实际源码运行，全部通过；没有运行 Vitest 类型检查、外部导出后端或网络上传。

练习：

1. 父 Span 启动子 Promise 却不 await，父结束后子还能执行什么？哪些记录会被忽略？
2. callback 返回 `{ok:false}`，与 callback 抛 Error，在未显式状态时有什么区别？
3. PI_TELEMETRY=false 为什么不能推导 Opencode 的会话请求头被移除？
4. 构造一个能被 URL 参数脱敏的 token，再构造一个该算法不会识别的自由文本 token。
5. 不附会话、只附摘要的报告路径，哪些内容可能先到模型提供商，哪些文件才到报告接收方？

下一章用这些契约思路阅读测试与评估：断言能证明什么，故障时间线怎样构造，以及如何避免把未运行的测试写成已通过。
