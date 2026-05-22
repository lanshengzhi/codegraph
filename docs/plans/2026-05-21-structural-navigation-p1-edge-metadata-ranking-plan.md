# CodeGraph 结构导航可用性增强 P1：edge metadata 与排序理由 TDD 实施计划

> 关联设计：[`docs/codegraph-structural-navigation-usability-design.md`](../codegraph-structural-navigation-usability-design.md)  
> 拆解路线图：[`2026-05-21-structural-navigation-roadmap.md`](./2026-05-21-structural-navigation-roadmap.md)  
> 前置计划：[`2026-05-21-structural-navigation-p0-output-plan.md`](./2026-05-21-structural-navigation-p0-output-plan.md)、[`2026-05-21-structural-navigation-p0b-dynamic-boundary-plan.md`](./2026-05-21-structural-navigation-p0b-dynamic-boundary-plan.md)  
> 状态：P1a implemented / validated (2026-05-22); P1b/P1c planned  
> 范围：为 resolved edge 保留可审计来源信号，并让 trace / context / explore 的排序理由透明；不做完整控制流、完整 alias/dataflow 或 registry runtime branch 判定。

---

## 目标

P1 聚焦“证据地基”和“排序解释”。P0/P0b 已经能把现有 edge kind、callsite、confidence、resolvedBy、boundary 和 exact next checks 展示出来；P1 要减少输出里的 `evidence=not-recorded`，并让候选路径/文件/符号说明“为什么排在这里”。

核心目标：

1. extraction / resolution 为 resolved edge metadata 保留更多来源信号：`referenceName`、`referenceKind`、source call shape、callee/receiver/property text 等；source file/language 可从 source node 或 unresolved ref denormalized fields 获得，不要求在 edge metadata 中重复存储。
2. MCP trace / callers / callees 输出可审计 edge evidence：源码形态 `direct-call`、`property-call`、`constructor-call`、`import`、`decorator`、`bare-call`；resolution fallback `name-match`、`framework`、`fuzzy`；以及 `not-recorded`。
3. trace path 排序从“长度 + 粗 confidence”升级为多信号静态 ranking：direct-call ratio、average edge confidence、scope/path match、low-evidence count、test/generated penalty、optional-branch keyword penalty。
4. 每条 trace path 给出 compact ranking reason 和 caveat，明确是 static ranking，不是 runtime main-path proof。
5. `codegraph_context` 给 entry/node 最小版 reason，`codegraph_explore` 首版只给 file reason：exact name/path match、search channel、graph proximity、generic-name penalty、test/generated penalty。
6. 所有新增 reason 必须来自记录的信号；缺失时输出 `reason: not recorded`，不得事后编造语义解释。

### 推荐拆分批次

P1 范围较大，实施时应拆成三个可独立验收的批次：

- **P1a：edge metadata carrier 与 MCP edge evidence**  
  DB migration → extraction metadata → resolution propagation → trace/callers/callees evidence output。P1a 是主线，context/explore reason 不应阻塞它。  
  **实施状态（2026-05-22）：已完成并验证。**
- **P1b：trace ranking 与 ranking reason**  
  在 P1a metadata 可用后，实现 path over-collection、top-K state retention、ranking score/reason 和 MCP path header。
- **P1c：context / explore relevance reason**  
  最小化暴露已有搜索/图邻近/penalty 信号；context 覆盖 entry/node reason，explore 首版只覆盖 file reason。若 reason carrier 牵动过大，可作为后续独立 PR。

---

## 决策：P1 需要一个小 schema migration

P1 需要把 extraction 阶段看到的 call expression shape 传给 resolution 阶段，最终写入 resolved edge metadata。当前 `unresolved_refs` 表只持久化：

```text
from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language
```

因此如果不迁移 schema，`receiverText`、`propertyText`、`calleeText`、`sourceEvidence` 等信息在 `indexAll -> resolveAndPersistBatched()` 中会丢失。

P1 决策：

- **新增 `unresolved_refs.metadata TEXT` JSON 列**，用于持久化 extraction source metadata。
- **不新增 edge 表列**；resolved edge 继续使用现有 `edges.metadata` JSON 承载新增字段。
- 旧索引 / 旧 edge metadata 仍兼容：缺失字段输出 `not-recorded`。
- schema version 从当前 `4` 升到 `5`。

理由：

- migration 范围小，向后兼容；
- 避免把 JSON metadata 展开成多个稳定性未验证的 edge columns；
- 让 P2/P3 后续 AST-heavy / registry / field-sites 能复用同一 metadata carrier。

---

## 非目标

P1 明确不做：

- 完整控制流、条件分支可达性证明；
- 完整 alias analysis、interprocedural dataflow；
- constructor options / object field assignment / callback binding 的完整闭合；
- provider registry runtime branch 唯一判定；
- `codegraph_field_sites`；
- long-function structure summary；
- LSP / TypeScript compiler API；
- 跨语言完整 call shape coverage；
- 用 ranking 声称“业务主路径”或“运行时一定发生”。

P1 可以说：

```text
Path 1 ranks higher because it has more direct-call edges, higher static confidence, and no optional/test penalties.
```

P1 不可以说：

```text
Path 1 is the runtime main path.
```

---

## Recon 结果：实施前代码切片

基于当前代码结构，P1 主要触点如下。

### 已有基础

- `src/types.ts`
  - `Edge.metadata?: Record<string, unknown>` 已存在。
  - `UnresolvedReference` 当前没有 `metadata`。
  - `TraceEdge` 当前包含 `confidence`、`resolvedBy`，但没有 source evidence / reference text。
  - `TracePath` 当前包含 `confidence` 与单句 `reason`。
- `src/db/schema.sql`
  - `edges.metadata` 已是 JSON text。
  - `unresolved_refs` 没有 metadata 列。
- `src/db/migrations.ts`
  - 当前 `CURRENT_SCHEMA_VERSION = 4`。
- `src/db/queries.ts`
  - `insertUnresolvedRef()`、`getUnresolvedReferences*()` 需要读写新增 metadata。
  - `rowToEdge()` 已安全解析 `edges.metadata`。
- `src/extraction/tree-sitter.ts`
  - `extractCall()` 已能区分很多 call expression 形态，但只把结果压缩为 `referenceName`。
  - TS/JS `member_expression`、Go `selector_expression`、Python `attribute`、Kotlin `navigation_expression` 等已有识别逻辑，可复用为 metadata。
  - `extractInstantiation()`、`extractImport()`、`extractDecoratorsFor()`、bare call 分支需要补 metadata。
