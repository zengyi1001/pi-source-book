# 第二章 TypeScript 类型与模块

本章解决阅读 Pi 时最常见的障碍：哪些文字会在运行时执行，哪些只是编译器的描述？模型发来的参数为什么不能仅靠 TypeScript 类型信任？

## 2.1 值与类型是两个层面

```ts
// 教学简化代码
interface Edit {
  oldText: string;
  newText: string;
}

const edit: Edit = { oldText: "alpha", newText: "ALPHA" };
```

`edit` 是运行时的对象，拥有两项字符串值。`Edit` 是类型，用来检查开发者是否按约定使用对象。类型信息被去除后，外部输入仍可能是 `{ oldText: 123 }`；运行时不会因为接口声明而自动拒绝它。

阅读本项目先掌握这些常见写法：

| 写法 | 含义 | 对应运行时问题 |
| --- | --- | --- |
| `string`、`number`、`boolean` | 字符串、数字、真假值 | 不能把数字直接当作文件路径 |
| `Edit[]` | 多个 Edit 组成的数组 | 空数组仍可能符合类型 |
| `string \| undefined` | 可能有文字，也可能没有值 | 找不到模型时必须分支处理 |
| `signal?: AbortSignal` | 字段或参数可省略 | 访问之前检查是否存在 |
| `Promise<EditResult>` | 将来成功得到 EditResult | 调用者仍需处理拒绝 |
| `readonly string[]` | 类型层限制通过此引用修改数组 | 不等同于 Object.freeze 或深层冻结 |
| `Record<string, Model>` | 按字符串键保存 Model | 外部 JSON 仍需要运行时验证 |

`interface` 描述对象有哪些字段；`type` 可以给对象、联合和其他组合起名字。`void` 表示调用者不应使用返回值；`never` 常用于不可能发生的分支或始终抛错的函数。不要仅凭名字判断值的合法性，继续看构造和校验路径。

`value?.field` 在 value 为 null/undefined 时返回 undefined；`value ?? fallback` 只在 null/undefined 时回退，`value || fallback` 还会把空串、0、false 当作需要回退。这正是代理配置、环境变量和费用判断中容易产生不同语义的地方。

这正是 Pi 同时使用 TypeScript 和 JSON Schema 的原因。前者约束开发者写的程序，后者验证外部数据的形状。

## 2.2 模块、导入与包边界

一个模块通过 `export` 暴露内容，通过 `import` 使用其他模块。阅读导入列表可以知道代码依赖什么，但不能仅靠导入判断运行时的完整执行顺序。

```ts
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
```

第一行需要运行时函数。第二行只需要类型描述，`import type` 在执行时被去掉。

`./...` 定位相邻文件；`@earendil-works/...` 是包名。根目录 npm workspaces 把 `packages/*` 组织为同一个仓库里的独立包。包的 `package.json` 描述对外入口，内部文件不一定都能由包使用者直接导入。

根 [tsconfig.json](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/tsconfig.json) 的 `paths` 将包名映射到源码，供本仓库类型检查使用。它不是一般 Node.js 在运行时解析任何包名的全局替换规则。运行源码、加载发布包和构建独立可执行文件使用的入口可以不同。

## 2.3 本项目为什么要求可擦除语法

可擦除语法指去掉类型标注后就能作为 JavaScript 执行的 TypeScript 语法。例如接口、类型别名、类型参数和普通类型标注。

项目 [tsconfig.base.json](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/tsconfig.base.json) 启用 `erasableSyntaxOnly`。仓库规则因此不允许依赖额外 JavaScript 生成的语法，例如 `enum` 和构造函数参数属性。

允许的形式是显式声明字段并赋值：

```ts
// 教学简化代码，与项目的类字段风格一致
class Queue {
  private mode: string;

  constructor(mode: string) {
    this.mode = mode;
  }
}
```

项目内部相对导入写 `.ts`，构建配置使用 `rewriteRelativeImportExtensions` 为产物重写扩展名。学习者不应把源码中的 `.ts` 机械改成 `.js` 来“修复”直接运行问题；要先理解源码与构建产物的执行路径。

## 2.4 泛型把输入与输出关系保留下来

```ts
function withQueue<T>(fn: () => Promise<T>): Promise<T>
```

`T` 是类型参数。函数不关心业务结果是什么，但保证传入函数的结果类型被保留：传入返回数字的函数，调用结果就是 `Promise<number>`；传入返回编辑结果的函数，调用结果就是那个编辑结果类型。

在实际 [file-mutation-queue.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/file-mutation-queue.ts) 中，队列负责顺序，不负责解释业务内容。泛型使这个基础设施可以同时服务于编辑和整文件写入。

## 2.5 联合类型让状态成为可检查的结构

联合类型用 `|` 表示多个可能。例如 `"sequential" | "parallel"` 表示只有两个合法字符串。

判别联合是在每种结构里放一个不同的标签：

