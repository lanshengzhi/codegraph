# CodeGraph 结构导航可用性增强 P0b：动态边界最小版 TDD 实施计划

> 关联设计：[`docs/codegraph-structural-navigation-usability-design.md`](../codegraph-structural-navigation-usability-design.md)
> 拆解路线图：[`2026-05-21-structural-navigation-roadmap.md`](./2026-05-21-structural-navigation-roadmap.md)
> 前置计划：[`2026-05-21-structural-navigation-p0-output-plan.md`](./2026-05-21-structural-navigation-p0-output-plan.md)
> 状态：implemented / validated (2026-05-21)
> 范围：在不新增 schema、不过度推断 callback/property/registry 的前提下，把 trace 断点、低证据边和缺失 metadata 变成可操作线索。

---

## 目标

P0b 聚焦“动态边界最小版”：不要求 CodeGraph 自动闭合动态绑定链，只要求当 trace 无法闭合、路径证据较弱或边缺少 metadata 时，输出明确、保守、可继续探索的边界线索。

核心目标：

1. `codegraph_trace` 在 incomplete / no path 场景下输出结构化 boundary：断在哪个 node、可能由哪条 edge 到达、所在 enclosing node、为什么未闭合。
2. 对 low-confidence / fuzzy / framework / metadata missing edge 给出低证据 caveat，明确这是静态图证据，不是 runtime proof。
3. 缺少原始调用形态时明确 `not-recorded` / `unclassified`，不得猜测 `callback`、`property-call`、`registry`。
4. boundary 输出附带 exact follow-up：`codegraph_node`、`codegraph_callees`、`read path:start-end`。
5. 保持 P0 已有输出：edge kind、callsite、provenance、confidence、resolvedBy、static-only caveat、grouped handles。

---

## 非目标

P0b 明确不做：

- schema migration；
- 新 persistent edge columns；
- 持久化 `referenceName`、receiver、property、callee text 或 call expression shape；
- 从 `unresolved_refs` 恢复未解析调用点；当前批量 resolve 会删除 resolved 与 unresolved refs，P0b 不依赖它；
- 自动识别或闭合 callback / property-call / registry / constructor options / object field assignment；
- provider registry candidates；
- long-function structure summary；
- field-sites 工具；
- 完整 path ranking reason；
- 运行时主路径证明。

如果没有可审计信号，输出必须停留在 `unclassified` / `not-recorded`，而不是给出看似智能但无证据的动态绑定判断。

---

## Recon 结果：实施前代码切片

本计划基于 2026-05-21 对当前代码的切片确认。

### 已有能力

- `src/types.ts`
  - `TraceEdge` 已包含：`kind`、`line`、`column`、`provenance`、`confidence`、`resolvedBy`。
  - `TraceResult` 当前包含：`status`、`from`、`targetCandidates`、`paths`、`gaps`、`recommendations`、`completenessNote`。
- `src/graph/trace.ts`
  - `GraphTracer.trace()` 使用 bounded BFS，返回完整 `TracePath[]`、`gaps: string[]`、`recommendations: string[]`、`visitedCount`。
  - `toTraceEdge()` 已从 `edge.metadata.confidence` / `edge.metadata.resolvedBy` 透传到 `TraceEdge`。
- `src/index.ts`
  - `CodeGraph.trace()` 负责 locator resolution、target resolution、调用 `GraphTracer` 并组装 `TraceResult`。
- `src/mcp/tools.ts`
  - `formatTraceResult()` 已输出 static-only caveat。
  - `formatEdgeEvidence()` 已输出：`edgeKind`、`callsite`、`provenance`、`confidence`、`resolvedBy`、`evidence=not-recorded`。
  - `buildTraceNextChecks()` 已能生成部分 exact follow-up，但 no-path 场景主要围绕 `from` 与 target，不知道 frontier/boundary node。
- `__tests__/trace.test.ts`
  - 已覆盖基础 trace、maxDepth incomplete、MCP formatter、incoming/both direction callsite。

### 现有缺口

- trace no-path / maxDepth 只返回泛化 string gap，缺少结构化 frontier / boundary。
- formatter 无法输出“断在哪个节点 / 哪条 edge / enclosing node”。
- 完整路径中的 low-confidence、framework、metadata missing edge 只显示字段值，不被汇总为低证据边界。
- 当前 edge metadata 只有 `confidence` 与 `resolvedBy`，不足以判断 callback / property-call / registry。

