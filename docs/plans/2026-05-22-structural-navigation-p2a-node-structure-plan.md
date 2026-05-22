# CodeGraph 结构导航可用性增强 P2a：长函数结构摘要 TDD 实施计划

> 关联设计：[`docs/codegraph-structural-navigation-usability-design.md`](../codegraph-structural-navigation-usability-design.md)  
> 拆解路线图：[`2026-05-21-structural-navigation-roadmap.md`](./2026-05-21-structural-navigation-roadmap.md)  
> 前置计划：[`2026-05-21-structural-navigation-p1-edge-metadata-ranking-plan.md`](./2026-05-21-structural-navigation-p1-edge-metadata-ranking-plan.md)  
> 状态：implemented / validated / review-passed (2026-05-22)  
> 范围：为 `codegraph_node` 增加按需 AST-derived 结构摘要模式；首版支持 TS/JS/TSX/JSX 的函数/方法节点；不做 LLM summary、跨函数 dataflow 或运行时路径证明。  
> 当前验证：`npx vitest run __tests__/node-structure.test.ts`、`npx vitest run __tests__/addressability.test.ts __tests__/instructions.test.ts`、`npm run build`、`npm test`（29 files / 762 tests passed）。

---

## 目标

P2a 聚焦“单个长函数内部的阅读导航”。P0/P0b/P1 已让跨节点 trace、edge evidence、dynamic boundary 与 ranking reason 更可信；但 trace 到达一个长函数后，agent 仍常在两种不理想选择之间切换：只看签名信息太少，`includeCode: true` 又把整段源码塞进上下文。

P2a 的目标是在两者之间增加一个结构层：

```text
codegraph_node({ nodeId, detail: "structure" })
```

核心目标：

1. 对 TS/JS/TSX/JSX 的 function / method / arrow-function-backed method 节点，返回 AST-derived 结构骨架。
2. 结构骨架展示 exact ranges，帮助 agent 继续 `read path:start-end` 或重新 `codegraph_node(includeCode=true)`。
3. 覆盖首版高价值结构：early returns、major branches / guards、switch、loops、try/catch/finally、关键 callsites、callback-like invocation hints、object literal construction hints、return value construction。
4. 输出必须明确：这是静态 AST 导航，不是自然语言语义总结，也不是 runtime proof。
5. 默认 `codegraph_node` 与 `includeCode: true` 行为保持兼容；结构摘要必须按需开启。
6. 不新增 DB schema，不持久化结构摘要；按请求解析目标文件。

---

## 实施策略与执行 Gate

P2a 可以作为**一个分支 / 一个 PR 一次性交付**，但不得作为一个不可拆分的大改动实施。实施者应按 checkpoint 逐段推进：每个 checkpoint 先写/补红测试，再实现最小通过代码，跑对应 focused validation；未通过 gate 时不得继续扩大范围。

本节是执行层指引；后续“类型设计”“AST 分析规则”“TDD 任务拆解”提供每个阶段的详细规格与测试矩阵。

### 交付模式

- **允许一次性交付：** P2a 是 opt-in 能力，不改 DB schema，默认 `codegraph_node` 行为保持兼容，因此可以在一个 P2a 分支中完成并一次 PR 合并。
- **禁止一次性糊成一个大提交：** 至少按 checkpoint 拆成可 review 的提交或 commit stack；每个提交应能说明“新增哪类能力 / 哪些降级路径 / 哪些测试已通过”。
- **先降级、后能力：** unsupported / unavailable / stale / large-source / parser-unavailable 等降级路径必须先落地，避免后续 AST 能力失败时只剩异常或误导输出。
- **先 library API、后 MCP：** `CodeGraph.getNodeStructure()` 与 analyzer 必须先独立可测；MCP handler/formatter 不直接读文件或 parse AST。
- **formatter 不改变事实集：** analyzer 返回完整 `items`；section cap、omitted count 和 `truncateOutput()` 只在 formatter 层做。
- **docs 最后同步：** instructions / README / changelog 只在 MCP 行为与文案稳定后更新，避免先写出与实际输出不一致的 agent guidance。

### 关键路径与依赖

```text
Checkpoint 1 API/降级骨架
  → Checkpoint 2 AST 定位 + 基础 callsite/return
    → Checkpoint 3 control-flow + enclosing + nested boundary
      → Checkpoint 4 callback/object hints
        → Checkpoint 5 MCP schema/strict resolution/formatter
          → Checkpoint 6 instructions/docs/build
```

依赖规则：

- Checkpoint 2 不应依赖 MCP；只能依赖 analyzer + `CodeGraph.getNodeStructure()`。
- Checkpoint 3 必须建立在 nested boundary 保护上，不能先收集 nested body 再补过滤。
- Checkpoint 4 的 callback/object hints 不能创建新 graph edge，也不能修改 resolver / trace。
- Checkpoint 5 必须使用 strict locator resolution；`detail: "structure"` 不允许复用 symbol pick-first 兼容路径。
- Checkpoint 6 不得引入新的行为承诺；只记录已经由测试覆盖的能力与 caveat。

### Checkpoint 1：API 与降级骨架

范围：

- `NodeStructure*` exported types。
- `src/structure/node-structure.ts` analyzer skeleton。
- `CodeGraph.getNodeStructure(nodeId, options?)`。
- 降级状态：`not_found`、`unsupported-language`、`unsupported-node-kind`、`source-unavailable`、`source-too-large`、`source-stale`、`parser-unavailable`、`parse-error` / `no-body` 基础分支。
- source-size guard 优先于 stale 检测；unsafe path 不输出危险 `read ../...` recommendation。

退出标准：

- 所有降级分支都返回 `NodeStructureResult`，不抛异常。
- `source-stale` 只有在存在 indexed `FileRecord.contentHash` 且 hash mismatch 时返回。
- `source-too-large` 在读取完整内容 / hash / parse 前返回。
- parserHost seam 可稳定测试 `parser-unavailable`。

验证：

```bash
npx vitest run __tests__/node-structure.test.ts -t "not_found|unsupported|source-unavailable|source-too-large|source-stale|parser-unavailable"
```

不得进入下一 checkpoint，除非降级路径均可操作且 recommendations 安全。

### Checkpoint 2：TS/JS AST 定位与基础 items

范围：

- query-time `loadGrammarsForLanguages([node.language])` + `getParser()`。
- full-file parse + `Tree` 在 `finally` 中释放。
- function-like candidate 定位与 body/implicit return 识别。
- syntax shape matrix：function declaration、block/expression arrow、function expression、class method、TS/JS class field arrow、HOF wrapper field、TSX expression-bodied component。
- 基础 `callsite` 与 `return-value` items。

退出标准：

- 每种 syntax shape 都能匹配 indexed node 对应的 AST body 或 implicit return。
- 每个 fixture 至少返回一个真实结构信号，range 落在 indexed node range 内。
- expression-bodied arrow 输出 `implicit return`，且仍能收集内部 callsite / JSX return-value。

验证：

```bash
npx vitest run __tests__/node-structure.test.ts -t "syntax shape|callsite|return-value|implicit return"
```

若某个 syntax shape 难以可靠定位，首版应返回 `no-body` + sync/read 建议并记录 caveat；不得用低置信 heuristic 输出误导性结构。

### Checkpoint 3：控制流、enclosing context 与 nested boundary

范围：

- `guard` / `branch` / `switch` / `loop` / `try` / `catch` / `finally`。
- `early-return` 检测。
- `depth` 与 `enclosing` stack。
- ordinary nested function declaration / local arrow / function expression / method / class boundary 保护。

