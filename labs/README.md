# 教材配套离线实验

## 首次准备源码

阅读教材不需要安装依赖。运行实验需要 Node.js 24，以及与教材同级、目录名为 `pi` 的固定版本源码。下面的命令用于一个新建的工作目录：

```sh
git clone https://github.com/zengyi1001/pi-source-book.git
git clone https://github.com/earendil-works/pi.git
git -C pi checkout --detach 11449730c8a733953ce1bcce70e066bccaa778a5
git -C pi apply --check ../pi-source-book/labs/pi-teaching.patch
git -C pi apply ../pi-source-book/labs/pi-teaching.patch
cd pi-source-book
node labs/run-offline.mjs
node labs/sync-book.mjs --check
```

[pi-teaching.patch](pi-teaching.patch) 包含两处已核验的测试修改和两个教学文件；完整修改后文件保存在 [overlay](overlay)，供在线阅读与哈希校验。补丁只应用一次；如果已经应用或本地文件有其他修改，`git apply --check` 会拒绝，请先核对工作区内容。

完整会话和 SQLite 实验还需要仓库依赖。从教材目录执行：

```sh
cd ../pi
npm ci --ignore-scripts
cd ../pi-source-book
node labs/run-integration.mjs
```

模型数据准备要求见 [第三十二章](../32-build-and-delivery.md)。以下实验命令均从教材目录运行。

## 离线算法实验

从教材目录运行；推荐 Node.js 24。本次在 macOS、Node.js 24.21.0 上验证。下面的 run-offline.mjs 只使用 Node 内置模块和仓库源码，不要求 npm 依赖，不调用模型、不读取 API key、不启动真实子代理、不访问网络。文件实验只修改随机临时目录并在 finally 清理。完整会话与 SQLite 集成实验需要仓库依赖，另见下节。

```sh
node labs/run-offline.mjs
node labs/run-offline.mjs loop
node labs/run-offline.mjs compaction
node labs/run-offline.mjs search
node labs/run-offline.mjs planning
node labs/run-offline.mjs subagents
```

省略参数运行全部；可选组名还包括 transcript、budgets、files。未知组名立即报错。任一断言失败退出码为非零；全部成功的标准输出最后一行为：

```text
PASS 26 cases; 8 suites; no model/network requests
```

完整标准输出保存在 [expected-output.txt](expected-output.txt)。Node 可能向 stderr 输出 stripTypeScriptTypes 的实验性 API 提示，这不是用例失败，也不属于预期 stdout。

## 输入、断言与覆盖边界

每一组在 [run-offline.mjs](run-offline.mjs) 中有完整固定输入和断言；以下计数是命名用例数，不是 assert 语句数。

| 组 | 用例数 | 输入与要观察的行为 | 执行方式及边界 |
| --- | ---: | --- | --- |
| transcript | 2 | 三条 system/user 更新；移除、重定义、章节删除、收敛 | 直接导入生产模块；覆盖提示/工具重放，不覆盖提供商 wire payload |
| budgets | 2 | 8000 字符输入、10000/5000 窗口；medium/high thinking | 直接导入生产模块；验证预算算术，不使用真实 tokenizer |
| loop | 5 | 两个调用、可控完成门、sequential、length、预检取消、terminate | 执行完整循环定义；模型 stream 为内存两事件响应，schema validator 为原参数返回，故不验证 schema/认证/HTTP |
| compaction | 4 | 8/4/20/4 token 的固定投影，保留预算 15，插入元数据 | 执行完整投影切点及辅助函数；基础 message 转换为模拟，不验证树投影、context edit 或模型摘要 |
| search | 4 | 三份固定词元文档；中文、平分、schema/namespace、active 工具集 | 执行实际排序与加载函数；工具表 API 为内存对象，不验证 MCP 连接或权限策略 |
| planning | 3 | Plan 编号 7/9，重复 DONE，命令字符串，真实扩展切换 | 直接导入 utils，并执行完整扩展；UI、消息和会话接口为记录对象，命令字符串不实际执行 |
| subagents | 5 | 八项任务、四 worker、分块 JSON、模型配置、chain 交接与失败、parallel 部分失败 | 执行完整调度/dispatch 和工具 execute 方法；spawn、角色发现与子任务为模拟，不证明 OS 生命周期或 UTF-8 跨字节块正确性 |
| files | 1 | 三次实际读改写，同文件与符号链接别名，失败后再运行 | 直接导入文件队列；实际临时文件，不证明跨进程或硬链接互斥 |

## 为什么提取源码，而不是复制算法

[source-slices.mjs](source-slices.mjs) 先按 [reading-inventory.tsv](../reading-inventory.tsv) 验证完整源码 SHA-256，再用唯一文本边界提取完整定义，调用 Node 的 stripTypeScriptTypes 擦除类型，并在 VM 中注入表中说明的协作对象。循环实验没有重写调度器，BM25 实验没有另写一份排序算法。