### resolution metadata 可用信号

当前 `resolvedBy` 值域来自 `src/resolution/types.ts`：

```ts
'exact-match' | 'import' | 'qualified-name' | 'framework' | 'fuzzy' | 'instance-method' | 'file-path'
```

P0b 可安全使用的分类信号：

- `confidence < 0.8` → low evidence；
- `resolvedBy === 'fuzzy'` → low evidence；
- `resolvedBy === 'instance-method'` 且 confidence 较低时 → low evidence；
- `resolvedBy === 'framework'` → framework boundary / caveat；
- `confidence` 和 `resolvedBy` 都缺失 → metadata not recorded；
- 无完整 path 且 traversal 到达 maxDepth → max-depth boundary；
- 无完整 path 且某 frontier node 在当前 `direction` / `edgeKinds` 下没有可遍历 adjacent edge → dead-end boundary；reason 中可说明 `unclassified` / raw call expression shape not recorded，但不新增 unclassified boundary type。

---

## 建议类型设计

在 `src/types.ts` 增加结构化 boundary 类型。

```ts
export type TraceBoundaryType =
  | 'max-depth'
  | 'dead-end'
  | 'low-evidence-edge'
  | 'framework-edge'
  | 'metadata-not-recorded';

export interface TraceBoundary {
  /** Conservative boundary classification derived from recorded graph facts only. */
  type: TraceBoundaryType;

  /** Node where the trace stopped or where the low-evidence edge lands. */
  node: NodeHandle;

  /** Source/enclosing node for the boundary edge, when known. */
  enclosingNode?: NodeHandle;

  /** Edge involved in the boundary, when known. */
  edge?: TraceEdge;

  /** Human-readable explanation. Must not claim runtime certainty. */
  reason: string;
}
```

在 `TraceResult` 中新增：

```ts
boundaries: TraceBoundary[];
```

实现细节建议：

- `GraphTracer.trace()` 返回 `TraceSearchResult.boundaries`。
- `CodeGraph.trace()` 总是把 `boundaries` 带入 `TraceResult`；from/target resolution failure 时为空数组。
- boundary 数量默认 cap，例如 5，避免 no-path 时输出膨胀。
- frontier 类 boundary（`max-depth` / `dead-end`）只在最终没有完整 path 时进入 `TraceResult.boundaries`；如果 trace 已找到完整 path，P0b 只输出完整 path 上的 `low-evidence-edge` / `framework-edge` / `metadata-not-recorded`。
- boundary callsite 永远基于实际 `edge.sourceNodeId` 对应节点，而不是 trace step 的前一个节点；`enclosingNode` 有 edge 时优先表示实际 edge source，没有 edge 时才 fallback 到 previous trace step。
- boundary reason 使用保守文案，不包含未被记录的 callback/property/registry 结论；不新增 `unclassified-*` 类型，无法分类时用 `dead-end` reason 说明 `unclassified` / call expression shape not recorded。

---

## Boundary 分类规则

### 全局输出规则

- `max-depth` / `dead-end` 是 frontier boundary，只在 `paths.length === 0` 时进入最终 `TraceResult.boundaries`。如果 BFS 已找到完整 path，旁路分支上的 max-depth/dead-end 不输出，避免噪声。
- `low-evidence-edge` / `framework-edge` / `metadata-not-recorded` 是 path edge caveat，可在完整 path 存在时输出，但只针对返回的完整 path 上的 edge。
- 有 edge 的 boundary：`callsite` 必须用实际 `edge.sourceNodeId` 对应节点的 `path + edge.line`；`enclosingNode` 优先是实际 edge source。只有没有 edge 时，才 fallback 到 trace steps 的 previous node。

### `max-depth`

触发条件：

- BFS 队列中的 item 达到 `depth >= maxDepth`；
- 当前 node 不是 target；
- 作为 traversal 期间可收集的 frontier candidate；最终仅在 `paths.length === 0` 时进入 `TraceResult.boundaries`。

输出含义：

```text
type=max-depth node=<current> enclosing=<actual edge source> callsite=<actual edge source path:line>
reason=Traversal reached maxDepth=N before reaching the target. Increase maxDepth or inspect this frontier node.
```

### `dead-end`

触发条件：