退出标准：

- control-flow items 使用 1-indexed line ranges，path 为 project-relative。
- callsite/object/return items 在 branch/loop/try/catch/finally/switch 内时携带 `enclosing`。
- nested function body 内的 `return` 和 callsite 不被标成 outer function 的 main structure。
- early-exit 检测不跨 nested boundary。

验证：

```bash
npx vitest run __tests__/node-structure.test.ts -t "control flow|guard|branch|switch|loop|try|catch|finally|nested"
```

若 nested boundary 与 inline callback 收集发生冲突，优先保证 ordinary nested function 不污染 outer structure；inline callback 能力可留到 Checkpoint 4。

### Checkpoint 4：callback-like 与 object/return construction hints

范围：

- direct/property/optional call callee metadata：`calleeText`、`receiverText`、`propertyText`。
- callback-like invocation heuristic + mandatory caveat。
- object literal keys：variable declarator、assignment、call argument、return argument、expression-bodied arrow。
- inline callback 一级收集；`includeNestedCallbacks: false` 关闭收集。

退出标准：

- callback-like item 必须包含 `binding not inferred` note，不能声称 target/binding/runtime path。
- inline callback body 内 items 必须带 `inside nested function/callback; not outer sequential flow` note。
- early return object 不重复输出为两个 construction items，但仍保留 `objectKeys`。
- 输出文本中不得出现 `runtime main path`、`definitely` 等证明性措辞。

验证：

```bash
npx vitest run __tests__/node-structure.test.ts -t "callback|object literal|objectKeys|includeNestedCallbacks|binding not inferred"
```

若 callback heuristic 噪声过高，首版应收紧命名规则或降低输出数量；不得通过扩大推断来“补全”绑定关系。

### Checkpoint 5：MCP `codegraph_node detail=structure` 与 formatter

范围：

- `codegraph_node` input schema 增加 `detail: { type: 'string', enum: ['structure'] }`。
- invalid `detail` 类型/值返回 MCP error。
- `detail: "structure"` 使用 `cg.resolveNodeLocator(locator)` strict resolution。
- ambiguity / not_found 复用既有 exact-handle 输出，不任选一个 node。
- `formatNodeStructure()`：sections、ranges、within context、includeCode ignored note、section cap、omitted count。
- 默认 `codegraph_node` 与 `includeCode: true` 旧行为保持不变。

退出标准：

- `detail: "structure"` 不输出完整源码 fenced block。
- 同时传 `includeCode: true` 时结构模式优先并提示 ignored。
- formatter 从完整 `items` 计算 omitted count；analyzer 不因 cap 裁剪。
- symbol-only ambiguity 保持 ambiguity alternatives 与 exact handles。

验证：

```bash
npx vitest run __tests__/node-structure.test.ts __tests__/addressability.test.ts
```

若 formatter 输出过长，先调整 section cap / label cap / grouping；不得让 analyzer 少收集事实来解决展示问题。

### Checkpoint 6：agent-facing instructions、README 与 build

范围：

- `src/mcp/server-instructions.ts`。
- `src/installer/instructions-template.ts`。
- `README.md`。
- `.cursor/rules/codegraph.mdc`（若仓库中存在/恢复）。
- `CHANGELOG.md`（若该分支准备发布用户可见能力）。

退出标准：

- instructions 明确：长函数先用 `detail: "structure"`，需要源码时再 `includeCode` / targeted `read`。
- instructions 明确：structure 是 static AST navigation，不是 runtime proof / LLM summary。
- README 的 tool 描述与 MCP schema/实际输出一致。
- build 通过。

验证：

```bash
npx vitest run __tests__/instructions.test.ts
npm run build
```

最终合并前建议再跑：

```bash
npx vitest run __tests__/node-structure.test.ts __tests__/addressability.test.ts __tests__/instructions.test.ts
npm test
```

### 停止条件与降级决策

实施过程中遇到下列情况应停止当前 checkpoint 扩展，优先降级或缩小范围：

- **AST shape 无法高置信匹配：** 返回 `no-body` / `parse-error` + `codegraph sync --quiet` / targeted `read`，不要输出低置信结构。
- **source 与 index 不一致：** 返回 `source-stale`、`items: []`，不要继续 parse 当前源码。
- **文件超过 guard：** 返回 `source-too-large`，不要读取完整内容、hash 或 parse。
- **callback/object hint 被误读为 dataflow：** 收紧 label/note，保留 caveat；不要新增跨函数推断。
- **输出超过上下文预算：** 调整 formatter cap 与 omitted count；不要让 analyzer 提前裁剪。
- **默认 `codegraph_node` 行为受影响：** 立即回退 MCP handler 改动，先恢复兼容测试。

### 建议提交粒度

推荐 commit stack：

1. `test(node-structure): add fixtures and degradation skeleton cases`
2. `feat(node-structure): add types and CodeGraph API skeleton`
3. `feat(node-structure): match TS/JS function bodies and basic items`
4. `feat(node-structure): summarize control flow with enclosing context`
5. `feat(node-structure): add callback and object construction hints`
6. `feat(mcp): expose codegraph_node detail structure formatter`
7. `docs: document node structure detail guidance`

如果实现中需要重排，仍应保持每个提交可 review、可单独解释，并在 PR 描述中列出各 checkpoint 的验证结果。

---

## 产品决策

### 工具形态

采用 roadmap 中建议的 `detail: "structure"`，而不是新增 MCP 工具。

原因：

- 用户已经通过 `codegraph_node` 精确定位到单个节点；结构摘要是 node detail 的一个展开层。
- 不把 trace 输出膨胀；如后续需要让 trace 提示长函数检查，也只应在 next checks 中建议 `codegraph_node({ nodeId, detail: "structure" })`。
- 保持“默认轻量、按需展开”的工具模型。

MCP input schema 增加：

```ts
detail?: 'structure';
```

兼容规则：

- 未传 `detail`：保持当前默认输出，仍只返回签名、docstring、location、handle。
- `includeCode: true`：保持当前行为；leaf function/method 返回源码，container 返回成员 outline。
- `detail: "structure"`：返回结构摘要，不返回完整源码。
- 如果同时传 `detail: "structure"` 与 `includeCode: true`，结构模式优先，并输出一行 note：`includeCode ignored because detail=structure`。避免一次调用同时输出结构与完整源码导致上下文膨胀。
- 非法 `detail` 值返回 MCP error，不 silently fallback。
- 默认 `codegraph_node({ symbol })` 可继续保持当前兼容行为；但 `detail: "structure"` 必须使用 strict locator resolution：调用 `cg.resolveNodeLocator(locator)`，`ambiguous` 直接格式化 ambiguity/alternatives，只有 exact resolved node 才调用 `getNodeStructure()`，不得沿用 symbol-only `findSymbol()` 的 pick-first 兼容路径。

### 支持范围

首版支持：

- 语言：`typescript`、`javascript`、`tsx`、`jsx`。
- 节点：`function`、`method`。
- 语法形态：
  - `function_declaration`；
  - `method_definition`；
  - `arrow_function` / `function_expression`，包含 block body 与 expression-bodied arrow；
  - expression-bodied arrow 视为 implicit return，例如 `const fn = (x) => normalize(x)` / `const Component = () => <View />`；
  - TS class field 中的 arrow function，例如 `handler = () => { ... }`（`public_field_definition`）；
  - JS/JSX class field 中的 arrow function，例如 `handler = () => { ... }`（`field_definition`）；
  - 常见 HOF wrapper 中的 class field arrow function，例如 `handler = withBatching((e) => { ... })`，共享 helper 必须同时覆盖 TS `public_field_definition` 与 JS/JSX `field_definition`。