- `src/resolution/index.ts`
  - `resolveAll()` 把 `UnresolvedReference` 转为 internal `UnresolvedRef` 时会丢弃未知字段。
  - `createEdges()` 当前只写 `metadata.confidence` 和 `metadata.resolvedBy`。
- `src/resolution/types.ts`
  - `UnresolvedRef` 与 `ResolvedRef.original` 需要扩展 metadata。
- `src/graph/trace.ts`
  - `buildPath()` 当前 ranking 主要来自 direct `calls` 数量与 path length。
  - `paths.sort()` 当前先按 `steps.length`，再按 `confidence`。
  - P0b boundary classification 已使用 confidence/resolvedBy。
- `src/mcp/tools.ts`
  - `formatEdgeEvidence()` 当前固定输出 `evidence=not-recorded`。
  - `formatTraceResult()` 只展示 path confidence 和单句 reason。
  - `handleExplore()` 自己对 file group 排序，但没有输出 reason。
  - `handleContext()` 依赖 `cg.buildContext(... format: 'markdown')`，formatter 没有 entry reason。
- `src/context/index.ts`
  - `findRelevantContext()` 内部已有大量排序信号：exact matches、text search、prefix/camel/compound channels、co-location boost、test penalty、graph traversal proximity。
  - 这些信号目前没有结构化保留下来。
- `src/context/formatter.ts`
  - entry points 只显示 name/kind/path/signature。

### 关键缺口

- extraction 看到的 AST shape 没有持久化到 unresolved ref；resolution 后 edge 无法知道 direct/property/constructor/import 等 source evidence。
- trace ranking reason 没有说明 direct-call ratio、low-evidence、optional/test/generated penalty。
- context/explore 排序过程有信号，但最终 markdown 输出没有 reason。

---

## Metadata 约定

P1 建议先保持 additive JSON metadata，不新增复杂对象层级到 DB columns。

### Source evidence 类型

在 `src/types.ts` 增加轻量枚举/union：

```ts
export type ReferenceSourceEvidence =
  | 'direct-call'
  | 'property-call'
  | 'constructor-call'
  | 'import'
  | 'decorator'
  | 'bare-call'
  | 'not-recorded';
```

说明：

- `direct-call`：源码形态类似 `foo()`。
- `property-call`：源码形态类似 `obj.foo()`、`this.foo()`、`config.streamFn()`。
- `constructor-call`：源码形态类似 `new Foo()` / language equivalent。
- `import`：import/use/require-like reference。
- `decorator`：decorator / annotation reference。
- `bare-call`：Ruby 等无括号 bare method call。
- `not-recorded`：旧索引、contains edge、或 extractor 未记录。

P1 不把 `framework` 放进 `ReferenceSourceEvidence`：framework 是 resolution / framework resolver 信号，应通过 `resolvedBy='framework'` 或 `metadata.framework` 表达。P1 也暂不承诺 `type-reference` source evidence；如果实现 extends/implements/type annotation metadata，应另加测试后再扩展 union。

### Display evidence 分类

`sourceEvidence` 只描述 extraction 看到的源码形态；`name-match` / `fuzzy` / `framework` 属于 resolution 信号，继续由 `resolvedBy` 表达。MCP 展示用的 `evidence=` 可以通过 helper 组合两类信号：

```ts
export type EdgeEvidenceDisplay =
  | ReferenceSourceEvidence
  | 'name-match'
  | 'fuzzy'
  | 'framework';
```

建议映射：

- 如果 `sourceEvidence` 已记录且不是 `not-recorded`，优先显示源码形态，例如 `evidence=property-call`，同时继续显示 `resolvedBy=fuzzy|framework|exact-match`。
- Display helper 必须把 `sourceEvidence === 'not-recorded'` 视为等价于 source evidence absent，再根据 `resolvedBy` fallback。
- 如果 source evidence absent / `not-recorded`，但 `resolvedBy === 'fuzzy'`，显示 `evidence=fuzzy`。
- 如果 source evidence absent / `not-recorded`，但 `resolvedBy === 'framework'`，显示 `evidence=framework`。
- 如果 source evidence absent / `not-recorded`，且 `resolvedBy === 'exact-match' | 'qualified-name' | 'instance-method' | 'import' | 'file-path'`，显示 `evidence=name-match`。
- 只有 `sourceEvidence` 与 resolution metadata 都缺失时，才显示 `evidence=not-recorded`。

### Reference metadata

在 `UnresolvedReference` / internal `UnresolvedRef` 上新增：

```ts
export interface ReferenceMetadata {
  /** Original reference name used for resolution. */
  referenceName?: string;
  /** Original edge kind before resolution-time promotion. */
  referenceKind?: EdgeKind;
  /** Conservative source-level evidence from extraction. */
  sourceEvidence?: ReferenceSourceEvidence;
  /** Raw callee / constructor / imported target text, capped. */
  calleeText?: string;
  /** For property calls: receiver/object text, capped. */
  receiverText?: string;
  /** For property calls: property/member text. */
  propertyText?: string;
  /** Tree-sitter node type for call expression or reference expression. */
  expressionKind?: string;
  /** Whether property lookup is computed/dynamic, when known. */
  isComputed?: boolean;
  /** Whether optional chaining/call is present, when known. */
  isOptional?: boolean;
  /** Number of call arguments, when cheap to compute. */
  argumentCount?: number;
  /** Framework name when a framework extractor/resolver produced the reference, if known. */
  framework?: string;
  /** Denormalized source file/language at extraction time; edge metadata need not repeat these. */
  filePath?: string;
  language?: Language;
}
```

Practical constraints：

- text fields should be capped, e.g. 120 chars, to avoid storing huge expressions.
- only record facts directly available from AST; do not infer runtime binding.
- if a language does not support a field, omit it rather than guessing.

### Edge metadata

`ReferenceResolver.createEdges()` writes a superset into `Edge.metadata`:

```ts
metadata: {
  confidence: ref.confidence,
  resolvedBy: ref.resolvedBy,
  referenceName: ref.original.referenceName,
  referenceKind: ref.original.referenceKind,
  sourceEvidence: ref.original.metadata?.sourceEvidence ?? 'not-recorded',
  calleeText: ref.original.metadata?.calleeText,
  receiverText: ref.original.metadata?.receiverText,
  propertyText: ref.original.metadata?.propertyText,
  expressionKind: ref.original.metadata?.expressionKind,
  isComputed: ref.original.metadata?.isComputed,
  isOptional: ref.original.metadata?.isOptional,
  argumentCount: ref.original.metadata?.argumentCount,
  framework: ref.original.metadata?.framework,
}
```