- 当前 node 不是 target；
- 未达到 maxDepth；
- 按当前 `direction` / `edgeKinds` / path filters 无可遍历 adjacent edge。

输出含义：

```text
type=dead-end node=<current> enclosing=<actual edge source if edge exists> callsite=<actual edge source path:line or unknown>
reason=No traversable indexed edge continues from this node. This is an unclassified indexed-graph boundary; dynamic calls may exist in source, but raw call expression shape is not recorded in P0b.
```

注意：`dead-end` 是图遍历事实，不等于证明源码没有调用。

### `low-evidence-edge`

触发条件之一：

- `edge.confidence < 0.8`；
- `edge.resolvedBy === 'fuzzy'`；
- `edge.resolvedBy === 'instance-method'` 且 confidence 缺失或低于阈值。

输出含义：

```text
type=low-evidence-edge node=<edge target> enclosing=<edge source> callsite=<source path:line>
reason=This edge was produced by low-evidence static resolution (low confidence, fuzzy, or weak instance-method matching). Inspect source before treating it as a likely runtime path.
```

### `framework-edge`

触发条件：

- `edge.resolvedBy === 'framework'`。

输出含义：

```text
type=framework-edge node=<edge target> enclosing=<edge source> callsite=<source path:line>
reason=Framework resolver produced this edge. It is a static framework pattern candidate, not lifecycle/runtime proof.
```

### `metadata-not-recorded`

触发条件：

- edge 存在，但 `confidence` 与 `resolvedBy` 均缺失。

输出含义：

```text
type=metadata-not-recorded node=<edge target> enclosing=<edge source> callsite=<source path:line or unknown>
reason=This edge exists in the graph, but resolver confidence/source and call expression evidence were not recorded.
```

P0b 不应把此类 edge 猜成 direct-call、callback、property-call 或 registry。

---

## MCP 输出形态约定

在 `formatTraceResult()` 中新增一个紧凑区块，建议位于 paths 之后、`Gaps / caveats` 之前或合并到 caveats 前：

```text
### Boundaries / low-evidence edges
- type=max-depth node=service nodeId=... range=src/flow.ts:5-7 enclosing=entry callsite=src/flow.ts:2
  reason=Traversal reached maxDepth=1 before reaching the target. Increase maxDepth or inspect this frontier node.
- type=low-evidence-edge node=target nodeId=... range=src/ambiguous.ts:20-22 enclosing=entry callsite=src/ambiguous.ts:3
  reason=This edge was produced by low-evidence static resolution (low confidence, fuzzy, or weak instance-method matching). Inspect source before treating it as a likely runtime path.
```

字段规则：

- `type` 必须展示；
- `node` 必须展示 `name`、`nodeId`、`range`；
- `enclosing` 有则展示 `name`；有 edge 时必须来自实际 `edge.sourceNodeId`，不是 trace step previous node；
- `callsite` 有 edge 和 source path 时展示实际 edge source 的 `path:line[:column]`，否则 `unknown`；
- `reason` 必须避免 runtime certainty；
- 缺少 call expression shape 时显式提到 `not recorded` / `unclassified`。

### Recommended next 增强

`buildTraceNextChecks()` 应优先加入 boundary 相关 exact checks：

```text
- codegraph_node({ nodeId: "<boundary.node.nodeId>" })
- codegraph_callees({ nodeId: "<boundary.node.nodeId>" })
- read <boundary.node.path>:<boundary.node.startLine>-<boundary.node.endLine>
```

如果有 `enclosingNode`，也可加入：

```text
- codegraph_node({ nodeId: "<boundary.enclosingNode.nodeId>" })
- read <enclosing.path>:<enclosing.startLine>-<enclosing.endLine>
```

输出 cap 建议：

- boundary list：最多 5 条；
- boundary next checks：最多 3 个 boundary 节点；
- read ranges：复用 P0 的按文件合并逻辑或最多 3 条。

---

## TDD 任务拆解

### 任务 1：新增 TraceBoundary 类型与 TraceResult 字段

**目标：** 先建立结构化 boundary carrier，不改变 trace 行为。

**测试先行：** 更新 `__tests__/trace.test.ts` 或新增纯类型/formatter 相关测试：

- `cg.trace(...)` 返回对象包含 `boundaries` 数组；
- resolved 完整 path 且无低证据边时 `boundaries` 可为空；
- from resolution failure / target not found 时 `boundaries` 为空数组，不抛异常。