降级规则：

- 非 TS/JS/TSX/JSX：返回 unsupported-language note 和 exact `read` / `includeCode` 建议。
- 非 function/method 节点：返回 unsupported-node-kind note；container 节点继续建议 `includeCode=true` 获取成员 outline。
- 找不到可解析源码、parser 不可用、目标 syntax node 无 body、源码过大或可能与索引不一致：返回对应降级 note，不抛异常，并建议 `codegraph sync --quiet` / targeted `read`。
- `source-stale` 必须有可实现的数据入口：`CodeGraph.getNodeStructure()` 从 indexed file table 获取 `FileRecord`（例如 `getFile(node.filePath)`）并传给 analyzer；analyzer 用当前源码 hash 与 `FileRecord.contentHash` 比较。

---

## 非目标

P2a 明确不做：

- LLM summary 或不可审计自然语言解释；
- 完整控制流图、path feasibility、条件求值；
- 完整字段级 dataflow / alias analysis；
- 跨函数参数、callback、对象字段绑定闭合；
- provider registry / resolver candidates；
- P2b 的项目级 `codegraph_field_sites`；
- schema migration 或结构摘要持久化；
- 对所有语言的结构摘要覆盖；
- 判断“主路径”“运行时一定发生”“业务语义正确”。

P2a 可以说：

```text
Line 42 has an if branch whose consequent returns.
Line 77 calls opts.onProgress?.(...), a callback-like invocation hint based on syntax/name.
```

P2a 不可以说：

```text
This is the runtime main path.
The callback definitely points to Foo.bar.
The returned object definitely becomes the provider payload.
```

---

## Recon 结果：实施前代码切片

### 已有基础

- `src/types.ts`
  - 已有 `NodeHandle`、`Language`、`NodeKind`、`ReferenceSourceEvidence` 等可复用类型。
  - 尚无 node-structure 相关 result / item 类型。
- `src/index.ts`
  - `CodeGraph::getCode(nodeId)` 已可按 node range 读取源码。
  - `CodeGraph::resolveNodeLocator()` 已支持 exact locator，MCP `codegraph_node` 可复用。
  - 尚无 `getNodeStructure()` API。
- `src/mcp/tools.ts`
  - `handleNode()` 当前只处理 `includeCode`。
  - `formatNodeDetails()` 可输出 node metadata、源码或 container outline。
  - `buildContainerOutline()` 已提供 container 的成员级 outline，但不是函数内部结构摘要。
  - tool schema 中 `codegraph_node` 尚无 `detail` 参数。
- `src/extraction/grammars.ts`
  - `getParser(language)` 可同步获取已加载 parser。
  - `loadGrammarsForLanguages()` 可按需加载 TS/JS grammar。
- `src/extraction/languages/typescript.ts`
  - 已定义 TS function/method/body 相关语法类型。
  - `resolveBody()` 已处理 `public_field_definition` 中的 arrow function / HOF wrapper，可作为 P2a AST 定位参考。
- `src/extraction/languages/javascript.ts`
  - JS/JSX methodTypes 包含 `field_definition`。
  - `resolveBody()` 已处理 `field_definition` 中的 arrow function / HOF wrapper；P2a helper 必须同时覆盖 TS 与 JS 两套 class-field node type。
- `src/extraction/tree-sitter-helpers.ts`
  - `getNodeText()`、`getChildByField()` 可复用。
- `src/utils.ts`
  - `validatePathWithinRoot()` 可用于安全读取目标文件。
- `__tests__/addressability.test.ts`
  - 已覆盖 MCP `codegraph_node` exact locator 与默认输出。
- `__tests__/trace.test.ts`
  - 已有临时项目 + CodeGraph indexing fixture 模式，可复用到新测试。
- `__tests__/instructions.test.ts`
  - agent-facing instructions 有同步测试；P2a 改变 MCP 使用方式时应补充断言。

### 关键缺口

- 目前 `codegraph_node` 没有“结构但非源码”模式。
- 现有 indexed edges/callees 不包含 callsite 所在 branch/try/loop 上下文。
- 需要一个按需 AST analyzer，它独立于 extraction/index pipeline，不改变 DB。
- 需要 MCP formatter 将结构项压缩成可读、可复制、带 caveat 的 markdown。

---

## 建议类型设计

在 `src/types.ts` 增加 additive exported types。

```ts
export type NodeStructureStatus =
  | 'available'
  | 'not_found'
  | 'unsupported-language'
  | 'unsupported-node-kind'
  | 'parser-unavailable'
  | 'source-unavailable'
  | 'source-too-large'
  | 'source-stale'
  | 'no-body'
  | 'parse-error';

export type NodeStructureItemKind =
  | 'early-return'
  | 'branch'
  | 'guard'
  | 'switch'
  | 'loop'
  | 'try'
  | 'catch'
  | 'finally'
  | 'callsite'
  | 'callback-invocation'
  | 'object-literal'
  | 'return-value';

export interface SourceRange {
  path: string;
  startLine: number;
  endLine: number;
  /** 0-indexed, matching existing Node.startColumn convention. */
  startColumn?: number;
  /** 0-indexed, matching existing Node.endColumn convention. */
  endColumn?: number;
}

export type NodeStructureEnclosingKind =
  | 'guard'
  | 'branch'
  | 'loop'
  | 'try'
  | 'catch'
  | 'finally'
  | 'switch';

export interface NodeStructureEnclosingContext {
  kind: NodeStructureEnclosingKind;
  range: SourceRange;
  /** Syntax-derived label for the enclosing control-flow item, capped. */
  label: string;
}

export interface NodeStructureItem {
  kind: NodeStructureItemKind;
  range: SourceRange;
  /** Nesting depth inside the target function body; formatter may indent from this. */
  depth: number;
  /** Short syntax-derived label, e.g. `if (!user)`, `for (... of ...)`, `return send(payload)`. */
  label: string;
  /** Optional raw condition/discriminant text, capped. */
  conditionText?: string;
  /** Optional callee/constructor text, capped. */
  calleeText?: string;
  /** Optional receiver for property calls, capped. */
  receiverText?: string;
  /** Optional property/member name for property calls. */
  propertyText?: string;
  /** Object literal keys when cheap and local to the literal. */
  objectKeys?: string[];
  /** Nearest enclosing control-flow stack, outermost → innermost. */
  enclosing?: NodeStructureEnclosingContext[];
  /** Conservative syntax-only caveat for heuristic items. */
  note?: string;
}

export interface NodeStructureOptions {
  /** Cap for syntax-derived labels / conditions / callee text. */
  maxLabelChars?: number;
  /** Maximum static object keys to list per object literal. */
  maxObjectKeys?: number;
  /** Include first-level inline callback bodies; default true; ordinary nested functions remain excluded. */
  includeNestedCallbacks?: boolean;
  /** Query-time full-file parse guard; default should be conservative, e.g. 1 MiB. */
  maxSourceBytes?: number;
}

export interface NodeStructureFormatOptions {
  /** Per output section cap. Formatter computes omitted counts from the full item list. */
  maxItemsPerSection?: number;
}

export interface NodeStructureResult {
  status: NodeStructureStatus;
  node?: NodeHandle;
  language?: Language;
  items: NodeStructureItem[];
  caveats: string[];
  recommendations: string[];
}
```

设计约束：