`filePath` / `language` 不必重复写入 edge metadata；需要 source file/language 时优先从 `edge.source` 对应 node 读取，或在 resolution 阶段使用 unresolved ref 的 denormalized fields。

对于 framework resolver / extractor：

- 不设置 `sourceEvidence='framework'`。
- 若 framework extractor / resolver 知道框架名，可设置 `metadata.framework=<name>`。
- 若普通 ref 被 framework resolver 命中，`resolvedBy='framework'` 是主要证据；source evidence 不应被伪造。

### Provenance 决策

P1 不把 `Edge.provenance` 作为主线验收项。`sourceEvidence` / `resolvedBy` 是本阶段的 evidence carrier；resolved edge 仍可能显示 `provenance=unknown`，这不是 P1 失败。若实施时选择补 `provenance='tree-sitter'`，必须作为额外小任务加测试，但不得让 provenance 输出成为 P1a 的必要条件。

### Trace edge metadata

`TraceEdge` 建议新增安全字段：

```ts
sourceEvidence?: ReferenceSourceEvidence;
referenceName?: string;
referenceKind?: EdgeKind;
calleeText?: string;
receiverText?: string;
propertyText?: string;
expressionKind?: string;
isComputed?: boolean;
isOptional?: boolean;
argumentCount?: number;
framework?: string;
```

旧 edge 上这些 source fields 可能为空；formatter 应先按 display evidence fallback 使用 `resolvedBy` 生成 `name-match` / `framework` / `fuzzy`。`sourceEvidence === 'not-recorded'` 必须被视为 source evidence absent；只有 source fields 与 resolution metadata 都缺失时才输出 `evidence=not-recorded`。

---

## Trace ranking 约定

在 `TracePath` 上保持现有 `confidence` 兼容，同时新增结构化 ranking 信息。`confidence` 继续表示路径静态置信度/edge confidence 聚合；`ranking.score` 是排序分，包含 path length、optional/test/generated penalty 等启发式因素，二者不能混用：

```ts
export type TracePathLabel =
  | 'higher-ranked-static-candidate'
  | 'alternate-static-candidate'
  | 'optional-branch'
  | 'low-evidence';

export interface TracePathRanking {
  /** Static ranking score used for sorting. Not runtime probability. */
  score: number;
  label: TracePathLabel;
  signals: {
    edgeCount: number;
    directCallCount: number;
    propertyCallCount: number;
    directCallRatio: number;
    averageConfidence?: number;
    lowEvidenceCount: number;
    frameworkEdgeCount: number;
    metadataMissingCount: number;
    scopeMatchCount: number;
    testOrFixtureNodeCount: number;
    generatedNodeCount: number;
    optionalKeywordCount: number;
  };
  reasons: string[];
  penalties: string[];
}
```

Signal 计算规则：

- `directCallCount` 必须基于 `edge.sourceEvidence === 'direct-call'`，不能基于 `edge.kind === 'calls'`。
- `propertyCallCount` 必须基于 `edge.sourceEvidence === 'property-call'`。
- `edge.kind === 'calls'` 只表示图关系类型，不表示源码调用形态；`provider.streamSimple()` 也是 `calls` edge，但不是 direct call。
- 缺少 source evidence 的旧 edge 不计入 direct-call ratio；可用 `resolvedBy` 影响 low-evidence/name-match reason，但不能假装 direct-call。
- `metadataMissingCount` 表示缺少有效 source evidence：`sourceEvidence` absent / invalid / `not-recorded` 都计入。
- `lowEvidenceCount` 表示 resolution 或静态绑定证据弱：低 confidence、`resolvedBy='fuzzy'`、弱 `instance-method`、`resolvedBy='framework'` 等计入。
- `{ sourceEvidence: 'not-recorded', resolvedBy: 'exact-match' }` 计入 `metadataMissingCount`，但不因 missing source evidence alone 计入 `lowEvidenceCount`。
- `{ sourceEvidence: 'property-call', resolvedBy: 'fuzzy' }` 计入 `propertyCallCount`，也计入 `lowEvidenceCount`，因为 resolution weak。

排序应使用可审计信号，建议规则：

1. higher `score` first；
2. shorter path as tie-breaker；
3. higher average confidence as tie-breaker；
4. deterministic tie-break by target path/name。

建议 score 组成（数值可在实现中校准）：

- base: `1.0`
- direct-call ratio bonus: `+ directCallRatio * 0.4`
- average confidence bonus: `+ avgConfidence * 0.3`
- scope/path match bonus: `+ scopeMatchRatio * 0.15`
- path length penalty: `- edgeCount * 0.03`
- property-call count penalty: `- propertyCallCount * 0.04`
- low evidence penalty: `- lowEvidenceCount * 0.15`
- metadata missing penalty: `- metadataMissingCount * 0.08`
- framework edge penalty: `- frameworkEdgeCount * 0.05`
- test/fixture/example penalty: `- testOrFixtureNodeCount * 0.2`
- generated penalty: `- generatedNodeCount * 0.2`
- optional keyword penalty: `- optionalKeywordCount * 0.15`

Optional / side-branch keyword set should be conservative and documented in one helper, e.g.:

```text
compact, compaction, preflight, retry, cleanup, fallback, error, recover, rollback, teardown, dispose
```

注意：keyword penalty 只影响 ranking/reason，不证明该 path 不会运行。`validate` 首版不作为独立 optional keyword，避免误伤业务主路径；后续若需要，只在 `validateBefore*` / `preflightValidate` 等更窄组合中低权重处理。

### Trace 搜索阶段要求

仅在最终 `paths.sort()` 使用 ranking 不够。当前 trace 搜索若继续使用：

```ts
while (queue.length > 0 && paths.length < opts.maxPaths ...)
bestDepth: Map<string, number>
```

就可能在 ranking 之前提前丢掉更优路径：低证据短路径先被 BFS 找到并填满 `maxPaths`，或更长但证据更强的候选被 `bestDepth` 剪掉。

P1b 必须同时调整搜索阶段：

