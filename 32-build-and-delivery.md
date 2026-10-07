# 第三十二章 从源码到安装包：构建、资源与交付

开发时能够导入一个函数，不代表用户安装后也能调用它。工作区可能恰好提供某个未声明依赖，图片 worker 可能还留在源码目录，模型 JSON 可能只存在于开发者电脑。本章说明 Pi 如何把这些隐式条件变成可检查的交付边界。以下内容描述基准提交中的脚本，没有实际执行构建、安装或发布。

## 32.1 Node 运行源码与发布 JavaScript

第二章介绍了可擦除的 TypeScript 语法：删除类型后，不需要额外生成运行逻辑。源码中的相对导入使用 `.ts`，方便支持类型擦除的 Node 直接运行；[tsconfig.base.json](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/tsconfig.base.json) 的 `rewriteRelativeImportExtensions` 在构建时把相对导入改为发布 JavaScript 所需的扩展名。

```text
源码：import { x } from "./helper.ts"
构建输出：import { x } from "./helper.js"
```

根 [tsconfig.json](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/tsconfig.json) 设置 noEmit，主要检查源码和测试；各包的 `tsconfig.build.json` 则指定 src、dist 和构建依赖的声明文件。严格类型检查、声明文件与源码映射是不同产物：`.d.ts` 给消费者提供类型，source map 帮助定位异常，JavaScript 才是普通安装后的执行文件。

源码路径别名也不能原封不动成为用户安装后的条件。根配置可把工作区包映射到其他包的 src；发布构建必须能够根据真实 package.json 入口解析依赖。

## 32.2 为什么根构建有顺序

根 [package.json](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/package.json) 明确串行构建 Chord、TUI、Telemetry、Codemode、MCP、AI、Durable、Agent、Protocol、Client、Server，最后构建 Coding Agent。这个顺序使后面的包能读取前面包生成的声明与运行文件。

不能因为这些包位于同一个工作区，就假设任意顺序构建都可行。例如 Coding Agent 的构建路径映射会读取 AI、Agent 和 TUI 的 dist 声明；相关输出不存在时，类型解析与后续打包都可能失败。

`build` 与 `build:offline` 还有模型数据来源的区别：AI 的普通 build 先生成模型目录，离线 build 只验证已有模型数据再编译。离线并不意味着模型数据可以缺失；它意味着使用已经物化并校验的快照。

## 32.3 包清单决定什么能被安装

[coding-agent/package.json](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/package.json) 的 bin 指向 `dist/bundle/cli.js`，SDK 主入口指向 `dist/index.js`，RPC 有自己的发布入口。exports 中的实验性 client 和 plugin 仅声明 source 条件；正式 dist 构建与文件清单排除实验性目录。

exports、files 和 dependencies 分别控制三个问题：哪些子路径允许导入、哪些文件进入 tarball、哪些其他包必须被安装。仅在源码里导出一个符号，并不能证明它已成为用户安装环境中的公共 API。

AI 包还用 sideEffects 标记 compat、images 和图片提供商注册入口。Tree shaking 是打包器删除不可达代码的过程；错误地把必要注册动作当作无副作用代码删除，会让包成功加载却找不到提供商。

## 32.4 普通编译与 Node bundle

[build-coding-agent-bundle.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/build-coding-agent-bundle.mjs) 在各包已有 dist 后，使用 esbuild 构建 CLI runtime、SDK bundle 和 RPC 入口。它开启 ESM 代码分割，多个入口可以共享按哈希命名的 chunk，目标为 Node 22.19。

打包使用空的 tsconfig 路径映射，要求解析方式与真实 npm 安装一致。它还检查所有外部导入，只允许 Node 内建模块及显式列出的包。若出现意外外部依赖，构建直接失败，而不是把缺失依赖留给用户运行时发现。

Jiti 的转换器在 Node 包中通过同步 lazy require 延迟装载；只有真正导入扩展时才需要加载转换实现。这是降低启动模块成本的选择，不是把扩展放进安全沙箱。

## 32.5 为什么 worker 必须有独立入口

主打包器能够跟随静态导入，却不一定能解析变量形式的模块路径或 worker URL。因此脚本单独输出 Bedrock 实现、各 OAuth flow、图片缩放 worker 和 Codemode worker。

```text
主程序加载成功
用户第一次调用图片工具
image-resize 根据自己的位置寻找 worker
若 worker 未打包或输出位置错误，此时才失败
```

脚本读取 OAuth loader 中的 flow 列表，要求每个 flow 都有独立输出项；还核对 loader、config 与 worker 的输出目录。第四章所述 config.ts 资源辅助函数依赖这些位置约定，不能随意把某个文件移动到另一个 chunk 目录。

CLI launcher 先启用 Node compile cache，再加载 CLI runtime。编译缓存减少后续进程的代码编译成本，不是模型响应缓存，也不改变会话日志持久化。

