# CodeGraph Addressability 与 Trace：TDD 实施计划

> 关联设计：[`docs/codegraph-addressability-and-trace-design.md`](../codegraph-addressability-and-trace-design.md)  
> 状态：implementation plan / TDD draft  
> 范围：库 API、MCP 工具输出与输入、Agent 使用说明；首版不引入 LSP、embedding、全程序控制流分析或新持久化身份 schema。

---

## 目标

本计划用 TDD 分两条主线落地设计文档：

1. **Addressability**：所有用户可见节点结果都带可复制、可复用的精确 handle；节点、调用图、影响分析工具可用 `nodeId`、`path + line`、`file:line`、`qualifiedName` 等精确 locator 定位。
2. **Trace**：新增一等 `codegraph_trace` 能力，从入口 locator 到目标 locator/query 返回候选路径、边信息、置信度、缺口与下一步建议。

首版原则：

- 不破坏现有 `symbol` 参数调用方式。
- 精确 locator 优先于模糊搜索。
- 新 trace 工具对含糊入口不静默猜测；返回候选 handles 要求调用方复查。
- 结果默认紧凑，不返回大段源码。
- 测试先行，每个行为先写红灯测试，再实现，再重构。

---

## 当前代码切片

主要触点：

- `src/types.ts`：新增 locator / handle / trace 相关类型。
- `src/db/queries.ts`：补充精确查询方法，例如按 `filePath + line` 找覆盖节点。
- `src/index.ts`：新增公共 API：`resolveNodeLocator()`、`resolveNodeLocators()`、`trace()`。
- `src/mcp/tools.ts`：更新既有工具 schema、解析 locator、格式化 handles，新增 `codegraph_trace`。
- `src/graph/traversal.ts` 或新文件 `src/graph/trace.ts`：实现候选路径搜索与排序。
- `src/mcp/server-instructions.ts`、`src/installer/instructions-template.ts`、`.cursor/rules/codegraph.mdc`：新增精确 handle 与 trace 工具使用说明。
- `__tests__/addressability.test.ts`、`__tests__/trace.test.ts`、必要时新增 `__tests__/mcp-addressability.test.ts`。

---

## 约定的首版 API 形状

### NodeLocator

在 `src/types.ts` 新增：

```ts
export interface NodeLocator {
  nodeId?: string;
  qualifiedName?: string;
  symbol?: string;
  path?: string;
  line?: number;
  fileLine?: string; // convenience: "src/a.ts:123"
  kind?: NodeKind;
}
```

解析优先级：

1. `nodeId`
2. `fileLine`
3. `path + line`
4. `qualifiedName`
5. `symbol + path`
6. `symbol`（保留旧行为）

### NodeHandle

```ts
export interface NodeHandle {
  nodeId: string;
  name: string;
  kind: NodeKind;
  qualifiedName: string;
  path: string;
  startLine: number;
  endLine: number;
  signature?: string;
}
```

### LocatorResolution

```ts
export type LocatorResolutionStatus = 'resolved' | 'ambiguous' | 'not_found';

export interface LocatorResolution {
  status: LocatorResolutionStatus;
  locator: NodeLocator;
  node?: Node;
  alternatives?: Node[];
  message?: string;
}
```

### MCP 输入兼容策略

为避免破坏现有调用，MCP 首版采用**平铺可选字段**，而不是强制嵌套 `locator` 对象：

- 既有字段：`symbol`
- 新增字段：`nodeId`、`qualifiedName`、`path`、`line`、`fileLine`

`codegraph_node` / `callers` / `callees` / `impact` 的 `required: ['symbol']` 改为运行时校验“至少提供一个 locator 字段”。旧的 `{ symbol: 'foo' }` 继续工作。

Trace 因为是新工具，可以使用前缀字段：

- `from` / `fromNodeId` / `fromQualifiedName` / `fromPath` / `fromLine` / `fromFileLine`
- `to` / `toNodeId` / `toQualifiedName` / `toPath` / `toLine` / `toFileLine`
- `scopePath`、`includePaths`、`excludePaths`、`maxDepth`、`maxPaths`、`edgeKinds`、`direction`

