# 第十五章：配置与凭据怎样避免互相覆盖

两次 Pi 进程可能同时修改同一份 `settings.json`。例如进程 A 切换主题，进程 B 关闭自动压缩。如果两者都把启动时读到的整个对象写回，后写入者会撤销另一方的修改。本章分析 Pi 用什么方式缩小这个问题，以及这些方式为何不等于数据库事务。

主要源码是 [settings-manager.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/settings-manager.ts)、[auth-storage.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/auth-storage.ts)、[trust-manager.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/trust-manager.ts) 和 [models-store.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/models-store.ts)。

## 15.1 先区分三个并发范围

| 范围 | 典型机制 | 本项目中的例子 |
| --- | --- | --- |
| 同一个对象中的异步操作 | Promise 尾链 | `SettingsManager.writeQueue` |
| 同一模块实例中的文件工具 | 按路径的 Promise 队列 | 第十一章的 `withFileMutationQueue()` |
| 使用同一磁盘锁协议的多个进程 | `proper-lockfile` | 配置、凭据和信任存储 |

第三行只能协调遵守该协议的参与者。用户编辑器、shell 的重定向和另一个不使用该锁的程序，仍可能直接写这些文件。锁也不会使 `writeFileSync()` 自动变成临时文件加重命名、磁盘同步或多文件事务。

本章解释仓库对 `proper-lockfile` 的调用与参数；依赖内部如何处理文件系统、心跳和异常，不应仅凭函数名猜测。书中不声称已运行其跨进程验证；本次安装工程依赖也不改变这项验证边界。

## 15.2 有效设置是几层合并的结果

`SettingsManager` 同时保留 `globalSettings`、`projectSettings` 和有效 `settings`。全局文件位于 agentDir，项目文件位于 cwd 的 `.pi/settings.json`。

`deepMergeObjects()` 递归合并普通对象，项目字段覆盖全局字段；数组不按元素递归合并，`undefined` 覆盖值被跳过。例如：

```json
// 全局：
{"compaction":{"enabled":true,"reserveTokens":16384}}
// 项目：
{"compaction":{"enabled":false}}
// 合并结果：
{"compaction":{"enabled":false,"reserveTokens":16384}}
```

这是带注释的教学表示，单独的配置文件仍须是合法 JSON。

`defaultTools` 有专门规则：普通工具名列表替换继承列表；全部由 `+name`、`-name` 构成的列表则按顺序追加修改。没有普通名字的修改列表从默认 `read,bash,edit,write` 开始计算。空列表明确得到空工具选择。

`applyOverrides()` 改变有效设置，不自行持久化。之后重新合并、重载等操作可以改变这层结果，因此不能把一次临时覆盖看成永远存在的独立配置文件层。

部分设置只读全局值，例如 `defaultProjectTrust`、设备 ID 和缓存预热模式。特别是预热会产生模型请求费用，源码因此不允许项目设置替用户开启另一种预热模式。

## 15.3 setter 先更新内存，再排队保存

以 `setCompactionEnabled(false)` 为例：

1. 更新内存中的全局 `compaction.enabled`。
2. 标记顶层 `compaction` 和嵌套 `enabled` 已修改。
3. 重新计算有效设置。
4. 深复制本次设置，并复制已修改字段集合。
5. 把保存任务接到 `writeQueue` 后面。

复制快照很必要。否则 setter 返回后，另一个 setter 可能改变同一个内存对象，让已经入队的旧任务保存一个并非它原本代表的状态。

实际写入时，`persistScopedSettings()` 在存储回调中重新解析磁盘当前对象，只覆盖本次标记的字段，而不是把整个旧快照替换到磁盘。

对于标记过嵌套键的字段，它先复制磁盘上的该嵌套对象，再修改相应键。例如修改 `compaction.enabled` 时，可以保留另一进程刚修改的 `compaction.reserveTokens`。

这项保护有粒度限制。`setModelThinkingLevel()` 标记的是整个 `modelThinkingLevels` 字段，没有标记单个模型键。因此两个进程各修改不同模型的思考级别，仍可能后写者覆盖前写者的整张映射。这是根据标记与合并代码可推导的边界，不是本次运行过的测试结果。

## 15.4 保存错误被收集，flush 不等于保证成功

`enqueueWrite()` 在队列任务失败时调用 `recordError()`，使尾链继续可用；错误不会把所有后续任务永久阻断。`drainErrors()` 取出并清空诊断。