## 32.6 浏览器边界如何检查

[check-browser-smoke.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/check-browser-smoke.mjs) 尝试构建浏览器入口，检查 Durable 通用环境和存储协议能进入浏览器 bundle，同时 Node 文件与 SQLite adapter 不被拉入。

它还构建只使用选定提供商的 Agent 示例，检查没有顺带引入 compat 全注册入口、整个生成目录，以及无关提供商 SDK。检查不只看模块是否出现在图中，还看是否有字节真正进入最终输出。

缺失的忽略模型 JSON 在这项检查中可用空目录数据替代，目的是检查模块图与浏览器可打包性。这不是一个真实模型目录，因此不能把浏览器 smoke 通过解释成所有模型都能正常调用。

## 32.7 入口依赖数量也是工程约束

[check-entry-graphs.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/check-entry-graphs.mjs) 跟随值导入图，为特定入口设置文件数量预算及禁止路径。例如纯模型辅助入口不应通过某个桶文件拉入整个提供商注册系统。

类型导入在运行时被擦除，所以与值导入的成本不同。`export *` 可能扩大运行依赖图；一个看似方便的重新导出，可能让只需小函数的消费者加载许多 SDK。

该检查采用源码文本模式匹配和有限解析规则，而非执行所有可能的模块路径；它是入口约束的静态检查，不能替代实际安装 smoke 或启动测量。

## 32.8 运行依赖不能只放在 devDependencies

[check-runtime-deps.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/check-runtime-deps.mjs) 通过 TypeScript AST 检查公共包构建范围内的值导入、导出、字面量 require 与动态导入，要求对应包存在于 dependencies、optionalDependencies 或 peerDependencies。

它还检查被 exclude 的源码是否又经导入进入构建。TypeScript 的 exclude 只限制入口根文件；其他源码仍可通过 import 被带回来。这解释了为什么“把实验目录写入 exclude”还需要检查依赖图。

[check-pinned-deps.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/check-pinned-deps.mjs) 则要求直接外部注册表依赖固定精确版本，内部工作区依赖与某些非注册表来源按脚本规则处理。依赖清单控制版本要求，lockfile 固定完整解析图；二者需要同时审阅。

## 32.9 模型生成器为什么属于技术方案

[generate-models.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/scripts/generate-models.ts) 不是把上游 JSON 原样复制进项目。它读取 models.dev、OpenRouter、Vercel Gateway、Radius 等来源，筛选工具能力，区分 chat、image、classifier，再补充协议兼容信息、思考级别、缓存元数据与图片限制。

同一个上游 ID 可同时对应聊天和图片操作，所以完整目录按 type 区分身份；内部数据按 API 分组，用 `type:id` 作键。提供商 `.models.ts` 分片从 JSON 推导类型，`models.generated.ts` 汇总三类目录。

多个来源重复时，聊天目录保留首先加入的条目。生成器中的人工修正与兼容设置也是代码，需要修改生成逻辑并重新生成，不能直接编辑最终聚合文件。书中不把这些基准版本的模型名称与价格当作今天的服务保证。

## 32.10 严格生成、暂存与失败恢复

普通非严格生成允许部分来源失败后返回空结果；项目发布路径使用 strict，使相关来源错误与特定目录缺失成为失败。完整上游响应也不等于合法输出，因此生成后仍需校验。

生成器先在临时目录写所有提供商 JSON 和 manifest，检查结构、身份与内容，再替换生成数据。更新 TypeScript 分片前保存旧文件内容；数据替换时将旧目录移动到暂存区域，后续校验失败则恢复旧数据，并通过异常处理恢复旧分片。

这是脚本在正常异常路径中的补偿恢复，不是跨文件系统、跨进程的事务。没有通用目录写锁，也没有把所有重命名和 TypeScript 文件写入合成一个原子提交；进程崩溃或多个生成器并发执行不能据此获得数据库式保证。

## 32.11 manifest 校验的具体范围

[model-data.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/scripts/model-data.ts) 检查聚合文件的提供商列表、分片集合、数据文件集合、schema 版本、结构哈希与每个文件的 SHA-256。随后检查模型 type、id、provider、api、模态、上下文和输出限制及费用字段。

SHA-256 在这里证明文件内容与清单一致，不证明价格在真实服务端仍正确，也不证明目录本身可信。类型声明和运行时数据校验同样各有作用：声明帮助消费者写代码，数据校验拒绝缺失或损坏快照。

[hydrate-model-catalog.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/ai/scripts/hydrate-model-catalog.ts) 可从已保存的完整目录离线生成内部 JSON，使用固定生成时间，使相同输入产生相同字节。它先验证暂存目录，再删除旧 data 并重命名新目录；与完整生成器相比，其替换路径没有保存旧目录用于失败恢复，应分别阅读。

