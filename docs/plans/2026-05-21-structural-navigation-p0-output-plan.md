# CodeGraph 结构导航可用性增强 P0：输出层可信度与可操作性计划

> 关联设计：[`docs/codegraph-structural-navigation-usability-design.md`](../codegraph-structural-navigation-usability-design.md)  
> 拆解路线图：[`2026-05-21-structural-navigation-roadmap.md`](./2026-05-21-structural-navigation-roadmap.md)  
> 状态：implemented / validated (2026-05-21)  
> 范围：优先利用现有图数据增强 MCP 与 trace 输出可信度；不做 schema migration、不做 AST-heavy 分析。

---

## 目标

P0 聚焦“避免误导”和“让下一步可执行”。首版不追求更聪明的静态分析，只把已经存在或能从当前 path step 推导出的结构事实更清楚地暴露出来。

核心目标：

1. trace / callers / callees 输出 edge 证据字段：edge kind、callsite、provenance、confidence、resolvedBy；缺失时明确 `unknown` / `not-recorded`。
2. trace 输出显式强调 static graph candidate，不是 runtime proof。
3. ambiguity、incomplete trace、no path 结果附带可复制 next checks。
4. 同名符号 ambiguity 输出更容易按文件/上下文选择 exact handle。
5. `codegraph_files` no-match 输出明确 indexed-only 边界，并建议文件系统或 sync 检查。

---

## 非目标

P0 明确不做：

- 新 schema migration；
- 新 persistent edge columns；
- call expression shape / receiver / property name 的完整提取；
- callback、registry、constructor options、object field assignment 的自动闭合；
- long-function structure summary；
- field-sites 工具；
- registry/resolver candidates；
- context/explore ranking reason；
- 运行时主路径证明。

如果缺少原始调用形态，P0 必须显示 `not-recorded`，不能猜测 `property-call`、`callback` 或 `registry`。

---

## 实施前代码切片

主要触点：

- `src/types.ts`
  - `Edge` 已有 `metadata?: Record<string, unknown>`、`line`、`column`、`provenance`。
  - `TraceEdge` 当前只暴露 `sourceNodeId`、`targetNodeId`、`kind`、`line`、`column`、`provenance`。
- `src/resolution/index.ts`
  - `createEdges()` 已写入 `metadata.confidence` 与 `metadata.resolvedBy`。
- `src/graph/trace.ts`
  - `GraphTracer.toTraceEdge()` 当前没有把 edge metadata 转成 trace 输出字段。
  - `buildPath()` reason 较泛化，ranking 主要按 path length 与 confidence。
- `src/index.ts`
  - `trace()` 已有 `completenessNote`，但 recommendations 偏泛。
  - `recommendTraceFollowup()` 主要建议 `codegraph_explore` 与 `codegraph_node`。
- `src/mcp/tools.ts`
  - `formatTraceResult()` 输出 path steps、edge kind、line，但没有展示 confidence/resolvedBy/provenance 的完整语义。
  - `handleCallers()` / `handleCallees()` 聚合时丢弃了 edge detail，只输出 node list。
  - `formatAmbiguity()` 已输出 handles，但尚未按文件/上下文组织。
  - `handleFiles()` no-match 只说 `No files found matching the criteria.`，没有说明 indexed-only。
- `__tests__/trace.test.ts`
  - 已覆盖基础 trace path、gap、fileLine、scopePath、MCP formatting。

---

## 输出形态约定

P0 输出应偏紧凑，优先 markdown 文本，避免大 JSON 块。

### Trace edge 行目标形态

示例：

```text
   └─ edgeKind=calls callsite=src/flow.ts:2 provenance=unknown confidence=0.90 resolvedBy=exact-match evidence=not-recorded
```

字段规则：

- `edgeKind`：来自 `edge.kind`，必须展示。
- `callsite`：如果 edge 有 `line`，用上一 trace step 的 `node.path` + edge line 组合；没有则 `callsite=unknown`。
- `provenance`：来自 edge provenance；缺失则 `unknown`。
- `confidence`：来自 `edge.metadata.confidence`；缺失则 `not-recorded`。
- `resolvedBy`：来自 `edge.metadata.resolvedBy`；缺失则 `not-recorded`。
- `evidence`：P0 不新增调用形态分析，默认显示 `not-recorded`；如果后续 P1 增加 metadata，再细分。

避免在 P0 使用未经证据支撑的：

```text
evidence=callback
binding=registry
binding=exact runtime path
```

### Trace caveat 目标形态

