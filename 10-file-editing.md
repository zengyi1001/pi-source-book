# 第十章文件编辑算法

编辑文件看似只有一句字符串替换，真实问题却更多：模型可能返回错误形状的参数；同一文本可能重复；两项替换可能重叠；第二项的位置会因第一项变长而移动；文件还可能带有看不见的 BOM、Windows 换行和 Unicode 标点。本章逐步分析 Pi 如何处理这些问题。

## 10.1 edit 与 write 的不同任务

`edit` 接收一个文件路径和一组 `oldText/newText`，适合局部修改。它读取现有文件，检查目标片段，生成新内容，再写回。

`write` 接收路径和完整内容，适合新文件或整体重写。它创建父目录，直接写入内容。它没有旧内容字段，不会检测模型提供的完整文本是否基于过时版本。

| 项目 | edit | write |
| --- | --- | --- |
| 参数 | `path`、`edits[]` | `path`、`content` |
| 文件要求 | 默认检查可读且可写 | 创建或覆盖 |
| 冲突依据 | 旧文本在当前内容中的匹配情况 | 没有旧版本校验 |
| 写回方式 | 计算出完整新内容后写入 | 将传入的完整内容写入 |
| 返回信息 | 成功文本、diff、patch、首个修改行 | 成功文本 |
| 并发机制 | 按文件队列 | 同一套按文件队列 |

“精确编辑”描述的是定位方式，不表示磁盘上只写修改的字节。默认实现的 `writeFile` 写的是整个结果字符串。

## 10.2 从工具声明到执行函数

主入口是 [edit.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/edit.ts) 的 `createEditToolDefinition`，其对象同时包含模型描述、参数模式、执行函数和界面渲染器。

`createEditTool` 经由 [tool-definition-wrapper.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts) 把它转换为底层代理接受的 `AgentTool`。转换保留参数准备、模式和执行函数，但不把界面渲染方法塞入代理循环。

模型调用首先经过 `prepareArguments`，然后经过代理层的 `validateToolArguments`，再进入工具的 `execute`。这些层次分别解决“常见格式差错”“数据结构正确性”“文件内容正确性”。

具体输入可以是：

```json
{
  "path": "src/config.ts",
  "edits": [
    { "oldText": "const retries = 1;", "newText": "const retries = 3;" },
    { "oldText": "const timeout = 10;", "newText": "const timeout = 30;" }
  ]
}
```

这是一个文件的两处独立替换，不是两个文件的事务。

## 10.3 参数修复发生在模式验证之前

`prepareEditArguments` 处理几种实际输入：

- `edits` 是 JSON 字符串，解析后是数组时改为数组。
- `edits` 是单个 `{ oldText, newText }` 对象时包装为单元素数组。
- 顶层仍有字符串 `oldText/newText` 时，将这一对追加到 `edits`，再删除顶层旧字段。

这里不是无限制“猜用户想写什么”。JSON 解析失败时保留原值，让后续结构验证处理。参数准备并不能把任意坏输入变成合法调用。

经典 CLI 版本会在部分修复分支原地修改参数对象。Durable 版本先浅复制输入，再修复；这项差异见 [durable 的 edit.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/durable/src/tools/edit.ts) 的 `prepareEditArguments`。理解两套实现时不能只看它们的工具名称相同。

## 10.4 文件读取必须位于队列内部

执行顺序为：

```text
验证 edits 非空
解析相对路径
申请该文件的修改队列
检查取消
检查文件可读写
读取完整内容
拆分 BOM 与正文
识别换行
统一为 LF
定位并验证全部替换
生成完整新内容
恢复换行与 BOM
写回
生成结果与差异
释放队列
```

队列包围读取到写回的全过程。如果在排队之前读取，两个调用仍可能携带同一份旧内容进入队列，顺序写入也会丢失更新。

路径优先使用执行上下文的 `cwd`，否则使用工具创建时的 `cwd`。默认 `access` 检查 `R_OK | W_OK`，默认 `readFile` 得到 Buffer，再按 UTF-8 解码。检查通过与后续读写成功之间没有操作系统层面的原子绑定，外部程序仍可能改变文件。