## 32.12 内容地址目录与更新指针

[model-catalog-protocol.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/model-catalog-protocol.ts) 定义内容 revision、模型分片和版本兼容选择。带 Pi 版本的请求选择不高于该版本的最高 minimumPiVersion；未指定版本时使用默认 revision。legacy 返回聊天目录，typed 返回包含不同操作类型的目录。

[publish-model-catalog.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/publish-model-catalog.mjs) 校验整包与分片一致、必需提供商存在、数量达到下限，以完整目录字节生成 revision。上传顺序是先不可变 revision 下的所有数据，最后更新可变 index 指针。

```text
revision 数据上传一半失败：旧 index 仍指向旧完整数据
全部 revision 数据成功：再写 index，客户端开始选择新数据
```

这个顺序避免新指针过早暴露不完整数据。脚本本身没有针对任意并发发布者使用对象存储 CAS；下载 index、合并再上传仍可能发生并发覆盖，因此工作流的串行协调与存储层一致性是另外的边界。

## 32.13 安装专用 lockfile 怎么生成

[generate-coding-agent-install-lock.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/generate-coding-agent-install-lock.mjs) 从根 lockfile 追踪编程代理的生产依赖图，把内部工作区链接转成发布包地址，保留必要的嵌套解析路径和平台可选依赖，删除开发与 extraneous 标记。

验证要求没有本地 link/resolved 路径，内部版本一致，所有依赖可解析，精确版本匹配，并保留平台相关项。`hasInstallScript` 条目还必须匹配明确的包名与版本允许清单；已经不在图中的旧允许项也会报错，防止白名单永久膨胀。

`--check` 只比较现有文件与确定生成结果；正常模式写出文件。这项检查不运行被允许的生命周期脚本，允许清单也不能被理解为无需审阅新版本行为。

## 32.14 从仓库外安装为什么能发现新问题

[coding-agent-consumer.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/coding-agent-consumer.mjs) 对发布包执行 pack，再创建只有编程代理作为直接依赖的独立安装目录，用本地 tarball overrides 选择传递依赖。

随后检查实验性 client/protocol/server 没被意外装入，相关源码目录与子路径没有进入安装包，并在最小离线环境里导入 SDK、运行 CLI 版本查询。仅将所有工作区包一起安装，会掩盖缺失的依赖声明；这里的单一直接依赖正是为了暴露这种情况。

[local-release.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/local-release.mjs) 进一步生成仓库外的 Node、Bun 安装和当前平台二进制。它默认会生成模型、检查、构建和测试，具有大量实际副作用。本书只读其实现，没有把它当作一个无成本的文档验证命令运行。

## 32.15 独立二进制还需要什么

[build-binaries.sh](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/build-binaries.sh) 使用 Bun compile 构建不同平台产物，并显式传入图片与 Codemode worker 入口。x64 使用 baseline 目标；编译时禁止自动加载项目 bunfig，避免当前工作目录的 preload 在 Pi 启动前执行。

独立产物仍需要附带主题、图片资源、HTML 导出模板、WASM、平台 native helper、文档与示例，因此交付单位是完整压缩包，而不是只复制 `pi` 可执行文件。

[bun/runtime-setup.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/bun/runtime-setup.ts) 注册二进制需要的 OAuth/Bedrock 实现以及嵌入 QuickJS WASM 路径。[restore-sandbox-env.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/bun/restore-sandbox-env.ts) 则在特定 Bun 沙箱环境中、process.env 完全为空时尝试从 Linux `/proc/self/environ` 恢复变量。它不会无条件覆盖已有环境。

## 32.16 可复现源码归档与实际发布步骤

[create-source-archive.sh](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/create-source-archive.sh) 使用临时 Git index，把指定提交与已物化的忽略模型数据组合成树，用提交时间及不带时间戳的 gzip 生成归档，验证必需文件、路径前缀以及没有 node_modules 或构建二进制。相同提交和相同模型数据是可复现的前提；相同提交配不同上游快照可能生成不同归档。

[release.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/release.mjs) 先检查工作区干净与 npm 包注册，再同步版本、更新 changelog、生成目录和安装锁，运行检查与测试，最后提交、打 tag 并推送。它会改变仓库与外部服务，不能作为普通学习命令试运行。

[publish.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/scripts/publish.mjs) 先校验所有公共包的版本和 tarball，再发布尚不存在的版本；`--dry-run` 仍查询注册表并检查打包内容，不代表完全没有网络。

## 32.17 发布不是一笔跨服务事务

[build-binaries.yml](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/.github/workflows/build-binaries.yml) 先生成并测试产物，再将 GitHub Release 放在草稿状态，发布 npm、完成 pi.dev 公告，最后公开 GitHub Release。失败清理可以删除草稿，但不能撤销已发布的 npm 包。

