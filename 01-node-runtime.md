# 第一章 Node.js 进程与异步执行

本章要解决的第一个问题是：一个命令行程序为什么能够一边等待模型，一边更新界面，并且同时执行多个文件工具？理解它需要先区分进程、JavaScript 执行和异步操作。

## 1.1 程序首先是一个进程

进程是操作系统管理的一次程序运行。进程拥有内存、环境变量、当前工作目录和标准输入输出。`pi` 从哪个目录启动，会影响相对路径如何解析；它继承的环境变量会影响配置、认证和网络行为。

源代码是文字文件。Node.js 是执行 JavaScript 的运行时，它为程序提供文件系统、进程、网络和终端接口。TypeScript 在 JavaScript 之上增加类型描述；这些描述帮助开发者检查代码，但不会自动把文件系统变成安全沙箱。

### 先认识代码中的值、对象与函数

如果没有写过 JavaScript，先读下面这段教学代码：

```js
const edits = [
  { oldText: "alpha", newText: "ALPHA" },
  { oldText: "beta", newText: "BETA" },
];

function describe(edit) {
  return edit.oldText + " → " + edit.newText;
}

for (const edit of edits) {
  console.log(describe(edit));
}
```

字符串是文字值；数组 `[]` 保存有顺序的多个值；对象 `{}` 用字段名保存值；`edit.oldText` 读取对象字段。函数接收参数，`return` 把结果交回调用者。for-of 依次取得数组元素；console.log 把一行文字写到标准输出。

`const` 表示变量绑定不能重新赋值，并不冻结对象。可以执行 `edits.push(...)`，因为改变的是数组内容；需要重新赋值的计数器使用 `let`。对象赋给另一个变量时，两者通常指向同一个对象；这解释了为什么 Pi 经常复制数组，又为什么数组浅复制仍不能隔离内容对象。

`(edit) => describe(edit)` 是箭头函数，可以作为参数交给其他函数。`edits.map(describe)` 产生一个新数组，`filter` 保留满足条件的项，`find` 返回第一项或 undefined。遇到这些代码时先确认它返回单个值还是数组，避免把“找不到”当作空对象继续读字段。

### 模块与一个最小可运行例子

将下面教学代码保存为独立的 `hello.mjs`，再用项目要求的 Node 版本运行 `node hello.mjs`：

```js
import { cwd } from "node:process";
import { resolve } from "node:path";

const input = "src/main.ts";
console.log(resolve(cwd(), input));
```

这里的 `import` 从 Node 内建模块取得函数；`node:` 表示运行时自带模块，不是从 npm 下载一个同名包。这个例子只输出解析后的路径，不读写目标文件，也不要求配置模型。

npm 管理 JavaScript 包和项目脚本。`package.json` 的 dependencies 表示运行需要的包，devDependencies 通常服务于开发与检查，scripts 定义命令。npm workspaces 把多个包组织在同一仓库中；不是把每个源码文件变成独立进程。第三章再逐一映射 Pi 的十三个包。

本项目根目录的 [package.json](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/package.json) 声明 `"type": "module"`，使用 ECMAScript 模块，并要求 Node.js 至少为 22.19.0。版本要求描述运行环境，不能代替安装依赖，也不能保证任意 TypeScript 语法都能直接执行。

### 当前工作目录不是访问范围

假设 Pi 在 `/work/project` 中运行，工具接到 `path: "src/main.ts"`。它会得到 `/work/project/src/main.ts`。如果传入绝对路径 `/tmp/demo.ts`，则访问该绝对路径；`../shared/file.ts` 也可以指向项目目录外。

因此，“相对项目目录解析”是方便定位文件的规则，不是限制读写范围的权限规则。具体定位代码在 [path-utils.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/path-utils.ts) 的 `resolveToCwd`。

## 1.2 同步调用与异步调用

同步调用完成后，下一句代码才执行。异步调用可以先启动工作，返回表示未来结果的对象。这个对象叫 Promise。

```ts
// 教学简化代码
const pending = readFile(path);
const buffer = await pending;
const text = buffer.toString("utf-8");
```

`pending` 不等于文件内容。`await` 表示当前异步函数要等待结果；等待期间，运行时可以处理别的任务。结果成功时，`buffer` 得到内容；失败时，`await` 抛出错误。

`async` 函数返回 Promise。即使函数直接 `return "ok"`，调用者得到的也是代表字符串结果的 Promise。阅读本项目时，遇到 `Promise<T>` 就应追问两个问题：谁等待它？失败由谁处理？

## 1.3 JavaScript 单线程仍然会发生竞态

竞态是执行交错改变最终结果的问题。它不要求两段 JavaScript 指令在同一瞬间运行。

文件初始内容是：

```text
alpha
beta
```

两个任务分别把 `alpha` 改为 `ALPHA`、把 `beta` 改为 `BETA`。如果都先读取旧文件，再分别写入自己的结果，就会出现：

```text
A 读到 alpha/beta
B 读到 alpha/beta
A 写入 ALPHA/beta
B 写入 alpha/BETA
```

最后 A 的修改消失了。这里 JavaScript 仍可一次只执行一个回调，但 `await readFile` 和 `await writeFile` 之间存在交错点。只要多个任务操作共享资源，就需要讨论顺序。