VM 对象的原型与主环境不同，plain() 只用于把返回数据转回主环境后比较；它不改算法输入或执行顺序。经典工具 execute 方法放进一个对象包装后执行，方法内部保留源码原样。异步顺序使用手动释放的 Promise，避免依赖“睡几毫秒一定先完成”的不稳定判断。VM 的同步执行时间限制不能替代真实子进程的生命周期管理。

源码哈希改变时实验立即拒绝继续。应先重新阅读实现、调整教材与断言，再更新清单；不能为了通过而直接删除校验。完整直接导入依赖闭包也在启动时校验；只有 type-only imports 被 Node 擦除。

## 完整会话、扩展与 SQLite 恢复实验

```sh
node labs/run-integration.mjs
node labs/run-integration.mjs coding
node labs/run-integration.mjs durable
```

[run-integration.mjs](run-integration.mjs) 只运行两个指定文件，共 16 个命名测试，不启动全套 Vitest。coding 组执行新增 [book-session-walkthrough.test.ts](overlay/packages/coding-agent/test/suite/book-session-walkthrough.test.ts)，durable 组执行既有 [harness-tools-recovery.test.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/test/harness-tools-recovery.test.ts)。模型选择和回答由 faux provider 提供；runner 创建临时 HOME，不继承认证、模型端点或用户扩展配置，并启用 PI_OFFLINE。

前提为 Node.js 24 和同级 `../pi` 仓库的固定依赖；缺少依赖时进入该仓库运行 `npm ci --ignore-scripts`。模型目录须符合第 32 章的固定数据要求，不能随意用另一个版本替代。本次使用已准备好的依赖与目录，无须构建 dist。[vitest-durable.config.mjs](vitest-durable.config.mjs) 合并根配置的源码别名与 Durable 包配置，使 AI 等包直接从该仓库源码加载。

| 组 | 用例数 | 实际验证 | 模拟与未覆盖部分 |
| --- | ---: | --- | --- |
| coding | 7 | AgentSession read/edit、整批失败零写入、磁盘 JSONL 保存/重开、事件追加顺序、字面搜索算法、真实扩展注册/声明/执行、schema 在读取前拒绝 | 模型、认证、设置、资源发现为夹具；没有 HTTP/TUI；扩展结果记录用例为内存日志 |
| durable | 9 | 实际 Harness、Node SQLite close/reopen、safe 双重策略、cwd/取消选择、beforeTool/afterTools 恢复、取消与部分结果、faulted 缺失结果、真实本地 bash 收尾、旧进度清理 | 模型为 faux；不做 SIGKILL/断电/数据库损坏或外部收费故障注入 |

Durable 的 bash 用例执行 `echo started; sleep 30`，看到持久进度后主动关闭，取消本地进程，再打开同一个临时数据库。它测试合作式关闭，不等待三十秒正常完成，也不重新执行 unsafe 命令。

runner 解析 Vitest JSON 报告，失败、跳过或 todo 均不算通过，错误退出非零。成功输出只列每个用例及三个 TRACE，完整结果见 [integration-expected-output.txt](integration-expected-output.txt)。全部运行结束行为：

```text
PASS 16 integration cases; faux models; temporary files and SQLite
```

只运行 coding 时结束文字为 `PASS 7 integration cases; faux models; temporary files and JSONL`；durable 为 9。Node SQLite 的实验性 API 提示不等于断言失败。runner 用 finally 清理环境临时目录，测试各自清理文件、会话和数据库夹具。

完整案例、失败反例和扩展开发过程在 [第 35 章](../35-session-development-workshop.md)，实际调度和恢复代码分析在 [第 26 章](../26-durable-tasks-and-recovery.md)。它们补足局部算法实验没有执行的会话与恢复管线，仍不提供真实模型能力的评估结果。

## 教材同步与验证

正文按章节保存在独立文件中，README.md 提供分章目录。修改章节后运行：

```sh
node labs/sync-book.mjs
node labs/sync-book.mjs --check
```

默认同步分章目录与章数/字符数，保持各章独立；--check 只读检查。程序验证编号连续、目录与章节标题一致、章节统计准确、没有合并正文文件、生产源码节录与所标行范围完全一致、Markdown 本地链接与锚点，以及实验预计输出中的用例数。

[reading-inventory.tsv](../reading-inventory.tsv) 保留基准提交的哈希；[verified-source-changes.tsv](../verified-source-changes.tsv) 记录本次已阅读、修复并验证的测试与辅助文件变更。[teaching-source-hashes.tsv](../teaching-source-hashes.tsv) 另外固定新增的示例和测试。同步程序先确认变更的基准哈希属于原清单，再核对全部当前哈希和新文件。记录不会自动更新；再次修改文件仍会使检查失败。离线算法实验继续按原清单核验其使用的运行时源码。

这些实验是教材的可复现局部证据。附录 B 的初版 14 组临时实验未保留程序，属于历史记录；此目录没有声称复原那些脚本或覆盖它们的全部场景。完整 OS 生命周期、真实 MCP/提供商、QuickJS Worker 与故障恢复的其他边界仍需各自的验证环境。