**实现：**

- `src/types.ts`
  - 增加 `TraceBoundaryType`、`TraceBoundary`。
  - `TraceResult` 增加 `boundaries: TraceBoundary[]`。
- `src/graph/trace.ts`
  - `TraceSearchResult` 增加 `boundaries: TraceBoundary[]`。
- `src/index.ts`
  - 所有 `TraceResult` return path 补 `boundaries`。

**验收：** 编译通过，旧 trace 测试不回归。

---

### 任务 2：GraphTracer 记录 max-depth frontier boundary

**目标：** maxDepth 导致 incomplete trace 时，指出断点 node、enclosing node 和 callsite edge。

**测试先行：** 复用 `writeTraceFixture()`：

```ts
const result = cg.trace({ symbol: 'entry' }, { symbol: 'target' }, { maxDepth: 1 });
expect(result.paths).toHaveLength(0);
expect(result.boundaries).toEqual(expect.arrayContaining([
  expect.objectContaining({
    type: 'max-depth',
    node: expect.objectContaining({ name: 'service' }),
    enclosingNode: expect.objectContaining({ name: 'entry' }),
    edge: expect.objectContaining({ kind: 'calls', line: 2 }),
    reason: expect.stringMatching(/maxDepth=1|maximum depth/i),
  }),
]));
```

**实现：**

- 在 `GraphTracer.trace()` 队列 item 达到 `maxDepth` 时收集 `max-depth` frontier candidate。
- `InternalStep[]` 已包含当前 node 和入边；boundary `node` 来自当前 step，`edge` 来自入边。
- `enclosingNode` / callsite 不能简单使用 previous step：有 edge 时必须用实际 `edge.sourceNodeId` 查节点；没有 edge 时才 fallback 到 `steps[steps.length - 2]`。
- frontier candidate 最终仅在 `paths.length === 0` 时进入 `TraceSearchResult.boundaries`。
- boundary cap 建议为 5。

**验收：** maxDepth no-path 不再只有 string gap；如果同一次 trace 已找到完整 path，旁路 max-depth 不输出。

---

### 任务 3：GraphTracer 记录 dead-end boundary

**目标：** 图遍历走到无法继续的 frontier 时，输出 dead-end / unclassified caveat。

**测试先行：** 新增 fixture：

```ts
export function entry(): void {
  service();
}

function service(): void {
  // no call to target
}

export function target(): void {}
```

断言：

```ts
const result = cg.trace({ symbol: 'entry' }, { symbol: 'target' }, { maxDepth: 4 });
expect(result.paths).toHaveLength(0);
expect(result.boundaries).toEqual(expect.arrayContaining([
  expect.objectContaining({
    type: 'dead-end',
    node: expect.objectContaining({ name: 'service' }),
    enclosingNode: expect.objectContaining({ name: 'entry' }),
    reason: expect.stringMatching(/No traversable indexed edge|dead.?end|not recorded/i),
  }),
]));
```

**实现：**

- 在取 adjacent edges 并过滤 `nextNode` / `nodeAllowed` 后，如果没有 enqueue 任何下一跳，且当前不是 target，收集 `dead-end` frontier candidate。
- frontier candidate 最终仅在 `paths.length === 0` 时进入 `TraceSearchResult.boundaries`。
- 有入边时，`enclosingNode` / callsite 使用实际 `edge.sourceNodeId`；没有入边时才 fallback 到 previous step 或 `unknown`。
- reason 必须说明这是 indexed graph dead end，不是源码或 runtime proof，并包含 `unclassified` / raw call expression shape not recorded 的含义。

**验收：** no-path 输出指出最后可达节点；如果同一次 trace 已找到完整 path，旁路 dead-end 不输出。

---

### 任务 4：完整路径中标注 low-evidence / framework / metadata-missing edges

**目标：** 即使 trace 找到完整 path，也把低证据边界列出来，避免 agent 把路径当作强证明。

**测试先行：** 建议用直接 DB / `GraphTracer` fixture，避免依赖复杂 extractor 行为。

测试准备：

- 用 `DatabaseConnection.initialize()` + `QueryBuilder` 插入 nodes；
- 用 `queries.insertEdge()` 插入不同 metadata 的 edges；
- 直接调用 `new GraphTracer(queries).trace(fromNode, [targetNode], options)`。