```ts
// 教学简化代码
type Preparation =
  | { kind: "prepared"; args: unknown }
  | { kind: "immediate"; error: string };

if (result.kind === "prepared") {
  // 此分支才有 args
}
```

Pi 的 `prepareToolCall` 用这个结构区分“可以执行”和“已有立即结果”。未知工具、参数错误或阻止执行的钩子都可以进入 `immediate`，不必伪装成一个已经运行的工具。

事件也是判别联合。处理 `event.type === "tool_execution_end"` 后，可以访问该事件对应的工具结果；处理 `agent_start` 时则没有这些字段。

## 2.6 unknown 要求先检查外部输入

`unknown` 表示值可能属于任何类型，但程序还不知道是哪种类型。访问属性或调用方法前，需要检查。

```ts
// 来自项目常见模式的教学简化
if (typeof value === "object" && value !== null && "code" in value) {
  // 此时才知道可以进一步检查 code
}
```

`value is SingleEditInput` 这种返回类型称为类型谓词：函数返回真时，编译器认为值满足对应类型。实际检查仍由函数代码完成。

类型断言 `value as EditToolInput` 不做运行时验证。它只告诉编译器按该类型看待值。遇到断言，必须继续寻找校验代码，不能把断言当成可靠性保证。

## 2.7 TypeBox 把运行时模式与静态类型连接起来

Pi 的文件编辑参数定义为：

```ts
// 依据 edit.ts 简化，省略描述文字
const editSchema = Type.Object({
  path: Type.String(),
  edits: Type.Array(Type.Object({
    oldText: Type.String(),
    newText: Type.String(),
  })),
});

type EditToolInput = Static<typeof editSchema>;
```

`editSchema` 是运行时对象，可以转换为模型看到的工具参数说明，也可以用于数据验证。`Static` 从这个对象的类型推导 TypeScript 输入类型，减少“两份结构定义各改各的”问题。

但是模式并没有自动表达所有业务规则。这里 `edits` 是数组；必须至少有一个元素，是 `validateEditInput` 额外检查的规则。旧文本不能为空、必须唯一和不能重叠，则由编辑算法在知道文件内容之后检查。

因此参数验证分为三层：

1. 结构是否正确：字段及字段类型。
2. 调用是否合理：至少存在一项修改。
3. 与当前文件是否一致：匹配、唯一性和不重叠。

第三层只能在读取文件后完成，无法由静态类型代替。

## 2.8 接口注入为什么方便测试与远程执行

`EditOperations` 描述 `access`、`readFile`、`writeFile` 三项能力。默认实现调用本地文件系统；调用者也可以传入另一个符合接口的对象。

测试可让 `writeFile` 在 Promise 上等待，精确制造“写入尚未完成但取消已经到达”的场景。远程扩展可以把文件操作委托给其他系统。这叫依赖注入：把依赖作为参数传入，而不是在业务算法里写死全部外部行为。

接口相同不表示保证相同。远程对象的 Promise 必须真正等到远端操作结束，否则本地队列会提前认为写入已完成。路径规范化也可能需要远端环境自己的规则。

### 类、私有字段与对象身份

类把状态和操作组合在一个实例里。`new Agent(...)` 创建实例，constructor 初始化字段，`this.state` 访问当前实例状态，方法通过这个状态完成工作。两个 Agent 实例有各自的 activeRun；类名相同不表示共享一把锁。

TypeScript 的 `private` 主要约束类型层访问；JavaScript 的 `#field` 是另一种运行时私有字段。应根据具体语法判断边界。`===` 比较对象时检查是否同一个对象，而不是字段是否相同；文件队列、模型 generation 和异步 UI 的过期检查常依赖身份，而不是深度比较。

对象展开 `{ ...value }` 创建新外层对象，嵌套数组与对象仍可能共享。`structuredClone` 与项目自己的 JSON clone 可以提供更深复制，但对支持值和原型有不同规则；第十五、二十五章会结合存储实现解释，而不把任意对象复制混为一谈。

## 2.9 本章源码定位与练习

| 源码 | 观察点 |
| --- | --- |
| [tsconfig.base.json](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/tsconfig.base.json) | 严格检查、可擦除语法、导入扩展名 |
| [types.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/agent/src/types.ts) | 判别联合、泛型、状态和钩子协议 |
| [edit.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/edit.ts) | 模式、静态类型、参数修复和业务验证 |
| [file-mutation-queue.test.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/test/file-mutation-queue.test.ts) | 注入操作以控制执行时刻 |

练习：说明为什么 `path: Type.String()` 不足以证明文件存在。答案是模式只检查字符串结构，存在性和可读写性要在运行时访问文件系统。

练习：说明为什么 `edits` 中两项 `oldText` 都是字符串，仍可能导致编辑失败。答案包括找不到文本、出现多个匹配、两个区域重叠和产生相同结果。
