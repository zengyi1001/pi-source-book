# 第二十七章 执行环境、文件工具与存储边界

本章把第 26 章的任务落到实际机器：工具怎样通过执行环境读写文件、启动 shell、捕获输出，以及这些操作与会话事务有什么关系。存储后端内部的事务与恢复已在第 25 章详细解释，本章重点是它们使用的文件系统能力和工具副作用。

先看一个具体轨迹：`edit` 得到文件队列位置，读取文件，计算新内容，启动写入；取消信号随后到达；写入已经发生，调用最终报取消。文件工具必须等待实际写入结束才释放队列，任务系统随后保存取消或中断结果。这几步不是同一个原子事务。

## 27.1 为什么工具不直接调用 node:fs

Durable 的工具接收 `ToolExecutionApi.env`，通过 `ExecutionEnv` 接口读写和执行命令。宿主在 `HarnessOptions.env` 中构造环境，可以按会话 cwd 或文档内容选择本地、容器或远程能力。

接口分成 `FileSystem` 和 `Shell`，`ExecutionEnv` 同时具备两者。默认本地实现是 `NodeExecutionEnv`。通过接口调用，并不自动产生沙箱；安全范围取决于具体实现。

| 源码 | 责任 |
| --- | --- |
| [env/index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/env/index.ts) | 文件系统、shell、Result 和错误契约 |
| [env/node.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/env/node.ts) | Node 文件操作、逐行读取、子进程和输出溢出文件 |
| [tools/env.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/env.ts) | 工具必须有环境，否则抛错 |
| [tools/path-utils.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/path-utils.ts) | 模型提供的路径归一化和读取路径候选 |
| [tools/file-mutation-queue.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/file-mutation-queue.ts) | 按环境命名空间和规范化路径串行修改 |
| [tools/read.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/read.ts)、[image.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/image.ts) | 文本读取、图片头识别和诊断 |
| [tools/edit.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/edit.ts)、[edit-diff.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/edit-diff.ts) | 定位文本、计算替换和差分 |
| [tools/write.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/write.ts)、[bash.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/bash.ts) | 整体覆盖和 shell 工具 |
| [truncate.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/truncate.ts) | 文件读取截断、UTF-8 字节计数 |
| [tools/index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/index.ts) | 显式组装 CodingTools 扩展 |

`CodingTools` 包含 read、write、edit、bash，但不会自动安装进所有 registry 或会话。第 26 章的代理选择决定哪些已安装工具进入请求。

## 27.2 Result 把预期失败写进返回值