每个 trace 输出应有显眼提示：

```text
> Static graph candidate only. This is not runtime proof; dynamic dispatch, callbacks, registries, and dependency injection may hide or reorder runtime paths.
```

### Next checks 目标形态

推荐项应尽量可复制：

```text
### Recommended next
- codegraph_node({ nodeId: "method:..." })
- codegraph_callees({ nodeId: "method:..." })
- read src/flow.ts:1-12
- codegraph_explore query "entry service repository target"
```

不要只输出：

```text
Try explore.
```

### Files no-match 目标形态

```text
No indexed files matched the criteria.

Note: codegraph_files lists indexed files only, not the complete filesystem. A file may be new, ignored, unsupported, non-code, or not synced yet.
Suggested checks:
- git status
- read <path>
- codegraph sync --quiet
```

---

## TDD 任务拆解

### 任务 1：TraceEdge 暴露现有 edge metadata

**目标：** trace 库层结果保留 confidence / resolvedBy 等现有 metadata，供 MCP formatter 使用。

**测试先行：** 更新 `__tests__/trace.test.ts`：

- `cg.trace({ symbol: 'entry' }, { symbol: 'target' })` 的 `result.paths[0].edges[0]` 包含：
  - `kind === 'calls'`
  - `line` 为数字
  - `confidence` 或等价字段，当 resolver 已记录时可读取；如果 fixture 没有记录则测试 `metadata` 显示缺失路径不崩溃。
- 对 edge metadata 缺失的人工/fixture 场景，trace 结果仍可格式化，不抛异常。

**实现：**

- 在 `src/types.ts` 扩展 `TraceEdge`，建议增加：

```ts
confidence?: number;
resolvedBy?: string;
evidence?: string; // P0 默认 not-recorded / unknown；P1 再细分
```

或增加更保守字段：

```ts
metadata?: {
  confidence?: number;
  resolvedBy?: string;
};
```

- 在 `src/graph/trace.ts::toTraceEdge()` 从 `edge.metadata` 安全提取：
  - number 类型的 `confidence`
  - string 类型的 `resolvedBy`
- 不改变 DB schema。

**验收：** trace 库层保留现有 metadata，旧 trace 测试不回归。

---

### 任务 2：MCP trace 输出 edge evidence 行

**目标：** `codegraph_trace` 输出能让 agent 区分 edge kind、callsite、provenance、confidence、resolvedBy 是否存在。

**测试先行：** 更新 MCP trace 测试：

- 输出包含 `edgeKind=calls`。
- 输出包含 `callsite=src/flow.ts:`，而不是只有 `at line 2`。
- 输出包含 `provenance=`，缺失时为 `unknown`。
- 输出包含 `confidence=` 或 `confidence=not-recorded`。
- 输出包含 `resolvedBy=` 或 `resolvedBy=not-recorded`。
- 输出包含 `evidence=not-recorded`，直到 P1 有真实 evidence。
- 输出包含 `Static graph candidate only` 或等价 not-runtime-proof caveat。

**实现：**

- 在 `src/mcp/tools.ts::formatTraceResult()` 中，渲染 edge 时使用前一个 step 的 path 组合 callsite：

```ts
const previousNode = path.steps[stepIndex - 1]?.node;
const callsite = edge.line && previousNode
  ? `${previousNode.path}:${edge.line}${edge.column != null ? ':' + edge.column : ''}`
  : 'unknown';
```

- 添加小型 helper，例如：
  - `formatTraceEdgeEvidence(edge, previousNode)`
  - `formatOptional(value, fallback = 'not-recorded')`

**验收：** MCP trace 输出无需读源码即可看到 edge 证据强弱与缺失边界。

---

### 任务 3：Trace recommendations 改为 exact next checks

**目标：** trace 成功、失败、不完整时都给可复制 follow-up。

**测试先行：**

- 成功 trace 输出 `Recommended next` 中至少包含：
  - `codegraph_node({ nodeId:` 针对 path 中关键节点；
  - `codegraph_explore query "..."`；
  - 至少一个 `read src/flow.ts:start-end`。
- maxDepth 不足时输出：
  - `codegraph_callees({ nodeId:` 或 `codegraph_node({ nodeId:`；
  - `increase maxDepth` 仍可保留，但不能是唯一建议。
- target not found / ambiguous 时仍保留 exact alternatives handles。

**实现：**