- 先 over-collect candidate paths，例如 `candidatePathLimit = Math.max(opts.maxPaths * 5, 10)`，并设置上限避免爆炸；排序后再 slice 到 `opts.maxPaths`。
- `while` 条件使用 candidate path limit，而不是直接用 `opts.maxPaths`。
- `bestDepth` 不能只按 node depth 剪枝。至少对同一 node 保留 top-K non-dominated candidate states（建议 K=3），比较维度包括 depth、partial confidence/evidence、optional/test penalty，而不是只保留最短路径。
- 如果实现无法可靠计算 partial score，也应先采用“每个 node 保留 K 个不同路径状态”的保守策略，避免 P1 ranking 无候选可排。
- boundary / gaps 仍基于最终搜索结果；完整路径存在时，只对最终展示的 top paths 输出 path-edge boundaries，避免 over-collection 把旁路 frontier boundary 带入输出。

### Trace test/generated penalty 规则

`codegraph_trace` 没有自然语言 query 参数，所以不能复用 context/explore 的 `isTestQuery`。P1b 采用显式 locator 规则：

- 如果 `from`、任一 target candidate、或 `scopePath` 位于 test/spec/fixture/example/generated 路径，则不施加 test/fixture/generated penalty，避免测试 trace 被生产路径无脑压下去。
- 否则，对经过 test/spec/fixture/example/generated 路径的候选施加 penalty，并在 reason 中说明。
- 不为 trace 新增自然语言 query 参数。

---

## Context / Explore reason 约定

新增轻量 relevance reason 类型：

```ts
export type RelevanceLabel = 'high-signal' | 'medium-signal' | 'low-signal' | 'not-recorded';

export interface RelevanceReason {
  label: RelevanceLabel;
  score?: number;
  signals: string[];
  penalties: string[];
}
```

建议在 `Subgraph` 或 `TaskContext` 上以 optional 形式携带：

```ts
reasons?: {
  nodes: Record<string, RelevanceReason>;
  files: Record<string, RelevanceReason>;
};
```

P1c 输出范围：context formatter 使用 entry/node reason；explore formatter 首版只使用 file reason，不逐个 symbol 输出 reason。

P1 最小版 reason signals：

- `exact name match`
- `exact symbol extracted from query`
- `path/name text match`
- `prefix/camel-case match`
- `compound multi-term match`
- `graph proximity to entry point`
- `directly connected to entry point`
- `entry point`
- `file contains multiple query symbols`

P1 最小版 penalties：

- `generic symbol name`
- `test/fixture/example path`
- `generated path`
- `lexical-only match`
- `low graph proximity`

如果 implementation 无法保留某一步 reason，应输出：

```text
Reason: not recorded
```

不要在 formatter 里根据自然语言 query 编造高层语义解释。

---

## MCP 输出形态约定

### Edge evidence 行

P1 后，trace / callers / callees edge evidence 行目标形态：

```text
└─ edgeKind=calls evidence=direct-call reference=service callsite=src/flow.ts:2 provenance=unknown confidence=0.90 resolvedBy=exact-match
```

Property call：

```text
└─ edgeKind=calls evidence=property-call reference=provider.streamSimple receiver=provider property=streamSimple callsite=src/provider.ts:42 confidence=0.80 resolvedBy=instance-method
```

Constructor call：

```text
└─ edgeKind=instantiates evidence=constructor-call reference=Agent callee=Agent callsite=src/session.ts:88 confidence=0.90 resolvedBy=exact-match
```

旧 / metadata missing edge：

```text
└─ edgeKind=contains evidence=not-recorded callsite=unknown provenance=unknown confidence=not-recorded resolvedBy=not-recorded
```

字段规则：

- `evidence` 通过 display helper 从 `sourceEvidence` + `resolvedBy` 得出；源码形态优先，resolution fallback 只用于缺少源码形态时。
- `reference` 来自 `referenceName`，没有则省略或 `not-recorded`。
- `receiver` / `property` 只在 recorded 时展示。
- `callee` 只在它和 `reference` 有差异或有额外价值时展示，避免输出膨胀。
- 所有文本字段应经过短截断和换行清洗。

### Trace path header

目标形态：

```text
### Path 1 — higher-ranked-static-candidate (static score 0.82)
Reason: direct-call ratio 1.00; average edge confidence 0.90; stays in requested scope; no optional/test/generated penalties.
Caveat: static ranking only, not runtime main-path proof.
```

Optional branch：

```text
### Path 2 — optional-branch (static score 0.51)
Reason: static path reaches target, but includes optional/preflight keywords: _checkCompaction, compact.
Penalties: optional-branch keyword penalty, longer path.
Caveat: static path exists; inspect guards/source before treating it as the normal runtime path.
```

### Context entry reason

目标形态：

```text
### Entry Points

- **AgentSession.prompt** (method) - src/agent/session.ts:120
  `(input: string, options?: PromptOptions): Promise<void>`
  Reason: high-signal; exact symbol match; graph proximity to runAgentLoop; production path.
```

### Explore file reason

建议增加一个紧凑 section，或在 file header 下输出一行：

```text
#### src/agent/session.ts — AgentSession.prompt(method), runAgentLoop(function)
Reason: entry point + directly connected symbols; exact name/path match; production path.
```

或：

```text
### Why these files
- src/agent/session.ts: high-signal; contains entry point AgentSession.prompt; graph proximity to provider flow.
```

P1 建议优先使用 per-file header reason，避免新增过长 section。

---

## TDD 任务拆解

### 任务 1：新增 unresolved reference metadata carrier 与 schema migration

**目标：** extraction metadata 能跨 DB 持久化到 resolution。

**测试先行：** 更新或新增 `__tests__/resolution.test.ts` / `__tests__/sqlite-backend.test.ts`，并更新现有 schema-version 断言（例如 `__tests__/pr19-improvements.test.ts` 中的 `CURRENT_SCHEMA_VERSION`）：

- `QueryBuilder.insertUnresolvedRef()` 写入带 `metadata` 的 ref 后，`getUnresolvedReferences()` 能读回：
  - `metadata.sourceEvidence === 'property-call'`
  - `metadata.receiverText === 'provider'`
  - `metadata.propertyText === 'streamSimple'`