- `NodeStructureItem` 必须只记录 AST 中直接观察到的事实。
- 文本字段必须 sanitize + cap，避免输出整段表达式。
- `items` 默认按 source order 排序；formatter 可再分组展示。
- `range.path` 必须是 project-relative path，line 使用 1-indexed；column 字段沿用现有 `Node.startColumn` / `Node.endColumn` 约定，使用 0-indexed。
- `callsite`、`callback-invocation`、`object-literal`、`return-value` item 应尽量携带最近 enclosing control-flow stack，帮助 agent 判断该语法点位于 guard/branch/loop/try/catch/finally/switch 下。
- `source-stale` 只有在能可靠检测到当前源码与 indexed file record 不一致时使用；hash mismatch 时首版固定返回 `status: 'source-stale'`、`items: []`，不继续做结构分析，并在 recommendations 中建议 `codegraph sync --quiet` 与 targeted `read`。如果只能从 no candidate/no body 推测，则保持 `no-body`/`parse-error` 并在 caveat/recommendations 中建议 sync。

---

## 输出形态约定

目标 MCP markdown 示例：

```text
## processRequest (function) — structure

Location: src/long.ts:10
Range: src/long.ts:10-86
Handle: nodeId=... qualifiedName=... range=src/long.ts:10-86

> Static AST structure only. This is reading-navigation guidance, not runtime proof or an LLM summary.

### Control flow
- guard src/long.ts:12-15 — if (!input.user) exits via return
- branch src/long.ts:17-19 — if (opts?.dryRun)
- try src/long.ts:22-38
  - loop src/long.ts:23-29 — for (const item of input.items)
  - catch src/long.ts:30-34
  - finally src/long.ts:35-37

### Key callsites
- callsite src/long.ts:13 — audit(...)
- callsite src/long.ts:18 — buildPreview(...)
- callsite src/long.ts:26 — worker.run(...)
  within: try src/long.ts:22-38 > loop src/long.ts:23-29
- callback-invocation src/long.ts:27 — opts?.onProgress?.(...)
  within: try src/long.ts:22-38 > loop src/long.ts:23-29
  note: callback-like syntax/name hint only; binding not inferred

### Construction / returns
- early-return src/long.ts:14 — return { ok, reason }
- object-literal src/long.ts:41-45 — const payload = { id, messages, tools }
- return-value src/long.ts:47 — return send(payload)

### Recommended next
- read src/long.ts:12-19
- read src/long.ts:22-38
- codegraph_node({ nodeId: "...", includeCode: true })
```

Formatter rules：

- 始终显示 caveat。
- 每个结构项都带 `path:start-end` 或 `path:line`。
- 对携带 `enclosing` 的 callsite/object/return item，formatter 应输出紧凑 context，例如 `within: try src/a.ts:10-30 > loop src/a.ts:12-20`。
- Analyzer 返回完整 `items`，不得因 section cap 提前裁剪；formatter 负责分组、cap，并从完整 item list 计算 omitted count。
- 若结构项过多，formatter 按类别 cap：
  - control flow: 40；
  - key callsites: 40；
  - construction / returns: 40；
  - 总输出仍走现有 `truncateOutput()`。
- 超过 cap 时输出 `... N more items omitted; use includeCode/read for full source`，其中 `N` 由 formatter 从完整 `items` 计算。
- 不输出完整源码代码块。

---

## AST 分析规则

### 1. 源码与 parser

- `CodeGraph.getNodeStructure(nodeId)` 读取 node：不存在则 `not_found`。
- 用 `validatePathWithinRoot(projectRoot, node.filePath)` 安全读取源码。
- 如果 `validatePathWithinRoot()` 返回 `null`，首版返回 `source-unavailable`，caveat 说明 path is invalid/outside project root；recommendations 不得包含 `read ${node.filePath}:...` 这类危险可复制路径，也不得尝试读取 root 外文件。
- 状态优先级：首版 **source-size guard 优先于 stale 检测**。读取完整内容/hash 前先检查当前文件大小；超过 `options.maxSourceBytes`（默认建议 1 MiB，可按项目调优）返回 `source-too-large`，首选建议 `read path:start-end`，不读取完整文件、不 hash、不判断 stale。`includeCode=true` 只作为次选建议：当 node range 很小或用户明确需要完整 node 源码时再使用。
- 文件大小未超限时，`CodeGraph.getNodeStructure()` 必须把 `getFile(node.filePath)` 取得的 `FileRecord | null` 传给 analyzer；analyzer 用当前文件内容的 `hashContent()` 与 `fileRecord.contentHash` 比较。实现应复用现有 hashing implementation（例如 `src/extraction/index.ts` 的 `hashContent()`，或将其抽到 shared util 后复用），不得在 analyzer 中复制一份可能 drift 的 SHA256 逻辑。hash mismatch 时固定返回 `status: 'source-stale'`、`items: []`，不继续 parse / analyze；recommendations 必须包含 `codegraph sync --quiet` + `read path:start-end`。若 `fileRecord` 缺失，则不能声称 stale，只能在 no-body/no-candidate 降级中建议 sync/read。
- 对 TS/JS/TSX/JSX，analyzer 必须通过 parserHost 无条件先 `await loadGrammarsForLanguages([node.language])`，再 `getParser(node.language)`；不要依赖 indexing 阶段已经在同进程加载 grammar。
- parser 不可用返回 `parser-unavailable`，不抛异常。
- parse exception 返回 `parse-error`，并附带保守 recommendation。
- query-time parse 必须释放 tree-sitter WASM resources，避免长驻 MCP server 内存膨胀。实现必须使用 `finally` 删除 `Tree`：

```ts
let tree: Tree | null = null;
try {
  tree = parser.parse(source);
  // analyze tree.rootNode
} finally {
  tree?.delete();
}
```

- tree-sitter root 含 `ERROR` node 时通常不会 throw：若目标 body 仍能高置信匹配，可返回 `available` 但添加 parse-error caveat；若无法可靠定位 body，则返回 `parse-error` 或 `no-body` 并建议 sync/read。

### 2. 目标 syntax node 定位

首版建议新增 `src/structure/node-structure.ts`：

```ts
export interface NodeStructureParserHost {
  loadGrammarsForLanguages(languages: Language[]): Promise<void>;
  getParser(language: Language): Parser | null;
}

export class NodeStructureAnalyzer {
  constructor(projectRoot: string, parserHost?: NodeStructureParserHost);
  async analyze(
    node: Node,
    fileRecord: FileRecord | null,
    options?: NodeStructureOptions
  ): Promise<NodeStructureResult>;
}
```

`parserHost` 是 internal/test seam；默认实现使用真实 `loadGrammarsForLanguages()` / `getParser()`。它不需要暴露为 public `CodeGraph.getNodeStructure()` option。

定位策略：

1. 解析完整文件，而不是只解析 node 源码片段，避免 method / class field snippet 无法独立 parse。
2. 遍历 function-like syntax nodes，筛选与 indexed node range 高重叠的候选。
3. 优先选择：
   - start line 与 `node.startLine` 最接近；
   - candidate range 被 indexed node range 包含或高度重叠；
   - candidate name 与 indexed node name 匹配；
   - 有 body 的 candidate。
4. 对 class field wrapper，尝试下钻到 arrow/function expression body；helper 必须覆盖 TS `public_field_definition` 与 JS/JSX `field_definition`，并可抽取/复用 extractor `resolveBody()` 逻辑，避免逻辑漂移。
5. 找不到 candidate 或 body 时返回 `no-body`；recommendations 必须包含 `codegraph sync --quiet` 与 `read path:start-end`，因为常见原因是 index/source stale 或 parser 形态未覆盖。