---

## TDD 总体节奏

每个任务遵循：

1. 写最小失败测试。
2. 运行聚焦测试，确认红灯。
3. 写最小实现。
4. 运行聚焦测试，确认绿灯。
5. 重构/收敛格式化。
6. 运行相关更宽测试。

推荐验证命令：

```bash
npx vitest run __tests__/addressability.test.ts
npx vitest run __tests__/trace.test.ts
npx vitest run __tests__/symbol-lookup.test.ts
npx vitest run __tests__/graph.test.ts
npm test
npm run build
```

---

## 任务 1：建立 Addressability 类型与 handle 格式化

**目标：** 引入可复用的 locator、handle 类型与紧凑格式化，不改变行为。

**测试先行：** 新建 `__tests__/addressability.test.ts`，先写纯函数测试：

- `toNodeHandle(node)` 输出 `nodeId`、`qualifiedName`、`path`、`startLine`、`endLine`、`signature`。
- `formatNodeHandle(node)` 包含可复制字段：`nodeId=...`、`qualifiedName=...`、`range=path:start-end`。
- `parseFileLine('src/a.ts:42')` 得到 `{ path: 'src/a.ts', line: 42 }`。
- `parseFileLine('src/a.ts:42:9')` 忽略列号或保存列号但 locator line 为 42。

**实现：**

- 在 `src/types.ts` 增加 `NodeLocator`、`NodeHandle`、`LocatorResolution`。
- 新建 `src/addressability/format.ts` 或在合适模块中实现：
  - `toNodeHandle(node: Node): NodeHandle`
  - `formatNodeHandle(node: Node): string`
  - `parseFileLine(input: string): { path: string; line: number } | null`

**验收：** 纯函数测试通过；无生产行为变化。

---

## 任务 2：实现精确 locator 解析 API

**目标：** `CodeGraph` 能解析 `nodeId`、`qualifiedName`、`path + line`、`file:line`、`symbol + path`、`symbol`。

**测试先行：** 在 `__tests__/addressability.test.ts` 构造临时 TypeScript 项目：

```ts
export class Service {
  run(): string {
    return helper();
  }
}
export function run(): string { return 'top'; }
function helper(): string { return 'ok'; }
```

测试用例：

- `resolveNodeLocator({ nodeId })` 精确返回该节点。
- `resolveNodeLocator({ qualifiedName })` 返回 exact qualified name 节点。
- `resolveNodeLocator({ path: 'src/service.ts', line: methodBodyLine })` 返回 innermost `Service.run`，不是 `Service` class 或 file node。
- `resolveNodeLocator({ fileLine: 'src/service.ts:<line>' })` 同上。
- `resolveNodeLocator({ symbol: 'run', path: 'src/service.ts' })` 在同名 method/function 中可按文件范围缩小，若仍多个则返回 `ambiguous`。
- `resolveNodeLocator({ symbol: 'run' })` 在多个 exact match 时返回 `ambiguous` 或 `resolved + alternatives`，按本计划库 API 返回 `ambiguous`，MCP 旧行为单独兼容。
- 行号不在任何 symbol 内时返回 `not_found`，并给 nearby alternatives。

**实现：**

- 在 `src/db/queries.ts` 增加：
  - `getNodesContainingLine(filePath: string, line: number): Node[]`
  - 可选：`getNearbyNodes(filePath: string, line: number, limit = 5): Node[]`
- 在 `src/index.ts` 增加：
  - `resolveNodeLocator(locator: NodeLocator): LocatorResolution`
  - `resolveNodeLocators(locator: NodeLocator): LocatorResolution`
- `path + line` 选择规则：
  - `startLine <= line <= endLine`
  - 优先最小范围：`endLine - startLine`
  - 过滤低价值节点：`import` / `export` 排在最后
  - 若范围相同，优先 `method` / `function` / `route` / `class` 等可执行或定义节点

**验收：** 聚焦测试通过；无需 schema migration。