## 10.5 BOM 与换行如何处理

BOM 是文件开头可能存在的编码标记。解码后的 UTF-8 BOM 表示为 `\uFEFF`。模型一般看不到它，要求 `oldText` 包含它会造成开头匹配失败。

[utils/text.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/utils/text.ts) 的 `splitBom` 将其从正文中分离，最后再放回文件开头。

`normalizeToLF` 把 CRLF 和单独的 CR 都变为 LF。目标旧文本和替换新文本也这样归一化，所以模型输出 LF 时可以匹配 CRLF 文件。

`detectLineEnding` 根据首先出现的换行样式选择 LF 或 CRLF，最后把所有 LF 恢复为这一样式。因此它保留的是选定的整体风格，不是混合换行文件中每一处换行的原始字节。只含单独 CR 的正文也不保留原来的 CR 风格。

这是一项明确取舍：降低模型处理不同平台换行的困难，同时没有实现逐行混合换行保真。

## 10.6 先精确匹配，再尝试有限归一化

[edit-diff.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/edit-diff.ts) 的 `fuzzyFindText` 先调用 `indexOf(oldText)`。找到时直接使用当前位置，不进行模糊归一化。

精确匹配失败后，对文件和旧文本应用 `normalizeForFuzzyMatch`：

1. Unicode NFKC 归一化。
2. 去除每行末尾的空白。
3. 将部分弯引号变成普通引号。
4. 将指定 Unicode 横线变成 `-`。
5. 将指定特殊空格变成普通空格。

例如模型写 `const title = "demo";`，文件可能包含弯引号。同样，行尾空格可能被模型省略。归一化能减少这些形式差异造成的失败。

这不是任意相似度搜索。算法不会根据“意思相似”选择函数，不会在拼错变量名时猜正确位置，也没有语法树分析。匹配仍然是归一化字符串空间中的子串搜索。

若任何一项需要模糊匹配，本次操作的全部替换统一在模糊归一化的基准文本上重新定位，避免不同替换使用互不兼容的偏移量。

## 10.7 唯一性检查究竟检查什么

每一项旧文本不能为空，并且必须找到。`countOccurrences` 在模糊归一化后的文本中检查匹配数量，因此即使某段原文精确匹配，另一段只存在标点差异，也可能被算为重复。

例如：

```text
const a = “x”;
const a = "x";
```

归一化后它们相同。较保守的重复检查要求模型提供更具体的上下文，减少误选位置。

但必须准确理解实现：计数公式是 `fuzzyContent.split(fuzzyOldText).length - 1`，统计的是非重叠子串。根据这一公式可以推导，`oldText = "aa"`、正文 `"aaa"` 时计数为 1，而不是所有重叠起点的数量 2。当前实现的唯一性语义不能被扩展描述为“枚举并拒绝每一种重叠子串出现位置”。

这一小例子也说明：接口文字描述必须结合实现和测试来读。

## 10.8 多处修改为什么共同匹配原文

假设文件是：

```text
name=pi
mode=old
```

两项替换分别为 `pi → pi-agent` 和 `old → new`。若先应用第一项再用旧偏移应用第二项，后面的目标位置已经移动。

Pi 的算法先收集每项在同一基准文本中的 `matchIndex` 和 `matchLength`，再按位置排序，最后从后向前替换。后面变长不会影响前面尚未处理的位置。

```text
原文位置：0 ... [前一项] ... [后一项] ...
第一步：替换后一项
第二步：替换前一项
```

本次调用不支持后一个修改依赖前一个修改的产物。例如第一项 `a → b`、第二项 `b → c`，第二项匹配的是原文里的 `b`，不是第一项产生的 `b`。需要这种递进效果时，应重新设计为一个替换，或在前一次调用完成后对新文件发起下一次调用。

## 10.9 重叠检查保证本次调用的一致性

排序后，相邻区间满足下式时拒绝：