用例 A：low confidence

```ts
queries.insertEdge({
  source: 'entry',
  target: 'target',
  kind: 'calls',
  line: 3,
  metadata: { confidence: 0.7, resolvedBy: 'exact-match' },
});

expect(result.paths.length).toBeGreaterThan(0);
expect(result.boundaries).toEqual(expect.arrayContaining([
  expect.objectContaining({
    type: 'low-evidence-edge',
    edge: expect.objectContaining({ confidence: 0.7 }),
  }),
]));
```

用例 B：framework

```ts
metadata: { confidence: 0.85, resolvedBy: 'framework' }
```

断言：

```ts
expect(result.boundaries).toEqual(expect.arrayContaining([
  expect.objectContaining({
    type: 'framework-edge',
    reason: expect.stringMatching(/framework/i),
  }),
]));
```

用例 C：metadata missing

```ts
queries.insertEdge({ source, target, kind: 'calls', line: 3 });
```

断言：

```ts
expect(result.boundaries).toEqual(expect.arrayContaining([
  expect.objectContaining({
    type: 'metadata-not-recorded',
    reason: expect.stringMatching(/not recorded|metadata/i),
  }),
]));
```

**实现：**

- 在 `GraphTracer.buildPath()` 或 path 构建后运行 `classifyTraceEdges()`。
- 只对返回的完整 path 上的 edge 根据规则生成 boundary。
- `framework-edge` 优先于 `low-evidence-edge`，避免一条 edge 重复分类。
- `metadata-not-recorded` 只在 confidence 与 resolvedBy 都缺失时触发。
- `max-depth` / `dead-end` frontier candidates 不应在完整 path 存在时混入此类结果。

**验收：** 完整 path 仍返回，但只伴随该 path 上的低证据 boundary。

---

### 任务 5：MCP formatter 输出 boundary 区块

**目标：** `codegraph_trace` 文本输出可直接看到断点类型、node handle、callsite、reason。

**测试先行：** 扩展 `MCP codegraph_trace` 测试。

maxDepth case：

```ts
const result = await handler.execute('codegraph_trace', {
  from: 'entry',
  to: 'target',
  maxDepth: 1,
});
const text = result.content[0].text;
expect(text).toContain('No complete path found.');
expect(text).toMatch(/Boundaries|low-evidence/i);
expect(text).toContain('type=max-depth');
expect(text).toContain('service');
expect(text).toContain('enclosing=entry');
expect(text).toContain('callsite=src/flow.ts:2');
expect(text).toContain('codegraph_node({ nodeId:');
expect(text).toContain('codegraph_callees({ nodeId:');
expect(text).toContain('read src/flow.ts:');
```

incoming / both callsite regression：保留 P0 现有 `formats incoming and bidirectional trace callsites with the edge source file` 测试；如果 P0b 新增的 boundary fixture 涉及 `direction: 'incoming' | 'both'`，必须断言 boundary `callsite` 也使用实际 edge source 文件，而不是 previous trace step 文件。

metadata missing case（使用真实 indexed TS fixture 的 `contains` edge 覆盖 MCP formatter，不依赖私有 DB）：

```ts
const result = await handler.execute('codegraph_trace', {
  fromNodeId: 'file:src/flow.ts',
  to: 'entry',
  edgeKinds: ['contains'],
  maxDepth: 1,
});
const text = result.content[0].text;
expect(text).toContain('Path 1');
expect(text).toContain('confidence=not-recorded');
expect(text).toContain('resolvedBy=not-recorded');
expect(text).toContain('evidence=not-recorded');
expect(text).toContain('type=metadata-not-recorded');
expect(text).not.toContain('callback-property-call');
expect(text).not.toContain('type=registry');
expect(text).not.toContain('registry-candidate');
expect(text).not.toContain('Possible binding sites');
```

**实现：**

- `src/mcp/tools.ts`
  - 新增 `formatTraceBoundaries(result.boundaries)` 或 helper。
  - 复用 `formatCallsite()` / `formatEdgeEvidence()`，但 source node 必须来自实际 `edge.sourceNodeId`。
  - `buildTraceNextChecks()` 优先纳入 boundary node exact checks。

**验收：** MCP 输出不是泛泛 caveat，而是有 exact handles 的断点列表。

---