首版必须建立 syntax shape matrix，并为每种形态断言 indexed node、matched AST candidate/body、以及 returned item range。Matrix fixture 不得使用空函数；每个 body 至少包含一个真实结构信号（例如 `return normalize(input);` 或 `this.run(event);`），不得为通过测试生成“假 item”。

| Source shape | Expected indexed node | Expected AST candidate / body |
|---|---|---|
| `export function fn(input) { return normalize(input); }` | `function` | `function_declaration` → `body` |
| `export const fn = (input) => { return normalize(input); }` | `function` | block-bodied `arrow_function` under `variable_declarator` |
| `export const fn = (input) => normalize(input);` | `function` | expression-bodied `arrow_function` → implicit return expression |
| `const fn = function (input) { return normalize(input); }` | `function` | `function_expression` under `variable_declarator` |
| `class C { method(input) { return normalize(input); } }` | `method` | `method_definition` → `body` |
| TS `handler = (event) => { return this.run(event); }` | `method` | `public_field_definition` → arrow/function body |
| JS `handler = (event) => { return this.run(event); }` | `method` | `field_definition` → arrow/function body |
| `handler = throttle((e) => { return this.run(e); })` | `method` | class field → wrapper call argument arrow/function body |
| `export const Component = () => <View />` | `function` | expression-bodied TSX arrow → implicit JSX return |

### 3. Control-flow items

识别并输出：

- `if_statement`
  - 若 consequent 的直接或浅层语句包含 `return_statement` / `throw_statement` / `break_statement` / `continue_statement`，分类为 `guard`；否则 `branch`。
  - `conditionText` 来自 condition AST，cap 120 chars。
  - label 只能描述语法：`if (<condition>)`，可加 `exits via return/throw`。
- `switch_statement`
  - 分类为 `switch`，label 包含 discriminant text；case 明细首版可不逐项展开。
- loop nodes
  - `for_statement`、`for_in_statement`、`for_of_statement`、`while_statement`、`do_statement` 分类为 `loop`。
- `try_statement`
  - 输出 `try`，并对子节点输出 `catch`、`finally`。
- `return_statement`
  - 若不是函数体最后一个 top-level return，或位于 branch/loop/catch 中，分类为 `early-return`。
  - early-exit 检测不得跨越普通 nested function / method / class boundary；嵌套函数里的 `return` 不能标成外层函数的 early return。
  - 所有 return 都可额外作为 `return-value` 展示，但避免重复：early return 可在 Construction / returns 组只出现一次，kind 保持 `early-return`。如果 early return 表达式是 object literal，该 `early-return` item 仍应携带 `objectKeys`，避免为去重丢掉 construction hint。
- expression-bodied arrow
  - 若 `arrow_function` body 不是 statement block，则把 body expression 视为 implicit return。
  - 输出 `return-value`，label 形如 `implicit return <expr>`。
  - 继续在该 expression 内收集 callsite / object literal hints；TSX/JSX expression body 可作为 `return-value` 输出，不新增 JSX 专属 item kind。

### 4. Callsites

识别 `call_expression` 与 `new_expression`。

分类建议：

- 普通 call：`callsite`。
- `new Foo(...)` 可作为 `callsite`，label `new Foo(...)`；P2a 不新增 `constructor-call` item kind，避免与 P1 edge evidence 混淆。
- callback-like invocation hint：满足以下任一保守条件时，kind 为 `callback-invocation`：
  - callee 是函数参数名；
  - callee 是 property call，property name 匹配 `callback|handler|listener|on[A-Z].*|.*Fn$|.*Callback$|.*Handler$`；
  - callee 使用 optional call/property chain 且 property name 符合上述 callback-like 命名。

必须附带 note：

```text
callback-like syntax/name hint only; binding not inferred
```

P2a 不根据 callback hint 创建 trace edge，也不推断绑定目标。

### 5. Object literal / return construction

识别：

- variable declarator / assignment value 是 object literal：`object-literal`，label `const payload = { ... }` 或 `assignment to payload = { ... }`。
- return argument 是 object literal：`return-value`，带 `objectKeys`。
- return argument 是 call expression / identifier / member expression：`return-value`，label `return <expr>`。
- expression-bodied arrow body：`return-value`，label `implicit return <expr>`；若表达式是 object literal 则带 `objectKeys`，若表达式是 JSX/TSX 则 label 保持 syntax-derived，例如 `implicit return <View />`。
- call argument 是 object literal：可作为 `object-literal`，label `<callee>({ keys }) argument`。

边界：

- 只列本函数内部直接出现的 object literal，不追踪对象后续跨函数流向。
- `objectKeys` 只取静态 key / shorthand key，computed key 显示为 `[computed]`，cap 12 keys。

### 6. Nesting depth、enclosing context 与 nested boundary

- `depth` 以目标 function body 为 0。
- 每进入 branch/loop/try/catch/finally，depth + 1，并把对应 control-flow item 压入 enclosing stack。
- 对 `callsite`、`callback-invocation`、`object-literal`、`return-value`，复制当前 enclosing stack 到 `item.enclosing`（outermost → innermost），至少包含最近的 guard/branch/loop/try/catch/finally/switch。
- 默认不跨普通 nested function declaration / function expression / arrow function / method / class boundary；这些内部的 return/call 不属于外层函数主结构。
- 仅当 `includeNestedCallbacks !== false` 且 nested function 是 inline callback argument 时，允许收集一级 callback body 内的少量 callsites / object literals；这些 item 必须带 note：`inside nested function/callback; not outer sequential flow`。
- ordinary nested function 的 body 不收集；可以输出一个轻量 caveat，提示存在 nested function boundary，但不得把其内部 return 标成外层 early-return。
- 若嵌套 callback 输出噪声太高，只收集一级且按 section cap；超出则 caveat。

---

## TDD 任务拆解

### 任务 0：测试 fixture 与 harness

**目标：** 新增专门测试文件，避免把 P2a 混入 trace/addressability 测试。

**测试先行：** 新增 `__tests__/node-structure.test.ts`：

- 使用临时目录写入 `src/long.ts` / `src/component.tsx` / `src/plain.js` 等 fixture。
- 大多数 fixture 可在 `beforeAll` 调用 `initGrammars()` + `loadAllGrammars()` 以降低测试噪声。
- lazy-loading 不强依赖同进程“grammar 未加载”状态来证明，因为 `indexAll()` 往往已经加载 parser，容易 false green。实现要求写死：`getNodeStructure()`/analyzer 每次都先 `await loadGrammarsForLanguages([node.language])`。
- `parser-unavailable` 使用 `NodeStructureAnalyzer` 的 internal `parserHost` seam 做稳定测试：注入 `loadGrammarsForLanguages: async () => {}` 与 `getParser: () => null`，断言返回 `parser-unavailable`。
- `describe.skipIf(!HAS_SQLITE)` 复用现有 better-sqlite 检测模式。
- 每个测试 `CodeGraph.initSync(root, { config: { include: ['src/**/*.{ts,tsx,js,jsx,py}'], exclude: [] } })` 后 `await cg.indexAll()`。
- `afterEach` destroy + cleanup。

**实现：** 无生产代码；只建立 red tests 的基础。

---

### 任务 1：类型与库 API 骨架

**目标：** 暴露稳定的 library-level API，MCP formatter 不直接读文件/parse AST。

**测试先行：** 在 `__tests__/node-structure.test.ts` 中添加：

- `cg.getNodeStructure(functionNode.id)` 返回 `status === 'available'`。
- result 包含 `node.nodeId`、`node.qualifiedName`、`language`、`items`、`caveats`、`recommendations`。
- 不存在 nodeId 返回 `status === 'not_found'` 且不抛异常。