因此恢复依赖“已发布版本可识别并跳过”等机制，而不是全局 rollback。工作流按 release tag 设置 concurrency，防止同一 tag 的构建彼此取消；公告另有串行组。这类协调与第十一章的进程内文件队列作用域完全不同。

## 32.18 受管理安装如何协调两个更新进程

[package-manager-cli.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/package-manager-cli.ts) 先验证 managed-install marker 的 kind、schemaVersion 和 layout，并确认当前包路径确实位于该安装的 releases 中。仅继承 `PI_MANAGED_INSTALL_ROOT` 环境变量的源码进程不会自动被当作该受管理安装。

更新先校验版本字符串，再用 proper-lockfile 锁住 `<managedRoot>/update`，同一安装中另一更新者遇到 ELOCKED 会明确失败。清理 staging 也尝试获得同一个锁；拿不到便跳过，不清除正在更新的目录。

正常更新轨迹为：

```text
取得 update 锁
→ 创建独立 staging/update-* 目录
→ 下载 package.json 与 package-lock.json
→ npm ci --ignore-scripts，安装生产和可选依赖
→ 实际运行新 CLI --version，核对目标版本
→ rename staging 为 releases/<version>
→ 临时文件写 current-version，再 rename 切换指针
→ finally 清 staging 并释放锁
```

已存在目标 release 时先运行版本验证，再激活它。安装或验证失败发生在激活之前，旧版本指针通常尚未切换；如果 release 已移动但激活失败，可以留下未激活的完整目录。指针 rename 与整个安装不是同一笔事务，也没有在此处用 fsync 建立断电持久性保证。

两个 manifest 下载可并行，因为彼此独立；目录安装、验证与激活必须顺序执行。此下载辅助函数使用普通 fetch，未在它自身加总超时或重试。不能将版本查询的管理 HTTP 重试预算自动套到全部更新请求。

## 32.19 更新目标、信任和 Windows 文件占用

没有目标的 `pi update` 默认只更新 Pi；`--extensions`、`--models` 与 `--all` 分别走不同路径。`--all` 先更新扩展，再更新 Pi，因此后者失败不会撤销已更新扩展。模型目录刷新单独设十五秒取消，并显式允许联网。

install/remove 的项目作用域需要项目信任；update 使用已保存的信任，不为自动更新重新装入一批项目钩子。自更新命令的 npmCommand 从全局 settings 读取，避免项目设置直接决定应用自身的更新命令。配置 TUI 同样分别解析全局与已信任项目的资源视图。

Windows 的原生依赖可能已被当前进程加载。[windows-self-update.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/windows-self-update.ts) 从 process.report 的 sharedObjects 找到当前包内已加载文件，移动到带时间、PID、UUID 的 quarantine，再把文件复制回原路径，让 npm 更新面对的是新的文件对象。清理旧 quarantine 失败可忽略，因为旧进程可能尚未退出。

这里的 move/copy 是平台更新准备，不是对所有 native 文件建立跨进程事务。它按路径归属和小写比较筛选文件；中途失败没有把全部移动自动回滚。

## 32.20 原生终端 helper 与版本提示的辅助路径

[win32/build.mjs](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/tui/native/win32/build.mjs) 为 x64 与 arm64 选择 MSVC 或 MinGW 工具链，在临时目录生成构建批处理或调用交叉编译器，再复制产物到对应 prebuild 目录。退出和 SIGINT 清理临时目录。探测工具链与实际构建是两步；环境中的 CC 配置可以改变编译器，不能只根据宿主架构猜生成目标。

[version-check.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/version-check.ts) 查询发布信息，普通启动检查捕获错误并退回无提示；主动更新则会报告获取失败。合法 semver 用语义版本比较，无效版本回退为字符串不同即视为候选更新。`PI_OFFLINE` 与跳过版本检查也在不同层生效。

[changelog.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/changelog.ts) 将已发布条目的本地文档链接和浮动 main/master 链接固定到相应 tag，并规范旧仓库域路径。这样用户读旧版本说明时，不会无意间跳到当前主分支中的另一套接口。

## 32.21 练习

1. 在主入口成功导入的情况下，列出图片 worker 第一次运行仍可能失败的两个打包原因。
2. 为什么源工作区所有测试通过，依然需要仓库外的单依赖安装检查？
3. 说明模型 manifest 内容哈希、内容 revision 与签名分别能够证明什么；当前脚本实际实现了哪些？
4. 如果 index 上传失败而 revision 全部上传成功，客户端会看到什么？如果两个发布者同时读旧 index，则还缺少什么保证？
5. 比较完整生成器和离线 hydration 在替换旧数据失败时的恢复路径。

下一章把这些局部机制串成完整轨迹，说明一次用户输入到底跨过哪些边界，以及哪里需要调用者自己承担并发与恢复责任。