`flush()` 等待调用时当前的写入尾链。由于错误已经被队列捕获，仅仅 `await flush()` 返回不能证明每次保存都成功；调用者还需要处理诊断。等待期间新加入的任务也不能仅凭一次 `flush()` 就被认定全部完成。

如果加载某个设置文件时发生解析错误，对应保存路径会停止自动写回，避免把损坏文件悄悄替换成内存默认值。`reload()` 先等待已有队列，再重新加载；重载失败保留原来有效的内存设置并记录错误。

设置文件没有一个在加载时严格验证所有字段的统一 schema。部分 getter 会检查类型、范围或使用默认值，例如压缩 token 数必须为非负安全整数；不能因为 TypeScript 的 `Settings` 接口存在，就认为任意 JSON 输入已经满足接口。

## 15.5 已存在的设置文件：锁住重新读取到写回

`FileSettingsStorage.withLock()` 如果判断目标文件已存在，会先获取同步磁盘锁，再读当前内容、执行回调、写入，并在 `finally` 释放锁。

同步锁获取遇到 `ELOCKED` 最多尝试 10 次，中间用约 20 ms 的忙等延迟。忙等是持续执行循环直到时间过去，会阻塞该进程的 JavaScript 执行；这里保留同步 API 的代价就是等待时不能处理其他回调。不能把它描述为异步睡眠。

存储向 `proper-lockfile` 传入 `realpath:false`。调用者已经做了路径规范化，但这个参数不能自动统一所有符号链接或硬链接别名。所有参与者仍需使用同一个锁身份。

## 15.6 首次创建文件有不同的临界区

如果设置文件不存在，`withLock()` 会先用 `undefined` 调用回调，等回调给出需要保存的内容后，才创建目录并获取锁。获得锁后没有重新读文件和重新计算合并结果。

根据实现，可以得到以下竞争轨迹：

```text
A：判断文件不存在 → 根据空对象算出 {theme:"dark"}
B：判断文件不存在 → 根据空对象算出 {retry:{enabled:false}}
A：获得锁 → 写入主题 → 释放
B：获得锁 → 写入先前算出的内容 → 释放
```

即使后两次实际写入被锁串行化，B 的内容仍基于空对象，A 的字段可能丢失。问题在于“读和计算”没有全部位于同一个临界区。临界区就是需要互斥执行的那段读、判断和修改过程。

这段轨迹说明为什么阅读并发代码不能看到 `lock` 就停止分析。必须逐步标出锁前、锁内和锁后的操作。本书记录该边界，不在撰写教材时修改产品实现。

## 15.7 凭据修改在锁内重新读取整份文件

`AuthStorage` 实现 `CredentialStore`，主要负责存储，不负责整个提供商认证流程。`modify(provider, fn)` 获取异步锁，解析当前文件，把当前提供商凭据交给 `fn`，再把新值合并回当前对象。

其他提供商的字段来自锁内读取到的磁盘对象，所以不会因为本实例内存快照较旧就自然被替换掉。`fn` 返回 `undefined` 表示保持当前凭据；删除有独立的 `delete()` 方法。

`FileAuthStorageBackend.withLockAsync()` 会在等待锁、取得锁、异步回调结束及写回前检查取消信号。锁持有期间的异步回调必须结束，才会进入 `finally` 释放锁。如果回调忽略取消，signal 不能强制结束它。这与文件修改队列“不能提前放行尚未结束的写入”遵循同一原则。

凭据文件首次创建使用 `0600`，目录首次创建使用 `0700`。写入 mode 仅用于创建，代码刻意保留现有文件的管理员权限和 ACL。ACL 是操作系统对文件访问权限的另一种描述方式。

初始化文件的存在检查与写入 `{}` 发生在获取凭据锁之前。根据实现，多进程首次创建仍有检查与创建之间的竞争，不能把正常修改路径的锁保证推广到整个初始化过程。

## 15.8 异步锁：可取消等待与锁失效检测

异步锁获取使用 30000 ms 的 stale 参数，并自己控制重试：从约 10 ms 的指数退避开始，加入随机抖动，单次延迟最多约 2000 ms，总等待受 30 秒截止时间约束。随机抖动用于减少多个等待者同时再次争锁。

取得锁的那个 await 返回时，用户可能已经取消；源码会先释放刚取得的锁，再抛出取消错误。

`onCompromised` 回调记录锁已受损。存储在回调前后、写入前后检查这个状态，避免在已知失去锁保证时继续正常返回。这里不能宣称“任何受损锁都不可能写入”：如果检测发生在写入完成之后，方法可能返回错误，而文件已经发生改变。

