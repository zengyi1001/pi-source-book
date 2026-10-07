# 第九章读取文件与发现代码

模型要修改文件，首先必须获得可靠的当前内容。Pi 将直接读取、目录列表、文件名搜索和内容搜索分为不同工具，并在每种输出上设置限制。本章解释它们如何实现，以及为什么“搜索到一行”不能代替“读到完整实现”。

## 9.1 工具集合是应用选择

[tools/index.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/index.ts) 提供三种组合：默认编码工具是 `read/bash/edit/write`；只读组合是 `read/grep/find/ls`；完整集合还包括 PowerShell。

这些工厂根据调用者的 `cwd` 和各工具选项构造对象。它们描述可提供哪些工具，不等于整个进程被隔离。扩展、命令或自定义工具可能有其他能力，文件系统权限也仍由运行进程决定。

## 9.2 read 的行号是给模型的接口

`read` 接收 `path`，以及可选 `offset` 和 `limit`。`offset` 从 1 开始，内部用 `offset - 1` 转为数组索引；它不是磁盘字节偏移。

执行顺序是：解析路径、检查可读、判断图片类型、读取内容。如果是文本，则先把整个文件读入 Buffer，再解码、按 LF 切行，选择范围，最后截断输出。

例如 5000 行文件，调用 `offset: 2001, limit: 100` 会选择第 2001 行起的 100 行，再检查输出是否超过字节限制。

这不是在磁盘上只读取 100 行。因此行范围限制降低模型上下文负担，却不保证读大文件时只占用相应几行的内存。模型参数描述说的是行号，模式使用数值类型；正常调用应使用有效整数，不能从描述推导模式已经强制所有数值边界。

## 9.3 文本有两个独立输出上限

默认上限是 2000 行与 50 × 1024 字节，先触及哪一项就按哪一项截断。

字节限制按 UTF-8 编码长度计算，不能用 JavaScript 的 `string.length` 替代。中文、ASCII 和表情在字符数与字节数之间有不同关系。

`truncateHead` 尽量只返回完整行。首行本身超过字节限制时，不返回半行，而是报告该行太长，并给出使用 shell 提取局部内容的提示。

如果因为系统上限截断，会告诉模型下一次应使用的 `offset`。如果用户主动限制了行数、文件还没读完，也会提示剩余行数和继续位置。

```text
read 第 1 到 2000 行
  → 返回下一次 offset=2001
read 从第 2001 行继续
  → 重复直到文件末尾
```

这就是完整阅读大文件的机制。一次调用成功不表示模型已经看到了整个文件。

`read` 用 `text.split("\n")` 统计文件行数组，截断助手则不把末尾换行产生的空元素计为一行。阅读边界提示时要注意统计口径，尤其是带末尾换行的文件；不能把所有内部行数简单视为同一个值。

## 9.4 路径输入为何有平台适配

[utils/paths.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/paths.ts) 统一处理 `~`、`file://`、可选 `@` 前缀、Unicode 空格和 Windows shell 盘符路径。

[tools/path-utils.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/path-utils.ts) 的 `resolveReadPathAsync` 在原路径不存在时尝试几种 macOS 常见文件名差异：AM/PM 前的窄不换行空格、NFD Unicode 形式、弯单引号及其组合。

这能解决用户粘贴截图文件名后实际名字不完全相同的问题。它尝试已有文件，而不是改名或复制文件。编辑路径使用普通 `resolveToCwd`，不能假定所有读取容错同样用于写入。

`getFileRevision` 在资源层用设备、inode、大小和纳秒时间形成变化标识。但 `read` 没有把这一标识返回为之后 `edit` 必须提交的文件版本；不应凭附近存在这个辅助函数，就推导文件工具实现了版本锁。

## 9.5 图片按内容识别

[mime.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/mime.ts) 读取文件前 4100 字节，检查 JPEG、PNG、GIF、WebP 和 BMP 标识及部分结构。不只依据文件扩展名。

