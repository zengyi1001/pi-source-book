# 第十二章命令执行与输出管理

编程代理需要运行搜索、编译器和用户脚本。但启动进程并不是完整实现：必须处理工作目录、环境、取消、后代进程、UTF-8 分块、海量输出和非零退出码。本章跟踪模型调用的 bash 工具，并与用户命令及扩展命令接口比较。

## 12.1 三条命令执行路径

| 入口 | 主要实现 | 行为特点 |
| --- | --- | --- |
| 模型的 bash/powershell 工具 | [tools/bash.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/bash.ts) | 工具结果、流式更新、结构化结果 |
| 应用中的用户 shell 执行 | [bash-executor.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/bash-executor.ts) | `BashResult`、输出清理、取消标记 |
| 扩展的命令加参数接口 | [exec.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/exec.ts) | `shell: false`、分开 stdout/stderr |

三者共享部分辅助代码，但不是完全相同的语义。尤其不能把一个接口的超时单位、输出限制或进程树终止保证套到另一个接口上。

## 12.2 shell 字符串与参数数组的区别

bash 工具收到 `command: "printf hello"` 后，通常启动 shell，并把命令交给 `-c`。管道、重定向、变量替换等解释由 shell 完成。

扩展 `execCommand(command, args, cwd, options)` 使用 `shell: false`，将每个参数作为独立字符串传给程序。参数内容不是自动作为 shell 代码解释。

这影响正确转义和安全边界。例如把任意路径直接拼进 bash 命令，路径中的空格和 shell 特殊字符可能改变解释；传给不经过 shell 的参数数组时则是另一套规则。

Pi 的默认 bash 工具以运行 Pi 的用户权限执行命令，没有在这个函数里建立容器、文件权限策略或网络限制。扩展可以替换 `BashOperations` 或 `spawnHook`，更强边界来自相应后端。

## 12.3 shell 的平台选择

[utils/shell.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/shell.ts) 支持显式 `shellPath`。Windows 优先常见位置的 Git Bash，再查 PATH；Unix 优先 `/bin/bash`，再查 PATH，最后退回 `sh`。

旧版 Windows WSL 的 `bash.exe` 采用 `-s` 并从标准输入传递命令，避免沿用不合适的 argv 调用方式。

PowerShell 工具只在 Windows 默认后端提供，优先 `pwsh.exe`，再用 `powershell.exe`，附带无配置文件、非交互等参数，并在命令前设置 UTF-8 控制台输出编码。

这些选择在“程序启动前”发生。如果自定义远程执行操作，本地 shell 选择未必参与。

## 12.4 环境变量是每次调用的快照

`getShellEnv` 复制当前进程环境，把 Pi 工具目录加入 PATH。Windows 上查找已有 PATH 键时不区分大小写。

`resolveSpawnContext` 先清除继承的 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL` 和 `PI_REASONING_LEVEL`，然后按当前上下文重新填入，避免上一会话元数据误传给新的命令。

`commandPrefix` 可为命令加入初始化前缀；`spawnHook` 可调整命令、cwd 与环境。它是扩展点，不是自动权限检查。理解执行结果时，要考虑命令是否经这些配置改变。

## 12.5 超时必须校验数值与单位

模型工具的 `timeout` 单位是秒，没有默认超时。实现拒绝非有限值、非正数和转换成毫秒后超过 `2,147,483,647` 的值。

超时启动计时器并请求终止进程树。随后等待进程路径结束，最终报告 `Command timed out after ... seconds`，附带已收集输出。

扩展命令接口的超时单位则是毫秒。将工具参数直接原样传给扩展接口，会造成相差 1000 倍的时间设定错误。

## 12.6 为什么要终止进程树

shell 可以启动编译器，编译器又可以启动其他进程。只向 shell 本身发信号，后代可能继续运行并持有管道。

默认 shell 操作在 Unix 上以独立进程组启动，终止时先向 `-pid` 发送 SIGKILL，失败再尝试单个 pid。Windows 则调用可信 System32 路径的 `taskkill.exe /F /T /PID`。

独立启动的子进程 id 还会被登记，便于父进程关闭路径清理。终止是尽力操作，Windows taskkill 的启动错误会被处理，不能据函数名宣称任何后代都必然即时消失；自行改变进程组或脱离约束的程序需要另外分析。

取消信号和超时都使用这条默认后端终止路径。自定义后端则要遵守其自己的 Promise 与取消契约。

## 12.7 exit 与 close 不在同一时刻

进程 `exit` 表示进程已经结束；`close` 通常要等标准输入输出句柄关闭。后代继承了 stdout 时，shell 已退出但管道可能一直开放。

如果只等待 close，工具可能卡住；如果在 exit 后固定等待 100 毫秒就销毁管道，还在输出的后代数据又可能丢失。

[waitForChildProcess](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/child-process.ts) 的处理方式是：exit 后等待两个流都结束，或等待输出空闲 100 毫秒。每个新数据块都会重新启动空闲计时器。

```text
shell exit
  → 后代在第 50 毫秒输出，重新计时
  → 第 120 毫秒再输出，重新计时
  → 最后一个块之后空闲 100 毫秒，结束等待