**实现：**

- `src/types.ts` 增加上述 NodeStructure types。
- 新增 `src/structure/node-structure.ts`。
- `NodeStructureAnalyzer` 构造函数接收 `projectRoot` 与可选 internal `parserHost`，由 analyzer 负责安全读文件、source-size guard、content-hash 比较与 parser-unavailable 降级。
- `src/index.ts`：
  - import analyzer；
  - constructor 初始化 `new NodeStructureAnalyzer(projectRoot)`，或在方法内用 `projectRoot` 懒创建；
  - 新增 `async getNodeStructure(nodeId: string, options?: NodeStructureOptions): Promise<NodeStructureResult>`；
  - 在该方法中读取 `const fileRecord = this.getFile(node.filePath)`，再调用 `analyzer.analyze(node, fileRecord, options)`，确保 `source-stale` 有 indexed `contentHash` 数据入口。
- `src/index.ts` re-export types 已通过 `export * from './types'` 自动覆盖。

---

### 任务 2：TS/JS 目标节点定位与基础 caveat

**目标：** 能从 indexed node 找回对应 AST body，并返回基础结构结果。

**测试先行：** fixture：

```ts
export function simple(input: string): string {
  const value = normalize(input);
  return value;
}
```

断言：

- `status === 'available'`。
- caveats 包含 `Static AST structure only` 或等价文案。
- recommendations 包含：
  - `read src/long.ts:<start>-<end>`；
  - `codegraph_node({ nodeId: "...", includeCode: true })`。
- items 至少包含一个 `callsite` for `normalize(...)` 和一个 `return-value`。

增加 syntax shape matrix red tests；每个 case 都使用非空 body，并断言：indexed node kind、matched body/implicit return 存在、至少一个真实 structure item range 落在 indexed range 内：

- `export function fn(input) { return normalize(input); }`；
- block-bodied arrow：`export const fn = (input) => { return normalize(input); }`；
- expression-bodied arrow：`export const fn = (input) => normalize(input);`，断言 `return-value` label 包含 `implicit return` 且 callsite 包含 `normalize`；
- function expression：`const fn = function (input) { return normalize(input); }`；
- class method：`class C { method(input) { return normalize(input); } }`；
- TS `public_field_definition` arrow class field；
- JS/JSX `field_definition` arrow class field；
- TS/JS HOF wrapper field：`handler = throttle((event) => { return this.run(event); })`；
- TSX expression-bodied component：`export const Component = () => <View />`，断言 `return-value` label 包含 `implicit return` / JSX text。

**实现：**

- analyzer 读取完整文件、执行 source-size/stale guards、加载 parser、parse。
- 定位 function-like syntax node 和 body。
- 遍历 body，先实现 callsite + return-value。
- 文本字段 sanitize/cap。

---

### 任务 3：control-flow 摘要

**目标：** 识别 early returns、guards、branches、switch、loops、try/catch/finally。

**测试先行：** fixture `processRequest()` 包含：

- `if (!input.user) { audit(...); return { ok: false }; }`
- `if (opts?.dryRun) { return buildPreview(input); }`
- `switch (input.kind) { ... }`
- `try { for (const item of input.items) { ... } } catch (err) { ... } finally { ... }`

断言：

- `items.some(i => i.kind === 'guard' && i.conditionText?.includes('!input.user'))`。
- 至少一个 `early-return`，range 指向 return 所在行。
- 至少一个 `branch` 或第二个 `guard` for dry-run。
- 存在 `switch`、`loop`、`try`、`catch`、`finally`。
- callsite inside control-flow fixture：`worker.run()` 位于 `try { for (...) { worker.run(...) } }` 内；断言该 callsite 的 `enclosing` 包含 `try` 与 `loop`，formatter 输出能看出 `within: try ... > loop ...`。
- 所有 item 的 `range.path === 'src/long.ts'`，line 为 1-indexed 且落在 node range 内。
- nested function boundary fixture 覆盖 declaration、local arrow、local function expression：

```ts
function outer(items: Item[]) {
  function innerDecl() {
    return dangerousDecl();
  }
  const innerArrow = () => dangerousArrow();
  const innerExpr = function () {
    return dangerousExpr();
  };
  safe();
}
```

  断言 `dangerousDecl()` / `dangerousArrow()` / `dangerousExpr()` 以及这些 nested body 内的 `return` 不被标成 outer 的 main callsite / early-return / main return-value；`safe()` 仍被收集。

**实现：**

- 增加 control-flow AST node visitor。
- 实现 shallow exits 检测 helper，且 traversal 不跨普通 nested function/class/method boundary。
- 对 try/catch/finally 输出分项。
- 添加 depth 计算与 enclosing stack propagation。

---

### 任务 4：关键 callsites 与 callback-like invocation hints

**目标：** 在不推断绑定的前提下，展示关键调用点和 callback-like 线索。

**测试先行：** fixture：

```ts
export function run(items: Item[], onProgress?: (id: string) => void, options?: { streamFn?: () => void }) {
  for (const item of items) {
    worker.run(item);
    onProgress?.(item.id);
    options?.streamFn?.();
  }
}
```

断言：

- `worker.run(...)` 是 `callsite`，`receiverText === 'worker'`，`propertyText === 'run'`。
- `onProgress?.(...)` 是 `callback-invocation`，note 包含 `binding not inferred`。
- `options?.streamFn?.(...)` 是 `callback-invocation` 或带 callback-like note；不得声称 target/binding。
- inline callback 一级收集 fixture：默认 `includeNestedCallbacks` 为 `true`，`items.map(item => { if (!item.ok) return skip(item); return transform(item); })` 可收集 `skip(...)` / `transform(...)`，但这些 callback body item 的 note 必须包含 `inside nested function/callback`。
- inline callback 内的 `return` 即使被收集，也不得算作 outer 的 early-return / main return-value；只能作为 nested callback item，并带 `inside nested function/callback` note。
- public option 关闭行为：`cg.getNodeStructure(nodeId, { includeNestedCallbacks: false })` 不收集 inline callback 内的 callsite / object literal / return（例如 `skip(...)`、`transform(...)`、callback return object 都不出现）。
- 输出不包含 `runtime main path`、`definitely` 等证明性措辞。

**实现：**

- 提取 callee text / receiver / property。
- 参数名集合来自 target function params。
- callback-like 命名 helper。
- optional chain 检测尽量基于 AST type/text；若不稳定，允许只根据 callee text 包含 `?.` 设置 note。
- inline callback body 只允许一级收集，并强制 note；ordinary nested function body 不收集。

---

### 任务 5：object literal 与 return construction hints

**目标：** 给长函数里 payload/build object 位置提供局部线索，但不跨函数追踪字段。

**测试先行：** fixture：

```ts
export function buildPayload(ctx: Context) {
  const payload = {
    system: ctx.systemPrompt,
    messages: convertMessages(ctx.messages),
    tools: ctx.tools ?? [],
  };
  send({ body: payload, stream: true });
  return { ok: true, payload };
}
```

断言：

- 存在 `object-literal` for `payload`，`objectKeys` 包含 `system/messages/tools`。
- 存在 `object-literal` for `send({ body, stream })` argument。
- 存在 `return-value` with `objectKeys` 包含 `ok/payload`。
- early return object fixture：`if (!ctx.ok) return { ok: false, reason }` 只输出一个 `early-return` item，但该 item 仍携带 `objectKeys` 包含 `ok/reason`。
- 不输出“systemPrompt definitely reaches provider payload”之类跨函数/dataflow 结论。