- 可在 `src/index.ts::recommendTraceFollowup()` 增强，也可在 MCP `formatTraceResult()` 根据 path steps 生成 MCP-specific recommendations。
- 推荐优先使用 exact handles：
  - 起点；
  - 终点；
  - path 中间节点数量有限时全部列出，过多时 cap 3-5 个。
- `read` 建议使用 `node.path:startLine-endLine`。

**验收：** 用户可以直接复制推荐项进入下一轮工具调用或 `read`。

---

### 任务 4：callers / callees 输出 edge detail

**目标：** 局部调用图工具也展示 edge 证据，而不是只列 node。

**测试先行：** 新增或扩展 MCP tests：

- `codegraph_callers({ symbol: 'target' })` 输出每个 caller 时包含：
  - caller handle；
  - `edgeKind=calls`；
  - `callsite=...`；
  - `confidence=` / `resolvedBy=` / `provenance=` fallback。
- `codegraph_callees({ symbol: 'entry' })` 同理。
- symbol-only ambiguous roots 的 note 仍输出 grouped handles。

**实现：**

- `CodeGraph.getCallers()` / `getCallees()` 已返回 `Array<{ node, edge }>`。
- 修改 `handleCallers()` / `handleCallees()` 不要只收集 `Node[]`，而是收集 `{ node, edge }`。
- 新增 formatter，例如：
  - `formatNodeEdgeList(items, title, direction)`
  - 复用 trace edge evidence helper。

**验收：** callers/callees 能说明“是谁调用了谁”以及 callsite/metadata，而不是只给目标节点列表。

---

### 任务 5：ambiguity 输出按文件分组

**目标：** 同名符号候选更容易消歧。

**测试先行：** 在 ambiguity fixture 中制造两个或多个 `entry` / `run`：

- ambiguity note 包含 `Ambiguous` 或 `symbols named`。
- 每个候选包含 `nodeId=`、`qualifiedName=`、`range=`。
- 输出按文件分组，例如：

```text
> src/a.ts:
> - entry (function) nodeId=...
> src/b.ts:
> - entry (function) nodeId=...
```

- 超过 cap 时仍显示 `... and N more`。

**实现：**

- 修改 `src/mcp/tools.ts::formatAmbiguity()`：
  - 按 `filePath` 分组；
  - 每组内按 `startLine` 排序；
  - 总候选 cap 仍控制输出长度。
- 不改变库层 `resolveNodeLocator()` 行为。

**验收：** agent 可以按文件/package 直接选择 exact handle。

---

### 任务 6：`codegraph_files` indexed-only no-match 提示

**目标：** 文件定位失败时不让 agent 误判文件不存在。

**测试先行：** 新增 MCP files 测试：

- 对不存在或未索引 path/pattern 调用 `codegraph_files`，输出包含：
  - `indexed files only`；
  - `new, ignored, unsupported, non-code, or not synced` 或等价说明；
  - `git status`；
  - `read <path>`（当传入 pathFilter 时）；
  - `codegraph sync`。
- 正常匹配时输出不变或只加简短 indexed header，不破坏 tree/flat/grouped 格式。

**实现：**

- 修改 `src/mcp/tools.ts::handleFiles()` 的 `files.length === 0` 分支。
- 可新增 helper：

```ts
formatFilesNoMatch(pathFilter?: string, pattern?: string): string
```

**验收：** no-match 结果明确是索引视图边界，而不是文件系统事实。

---

### 任务 7：agent-facing 说明同步（如实现阶段改变工具指导）

**目标：** 如果 P0 实现改变 MCP 工具输出语义或建议 agent 使用新字段，应同步用户可见说明。

**测试先行：** 若修改说明，更新现有 instructions tests 或新增断言。

**可能触及：**

- `src/mcp/server-instructions.ts`
- `src/installer/instructions-template.ts`
- `.cursor/rules/codegraph.mdc`

**说明：** P0 如果只是格式更清楚，可能只需小幅补充“trace/callers/callees 会显示 edge evidence；缺失时 not-recorded”。如果不改变使用方式，可不强行扩大说明。

---

## 推荐实施顺序

1. TraceEdge metadata 类型与库层传播。
2. MCP trace edge evidence formatting。
3. Trace recommendations exact next checks。
4. callers/callees edge detail formatting。
5. ambiguity grouped handles。
6. `codegraph_files` indexed-only no-match。
7. 必要的 instructions / README / CHANGELOG 更新。

这样可以先强化最核心的 trace 输出，再扩展到局部调用图与文件边界。

---

## 实施结果

P0 已按上述顺序完成，核心实现点：