---

## 任务 3：MCP 搜索与节点详情输出 handles

**目标：** 所有 search/node 结果可复制到下一次调用。

**测试先行：** 用 `ToolHandler.execute()` 写 MCP 层测试：

- `codegraph_search({ query: 'run' })` 每个结果包含：
  - `nodeId=`
  - `qualifiedName=`
  - `range=src/service.ts:<start>-<end>`
  - signature（如存在）
- `codegraph_node({ symbol: 'run' })` 的详情包含 `nodeId`、`qualifiedName`、完整 line range，不只 start line。
- `includeCode=false` 时仍有 range。

**实现：**

- 更新 `src/mcp/tools.ts`：
  - `formatSearchResults()` 使用 `formatNodeHandle()`。
  - `formatNodeDetails()` 增加 handle 与 `Range`。
  - `formatNodeList()` 与 `formatImpact()` 输出 path range，而不是只有 `path:startLine`。

**验收：** 新 MCP 测试通过；旧搜索、节点详情测试不回归。

---

## 任务 4：MCP node/callers/callees/impact 接受精确 locator

**目标：** 既有调用图工具可用 exact handle，避免同名聚合或猜测。

**测试先行：**

- `codegraph_node({ nodeId })` 返回目标节点，不走 `symbol` 搜索。
- `codegraph_node({ fileLine })` 返回 innermost symbol。
- `codegraph_callers({ nodeId })` 只查询该节点，不聚合同名节点。
- `codegraph_callees({ path, line })` 可工作。
- `codegraph_impact({ qualifiedName })` 可工作。
- 旧调用 `codegraph_node({ symbol: 'run' })` 仍可返回一个结果，但 ambiguity note 必须列出 alternatives 且每个 alternative 带 handle。
- 无 locator 字段时返回 MCP error。

**实现：**

- 更新 MCP schemas：新增 `nodeId`、`qualifiedName`、`path`、`line`、`fileLine`。
- 添加 `argsToLocator(args)`。
- 将 `handleNode()` 从 `findSymbol()` 切换为 `cg.resolveNodeLocator()`。
- 将 `handleCallers()` / `handleCallees()` / `handleImpact()` 改成：
  - 若 exact locator resolved：只查该节点。
  - 若 `symbol` only：保留旧 `findAllSymbols()` 聚合行为，但 ambiguity note 带 handles。
- 保留 `findSymbol()` / `findAllSymbols()` 作为 symbol-only compatibility path，或逐步改造成调用 locator API。

**验收：** 精确 locator 不聚合同名节点；旧 symbol-only 工具行为不破坏。

---

## 任务 5：Ambiguity 输出标准化

**目标：** 含糊时不只提示 `path:start`，而是给可复制 handles。

**测试先行：**

- 两个 `run` exact matches 时，`codegraph_node({ symbol: 'run' })` 的 note 包含：
  - `Ambiguous` 或 `symbols named "run"`
  - 每个候选的 `nodeId=`
  - 每个候选的 `range=`
- `codegraph_callers({ symbol: 'run' })` 聚合说明列出所有 root handles。
- `resolveNodeLocator({ symbol: 'run' })` 库 API 返回 `status: 'ambiguous'` 与 alternatives。

**实现：**

- 新增 `formatAmbiguity(alternatives: Node[], query: string)`。
- 更新 `findSymbol()` / `findAllSymbols()` note 生成逻辑。
- 确保输出不超过 `MAX_OUTPUT_LENGTH`，alternatives 默认 cap，例如 10 个，超过显示 `... and N more`。

**验收：** ambiguity 可被 agent 直接复制为 `nodeId` 或 `fileLine` follow-up。

---

## 任务 6：Trace 类型与图路径引擎

**目标：** 在库层实现候选路径搜索，不先接 MCP。

**测试先行：** 新建 `__tests__/trace.test.ts`，构造小型调用链：

```ts
export function entry() { service(); }
function service() { repository(); }
function repository() { target(); }
export function target() { return 'done'; }
```

测试用例：