图片走二进制读取，再经 [image-process.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/image-process.ts) 转换为支持的内联格式并按模型限制缩放，结果包含说明文字和 base64 图像块。转换或缩放失败时返回文本说明，不能伪造图像。

模型没有图像能力时，读取工具会附加“本次请求将省略图片”的说明；读取工具仍可能产生图像块，真正模型请求的适配还需在更上层完成。这种分层避免把模型能力判断和原始文件读取混为一谈。

## 9.6 图片缩放为什么放进 Worker

图像解码、缩放和编码是计算密集型工作。如果都在终端主线程执行，等待模型期间的交互界面也可能停顿。

[image-resize.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/image-resize.ts) 创建 Worker，把复制后的字节缓冲转移过去。转移 ArrayBuffer 会让原缓冲失效，因此先复制，避免调用者的字节被意外分离。

Worker 返回一次结果、报告错误或退出。主线程统一处理结果，在 `finally` 请求终止 Worker。无法加载 Worker 时退回进程内实现，使图片读取仍可工作；这条回退也意味着不能承诺每个平台都将计算完全移出主线程。

默认尺寸上限是 2000 × 2000，默认编码体积上限按 base64 负载计算为 4.5 MiB；实际可由模型元数据覆盖。先按比例缩小尺寸，再依次尝试 PNG 和不同质量 JPEG，仍超限时将尺寸逐次乘以 0.75，直到最低可行尺寸。

源码注释写“挑更小格式”，但循环实际选择第一个满足上限的候选，PNG 排在 JPEG 之前。正文应描述实际选择规则，不应宣称它在所有候选中寻找最小体积。

缩放后附加原始尺寸、显示尺寸和坐标映射提示，帮助模型把图像位置换算回原文件。图像处理使用 Photon 的 Rust/WASM 实现，显式释放图像对象；EXIF 方向辅助代码处理翻转与旋转。

## 9.7 ls 处理一个目录

[ls.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/ls.ts) 检查路径存在且是目录，读取全部目录名，按不区分大小写的规则排序。逐项查询状态，为目录追加 `/`，无法查询的条目跳过。

默认最多返回 500 项，再检查 50 KiB 输出上限。点文件也在列表中；它不是递归遍历，不能用一次 `ls` 推断整个项目结构。

目录可能在读取条目与查询状态之间发生变化，因此跳过失效项是容错行为。输出也不是某一时刻整个目录的事务快照。

## 9.8 find 委托 fd 做文件名搜索

[find.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/find.ts) 的默认实现调用 `fd`，而不是在 TypeScript 中自行递归所有目录。

它构造参数数组，使用 `--glob --color=never --hidden` 和默认 1000 个结果上限。模式与路径放在 `--` 后，避免它们被当作选项；这里不需要先拼成 shell 命令字符串。

模式不含 `/` 时匹配文件名；含路径时加入 `--full-path`，相对模式必要时补 `**/`。Windows 下还处理本机路径分隔符。

代码向上查找 `.git` 来判断是否位于 Git 仓库中：仓库内保留 fd 自己的 Git 感知忽略规则；仓库外加入 `--no-require-git`。因此不能用一句“手动加载一份 .gitignore”概括其忽略行为。

结果统一为相对搜索根的路径和 `/` 分隔符。自定义 `glob` 操作可以替代 fd，并接收忽略目录和结果限制；自定义实现需要真实遵守这些选项，类型描述不能替它执行限制。

## 9.9 grep 委托 ripgrep 做内容搜索

[grep.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/grep.ts) 使用 `rg --json --line-number --color=never --hidden`，支持普通正则、固定字符串、不区分大小写和文件 glob 过滤。

默认限制 100 个匹配事件，到达上限就终止搜索子进程。输出匹配行用 `path:line:`；上下文行用 `path-line-`。每行另有限长规则，默认 500 个 JavaScript 字符串单位，再施加总输出字节限制。