**实现：**

- 识别 object node，提取静态 keys。
- 从 parent context 判断 assignment / variable declarator / call argument / return object。
- 对 computed/spread key 使用 `[computed]` / `...spread` 标记。

---

### 任务 6：MCP `codegraph_node detail=structure` formatting

**目标：** agent-facing 输出可读、紧凑、可复制。

**测试先行：** 在 `__tests__/node-structure.test.ts` 或 `__tests__/addressability.test.ts` 中添加 MCP 测试：

- `handler.execute('codegraph_node', { nodeId, detail: 'structure' })`：
  - 包含 `## <name> (<kind>) — structure`；
  - 包含 `Static AST structure only`；
  - 包含 `### Control flow`、`### Key callsites`、`### Construction / returns`；
  - 包含 exact ranges，例如 `src/long.ts:12-15`；
  - 包含 `codegraph_node({ nodeId: "...", includeCode: true })`；
  - 不包含完整源码 fenced code block。
- `handler.execute('codegraph_node', { nodeId, detail: 'structure', includeCode: true })`：
  - 返回结构摘要；
  - 包含 `includeCode ignored` note。
- cap/omitted count fixture：构造超过 section cap 的 callsites，断言 formatter 从完整 `items` 计算并输出 `... N more items omitted`；analyzer 层仍返回完整 items。
- MCP schema discovery：`handler.getTools()` / exported `tools` 中的 `codegraph_node.inputSchema.properties.detail` 存在，`type === 'string'` 且 `enum === ['structure']`，确保 MCP client/agent 能发现该参数。
- `handler.execute('codegraph_node', { nodeId, detail: 'full' })` 返回 `isError === true`。
- `handler.execute('codegraph_node', { nodeId, detail: true })` 返回 `isError === true`，避免非字符串非法值 silently fallback。
- symbol-only ambiguity 场景：`handler.execute('codegraph_node', { symbol: 'run', detail: 'structure' })` 仍返回既有 ambiguity note / alternatives，不丢 exact handles，也不任选一个生成 structure。
- 默认 `handler.execute('codegraph_node', { nodeId })` 输出与当前行为一致，不包含 structure sections。
- `includeCode: true` 对 leaf function 仍返回源码；对 class 仍返回成员 outline。

**实现：**

- `src/mcp/tools.ts` schema 为 `codegraph_node` 增加 `detail` enum。
- `handleNode()` 解析/校验 `detail`，非法类型/非法枚举值返回 MCP error。
- `detail === 'structure'` 时不要走 symbol-only `findSymbol()` 兼容路径；必须使用 `cg.resolveNodeLocator(locator)` strict resolution。`ambiguous`/`not_found` 直接复用既有 resolution failure formatter，只有 `resolved` 才调用 `cg.getNodeStructure(resolution.node.id, options)`。
- 未传 `detail` 时保留当前 `findSymbol()` 兼容行为，避免破坏旧 `codegraph_node({ symbol })` 用户。
- 新增 `formatNodeStructure(result, formatOptions?: NodeStructureFormatOptions)`；section cap 只在 formatter 层应用。
- 复用 `truncateOutput()`。

---

### 任务 7：unsupported / unavailable 降级路径

**目标：** 对不支持场景诚实、可操作，不抛异常。

**测试先行：**

- Python fixture：`def py_func(): ...`，`detail: 'structure'` 输出 `currently supports TypeScript/JavaScript/TSX/JSX`，并建议 `includeCode=true` / `read`。
- 稳定 indexed node kind 的 unsupported fixture：`class` container、`interface`、`type_alias`、`constant` / `variable`。输出 `structure detail supports function/method bodies`，建议 container 使用 `includeCode=true` member outline 或选择具体 method node。避免把测试绑定到 interface method signature 是否被当前 extractor 索引成 method 的不稳定细节。
- 删除源码文件后调用 `cg.getNodeStructure(nodeId)` 返回 `source-unavailable`。
- unsafe path fixture：直接构造 fake `Node`（例如 `filePath: '../escape.ts'`）调用 analyzer，`validatePathWithinRoot()` 返回 null 时返回 `source-unavailable`，不读取 root 外文件，recommendations 不包含危险 `read ../escape.ts:...`。
- very-large source fixture：设置小 `maxSourceBytes` 后返回 `source-too-large`，建议 targeted `read path:start-end`，不 parse full file。
- stale-source fixture：index 后修改目标文件再调用 structure；hash mismatch 必须返回 `status === 'source-stale'`、`items.length === 0`，并建议 `codegraph sync --quiet` + targeted read。只有 `FileRecord` 缺失或无法比较 hash 时，才在 no-candidate/no-body 输出中建议 sync/read 而不声称 stale。
- stale + large precedence fixture：index 后把文件改成超出 `maxSourceBytes` 的内容；首版 size guard 优先，返回 `source-too-large`，不要求 stale 判断。
- parser-unavailable fixture：直接构造 `NodeStructureAnalyzer(projectRoot, fakeParserHost)`，其中 `getParser()` 返回 `null`，断言 `status === 'parser-unavailable'`。
- parse-error fixture：源码包含 tree-sitter `ERROR` 但目标 body 可定位时，返回 `available` + parse-error caveat；目标 body 不可靠时返回 `parse-error`/`no-body`。

**实现：**

- analyzer status 分支。
- formatter 对非 available status 使用统一降级模板。
- no candidate / no body / stale / parse-error 降级都必须包含 `codegraph sync --quiet` 与安全的 `read path:start-end`；unsafe/outside-root path 降级不得输出可复制的危险 read path。

---

### 任务 8：agent-facing instructions 与 docs/test 同步

**目标：** 新工具参数改变 agent 使用方式，必须同步 instructions。

**测试先行：** 更新 `__tests__/instructions.test.ts`：

- `SERVER_INSTRUCTIONS` 包含：
  - `detail: "structure"`；
  - `long functions` 或 `structure summary`；
  - `not runtime proof`。
- `INSTRUCTIONS_TEMPLATE` 包含同类 guidance。

**实现：**

- 更新 `src/mcp/server-instructions.ts`：
  - Tool selection 中 `codegraph_node` 增加“long function -> detail: "structure" first, includeCode/read only when needed”。
  - Limitations 中说明 structure 是 static AST navigation。
- 更新 `src/installer/instructions-template.ts`。
- 更新 `README.md` 的 MCP tools / `codegraph_node` 描述，说明 `detail: "structure"` 用于长函数结构导航。
- 若仓库存在 `.cursor/rules/codegraph.mdc`，同步更新；当前仓库若未跟踪该文件，实施 PR 应在总结中说明 not applicable。
- 若发布前包含用户可见能力，补 `CHANGELOG.md`。

---

## 验收标准

P2a 完成时必须满足：

1. `codegraph_node` 默认输出不变。
2. `codegraph_node({ nodeId, detail: "structure" })` 对 TS/JS 函数/方法返回结构摘要，不返回完整源码。
3. 每个 structure item 都带 project-relative exact range。
4. 至少覆盖以下 TS/JS fixture 项：
   - syntax shape matrix：非空 function declaration、block-bodied variable arrow、expression-bodied arrow、function expression、class method、TS `public_field_definition`、JS/JSX `field_definition`、HOF wrapper field、expression-bodied TSX component；
   - guard / branch；
   - early return；
   - switch；
   - loop；
   - try/catch/finally；
   - direct/property callsite；
   - callback-like invocation hint；
   - object literal keys；
   - return value construction。