本项目的 `edit` 因此把整个“读取—计算—写入”放入按文件队列，而不是只把 `writeFile` 排队。实现详见第十一章。

## 1.4 Promise.all 保持结果位置，不保证完成顺序

```ts
// 教学简化代码
const results = await Promise.all([runA(), runB()]);
```

这会启动 A、B，再等待它们都成功。B 可以先完成，但 `results[0]` 仍然是 A 的结果。一个 Promise 失败会使整体等待失败，并不自动撤销其他任务已经启动的工作。

Pi 的代理循环利用这一区别：并行工具可以按实际完成顺序更新界面，但工具结果写入模型对话时保持模型声明的顺序。源码在 [agent-loop.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/agent-loop.ts) 的 `executeToolCallsParallel`。

这解释了一个容易混淆的现象：界面先显示第二个工具完成，并不意味着模型下一轮看到的工具结果被重排。

## 1.5 错误、finally 与资源释放

```ts
// 教学简化代码
await previous;
try {
  return await mutate();
} finally {
  releaseNext();
}
```

`try` 中成功、抛错或等待的 Promise 失败，都会进入 `finally`。这让一个失败的编辑操作不会永久阻塞后续操作。

注意这里的 `return await`：函数需要等 `mutate()` 完成后再释放资源。如果写成只返回尚未完成的 Promise，而资源释放过早，后续工作可能与实际写入重叠。理解异步 `finally` 的时间关系，比记住语法形式更重要。

Pi 的文件队列尾部 Promise 表示“轮到下一项了”。它不承载业务结果，因此业务失败不会把后续队列也变成失败链。

## 1.6 取消是请求，不是撤销历史

`AbortController` 用来发出取消信号，`AbortSignal` 用来观察它。调用 `abort()` 后，配合这个信号的程序可以停止后续工作。信号本身不会自动撤销已完成的文件写入，也不会使任意底层操作立即消失。

Pi 的 `edit` 在多个 `await` 之后检查 `signal.aborted`。如果取消发生在一次写入已经启动以后，它先等写入完成，再报“Operation aborted”，最后释放文件队列。

因此，下列状态可以同时成立：

- 工具向调用者报告取消。
- 文件实际上已经发生修改。
- 后续编辑必须读取修改后的文件。

这不是事务回滚。事务回滚是另一种机制，需要额外保存旧状态并可靠恢复，当前默认文件编辑路径没有提供它。

## 1.7 回调和事件把层次连接起来

回调就是传给另一段代码、由它在适当时刻调用的函数。事件是在状态变化时通知订阅者的数据。

工具的 `onUpdate` 回调报告局部输出；代理循环把它转换成 `tool_execution_update` 事件；界面订阅事件并更新显示。执行工具不必知道界面的颜色，界面也不必参与底层文件写入。

在 [agent.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/agent.ts) 的 `subscribe` 和 `processEvents` 中，事件监听器按订阅顺序被等待。一个监听器的异步处理也是当前运行的一部分。`agent_end` 表示循环不再产生事件，而 `waitForIdle()` 要等监听器结束后才完成。

### 事件循环、流和缓冲区

事件循环负责在当前同步代码结束后处理已就绪的异步工作。`await` 暂停当前异步函数，不暂停整个进程；一个永远不让出的同步计算却可能阻止界面及时处理输入。`setTimeout(fn,100)` 表示最早约一百毫秒后可以调度，不保证正好在第 100 毫秒运行。缓存预热和超时实现都需要考虑这种迟到。

Buffer 保存字节，JavaScript 字符串保存文本。中文字符的 UTF-8 字节数可以大于字符串 length；读取块可能在一个字符的中间断开。第十三章用 StringDecoder 处理日志块，第十八章还要另算终端显示宽度。字节数、字符串长度和屏幕列数不能互换。

流把较大结果分成多块交付。异步迭代器支持 `for await (const event of stream)`：每次等待下一项，而不是一次拿完整数组。流的正常结束、错误结束与连接突然 EOF 是三种情况；提供商适配器要确保最终结果也能结束，不能永远等待一个已经断开的连接。

标准输入、输出、错误分别是 stdin、stdout、stderr。stdout 适合结果或协议，stderr 适合诊断；写出也可能遇到背压，即接收者暂时来不及消费。第四章说明 Pi 如何串行等待写出，避免 JSON 协议与普通日志混杂。

## 1.8 本章源码定位与练习

| 源码 | 观察点 |
| --- | --- |
| [package.json](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/package.json) | 模块格式、工作区、Node.js 版本要求 |
| [file-mutation-queue.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/file-mutation-queue.ts) | Promise 链和 `finally` |
| [edit.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/edit.ts) | `await` 后的取消检查 |
| [agent.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/agent.ts) | 订阅者等待与运行结束 |

练习：画出两个编辑同时读取同一文件的轨迹，再把队列加到“仅写入”和“读取到写入整体”两个位置。只有后者让 B 的读取发生在 A 的写入之后。

练习：假设工具写入在第 20 毫秒启动，第 25 毫秒收到取消，第 40 毫秒才完成。说明为什么第 25 毫秒立即释放队列会让下一项与它重叠。答案在第十一章。