- `getUnresolvedReferencesBatch()` / `getUnresolvedReferencesByFiles()` 同样保留 metadata。
- 真正构造一个 v4 临时 DB，不要用 v1 schema 伪装 version 4：
  - v4 fixture 应等价于当前 schema minus `unresolved_refs.metadata`；
  - 包含 v2 已有列：`unresolved_refs.file_path`、`unresolved_refs.language`、`edges.provenance`、`project_metadata`；
  - 包含 v3/v4 相关 index 状态，例如 `idx_nodes_lower_name`，且没有 redundant `idx_edges_source` / `idx_edges_target`；
  - `schema_versions` 包含 1..4；
  - 插入一条没有 `metadata` 列的老 `unresolved_refs` 数据；
  - open 后运行 migration；
  - assert `unresolved_refs.metadata` 列存在；
  - assert schema version 为 5；
  - assert 老数据仍可读且 `metadata === undefined`。
- 新库初始化测试：`DatabaseConnection.initialize()` 创建的新 DB 直接包含 `unresolved_refs.metadata` 列，不只依赖 migration path。
- `metadata` 为 `null` / malformed JSON / primitive JSON（string/number/array）时不崩溃，返回 `undefined`。

**实现：**

- `src/types.ts`
  - 增加 `ReferenceSourceEvidence`、`ReferenceMetadata`。
  - `UnresolvedReference` 增加 `metadata?: ReferenceMetadata`。
- `src/resolution/types.ts`
  - `UnresolvedRef` 增加 `metadata?: ReferenceMetadata`。
- `src/db/schema.sql`
  - `unresolved_refs` 增加 `metadata TEXT`。
- `src/db/migrations.ts`
  - `CURRENT_SCHEMA_VERSION = 5`。
  - migration v5：`ALTER TABLE unresolved_refs ADD COLUMN metadata TEXT DEFAULT NULL;`
- `src/db/queries.ts`
  - `UnresolvedRefRow` 增加 `metadata: string | null`。
  - insert SQL 增加 metadata。
  - 所有 unresolved refs row mapper 解析 metadata。
  - 通过 typed helper 校验 metadata 必须是 plain object；array/string/number/malformed JSON 一律降级为 `undefined`。

**验收：** metadata round-trip 稳定，旧 DB 可迁移，旧 refs 无 metadata 不影响 resolution。

---

### 任务 2：TS/JS call / import / instantiation extraction 写入 source evidence

**目标：** 首版减少 TS/JS/TSX/JSX 的 `evidence=not-recorded`。

**测试先行：** 扩展 `__tests__/extraction.test.ts`，新增 TS fixture：

```ts
class Provider {
  streamSimple(): void {}
}

function service(): void {}

export function entry(provider: Provider): void {
  service();
  provider.streamSimple();
  this.localHandler();
  new Provider();
}
```

断言：

- direct call ref：
  - `referenceName === 'service'`
  - `metadata.sourceEvidence === 'direct-call'`
  - `metadata.calleeText === 'service'`
- property call ref：
  - `referenceName === 'provider.streamSimple'`（保持现有 resolution 行为）
  - `metadata.sourceEvidence === 'property-call'`
  - `metadata.receiverText === 'provider'`
  - `metadata.propertyText === 'streamSimple'`
  - `metadata.calleeText === 'provider.streamSimple'`
- `this.localHandler()`：
  - `referenceName === 'localHandler'`（保持现有 skip receiver 行为）
  - `metadata.sourceEvidence === 'property-call'`
  - `metadata.receiverText === 'this'`
  - `metadata.propertyText === 'localHandler'`
- instantiation ref：
  - `referenceKind === 'instantiates'`
  - `metadata.sourceEvidence === 'constructor-call'`
  - `metadata.calleeText === 'Provider'`
- import ref：
  - `metadata.sourceEvidence === 'import'`
- decorator ref（如果复用现有 decorator fixture）：
  - `metadata.sourceEvidence === 'decorator'`
- metadata sanitization：
  - 超长 `calleeText` / `receiverText` / `propertyText` 被截断到约定 cap（例如 120 chars）；
  - 换行 / 制表符 / 多空白被清洗成单行；
  - 非法 `sourceEvidence` 值在 formatter/helper 层降级为 `not-recorded`。

**实现：**

- 在 `src/extraction/tree-sitter.ts` 增加 helper：
  - `createReferenceMetadata(...)`
  - `sanitizeMetadataText(text, cap = 120)`
  - `buildCallMetadata(callNode, calleeNode, receiverNode?, propertyNode?)`
- `extractCall()` 在决定 `calleeName` 时同时记录 metadata。
- `extractInstantiation()` 写 `constructor-call` metadata。
- `extractImport()` 写 `import` metadata。
- `extractDecoratorsFor()` 写 `decorator` metadata。
- `extractBareCall()` 分支写 `bare-call` metadata。

**验收：** 新 metadata 只记录 AST 事实，不改变现有 referenceName / resolution 行为。

---

### 任务 3：Resolution 把 reference metadata 传播到 resolved edge metadata

**目标：** resolved edge 能被 trace/callers/callees 使用 source evidence。

**测试先行：** 扩展 `__tests__/resolution.test.ts`：

- 用真实 `CodeGraph.indexAll()` fixture：

```ts
class Provider {
  streamSimple(): void {}
}
export function entry(provider: Provider): void {
  provider.streamSimple();
}
```

断言 resolved edge：

- `edge.kind === 'calls'`
- `edge.metadata.confidence` 和 `edge.metadata.resolvedBy` 保持存在；
- `edge.metadata.referenceName === 'provider.streamSimple'`；
- `edge.metadata.sourceEvidence === 'property-call'`；
- `edge.metadata.receiverText === 'provider'`；
- `edge.metadata.propertyText === 'streamSimple'`。

再加 direct call fixture，断言 `sourceEvidence === 'direct-call'`。

**实现：**

- `src/resolution/index.ts::resolveAll()` 转 internal ref 时保留 `metadata`。
- `src/resolution/index.ts::createEdges()` 合并 metadata：
  - existing `confidence` / `resolvedBy`；
  - original `referenceName` / `referenceKind`；
  - extraction `metadata` 中可审计字段。
- 如果 resolution-time kind 被 promote（`calls` -> `instantiates`、`extends` -> `implements`），保留：
  - `referenceKind` 为 original kind；
  - edge `kind` 为 promoted kind；
  - 可选 `promotedFrom` 字段说明。

**验收：** edge metadata 足够 formatter 输出 evidence，不需要重新读源码。

---

### 任务 4：TraceEdge 与 MCP edge evidence 使用 recorded metadata

**目标：** `codegraph_trace` / `codegraph_callers` / `codegraph_callees` 不再固定 `evidence=not-recorded`。