- `cg.trace({ from: { symbol: 'entry' }, to: { symbol: 'target' }, maxDepth: 4 })` 返回至少一条 path。
- path steps 顺序为 `entry -> service -> repository -> target`。
- 每一步包含 `NodeHandle`。
- 每条边包含 `kind` 与 callsite `line`（如 extractor 提供）。
- `maxDepth: 1` 时没有完整 path，返回 gap / caveat / next suggestions。
- `from` 为 ambiguous symbol 时返回 ambiguity，不静默选择。
- `from` 使用 `fileLine` 时可 trace。
- `includePaths` / `excludePaths` 能过滤路径；默认可对 test files 降权但不硬过滤。

**实现：**

- 在 `src/types.ts` 增加：

```ts
export interface TraceOptions {
  maxDepth?: number;
  maxPaths?: number;
  edgeKinds?: EdgeKind[];
  direction?: 'outgoing' | 'incoming' | 'both';
  includePaths?: string[];
  excludePaths?: string[];
  scopePath?: string;
}

export interface TraceResult {
  from: NodeHandle;
  targetCandidates: NodeHandle[];
  paths: TracePath[];
  gaps: string[];
  recommendations: string[];
  completenessNote: string;
}
```

- 新建 `src/graph/trace.ts`，实现 `GraphTracer`：
  - 解析 target：exact locator 优先；否则用 `searchNodes(toQuery, { limit })` 取候选。
  - bounded BFS / best-first，从 from 开始按 direction 与 edgeKinds 走边。
  - 默认 edgeKinds：`['calls', 'references', 'imports']`；必要时允许调用方包含 `contains`。
  - 记录完整 path，不只 visited node；用 `(nodeId, depth)` 控制爆炸。
  - 命中 target candidate 或命中 target terms（name / qualifiedName / path / signature）即生成 candidate path。
  - 排序依据：路径短、direct calls 多、scope 内、target match 强、非测试文件、edge provenance。
- 在 `src/index.ts` 增加 `trace(from: NodeLocator, to?: NodeLocator | string, options?: TraceOptions): TraceResult`。

**验收：** 库层 trace 测试通过；没有 MCP 输出格式干扰。

---

## 任务 7：新增 `codegraph_trace` MCP 工具

**目标：** 暴露 trace 给 agent，输出 path-shaped 结果。

**测试先行：** 在 `__tests__/trace.test.ts` 或单独 MCP 测试中：

- `ToolHandler.execute('codegraph_trace', { from: 'entry', to: 'target', maxDepth: 4 })` 输出：
  - `## Trace`
  - `Path 1`
  - `entry`、`service`、`repository`、`target`
  - 每步 `nodeId=` 与 `range=`
  - 边 kind，例如 `calls`
  - `Recommended next` 区块
- `fromNodeId` 输入可工作。
- ambiguous `from` 输出 alternatives handles，不返回伪 trace。
- `scopePath` 限制目标候选。

**实现：**

- 在 `src/mcp/tools.ts` 的 `tools` 数组新增 `codegraph_trace`。
- `execute()` switch 增加 `handleTrace()`。
- `handleTrace()` 将 MCP 平铺字段转为 `NodeLocator` 与 target query/locator。
- 新增 `formatTraceResult(result)`：
  - path rank、confidence、reason
  - ordered steps
  - edge kind + callsite line
  - caveats/gaps
  - target candidates considered
  - recommended `codegraph_explore` query 或 exact `codegraph_node` handles
- 输出 hard cap 使用现有 `truncateOutput()`。

**验收：** MCP trace 输出可读、紧凑、可继续操作。

---

## 任务 8：更新 Agent 指南与工具说明

**目标：** 工具说明和安装写入的 agent 指南保持同步。

**测试先行：**

- 若现有 tests 对 installer 模板做快照/内容断言，先新增断言：模板包含 `codegraph_trace` 与 `nodeId/path:line` 精确 locator 指南。
- `mcp initialize` 返回的 server instructions 包含 trace 工具选择说明。