5. callback-like 输出必须包含 caveat，不能推断绑定目标。
6. callsite/object/return items 在 branch/loop/try/catch/finally/switch 下时携带 `enclosing`，formatter 输出可读的 `within:` context。
7. ordinary nested function declaration / local arrow / local function expression body 不被收集为外层函数 main structure；inline callback 一级收集必须带 `inside nested function/callback` note；`includeNestedCallbacks: false` 时不收集 inline callback body 的 callsite/object/return。
8. unsupported language / node kind / source unavailable / unsafe outside-root path / parser unavailable / source-too-large / no-body 都返回可操作降级说明，不抛异常；unsafe path 不输出危险 read recommendation；parser-unavailable 通过 fake parserHost 覆盖；hash mismatch 固定返回 `source-stale` 且不分析结构。
9. source-size guard 优先于 stale：stale+large 组合返回 `source-too-large`。
10. query-time tree-sitter `Tree` 在 `finally` 中释放，避免 MCP 长驻进程 WASM heap 泄漏。
11. 输出中有显眼 caveat：static AST structure only / not runtime proof / not LLM summary。
12. invalid `detail` 类型/值返回 MCP error；symbol ambiguity 保持既有 ambiguity 输出与 exact handles；MCP schema discovery 暴露 `detail: { type: 'string', enum: ['structure'] }`。
13. formatter 从完整 `items` 计算 section cap 与 omitted count；analyzer 不因输出 cap 裁剪 items。
14. instructions tests 更新并通过；README 同步更新 `codegraph_node detail: "structure"`。
15. 无 DB migration；旧索引无需重建即可使用结构模式（只要源文件存在、大小在 guard 内且 parser 可用且 hash 未 stale）。

---

## Focused validation 命令

实施阶段建议按顺序运行：

```bash
npx vitest run __tests__/node-structure.test.ts
npx vitest run __tests__/addressability.test.ts __tests__/instructions.test.ts
npm run build
```

若触及 parser/loading 或 MCP formatting 较多，再运行：

```bash
npx vitest run __tests__/extraction.test.ts __tests__/trace.test.ts
npm test
```

---

## 受影响文件清单

预计新增：

- `src/structure/node-structure.ts`
- `src/structure/index.ts`（可选，若需要 barrel export）
- `__tests__/node-structure.test.ts`

预计修改：

- `src/types.ts`
- `src/index.ts`
- `src/mcp/tools.ts`
- `src/mcp/server-instructions.ts`
- `src/installer/instructions-template.ts`
- `src/extraction/languages/typescript.ts`（仅当抽取/复用 class-field body helper 时）
- `src/extraction/languages/javascript.ts`（仅当抽取/复用 class-field body helper 时）
- `src/extraction/tree-sitter-helpers.ts` 或新增 shared helper（仅当抽取共享 AST helper 时）
- `__tests__/instructions.test.ts`
- `README.md`
- `CHANGELOG.md`（发布前用户可见能力变化时）
- `.cursor/rules/codegraph.mdc`（若仓库中存在/恢复该 agent-facing 文件）

预计不修改：

- `src/db/schema.sql`
- `src/db/migrations.ts`
- `src/resolution/*`
- `src/graph/trace.ts`（除非后续决定让 trace recommendations 主动建议 structure；P2a 首版可不改 trace）

---

## 风险与缓解

### 风险 1：AST node 定位与 extractor 逻辑漂移

缓解：

- 复用或抽取 TS/JS extractor 中 body resolution helper，特别是 TS `public_field_definition` 与 JS/JSX `field_definition` + arrow/HOF wrapper。
- 测试覆盖 syntax shape matrix：function declaration、variable arrow、function expression、method、TS/JS class field arrow、HOF wrapper、TSX/JSX component。

### 风险 2：query-time full-file parse 太慢或源码已过期

缓解：

- `maxSourceBytes` guard 优先；超限返回 `source-too-large`，首选建议 targeted `read path:start-end`，不读取完整文件、不 hash、不 parse full file；`includeCode=true` 仅作为 node range 很小或用户明确需要完整 node 源码时的次选。
- 检测到 hash mismatch 时固定返回 `status: 'source-stale'`、`items: []`，不继续 parse/analyze；不能检测时，在 no candidate/no body/parse-error 降级中建议 `codegraph sync --quiet`。
- tree-sitter `ERROR` node 不等于 throw；能可靠定位且非 stale 时返回 available + caveat，不能可靠定位时降级。
- query-time `parser.parse()` 返回的 `Tree` 必须在 `finally` 中 `delete()`，避免长驻 MCP server 的 WASM heap 泄漏；review/测试可通过 code inspection 或 targeted unit seam 覆盖。
- stale-source、very-large-source、stale+large precedence fixture 必须覆盖。

### 风险 3：输出过多，反而污染上下文

缓解：

- 结构项按类别 cap，并展示 omitted count。
- 文本字段 cap。
- 不输出源码代码块。
- 继续使用 MCP `truncateOutput()`。

### 风险 4：callback/object hints 被误读为 dataflow/runtime proof

缓解：

- callback-like item 必带 caveat。
- ordinary nested function body 默认不收集；inline callback 一级收集必须带 `inside nested function/callback` note。
- exit/early-return 检测不得跨 nested function boundary。
- object literal item 只说本地构造位置和 keys。
- formatter 顶部统一 static-only caveat。
- tests 断言不出现证明性措辞。

### 风险 5：parser 在 MCP 查询时未加载

缓解：

- `getNodeStructure()` 是 async，并且无条件先调用 `loadGrammarsForLanguages([node.language])`，不依赖 indexAll 同进程副作用。
- parser unavailable 返回降级说明，不影响普通 `codegraph_node`。
- 通过 internal `parserHost` seam 注入 `getParser() => null` 覆盖 parser-unavailable 分支，避免依赖模块级 grammar cache 状态。

### 风险 6：跨语言期待被过度放大

缓解：

- tool description、instructions、unsupported output 都明确首版 TS/JS/TSX/JSX。
- 后续语言支持必须单独加 fixture 与测试。

---

## 推荐实施顺序

1. 先写 `__tests__/node-structure.test.ts` skeleton、simple fixture red test、syntax shape matrix red tests。
2. 加 types + `NodeStructureOptions` / `NodeStructureFormatOptions` + `NodeStructureEnclosingContext` + `CodeGraph.getNodeStructure()` + analyzer skeleton，让 not_found/unsupported/source-unavailable/source-too-large/source-stale/parser-unavailable 分支先通过。
3. 实现 source-size/stale guards（size 优先）、TS/JS lazy parser loading、parserHost test seam、target function body 定位、basic callsite/return-value。
4. 增加 control-flow visitor、enclosing stack propagation 与 nested function boundary 保护。
5. 增加 callback-like 与 object-literal hints；inline callback 默认收集一级且强制 note，`includeNestedCallbacks: false` 关闭收集。
6. 接入 MCP `detail: "structure"` schema、handler、strict resolution 路径与 formatter。
7. 补 unsupported/unavailable/stale/large-source MCP tests。
8. 更新 instructions、README + tests。
9. 跑 focused validation；若输出文案影响 agent-facing 行为，补 changelog。

---

## 与 P2b 的边界

P2a 只回答：

> “这个节点内部有哪些结构区域和关键语法点，我下一步该读哪几段？”

P2b 才回答：

> “给定字段/key，在项目中有哪些读写、构造、映射位置？”

因此 P2a 可以在当前函数内展示 object literal keys 和 local property/callback callsites，但不得实现项目级字段搜索、跨函数 payload mapping 或 alias/dataflow。