**测试先行：** 扩展 `__tests__/trace.test.ts`：

- direct call trace 输出包含：
  - `evidence=direct-call`
  - `reference=service`
  - 不包含该 edge 的 `evidence=not-recorded`
- property call trace 输出包含：
  - `evidence=property-call`
  - `reference=provider.streamSimple`
  - `receiver=provider`
  - `property=streamSimple`
  - `resolvedBy=instance-method` 或当前实际 resolver 策略
- resolution fallback：当 edge 没有 `sourceEvidence` 但有 `resolvedBy=exact-match|qualified-name|instance-method|import|file-path` 时，输出 `evidence=name-match`。
- explicit not-recorded fallback：当 edge metadata 为 `{ sourceEvidence: 'not-recorded', resolvedBy: 'exact-match' }` 时，也输出 `evidence=name-match`，不能输出 `evidence=not-recorded`。
- metadata missing edge（例如 `contains`）仍输出：
  - `evidence=not-recorded`
  - 不猜测 property/callback/registry。
- callers/callees 输出同样包含 evidence/reference/receiver/property。

**实现：**

- `src/types.ts::TraceEdge` 增加 source metadata 字段。
- `src/graph/trace.ts::toTraceEdge()` 从 `edge.metadata` 安全提取。
- `src/mcp/tools.ts::formatEdgeEvidence()`：
  - 用 `edgeEvidenceDisplay(edge)` 生成 `evidence=...`；
  - 有 `referenceName` 时展示 `reference=...`；
  - 有 `receiverText` / `propertyText` 时展示；
  - 文本字段截断、去换行。
- 复用同一 helper 格式化 trace/callers/callees。

**验收：** MCP 输出显示真实 recorded evidence，旧 edge 保守降级。

---

### 任务 5：Trace path over-collection、ranking signals 与 reason

**目标：** 多条 trace path 的排序理由透明，并确保 ranking 有足够候选可排；旁路路径不能只因为 BFS 先找到或更短就抢占首位。

**测试先行：** 建议用 `GraphTracer` + 手工 DB fixture，避免 extractor/resolver 影响 ranking 测试。

用例 A：direct/high-confidence path outranks low-confidence path。

- Path A：`entry -> normal -> target`，edges metadata：`sourceEvidence=direct-call`、`confidence=0.9`。
- Path B：`entry -> fuzzy -> target`，edges metadata：`sourceEvidence=direct-call`、`confidence=0.5`、`resolvedBy=fuzzy`。
- 断言：
  - `paths[0]` 是 normal path；
  - `paths[0].ranking.signals.averageConfidence > paths[1].ranking.signals.averageConfidence`；
  - `paths[1].ranking.penalties` 包含 low evidence / fuzzy；
  - `paths[0].confidence` 仍是路径静态置信度/edge confidence 聚合，不等于 `paths[0].ranking.score` 的启发式排序分。

用例 B：optional branch keyword penalty。

- Path A：`entry -> runAgentLoop -> target`。
- Path B：`entry -> _checkCompaction -> compact -> target`。
- 断言：
  - optional path label 为 `optional-branch` 或 penalties 包含 optional keyword；
  - MCP output 对 Path B 显示 `compaction/compact` penalty；
  - caveat 包含 static ranking only / not runtime proof。

用例 C：test/fixture/generated penalty 的 locator 规则。

- 非 test locator：Path A 节点 filePath 在 `src/flow.ts`，Path B 节点 filePath 在 `src/__tests__/flow.test.ts` 或 `fixtures/flow.ts`；Path A 排名前于 Path B，reason/penalties 包含 `test/fixture/example path`。
- test locator：`from` 或 target 位于 test/spec/fixture path 时，不施加 test/fixture penalty；从 test node trace 到 test target 不应被生产路径无脑压下去。

用例 D：over-collection 防止 BFS 早停。

- 设置 `maxPaths=1`。
- 构造邻接顺序让低证据 / optional path 先被发现，高证据 direct path 后被发现。
- 断言最终返回的是 high-confidence direct path，而不是先发现的低证据 path。
- 断言内部 candidate path 数量超过 `maxPaths` 后再排序/截断，或者通过 observable output 验证结果。

用例 E：top-K state retention 防止 `bestDepth` 剪掉更优路径。

- 构造两条路径到达同一中间节点：短但 low-evidence，长但 direct/high-confidence。
- 该中间节点再到 target。
- 断言长但证据更强的 state 没有被 `bestDepth` 单纯按 depth 剪掉，并有机会进入 ranking。

用例 F：direct-call ratio 不等于 `edge.kind === 'calls'`。

- 构造两条 path，所有 edge 都是 `kind='calls'`。
- Path A 的 edge metadata 为 `sourceEvidence='direct-call'`。
- Path B 的 edge metadata 为 `sourceEvidence='property-call'`。
- 断言 Path A 的 `directCallRatio` 更高且排名高于 Path B；Path B 只增加 `propertyCallCount`，不增加 `directCallCount`。

**实现：**

- `src/search/query-utils.ts`
  - 若没有现成 helper，新增/导出 `isGeneratedFile()` 或 `isNonProductionPath()`；复用现有 `isTestFile()`。
- `src/graph/trace.ts`
  - 新增 `rankTracePath(steps, opts): TracePathRanking`。
  - `buildPath()` 计算 `ranking` 并生成 reason。
  - direct/property call counts 必须从 `sourceEvidence` 读取；不要继续用 `edge.kind === 'calls'` 近似 direct call。
  - 保留 `TracePath.confidence` 的兼容语义：建议用 average edge confidence / existing static path confidence；不要把它赋值为 `ranking.score`。
  - 新增 `candidatePathLimit = Math.max(opts.maxPaths * 5, 10)`（再加硬上限），搜索阶段 over-collect，排序后再 `slice(0, opts.maxPaths)`。
  - `while` 条件改用 candidate path limit，而不是 `opts.maxPaths`。
  - 将 `bestDepth` 替换或扩展为 per-node top-K candidate states；至少保留 K=3 个 non-dominated states，避免只按 depth 剪枝。
  - `paths.sort()` 改为 ranking score 优先，长度/avg confidence deterministic tie-break。
  - 完整 path 存在时，path-edge boundaries 只基于最终展示的 top paths 生成，避免 over-collected 旁路污染输出。
- `src/mcp/tools.ts::formatTraceResult()`
  - path header 显示 label + `ranking.score` as static score；
  - reason 输出 `ranking.reasons` / `ranking.penalties` 的 compact human text；
  - 如展示 `confidence`，文案必须叫 edge/static confidence，不得与 static score 混用。