**实现：** 修改：

- `src/mcp/server-instructions.ts`
- `src/installer/instructions-template.ts`
- `.cursor/rules/codegraph.mdc`

新增指导要点：

- 搜索结果中的 `nodeId` / `range` 可直接传给 `codegraph_node`、`callers`、`callees`、`impact`、`trace`。
- 架构/lifecycle/end-to-end flow 问题优先：`codegraph_context` 找入口，`codegraph_trace` 连路径，`codegraph_explore` 或 Read 检查源码。
- `file:line` 来自编译错误/堆栈/Read 输出时，直接用于 `codegraph_node` 或 trace `fromFileLine`。

**验收：** 文档和 MCP 工具列表一致；安装器测试通过。

---

## 任务 9：补充 CLI/README/CHANGELOG（视发布要求）

**目标：** 用户可见语义变化被记录。

**测试先行：** 如果新增 CLI `codegraph trace`，先写 CLI 行为测试；否则不改 CLI。

**首版建议：** 暂不新增 CLI trace，先聚焦 MCP 与库 API。README 只补 MCP/API 示例。

**实现：**

- `README.md` 增加 Addressability 与 Trace 简短示例。
- `CHANGELOG.md` 新增版本条目（如果这是发布前变更）。

**验收：** 用户从 README 能看到 `nodeId` / `file:line` / `codegraph_trace` 的基础用法。

---

## 风险与缓解

### 1. Node ID 稳定性被误解

当前 `generateNodeId(filePath, kind, name, line)` 包含 line，因此移动代码会改变 ID。文档必须表述为：`nodeId` 是当前索引内的精确 opaque handle，不承诺跨重排永久稳定。

### 2. MCP schema 兼容性

旧工具目前要求 `symbol`。实施时要移除 schema required，但运行时校验至少一个 locator 字段。旧 `{ symbol }` 调用必须继续通过。

### 3. Trace 过度宣称正确性

Trace 输出必须写明是 static graph guidance，不是 runtime proof。动态 dispatch、provider registry、DI、callback gaps 要作为 caveat/gap 呈现。

### 4. 路径搜索爆炸

必须限制：`maxDepth`、`maxPaths`、visited cap、target candidate cap、输出 cap。默认不超过：`maxDepth=6`、`maxPaths=5`、target candidates 20、visited nodes 1000。

### 5. 输出膨胀

Handle 格式要紧凑。Search 每个结果只显示一行 handle，不输出 JSON 大块。Trace 不输出源码，只给 follow-up handles。

---

## 最小验收清单

Addressability：

- [ ] `codegraph_search` 每个结果显示 `nodeId`、`qualifiedName`、`range`。
- [ ] `codegraph_node` 接受 `nodeId`、`qualifiedName`、`path + line`、`fileLine`。
- [ ] `codegraph_callers` / `codegraph_callees` / `codegraph_impact` 接受同一 locator family。
- [ ] `file:line` 定位 innermost symbol。
- [ ] 同名 symbol ambiguity 输出 exact handles。
- [ ] 旧 symbol-only 调用仍可用。

Trace：

- [ ] `codegraph_trace` 可从入口到目标返回候选 path。
- [ ] path steps 都含 exact handles。
- [ ] edges 含 kind 与 callsite line（可用时）。
- [ ] 直接边、gap/caveat 区分清楚。
- [ ] scope/exclude filters 生效。
- [ ] 输出推荐下一步 `codegraph_explore` / `codegraph_node` / Read ranges。
- [ ] trace 不声称完整运行时证明。

---

## 推荐实施顺序

1. Addressability 纯类型与格式化。
2. `CodeGraph.resolveNodeLocator()` 库 API。
3. MCP search/node handle 输出。
4. MCP node/callers/callees/impact locator 输入。
5. Ambiguity 标准化。
6. Trace 库层路径引擎。
7. `codegraph_trace` MCP 工具。
8. Agent 指南/README/CHANGELOG。

这样可以先让所有既有工具受益，再用精确 locator 作为 trace 的可靠输入模型。