写回使用直接 `writeFileSync()`。进程崩溃、磁盘写失败或其他参与者绕过锁时，没有本模块提供的日志回滚或原子重命名。锁、写入成功、崩溃一致性是三个不同问题。

## 15.9 凭据缓存怎样共享一次重载

`AuthStorage.readLatestData()` 先比较文件 revision。revision 是文件元数据生成的标识，不是完整内容哈希，也不是文件编辑工具的乐观版本条件。

缓存需要刷新时，它建立一个重载 Promise，多个读者等待同一任务；每个读者有自己的取消信号，并增加 `readers` 计数。一个读者取消只结束自己的等待。最后一个读者离开后，代码才中止共享任务。

共享状态只为最先遇到的一份规范化文件路径保留，并不是一个永远增长的“所有路径到缓存”映射。普通 `reload()` 失败会保留最后有效的内存快照；一些没有取消信号的读取也回退到旧缓存。因此读取成功不一定意味着刚刚成功读到了最新磁盘内容。

`FileModelsStore` 复用同一个文件锁后端和类似的重载共享机制，但读取返回模型条目的深复制。不要把它的复制策略推广到所有 `AuthStorage.read()` 返回值：OAuth 对象在普通存储路径中并未统一深复制。

## 15.10 内存后端、只读后端与运行时覆盖

`InMemoryAuthStorageBackend` 用 Promise 链串行化异步修改；前一次失败会被捕获，下一次仍可执行。返回值可与取消信号竞争，但底层任务仍保持在尾链中，下一次修改要等待它结束。同步 `withLock()` 没有加入这条异步链，不能据此声称混用两种 API 也被同一互斥机制保护。

`ReadOnlyAuthStorage` 首次加载时验证凭据结构并缓存。它不创建文件，修改与删除直接报错；缓存也不会每次检查 revision。命令形式的 key 在读取中保留原配置，不在这个读取函数内执行命令。

[runtime-credentials.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/runtime-credentials.ts) 把 CLI 的临时 API key 放在内存 Map 中，读取时优先于底层凭据。这解释了 `--api-key` 为什么不需要写入 `auth.json`。但该包装器的 `modify()` 仍委托给底层存储，不能把整个对象理解成只读凭据视图。

## 15.11 配置值也可能是一段同步命令

[resolve-config-value.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/resolve-config-value.ts) 支持三种主要输入：

- 普通字面量。
- `$NAME`、`${NAME}` 环境变量插值；缺少任意变量时返回 `undefined`。
- 以 `!` 开头的 shell 命令，取其 stdout 并 trim。

普通值中的 `$$` 与 `$!` 可转义字面 `$` 和 `!`。环境值先检查凭据配置中的 env，再检查进程环境；空字符串被视为没有可用值。

命令使用同步子进程 API，设置 10 秒超时，并缓存结果到进程结束，失败结果也可以被缓存。`resolveConfigValueUncached()` 和要求报错的解析路径另行执行不缓存版本。因此“已经更新系统 keychain”并不必然意味着同进程缓存的命令值立即更新。

## 15.12 信任存储锁住哪些操作

`ProjectTrustStore` 为 `trust.json` 使用单独锁路径。读取和写入都在锁中进行；读取从规范化 cwd 向父目录查找最近的明确决定，子目录决定优先于祖先。

`setMany()` 在一次锁范围中读取当前对象并应用多项更新，值为 `null` 时删除该项，保存前按路径排序。允许“信任父目录并清除当前目录例外”的操作作为一次存储更新完成。

项目资源是否可信与工具本身是否有文件系统权限是不同问题。信任检查控制项目设置、扩展、技能等是否被加载；它不是每次 `edit` 调用上的操作系统沙箱。

## 15.13 练习：画出真正的锁范围

1. 在 `FileSettingsStorage.withLock()` 中标出文件已存在与不存在两条路径的临界区。
2. 分别修改 `compaction.enabled` 和 `modelThinkingLevels["provider/model"]`，保存合并的粒度为何不同？
3. 凭据回调忽略取消信号时，为什么不能立即释放锁？
4. `flush()` 返回但诊断中有保存错误，界面应该怎样描述结果？
5. 共享重载的一个读者取消，为什么不直接取消所有读者使用的任务？

判断并发保证时，始终追踪完整的“获取身份、获取锁、读取、计算、写回、释放”，并单独说明首次创建、失败和崩溃路径。