这里“匹配数”对应 rg 的 match 事件，通常是匹配行，不能直接理解为一行里正则命中的总次数。恰好达到上限时会报告上限到达，也不表示已证明后面还有更多匹配。

没有上下文时优先使用 rg 事件里的行文本。有上下文时，待 rg 结束后重新读取对应文件，用调用内的 Map 缓存文件行，避免同一文件每个匹配都重复读取。

这也引入一个边界：搜索时的文件与后来读取上下文时的文件可能不同，没有一致性快照。出现“搜索定位与上下文对不上”时，要重新读取当前文件，而不是认为源代码必然矛盾。

与 `find` 不同，`GrepOperations` 只替换目录判断和上下文读取，默认搜索子进程仍是本地 rg。仅传一个远程 `readFile`，不会自动把搜索本身迁到远端。

## 9.10 搜索工具的退出码与取消

rg 的退出码 1 表示没有匹配，按普通空结果处理。主动因匹配上限终止，也不当作执行错误。其他失败返回标准错误输出或退出码。

find/grep 的取消路径会停止对应子进程。它们是只读搜索，取消时结束等待与文件修改临界区提前释放的问题不同。自定义后端如果没有接受取消信号，底层工作仍可能继续，返回的 Promise 状态不等于所有外部工作瞬间停止。

## 9.11 外部搜索程序如何获得

[tools-manager.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/tools-manager.ts) 先查 Pi 的工具目录，再试系统 PATH；fd 还接受 `fdfind` 这个名称。缺失且非离线模式时，根据平台与架构下载安装工具。

它从 GitHub 的 latest 页面重定向取得版本，选择对应归档格式；macOS x64 的 fd 有专门固定版本规则。下载后的解压目录带工具名、进程 id、时间和随机后缀，减少 fd 与 rg 同时安装时的目录碰撞。

但这条下载路径没有进程内单工具 Promise 去重或跨进程安装锁。独立解压目录解决的是其中一种冲突，不能推导多个进程对同一归档或最终目标的安装已经全面互斥。

`PI_OFFLINE` 的指定真值会跳过下载；Android/Termux 路径要求使用系统包管理器。源码分析不需要真的触发下载，教材也不把联网安装当作读取原理的实验。

## 9.12 模型截断与界面折叠是两件事

工具执行阶段的 50 KiB 上限决定模型能得到多少输出。渲染器的折叠决定终端初始展示多少行，例如普通 read 成功结果默认折叠、find 与 ls 默认显示前 20 行。

展开终端组件只能显示已经返回的内容，不能找回因工具输出上限被截掉的内容。后者需要再次读取或查看完整输出文件。

渲染器被拆到 `tools/renderers/`，让只展示工具结果的进程可以导入展示代码。不能据代码中的性能注释将某个内存数字写成所有环境都相同的测量结果。

## 9.13 源码定位与练习

| 文件 | 学习内容 |
| --- | --- |
| [read.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/read.ts) | 全文件读取、行范围、图片分支 |
| [truncate.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/truncate.ts) | 按行与 UTF-8 字节截断 |
| [find.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/find.ts) | fd 参数和路径模式 |
| [grep.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/grep.ts) | rg JSON 事件与上下文缓存 |
| [image-resize-core.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/image-resize-core.ts) | 尺寸、格式、编码负载 |
| [tools-manager.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/tools-manager.ts) | 外部工具发现与下载 |

练习：10 万行文件调用 `read(limit: 10)`，是否只从磁盘读取 10 行？答案是否定的，当前默认实现先完整读取。

练习：grep 搜索到函数签名后，能否说明整个函数的异常路径？答案是否定的，应以 read 获取完整实现及相关依赖。

练习：终端按键展开 read，能否绕过工具的 50 KiB 上限？答案是否定的，界面折叠与工具截断属于两层。