**验收：** trace 搜索先收集足够候选，再用 ranking 可解释地排序；`confidence` 与 `ranking.score` 语义分离。

---

### 任务 6：Context entry/node relevance reason 最小版

**目标：** `codegraph_context` 的 entry point 不只是列表，而是带 reason。

**测试先行：** 扩展 `__tests__/context.test.ts`：

- fixture 包含：
  - 一个 exact symbol：`AuthService.login`；
  - 一个 lexical-only/generic symbol：`Text` 或 `run`；
  - 一个 test/fixture path 同名符号。
- 调用 `cg.buildContext('AuthService login flow', { format: 'markdown', includeCode: false })`。
- 断言 markdown：
  - entry point 下包含 `Reason:`；
  - exact symbol 包含 `exact` / `symbol`；
  - test path 候选如果出现，reason/penalty 包含 `test` 或 `fixture`；
  - 如果 reason 未记录，显示 `Reason: not recorded` 而不是空白。
- import/export reason propagation fixture：搜索先命中 import/export node，`resolveImportsToDefinitions()` 替换成 definition 后，definition entry 仍保留原 reason，并追加 `resolved from import/export match` signal。

**实现：**

- `src/types.ts`
  - 增加 `RelevanceReason`；
  - `SearchResult` 可增加 `reason?: RelevanceReason`；
  - `Subgraph` 或 `TaskContext` 增加 optional `reasons`。
- `src/context/index.ts`
  - 在 exact matches/text results/prefix/camel/compound/search merge 过程中记录 signal。
  - 在 test penalty/generic penalty/co-location boost 时记录 penalty/signal。
  - traversal 加入节点时记录 `graph proximity to entry point` / `directly connected to entry point`。
  - `resolveImportsToDefinitions()` 将 import/export 搜索结果替换成 definition 时，必须转移原 result reason，并追加 signal：`resolved from import match` / `resolved from export match` 或 `definition reached from import/export match`。
- `src/context/formatter.ts`
  - Entry Points 下输出一行 compact reason。
  - JSON formatter 输出 structured `reasons`。

**验收：** context 输出能解释高信号/低信号入口，且不显著增加输出体积。

---

### 任务 7：Explore file reason 最小版

**目标：** `codegraph_explore` 文件排序与重要文件入选原因透明。P1c 首版只做 file reason，不做 per-symbol reason，避免输出膨胀。

**测试先行：** 扩展 `__tests__/explore-output-budget.test.ts` 或新增 `__tests__/explore-reasons.test.ts`：

- 调用 `codegraph_explore({ query: 'Session method helper' })`。
- 输出包含：
  - `Reason:` 或 `Why these files`；
  - 至少一个文件 reason 包含 `entry point` / `directly connected` / `graph proximity`；
  - test/fixture 文件如果列出，reason 包含 penalty；
  - 输出仍受 adaptive budget 限制。

**实现：**

- `src/mcp/tools.ts::handleExplore()`：
  - 从 `subgraph.reasons.files` 读取 file reasons；
  - file group scoring 时记录：entry point count、connected count、query path/name match、test/generated penalty；
  - file header 下输出 one-line file reason，cap 160 chars。
- 如果 `subgraph.reasons` 不存在：
  - 输出 `Reason: not recorded`，不要编造。

**验收：** explore 的文件选择理由可见，但不破坏 source section 的主要价值；per-symbol reason 明确不属于 P1c 首版。

---

### 任务 8：agent-facing instructions / README / CHANGELOG 同步

**目标：** P1a/P1b/P1c 对应用户可见 MCP 输出或 agent 使用建议变更时，必须同步 agent-facing instructions。P1a/P1b 必然改变 MCP 输出语义，因此不是可选项。

**测试先行：** 更新 `__tests__/instructions.test.ts`。

**必须触及：**

- `src/mcp/server-instructions.ts`
- `src/installer/instructions-template.ts`
- `.cursor/rules/codegraph.mdc`（如果 tracked / exists；若仓库不存在该文件，实施结果中明确说明）

**发布前视情况触及：**

- `CHANGELOG.md`（发布前用户可见能力变化）

建议说明新增点：

- trace/callers/callees may show `evidence=direct-call|property-call|...` when recorded;
- ranking score/reason is static evidence, not runtime proof;
- context/explore reasons explain why candidates were returned and may include penalties.

**验收：** instructions 测试通过；说明不夸大 runtime proof。

---

## 推荐实施顺序

### P1a：edge metadata carrier 与 MCP edge evidence

**状态：implemented / validated (2026-05-22)。**

1. ✅ **Types + DB migration**：已建立 metadata carrier 和 round-trip / v4 migration 测试。
2. ✅ **Extraction source evidence**：已覆盖 TS/JS direct/property/constructor/import/decorator metadata、Ruby bare-call metadata 与 sanitization。
3. ✅ **Resolution propagation**：resolved edge metadata 已包含 reference/source evidence。
4. ✅ **MCP edge evidence**：trace/callers/callees 已从固定 `not-recorded` 升级到 recorded evidence / name-match fallback。
5. ✅ **P1a instructions / CHANGELOG**：已同步 agent-facing instructions 与 CHANGELOG；仓库中不存在 `.cursor/rules/codegraph.mdc`。

### P1b：trace ranking 与 ranking reason

6. **Trace over-collection**：candidatePathLimit 与 per-node top-K candidate states，避免 BFS 早停/剪枝丢候选。
7. **Trace ranking**：ranking signals、path labels、reason、sort；保持 `confidence` 与 `ranking.score` 分离。
8. **P1b instructions / CHANGELOG**：必须同步 agent-facing instructions，说明 static score/reason 不是 runtime proof；发布前补 CHANGELOG。

### P1c：context / explore relevance reason

9. **Context reasons**：entry/node relevance reason carrier + markdown/json formatter。
10. **Explore reasons**：file header/file group reason。
11. **P1c instructions / CHANGELOG**：实现 P1c 输出后必须同步 agent-facing instructions，说明 context/explore reason 是排序解释，不是完整语义证明；发布前补 CHANGELOG。

这样可以先完成“证据被记录并可见”，再改变 trace 搜索/排序，最后补 context/explore reason，降低回归风险。

---

## 验证命令

Focused validation：