```text
previous.start + previous.length > current.start
```

这可以识别嵌套替换和部分重叠。边界刚好相接不算重叠。

例如原文 `abcdef`，修改 `abc → X` 和 `bcde → Y` 无法独立应用；两个修改都声称拥有 `bc`。Pi 要求将它们合为一个修改，不自行选择优先级。

全部匹配、重复和重叠检查都在写回之前完成。因此，一次调用中第二项找不到旧文本时，第一项也不会提前写入文件。这是“单次计算全部通过后再写”的保证，不是磁盘写入失败时的事务回滚。

## 10.10 模糊匹配如何保护未修改的行

归一化可能缩短文本。例如去掉行尾三个空格，会使后续字符偏移发生变化。如果直接把归一化全文写回，文件里所有弯引号和行尾空格都会被改掉。

`applyReplacementsPreservingUnchangedLines` 因此维护两个视图：原始 LF 正文和模糊归一化正文。它依据真实替换区间计算覆盖的行，将修改触及的行从归一化视图生成，将未触及的行从原正文复制回来。

不能依靠普通行 diff 随意对齐重复行。两段原始行可能归一化后相同，若按相似行猜对齐，可能把更改套在错误出现位置。实际实现依据已经确认的区间来确定行范围。

保真粒度是“未触及的行块”。被触及的整行可能包含除目标片段外的其他标点或空白归一化变化；不能把这个机制写成“除精确目标字节外其余字节绝对不变”。它还要求两个视图的行数一致，否则拒绝处理。

## 10.11 diff 与 patch 服务不同读者

成功后产生两种差异：

- `diff`：面向终端展示，带行号、上下文和省略标记。
- `patch`：标准 unified patch，由 `Diff.createTwoFilesPatch` 生成。

`firstChangedLine` 是新文件中的首个变化行，便于界面导航。差异比较的是处理后的 LF 正文，不包含重新添加的 BOM 和恢复的 CRLF 字节。

`computeEditsDiff` 可以预览修改，但它自行读取文件，没有持有修改队列，也没有为真正执行保留版本。因此，预览说明“当时读取到的文件会产生什么差异”，并不承诺后来执行时文件完全相同。

## 10.12 错误也是模型继续工作的输入

找不到文本、重复、重叠、旧文本为空、没有变化、访问失败和取消都会使调用失败。代理层把失败转换为错误工具结果，模型下一轮可以重新读取文件、扩大唯一上下文或重新组织替换。

错误消息的措辞可能说“exact text”，而内部确实存在有限模糊归一化。学习源码时应以完整行为为准，而不是从一段错误文字推断所有分支。

## 10.13 源码定位与练习

| 文件与函数 | 基准版本行号 | 内容 |
| --- | --- | --- |
| [edit.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/edit.ts) `prepareEditArguments` | 103 | 参数修复 |
| 同文件 `createEditToolDefinition` | 143 | 声明、排队、读写 |
| [edit-diff.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/edit-diff.ts) `fuzzyFindText` | 207 | 两级匹配 |
| 同文件 `applyEditsToNormalizedContent` | 300 | 批量定位与检查 |
| 同文件 `applyReplacementsPreservingUnchangedLines` | 132 | 未触及行块保留 |
| [write.ts](https://github.com/earendil-works/pi/blob/11449730c8a733953ce1bcce70e066bccaa778a5/packages/coding-agent/src/core/tools/write.ts) | 44 | 整体写入 |

练习：文件包含两个完全相同的 `return true;`。怎样构造 `oldText`？答案是加入对应函数名或附近独特语句，使归一化后的旧文本只出现一次；不能要求工具默认选择第一个。

练习：三项修改的第二项找不到匹配，第一项是否已经写入？答案是没有，匹配检查在内存中完成后才调用写入。

练习：预览成功后用户手动改了同一行，执行是否必须使用预览内容？答案是否定的，真正执行重新读取当前文件并定位。

下一章继续回答更困难的问题：两个调用同时编辑时如何排队，以及取消、符号链接和外部程序如何影响这些保证。