- `TraceEdge` 透传现有 edge metadata：`confidence`、`resolvedBy`。
- MCP trace/callers/callees 输出 edge evidence：`edgeKind`、`callsite`、`provenance`、`confidence`、`resolvedBy`、`evidence=not-recorded`。
- trace caveat 移到输出顶部，强调 static graph candidate / not runtime proof；confidence 在 caveat 中说明为静态 resolution confidence。
- trace next checks 主要在 MCP formatter 层生成，避免把 MCP 风格字符串过度下沉到库层。
- callsite 使用 edge source node 的文件路径，而不是简单使用上一 trace step；已覆盖 `incoming` / `both` trace 测试。
- callers/callees 保留 `{ node, edge }` detail，去重 key 包含 node、root、edge source/target/kind/line/column，避免只按 node 聚合丢 edge。
- ambiguity alternatives 先全量按文件/行排序再 cap，并按文件分组输出 exact handles。
- `codegraph_files` no-match 输出 indexed-only 边界、index-relative path 提醒与 `git status` / `read` / `codegraph sync --quiet` 建议。
- 未新增 schema migration、persistent edge columns 或 AST-heavy 分析；缺失调用形态仍输出 `evidence=not-recorded`。
- 已同步 `src/mcp/server-instructions.ts`、`src/installer/instructions-template.ts` 与 `CHANGELOG.md`；当前 repo 没有 tracked 的 `.cursor/rules/codegraph.mdc`，因此未更新该文件。

验证已通过：

```bash
npm run build
npx vitest run __tests__/trace.test.ts __tests__/addressability.test.ts __tests__/instructions.test.ts
npm test
```

---

## 验证命令

Focused validation：

```bash
npx vitest run __tests__/trace.test.ts
```

如新增 files/ambiguity MCP 测试，运行对应文件，例如：

```bash
npx vitest run __tests__/mcp-files.test.ts
npx vitest run __tests__/addressability.test.ts
```

相关 broader validation：

```bash
npm run build
npm test
```

---

## 最小验收清单

P0 完成时应满足：

- [x] `codegraph_trace` 每条 edge 显示 `edgeKind`。
- [x] `codegraph_trace` 每条 edge 显示 `callsite=path:line` 或 `callsite=unknown`。
- [x] `codegraph_trace` 每条 edge 显示 `provenance=`，缺失为 `unknown`。
- [x] `codegraph_trace` 每条 edge 显示 `confidence=`，缺失为 `not-recorded`。
- [x] `codegraph_trace` 每条 edge 显示 `resolvedBy=`，缺失为 `not-recorded`。
- [x] `codegraph_trace` 显示 static-only / not-runtime-proof caveat。
- [x] incomplete trace 至少输出一个 exact next check。
- [x] successful trace 输出 `codegraph_node` / `read range` / `codegraph_explore` 等可复制 follow-up。
- [x] `codegraph_callers` / `codegraph_callees` 输出 edge detail 与 callsite。
- [x] ambiguous symbol note 输出 grouped exact handles。
- [x] `codegraph_files` no-match 输出 indexed-only 边界与建议检查。
- [x] 未引入 schema migration 或 AST-heavy 依赖。

---

## 风险与缓解

### 风险 1：把 confidence 误读为 runtime confidence

**缓解：** 输出中使用 `resolution confidence` 或在 caveat 中说明它来自静态 resolution，不是运行时概率。

### 风险 2：edge evidence 字段被过度推断

**缓解：** P0 默认 `evidence=not-recorded`；只有 P1 引入可审计 metadata 后再细分。

### 风险 3：recommendations 过多导致输出膨胀

**缓解：** 每条 path 的 exact next checks cap 3-5 个；全局继续使用 `MAX_OUTPUT_LENGTH`。

### 风险 4：callers/callees 聚合去重丢 edge

**缓解：** 去重 key 使用 `node.id + edge.source + edge.target + edge.kind + edge.line`，不要只按 node 去重。

### 风险 5：文件 no-match 提示让用户误以为必须 sync

**缓解：** 文案说“可能原因”，同时建议 `read` / `git status`，不把 sync 作为唯一解释。

---

## P0 完成后的下一步

P0 验收后，再根据实际输出评估 P0b：

- 哪些 no-path / low-confidence 场景最常见？
- 是否已有足够 metadata 标记 dynamic boundary？
- 是否需要先保存 `referenceName` / call expression shape，再做 boundary classification？

如果 P0 输出仍大量显示 `not-recorded` 且影响可用性，再进入 P1 edge metadata 计划，而不是在 P0 中临时猜测。