```

它避免把“进程退出后的固定期限”当作完整输出的截止时间。不过静默间隔超过宽限后再出现的输出可能已经不再接收，这依然是面向交互工具的工程折中，不是无限期保证捕获每个后代输出。

## 12.8 UTF-8 字符可能跨数据块

中文的字节可以一部分位于前一个 Buffer，一部分位于后一个 Buffer。对每块独立 `toString` 会把不完整编码变成替代字符。

[OutputAccumulator](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/output-accumulator.ts) 使用 `TextDecoder` 的流式模式，保留尚不完整的尾部字节，在下一块到达时补齐。`finish()` 再刷新解码器。

它把 stdout 和 stderr 交给同一个累积器，因此输出是两个流到达回调时的组合顺序。不能把它视为系统对两个独立管道提供的全局严格时序，也不能还原每一行原来来自哪个流。

## 12.9 长输出怎样同时保留尾部和完整日志

小输出暂存原始 Buffer，另维护解码后的滚动尾部、总字节数、完成行数和当前未结束行的大小。

超过行数或字节阈值时创建随机名临时日志，把之前原始块写进去，再持续写入新块。显示只保留末尾 2000 行或 50 KiB，因为错误和汇总通常出现在命令结尾。

滚动尾部超过阈值时按 UTF-8 边界裁剪，并记录是否从行边界开始。生成快照时尽量避开前端不完整行；最后一行自身过长则允许只保留它的末尾并明确标记。

这减少累积文本长期常驻内存的规模，但不能把它写成进程总内存严格上限：输入 Buffer、临时字符串以及写流尚未落盘的缓冲仍可能占内存；当前 `write` 调用也没有等待 `drain` 来对所有输出生产者施加背压。

背压是消费者处理不过来时让生产者放慢的机制。理解这个词之后，读者才能准确区分“丢弃显示中的旧内容”与“限制整个数据管线的内存”。

## 12.10 输出更新为什么每 100 毫秒节流

每个字节块都触发终端重绘，会让日志密集时界面负担过重。工具设置 dirty 标记，距离上次更新不足 100 毫秒时安排计时器，合并期间多个数据块。

命令结束时关闭接收输出、刷新解码器、清理计时器、补发最后一次更新，再等待临时文件关闭。这避免最后一点输出被节流计时器遗留。

工具的输出更新和渲染器每秒更新耗时标签是不同计时器。前者控制内容变化频率，后者让没有新输出时仍能显示运行时长。

## 12.11 模型内容与程序化结果有不同上限

工具的 `content` 是给模型的可读尾部输出。`structuredContent` 是给程序化调用者的对象：`output`、`truncated`、可选完整日志路径、`exit_code` 和 `wall_time_seconds`。

结构化 output 的采样预算是 1 MiB。文件超过预算时读取头尾各一部分，中间加省略提示，且在 UTF-8 边界切割。这不表示结构化返回值的整个 JSON 序列化大小绝对不超过 1 MiB，省略提示和其他字段还会增加字节。

非零退出码返回 `isError: true`，同时保留结构化结果。因此模型看到错误，而代码执行调用者仍可读取退出码并编写条件分支。取消、超时和没有退出码则走抛错路径，不能假定它们与非零退出具有同样的可读取对象。

## 12.12 用户命令接口保留另一套实现

`executeBashWithOperations` 对输出去除 ANSI、控制字符和 CR，并在超过阈值时保存清理后的文本。它返回 `cancelled` 布尔值；取消时不把它统一当成抛出的普通命令错误。

这条路径没有复用新的 OutputAccumulator：滚动缓冲按块及字符串长度计数，结束时调用 `truncateTail`，临时文件使用 `end()` 而没有等待相同的关闭 Promise。不能把模型 bash 工具的输出原始字节保留和文件关闭等待机制直接移植到它的说明中。

这种重复实现是项目现状。学习者可以据此讨论统一接口的设计，但教材不能假称两条代码路径已经统一。

## 12.13 扩展命令接口的限制

`execCommand` 分别累积 stdout 和 stderr 字符串，没有默认工具式的 50 KiB 输出截断。它的取消先对直接进程发 SIGTERM，并安排延迟强制终止逻辑；这里没有使用 shell 工具的 `killProcessTree`。

Node.js 的 `proc.killed` 表示终止信号是否已发送，并不等于进程已确认退出。阅读它的强制终止条件时应按实际代码理解，不能将注释里的“5 秒后强杀”扩展为保证强制终止顽固进程。

默认 shell 操作会将信号结束映射为 `128 + 信号编号` 或失败码；扩展 exec 的空退出码处理又不同。因此调用者要同时检查 `killed` 和 `code`，不能以一个共享概念“命令结果”掩盖这些差别。

## 12.14 与文件队列的关系

bash 可以修改文件，但命令内容无法由这个通用执行器可靠推断成一组文件路径。当前实现没有让 bash 自动申请第十一章的文件队列。

因此，模型同一批调用 `edit(path)` 和 `bash("...修改同一路径...")` 可以发生冲突。将整批工具设为顺序执行能减少同批交错，但不会建立跨进程锁，也不会撤销脚本已有的副作用。

## 12.15 源码定位与练习

| 文件与函数 | 关注点 |
| --- | --- |
| [bash.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/bash.ts) `createLocalShellOperations` | 启动、取消、超时、退出码 |
| 同文件 `createShellToolDefinition` | 环境注入、节流、双层输出 |
| [output-accumulator.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/output-accumulator.ts) | UTF-8、滚动尾部、完整日志 |
| [child-process.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/child-process.ts) | exit 后输出空闲判断 |
| [shell.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/shell.ts) | 平台后端与进程树清理 |
| [bash-executor.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/bash-executor.ts) | 用户命令路径 |

练习：命令输出 5 MiB 且末尾是错误信息，模型与代码调用者各得到什么？答案是模型得到限长尾部及日志路径；程序化结果按 1 MiB 预算取头尾并报告截断，完整输出另存在日志。

练习：shell 退出后后代持续输出 300 毫秒，是否在 exit 后第 100 毫秒固定截断？答案是否定的，每个块重新启动空闲计时器。

练习：把工具 `timeout: 10` 直接作为扩展 exec 的 timeout 会怎样？答案是 10 秒被误解为 10 毫秒，需要显式单位转换。