### 任务 6：property/callback-like 未解析调用保持保守输出

**目标：** 证明 P0b 不猜测 callback/property/registry。

**测试先行：** 新增 TS fixture：

```ts
export function entry(config: { streamFn: () => void }): void {
  config.streamFn();
}

export function target(): void {}
```

MCP 断言：

```ts
const result = await handler.execute('codegraph_trace', {
  from: 'entry',
  to: 'target',
  maxDepth: 4,
});
const text = result.content[0].text;
expect(text).toContain('No complete path found.');
expect(text).toMatch(/dead-end|not recorded|unclassified/i);
expect(text).toContain('read src/property-boundary.ts:');
expect(text).not.toContain('callback-property-call');
expect(text).not.toContain('type=registry');
expect(text).not.toContain('registry-candidate');
expect(text).not.toContain('Possible binding sites');
```

**实现：**

- 不新增 AST call-shape extraction。
- dead-end reason 中说明 raw call expression shape is not recorded。

**验收：** P0b 提供下一步阅读位置，但不假装知道动态绑定类型。

---

### 任务 7：agent-facing 说明同步

**目标：** 如果 P0b 改变 MCP trace 输出语义，应同步 agent-facing instructions。

**测试先行：** 更新 `__tests__/instructions.test.ts`：

```ts
expect(SERVER_INSTRUCTIONS).toContain('dynamic boundary');
expect(INSTRUCTIONS_TEMPLATE).toContain('dynamic boundary');
```

或使用更稳定短语：

```ts
expect(SERVER_INSTRUCTIONS).toContain('boundary');
expect(INSTRUCTIONS_TEMPLATE).toContain('boundary');
```

**实现：**

- `src/mcp/server-instructions.ts`
  - 在 trace/callers/callees limitation 或 tool selection 中补充：trace may show boundaries / low-evidence edges; inspect exact handles.
- `src/installer/instructions-template.ts`
  - 同步相同语义。
- `.cursor/rules/codegraph.mdc`
  - 若 tracked 文件存在，同步；当前 P0 记录显示 repo 内没有 tracked `.cursor/rules/codegraph.mdc`。

**验收：** instructions tests 通过。

---

### 任务 8：CHANGELOG / README 更新判定

**目标：** 用户可见 MCP 输出变化在发布前有记录。

**建议：** P0b 实施阶段应更新 `CHANGELOG.md`，因为 `codegraph_trace` 输出新增 boundary / low-evidence guidance 是用户可见能力。

README 是否更新取决于当前 README 是否已有 trace 示例：

- 如果 README 只描述工具列表，可不强制更新；
- 如果 README 有 trace 输出示例，应补一句 “trace highlights dynamic/static boundaries and low-evidence edges when recorded”。

---

## 推荐实施顺序

1. `TraceBoundary` 类型与 `TraceResult.boundaries` plumbing。
2. max-depth boundary。
3. dead-end boundary。
4. complete path edge evidence boundary classification。
5. MCP boundary formatter。
6. boundary-aware exact next checks。
7. conservative property/callback-like no-path regression。
8. instructions / changelog 更新。

这样可以先让 no-path 场景有结构化断点，再扩展到完整路径的低证据提示，最后同步 agent-facing 文档。

---

## 实施结果

P0b 已按 TDD 计划完成，核心实现点：

- `TraceResult` / `TraceSearchResult` 新增 `boundaries: TraceBoundary[]`，from resolution failure 与 target not found 均返回空数组。
- `GraphTracer` 在 no-path 场景收集 `max-depth` 与 `dead-end` frontier boundary；如果已找到完整 path，旁路 frontier boundary 不进入最终输出。
- 完整 path 上的 `low-evidence-edge`、`framework-edge`、`metadata-not-recorded` 会作为低证据 boundary 输出；`framework-edge` 优先于低证据分类。
- boundary `enclosingNode` / `callsite` 有 edge 时基于实际 `edge.sourceNodeId`，覆盖 outgoing / incoming / both trace。
- MCP `codegraph_trace` 新增 `Boundaries / low-evidence edges` 区块，并优先推荐 boundary node 的 `codegraph_node`、`codegraph_callees` 与 `read path:start-end`。
- property/callback-like 未解析调用保持保守输出：提示 indexed-graph dead end / raw call expression shape not recorded，不输出 `callback-property-call`、`property-call`、`type=registry`、`registry-candidate` 或 `Possible binding sites`。
- 已同步 agent-facing instructions、README 与 CHANGELOG；未引入 schema migration、persistent edge columns、AST-heavy 分析或 runtime proof 声明。