```ts
// 原接口形状的简化表示。
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

文件不存在、权限不足、取消、命令超时都可能是正常业务分支，环境方法通常以 Result 返回，而不是把它们全部抛出。`getOrThrow()` 是调用方明确选择把错误提升为异常的辅助函数。

`FileError.code` 区分 not_found、permission_denied、invalid、aborted、not_supported 等；`ExecutionError` 区分 timeout、spawn_error、callback_error 等。Node 实现把底层错误码转换成这些值，同时保留 cause。

工具对错误还会再次分类：例如 read 找不到文件而抛错，会由工具任务生成诊断并以 failed 结束；read 识别出不支持的图片时直接返回 `isError: true`，工具任务仍可 completed。外部操作 Result、模型结果 isError、任务结算 outcome 不能互换。

## 27.3 环境 ID 是文件命名空间，不是对象 ID

所有本地 Node 环境的 `id` 都是 `node:local`，不同 cwd 的环境对象仍看到同一机器的文件。文件队列因此可以让不同会话中的环境对象共用同一个文件队列。

自定义实现应让相同 ID 表示相同文件系统和路径语义；容器或远程主机应有各自命名空间。错误地复用 ID，会让无关文件互相等待；错误地为同一文件系统生成不同 ID，则会漏掉应有的串行关系。

`cwd` 是可修改字段。本地环境解析相对路径时基于这个字段，但不会禁止 `..`、绝对路径或 home 路径，也不会将文件访问限制在 cwd 下。接口的可移植性不等于目录隔离。

## 27.4 路径在两层归一化

工具层先把特定 Unicode 空格替换为普通空格，并去掉开头的 `@`，再调用环境的 absolutePath。Node 层解析 `~`、`~/`、file URL，使用本机路径规则得到绝对路径。无效 file URL 被当作普通路径处理，保留 Result 契约。

read 额外尝试少量候选：原路径、日期文件名中窄不换行空格、NFD Unicode 形式、弯单引号，以及两种转换组合。它通过 exists 依次找第一个存在的路径。edit/write 不采用这些读取候选，以免静默把写入目标改成另一个文件。

路径存在性检查不是锁。检查之后文件可以被删除、替换或重定向，所以最终读写仍必须处理失败。`absolutePath()` 和 `joinPath()` 本身只处理字符串，Node 实现不会在这些函数里统一检查取消。

## 27.5 lstat、realpath 与实际读取的区别

`fileInfo()` 使用 lstat：符号链接本身显示为 symlink，而不是直接显示目标类型。`canonicalPath()` 使用 realpath，得到实际目标路径；`readFile()` 和 `writeFile()` 按文件系统规则跟随符号链接。

edit 接受普通文件或符号链接，随后读取目标。如果 symlink 指向目录或已经悬空，读取会失败；前一次 fileInfo 不能证明之后目标仍可编辑。

`listDir()` 先读取目录项，再逐个 lstat。它不是目录的一致性快照，扫描期间条目消失可以导致错误。`exists()` 只把 not_found 变成 false，权限等其他错误继续返回错误，不将其误报为“不存在”。

## 27.6 Node 写入是直接覆盖

`NodeExecutionEnv.writeFile()` 的轨迹是：检查取消、递归创建父目录、再次检查取消、调用 Node writeFile 并传入 signal，返回结果。

这里没有写前全文版本条件，没有临时文件替换，没有本次工具写入的 fsync，也没有自动备份。信号传给底层也不意味着失败时旧文件一定完整保留；直接覆盖可能已经部分发生。

`appendFile()` 创建父目录后追加，追加调用不传 signal，完成后再检查取消。因此取消可能得到 aborted Result，而文件已经增加了内容。`truncateFile()` 和 `flushFile()` 也有操作后的取消检查，检查结果不能撤销已经截断或同步的文件。

rename、remove、createDir 等主要在操作开始前检查取消。不同环境方法的取消时点并不完全相同，工具调用方不能把所有方法都当成具有统一回滚语义的接口。

## 27.7 文件队列的完整临界区

Durable 的队列键是：

```text
env.id + "\0" + canonicalPath
```

存在文件使用 canonicalPath；文件不存在时递归规范化父目录，再拼接文件名；实现不支持规范化时退回绝对路径。这让符号链接父目录下的新文件，创建前后更容易使用同一个键。

键解析完成后，读取当前 Promise 尾部、创建释放 Promise、登记新尾部，这几步没有 await 间隔。业务回调等前一项完成后再运行，finally 释放；只有自己仍是最后一项时才从 Map 删除，避免删掉后来登记的队列。

edit 的读取、计算、写入和结果构造全部在这个回调内；write 的整体写入也在其中。只锁 writeFile 那一行不足以避免两个 edit 都读取同一个旧版本。

这里没有传统队列的全局 registrationQueue，同一文件按键解析完成顺序排队。路径解析耗时不同，后发调用可以先获得位置。两套工具模块有各自的 Map，彼此不组成一个统一队列服务。

## 27.8 取消不能越过正在执行的写入

队列不会因为 signal 取消就提前释放当前回调。等待前一个调用时也没有一个统一的“取消立即出队”机制；轮到工具后，业务代码再检查取消并拒绝。

```text
A 开始慢写入
B 排队
A 取消，但写入仍在进行
A 的底层操作完成，工具检查取消并抛错
A finally 释放
B 读取实际文件后继续
```

这样 B 不会在 A 仍可能写入时提前开始。代价是取消后的等待可能较长；若自定义回调永不结束，队列无法安全释放。取消等待、停止副作用和撤销副作用是三种不同操作。

硬链接、键确定后的 symlink 重定向、bash、外部编辑器和其他进程仍在保护范围外。第 11 章已用具体轨迹解释这些限制。

## 27.9 edit 的参数修复与同一基准

`prepareEditArguments()` 在副本上修复模型常见形状：把 edits 的 JSON 字符串解析成数组或单项对象，把单项对象包成数组，把顶层 oldText/newText 追加到 edits。原始调用参数不被修改，最终仍经过工具 schema 验证。

工具再拒绝空 edits 数组。所有替换都匹配同一原始文件，不把前一项新内容作为后一项基准。因此：

```text
原文：alpha / beta
修改 1：alpha → ALPHA
修改 2：beta  → BETA
```

可一次计算；但修改 2 不能以修改 1 产生的 `ALPHA` 为 oldText。这样替换次序不改变匹配基准，也容易判断区间重叠。

## 27.10 归一化不应重写无关行

edit 读取全文，保存 BOM 和原换行习惯，将工作文本转为 LF。匹配先精确查找，再做 NFKC、行尾空白、引号、破折号和部分 Unicode 空格归一化。

任一替换需要模糊匹配，就统一在归一化空间重新定位所有替换。每个 oldText 要唯一；重复、找不到、空 oldText 或区间重叠都失败。区间排序后倒序应用，避免前面的长度变化使后面的偏移失效。

模糊结果不是整份归一化文本直接写回。`applyReplacementsPreservingUnchangedLines()` 把匹配区间扩展到触及的行，只重写这些行，未触及行从原工作文本复制。这避免为了匹配一处弯引号而把所有其他行的引号和尾部空格也改掉。

触及行仍可能受到归一化影响；保留的是未触及行，不是逐字符精确逆映射。统一恢复换行与 BOM 后直接写入。结果没有实际变化则报错，不宣称完成了一次空编辑。

算法与传统工具基本对应，第 10 章已有偏移、重复和触及行示例。当前 Durable edit 没有在写入前重新读取全文检查外部修改，不能添加源码里不存在的乐观版本检查。

## 27.11 diff 和 patch 是展示结果，不是提交机制

成功写入后，edit 用 `diff` 库计算带行号的展示 diff，以及标准 unified patch。details 包含 diff、patch 和首个变化行。

比较的是 LF 工作文本，新旧 BOM 和换行格式不作为独立展示差异。patch 用来解释已经发生的修改，不是这里写文件时交给 Git apply 的操作指令。

根据执行顺序可推导：如果写入成功后，差分计算或结果持久化失败，文件仍可能已经改变。生成 patch 不会把先前写入纳入 Session 回滚。

## 27.12 write 与 edit 的不同冲突条件

edit 用 oldText 作为局部前置条件。前一个调用已经改掉目标时，后一个编辑找不到旧文本就失败；无关位置变化而目标仍唯一时，通常可以继续。

write 的语义是整体覆盖，没有旧内容前置条件。即使排队让它晚于 edit，它仍可以覆盖 edit 的结果。这不是队列失效，是明确的覆盖语义。调用方需要保留无关修改时应选择适当的局部编辑。

两个文件不组成共同事务。一份写入成功、另一份失败，不会自动恢复前者。Session 可以原子提交多个记录，却不能据此声称普通文件修改也具备同样的原子性。

## 27.13 read 先整文件读取，再选择行

当前 Durable read 使用 readBinaryFile 把整个文件读入内存，图片识别后以 TextDecoder 解码，再 split 换行并选取 offset/limit。offset 是一基行号；合理使用时应传正整数，源码 schema 使用 Number，并没有把这两个字段全面限制为正整数。

输出采用 2000 行或 50 KiB 先到的限制。首行本身超过字节上限时，普通 truncateHead 原本返回空内容；read 特别取首行在 UTF-8 字符边界上的前段，并给出后续读取提示。

显式 limit 后尚有内容，以及默认截断，都作为 diagnostics 报告，文件文本本身不混入提示文字。末尾换行会让 split 产生最后一个空项，因此文件行计数和逐行阅读器的计数要按各自实现理解。

这是输出限制，不是输入内存上限，也不是按 offset 直接 seek 到某行。大型文件即使只要求少量行，当前工具仍先读完整文件。

## 27.14 图片头识别没有实现图片读取

image.ts 识别 JPEG、PNG、GIF、WebP 和部分 BMP 头；PNG 检查 IHDR，并识别 acTL 动画标记。它不是完整图片解码器，也不是通用二进制文件分类器。

read 遇到已识别图片返回 unsupported_image。未识别的内容继续按文本解码，TextDecoder 默认对无效字节使用替换字符。不能把这个实验性 read 描述成第 9 章传统工具那样具有完整图片读取能力。

四个内置 CodingTools 都没有显式设置 `replay`，因此均采用默认 unsafe。包括 read。读取语义通常有机会实现安全重放，但当前代码没有给它自动授权。

## 27.15 逐行读取是存储恢复的另一条路径

环境提供 `openTextLineReader()`，Node 实现使用文件句柄、64 KiB 字节缓冲和流式 TextDecoder。它保存 byteOffset、未消费文本和 EOF 状态，按 LF 返回 `{ text, terminated }`。

CRLF 的 CR 保留在 text 中；最后无 LF 的文本返回 terminated false。这对日志恢复很重要：一个看似完整 JSON、但没有提交用换行结束的尾部，需要由上层决定是否接受。

读取字节后、更新 offset 前检查取消。取消时这段字节尚未被消费，下次读取仍可从原 offset 开始，避免跳过数据。该 reader 没有为并发 readLine 添加串行锁，应由单个读取循环拥有。

通用 reader 的默认解码并非 fatal；Durable JSONL 存储恢复另有完整行、UTF-8 和提交确认检查，具体见第 25 章。不能把所有 JSONL 使用场景合并成一套恢复算法。

## 27.16 shell 选择与环境继承

Node 环境选定 shell 后 spawn。指定 shellPath 要能找到；POSIX 通常优先 `/bin/bash`，再尝试 PATH 中可用 shell。Windows 尝试 Git Bash 等路径，对旧系统 bash 路径还采用 stdin 传命令的特殊方式。

`exec` 的 command 是 shell 程序，不是一个自动转义的参数数组。bash 工具可以加 commandPrefix，再由 prepare 回调修改 command、cwd、env 和 inheritEnv。这个准备过程不会自动将危险字符串转换为安全参数。

inheritEnv 默认为真，合并当前进程、环境构造时的 shellEnv 和本次 env；设为 false 时只使用本次额外 env，不继续继承基础环境。是否允许外部命令、网络和其他目录，由具体 shell 环境决定，本地默认实现没有这层限制。

timeout 单位是秒，必须有限且大于零，不能超过 Node 定时器最大毫秒值；没有默认超时。非法 timeout 返回错误或由工具提前抛错。

## 27.17 stdout/stderr 的解码与合并

stdout、stderr 各自使用 TextDecoder，防止一条流里的多字节字符被另一条流干扰。每个已解码 chunk 按到达顺序调用 onOutput。

两条流合并的是观察到的到达顺序，不是操作系统为 stdout/stderr 提供了一个统一业务顺序。调用方不能根据合并结果证明两个独立写入在源程序中的全部先后关系。

onOutput 是同步 void 回调，原始、没有总量限制、没有节流。bash 工具立即交给有界 OutputBuffer，进度提交再节流。回调抛错时环境记录 callback_error，并尝试终止进程；接口不会等待一个误返回的异步回调 Promise。

OutputBuffer 只移除相应控制字符，不是完整 ANSI 解释器。例如移除 ESC 不会顺带解析并删除所有 CSI 后续字符。原始完整输出和模型可见的有界文本因此有不同用途。

## 27.18 溢出文件的背压

超过 spill 字节或行阈值后，环境创建临时文件，写入此前捕获的前缀和全部后续输出。这里的“背压”指写入目标处理不及时时，让读取来源暂停，避免无限堆积。

创建 spill 文件期间暂停 stdout 和 stderr；写入流使用 1 MiB highWaterMark，write 返回 false 时暂停来源，drain 后再恢复。取消、超时、spill 错误或回调错误后不继续恢复。

退出结算前会等待 spill 创建和写入结束。完整文件保留原始合并输出，包含控制字符；模型可见内容则由工具保留窗口和诊断组成。spill 不是会话任务日志，恢复不会自动重播它。

bash 工具把完整文件路径作为 full_output 诊断保存。超时或取消后，只要 spill 已创建，错误结果也可能携带路径。

## 27.19 退出、超时与后代进程

POSIX spawn 使用 detached 进程组，取消或超时时尝试向负 PID 的进程组发送 SIGKILL，失败再杀主进程；Windows 使用 taskkill。脱离原组的后代仍可能不受这次清理约束。

主进程 exit 不一定意味着 stdout/stderr 已结束，例如后代仍持有管道。实现等待流结束；主进程已退出但管道仍活着时，采用约 100 ms 输出空闲宽限，收到数据会重新计时，spill 正在排空时也延长等待。最终销毁本地管道，所以很晚的后代输出可能不再被捕获。

普通非零退出码仍是 `exec` 的成功 Result，表示程序确实执行完并返回这个码。bash 工具随后将非零退出抛成错误，让工具任务保存诊断。信号退出还会转换成相应退出码。

取消信号已经在调用开始前触发时，不 spawn；已经启动后的取消是终止尝试，不是副作用回滚。超时也同样可能发生在命令已修改文件之后。

## 27.20 cleanup 与临时文件所有权

Node 环境追踪自己启动的子进程 PID。`cleanup()` 尝试终止它们并清空集合，但不等待所有退出，也不把环境标为永久关闭；以后仍可使用该对象。

createTempFile 先创建临时目录，再创建随机文件。cleanup 不自动删除这些临时目录或 spill 文件。宿主若需要明确的清理策略，必须知道哪些临时产物仍需供用户读取，再自行管理生命周期。

多个环境对象共用同一个文件队列命名空间，但不会共用各自的活动子进程集合。这两个“共享”维度不同，不应根据相同 env.id 推导 cleanup 会清理所有会话进程。

## 27.21 环境、storage 和 Session 的分层保证

| 层次 | 实际负责的事情 | 不能由它推出的保证 |
| --- | --- | --- |
| NodeExecutionEnv | 具体文件和进程操作、错误转换 | 文件版本冲突检测、自动沙箱、外部效果回滚 |
| 文件队列 | 本模块同命名空间同路径的 edit/write 串行 | 跨进程互斥、bash 互斥、多文件事务 |
| Durable storage | 将记录批次提交给 Memory、JSONL 或 SQLite | 任意工具写文件也参与记录事务 |
| Session | 串行准备、提交、采用和发布记录 | 执行工具外部副作用恰好一次 |
| TaskScheduler | 调用门禁、恢复、监督和重放决策 | 自动证明工具幂等或撤销已发生操作 |

JSONL 后端使用环境的 append、flush、truncate、rename 管理主日志和旁文件；顺序和恢复确认机制在第 25 章。默认 fsync 选项不能笼统表述为“所有文件每次都同步”。SQLite 后端的锁和事务主要由数据库适配器与 SQLite 提供，而不是 edit/write 的 Promise 队列。

修改存储能力或替换远程环境时，应逐项确认接口契约，尤其是追加后的取消、文件规范化、重命名语义和 flush。只满足同名 TypeScript 方法，不能证明新环境具备和本地实现相同的故障边界。

## 27.22 实验与练习

使用 Node.js 24.19.0 直接导入实际环境、队列和输出源码，运行了八组实验：逐行读取的 CR/Unicode/EOF；跨环境对象及符号链接父目录的新文件队列；键解析先后改变执行顺序；取消回调未结束时不提前释放；UTF-8 分块与头尾裁切；进度停止等待在途提交；本地 shell 完整 spill 与捕获内容一致；非零码、超时、回调失败及 cleanup 后对象仍可使用。结果均通过，临时实验文件已自行清理。

取消实验中的慢副作用使用测试回调，验证的是队列交接边界；不将它当作所有底层文件操作的取消集成测试。实验没有调用模型或外部服务。

1. 两个环境访问同一机器同一路径，但使用不同 ID，会失去哪一项保护？
2. A 的 canonicalPath 很慢，B 较快。推演两套文件队列各自的执行顺序。
3. shell 在超时前修改了文件，任务返回 timeout。说明为什么不能自动宣称文件未改。
4. read 返回小量文本，为什么仍可能占用较大内存？
5. write 和 Session 文档修改都在工具中发生。文件成功、Session 提交失败时，为什么没有跨两者的自动回滚？
6. 想增加条件写入，明确列出需要比较的版本、比较与写入之间的窗口，以及哪些写入方必须共同参与协议。

下一章分析远程请求协议：字节帧怎样解码，请求如何对应响应，以及连接中断时能取消到哪一层。