```bash
npx vitest run __tests__/extraction.test.ts -t "evidence"
npx vitest run __tests__/resolution.test.ts -t "metadata"
npx vitest run __tests__/sqlite-backend.test.ts -t "migration"
npx vitest run __tests__/pr19-improvements.test.ts
npx vitest run __tests__/trace.test.ts
npx vitest run __tests__/context.test.ts
npx vitest run __tests__/explore-output-budget.test.ts
npx vitest run __tests__/instructions.test.ts
```

Broader validation：

```bash
npm run build
npm test
```

如 migration 改动影响 SQLite backend，额外运行：

```bash
npx vitest run __tests__/sqlite-backend.test.ts
```

---

## 最小验收清单

P1 完成时至少满足：

- [x] `unresolved_refs.metadata` migration 存在，真实 v4 DB 可升级到 schema version 5；新 DB 初始化直接包含 metadata 列；`__tests__/pr19-improvements.test.ts` 等 schema-version 断言已更新。_P1a 已完成。_
- [x] `UnresolvedReference.metadata` 能通过 QueryBuilder insert/get/batch/byFiles/getByName round-trip；null/malformed/primitive JSON 安全降级。_P1a 已完成。_
- [x] TS/JS direct call extraction 写入 `sourceEvidence=direct-call`。_P1a 已完成。_
- [x] TS/JS property call extraction 写入 `sourceEvidence=property-call`、`receiverText`、`propertyText`。_P1a 已完成。_
- [x] instantiation/import/decorator refs 写入对应 source evidence，并覆盖 Ruby bare-call source evidence。_P1a 已完成。_
- [x] metadata 文本字段有 cap、去换行/制表符测试；非法 `sourceEvidence` 降级为 `not-recorded`。_P1a 已完成。_
- [x] resolved edge metadata 包含 `referenceName`、`referenceKind`、`sourceEvidence`、confidence、resolvedBy。_P1a 已完成。_
- [x] `codegraph_trace` edge line 展示 recorded `evidence=`；无 source evidence 或 `sourceEvidence='not-recorded'` 但有 resolver metadata 时显示 `evidence=name-match|framework|fuzzy`；完全缺失时才是 `not-recorded`。_P1a 已完成。_
- [x] `codegraph_callers` / `codegraph_callees` 展示同样 edge evidence。_P1a 已完成。_
- [ ] trace 搜索 over-collects candidate paths，并用 per-node top-K state retention 避免 `bestDepth` 单纯按深度剪掉更优路径。_P1b。_
- [ ] trace path 有 structured ranking signals/reasons；多路径排序考虑 direct-call ratio、edge confidence、optional branch、test/fixture/generated penalty；direct/property call counts 基于 `sourceEvidence`，不是 `edge.kind === 'calls'`。_P1b。_
- [ ] `TracePath.confidence` 与 `TracePath.ranking.score` 分离；MCP 输出 `ranking.score` 时称为 static score。_P1b。_
- [ ] trace 输出显式说明 static ranking only / not runtime proof。_P1b。_
- [ ] `codegraph_context` entry point 输出 reason 或 `reason: not recorded`，import/export resolved to definition 时 reason 被转移并追加 signal（P1c，可不阻塞 P1a/P1b）。
- [ ] `codegraph_explore` 文件输出 reason 或 `reason: not recorded`；per-symbol reason 不属于 P1c 首版（P1c，可不阻塞 P1a/P1b）。
- [x] P1a 对应用户可见输出变更已同步 `src/mcp/server-instructions.ts`、`src/installer/instructions-template.ts`，并更新 instructions tests；仓库中不存在 `.cursor/rules/codegraph.mdc`。_P1b/P1c 后续若改变输出仍需再次同步。_
- [ ] 输出 reason 不声称 runtime main path。_P1b/P1c。_
- [x] 不引入完整 control-flow/dataflow/alias/registry runtime 判定。_P1a 已遵守。_

---

## 风险与缓解

### 风险 1：schema migration 增加安装/升级风险

**缓解：** 仅新增 nullable JSON column；旧数据不需要 backfill；QueryBuilder mapper 对 null/malformed JSON 容错；覆盖 native/wasm backend migration 测试。

### 风险 2：把 property-call 误读为动态绑定已闭合

**缓解：** 文案使用 `evidence=property-call`，并保留 `resolvedBy` / confidence；不输出 “binding exact” 或 “runtime target proven”。如需要，ranking reason 可说 “property call receiver binding may need source verification”。

### 风险 3：ranking 看起来像业务主路径判断

**缓解：** path header 使用 `static score` / `static ranking`；每条 path caveat 明确不是 runtime proof；optional penalty 只说 “keyword penalty”，不说 “definitely optional”。

### 风险 4：reason 输出膨胀

**缓解：** 每个 edge 只展示 recorded compact fields；每个 path reason cap 3-5 signals；context/explore reason 单行 cap 160 chars；继续使用现有 output budget/truncation。

### 风险 5：context reason 难以完整追踪

**缓解：** P1 只做最小可审计 signals；无法追踪的 channel 输出 `not recorded`；不要为追求完整 reason 重写整个 context ranking pipeline。

### 风险 6：trace test/generated penalty 缺少自然语言 query 上下文

**缓解：** `codegraph_trace` 不新增自然语言 query 参数，也不复用 context/explore 的 `isTestQuery`。Trace ranking 使用 locator 规则：from/target/scopePath 任一位于 test/spec/fixture/example/generated 路径时，不施加 test penalty；否则对经过这些路径的候选施加 penalty，并在 reason 中说明。Context/explore 仍可使用自己的 query-based `isTestQuery`。

### 风险 7：edge metadata JSON 字段命名漂移

**缓解：** 在 `src/types.ts` 定义 `ReferenceMetadata` 类型和 helper；formatter/resolution 只通过 helper 读取字段；测试断言关键字段名。

---

## P1 完成后的下一步

P1 完成后再评估：

- `evidence=property-call` / `sourceEvidence` 是否足以支撑 P2a 长函数结构摘要中的 callback invocation hints；
- 哪些 field/key metadata 需要进入 P2b `codegraph_field_sites`；
- registry/resolver 候选是否应优先做 provider registry、route registry，还是 workspace import；
- context/explore reason 是否需要更结构化的 JSON API，还是保持 markdown-only 最小版即可。

如果 P1 后 trace 仍频繁断在 `property-call` / `not-recorded`，下一批不应继续加 ranking heuristics，而应进入 P2b/P3 的按需候选线索能力。