验证已通过：

```bash
npx vitest run __tests__/trace.test.ts __tests__/instructions.test.ts
npm run build
npm test
```

---

## 验证命令

Focused validation：

```bash
npx vitest run __tests__/trace.test.ts
npx vitest run __tests__/instructions.test.ts
```

Broader validation：

```bash
npm run build
npm test
```

---

## 最小验收清单

P0b 完成时应满足：

- [x] `TraceResult` 包含 `boundaries: TraceBoundary[]`。
- [x] maxDepth incomplete trace 输出 `type=max-depth` boundary。
- [x] dead-end no-path trace 输出 `type=dead-end` boundary。
- [x] 如果 trace 已找到完整 path，旁路 `max-depth` / `dead-end` frontier boundary 不进入最终输出。
- [x] low-confidence / fuzzy edge 输出 `type=low-evidence-edge` caveat。
- [x] framework edge 输出 `type=framework-edge` caveat。
- [x] metadata missing edge 输出 `type=metadata-not-recorded`，并保留 `confidence=not-recorded` / `resolvedBy=not-recorded` / `evidence=not-recorded`。
- [x] boundary 输出包含 exact node handle：`nodeId` 与 `range`。
- [x] boundary 输出包含 `callsite=path:line` 或 `callsite=unknown`。
- [x] incoming / both trace 下，boundary callsite 使用实际 `edge.sourceNodeId` 文件，而不是 previous trace step 文件。
- [x] boundary 输出包含 `enclosing=`，当 source/enclosing node 可知；有 edge 时 `enclosing` 表示实际 edge source。
- [x] Recommended next 包含 boundary node 的 `codegraph_node` / `codegraph_callees` / `read path:start-end`。
- [x] property/callback-like 未解析调用不被猜成 `callback-property-call`、`property-call`、`type=registry`、`registry-candidate`，也不输出 `Possible binding sites`。
- [x] trace caveat 仍强调 static graph candidate / not runtime proof。
- [x] 未引入 schema migration、AST-heavy 分析或 runtime proof 声明。
- [x] agent-facing instructions 已同步 boundary 语义。

---

## 风险与缓解

### 风险 1：boundary 被误读为动态类型识别

**缓解：** 类型名与 reason 保持保守：`dead-end`、`metadata-not-recorded`、`low-evidence-edge`。缺少 call-shape 时不得输出 `callback`、`property-call`、`registry`。

### 风险 2：low confidence 被误读为 runtime probability

**缓解：** 文案使用 “static resolution confidence”，并继续保留 P0 的 not-runtime-proof caveat。

### 风险 3：boundary 太多导致 trace 输出膨胀

**缓解：** boundary cap 5；next checks cap 3 个 boundary 节点；复用输出 truncation；`max-depth` / `dead-end` frontier boundary 只在 no-path 时最终输出。

### 风险 4：incoming / both trace 下 callsite/enclosing 回归

**缓解：** boundary formatter 与 boundary construction 都以实际 `edge.sourceNodeId` 查 source node；新增 incoming/both 或 formatter 断言，避免使用 previous trace step 作为 callsite source。

### 风险 5：direct DB 测试与真实 extractor 行为脱节

**缓解：** edge classification 用 direct DB fixture 精准覆盖 metadata 组合；maxDepth/dead-end/property-like 用真实 TS fixture 覆盖 end-to-end MCP 输出。

### 风险 6：dead-end 被误解为源码没有调用

**缓解：** reason 明确 “No traversable indexed edge”，不是源码或 runtime 事实；建议 `read` 精确范围，并说明 raw call expression shape not recorded / unclassified。

---

## P0b 完成后的下一步

P0b 完成后再评估 P1 是否需要新增 edge metadata：

- 如果大量 boundary 仍是 `metadata-not-recorded`，优先规划 `referenceName` / call expression shape 持久化。
- 如果 property/callback/registry 是主要痛点，再进入 P1/P2 的 candidate binding / field-sites / registry candidates，而不是在 P0b 中猜测。
- 如果 output 噪声过大，再单独规划 boundary ranking / grouping。
