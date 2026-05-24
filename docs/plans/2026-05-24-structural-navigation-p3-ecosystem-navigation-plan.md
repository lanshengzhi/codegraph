# CodeGraph 结构导航可用性增强 P3：Registry / Workspace Import / Coverage 生态导航 TDD 实施计划

> 关联设计：[`docs/codegraph-structural-navigation-usability-design.md`](../codegraph-structural-navigation-usability-design.md)  
> 拆解路线图：[`2026-05-21-structural-navigation-roadmap.md`](./2026-05-21-structural-navigation-roadmap.md)  
> 前置计划：[`2026-05-22-structural-navigation-p2b-field-sites-plan.md`](./2026-05-22-structural-navigation-p2b-field-sites-plan.md)  
> 状态：proposed / ready for TDD implementation (2026-05-24)  
> 范围：补强 monorepo workspace package import、registry/resolver 候选提示与索引覆盖说明；优先提供可审计候选与边界解释；不做完整 Node resolver、runtime branch 判定或全文件系统视图。

---

## 目标

P3 聚焦“项目生态边界”处的结构导航体验。P0/P0b/P1 已让 trace、edge evidence、ranking reason 更可信；P2a/P2b 已提供按需阅读导航和字段/key 线索。真实 monorepo 或 agent/server 代码中，剩余高频断点通常不在单个函数内部，而在这些边界上：

```text
workspace package import  -> package.json exports/main/types/index barrel -> source implementation
provider/tool/extension registry -> runtime key/model api/route path -> candidate handler
index coverage             -> indexed source view vs actual git/fs/source support boundary
```

P3 的目标是把这些边界从“trace 断了 / search 无结果 / agent 回到盲目 grep”变成可操作线索：

1. 给定 workspace package import specifier，列出对应 workspace package、entry/source candidate、exports/main/types 证据、re-export chain 与 next checks。
2. 给定 registry/resolver 相关 query/key/kind，列出 provider/tool/extension/route 候选注册项与 handler candidates。
3. 在 status/files/no-match 场景中更清楚说明 CodeGraph 的 indexed-only 边界、pending changes、extraction errors、unresolved refs、workspace/package 配置摘要。
4. 对 trace 的 registry/workspace import boundary 只追加精确 follow-up 建议，不把大候选列表默认塞进 trace 输出。
5. 所有输出都明确：这是静态候选/覆盖解释，不是 runtime 唯一路径证明，也不是完整 Node package resolver。

一句话边界：**P3 列候选、解释覆盖、给下一步；不证明 runtime 分支，也不替代 Node/TS/LSP resolver。**

---

## 交付策略：三个独立 PR

经风险评估后，P3 拆为三个独立 PR 交付，而非一个巨型 PR：

| PR | 范围 | 风险等级 | 核心交付 |
|---|---|---|---|
| **PR1 (P3a)** | Coverage / Status 增强（CP0→1→2） | L（零 graph 变更） | `getCoverageReport()` + `codegraph_status coverage` + CLI `--coverage` |
| **PR2 (P3b)** | Workspace Import + resolver 集成（CP0→3→4）+ MCP tool | M（resolver 改动） | `getWorkspaceImportCandidates()` + resolver hook + `codegraph_import_candidates` MCP |
| **PR3 (P3c)** | Registry + MCP 统一 + 文档收尾（CP0→5a→5b→6→7） | L-M（AST parser 性能） | `getRegistryCandidates()` + MCP tool + trace recs + agent docs |

### 拆分理由

- **PR1 零风险单独交付**：coverage 不碰 resolver/edges/DB schema，只读已有 stats/file records，最适合先铺路、建立 formatter 风格。
- **PR2 隔离 resolver 风险**：workspace resolver 集成是 P3 唯一会改 `resolveImportPath()` 行为的部分；如果产生 false edges，回滚 hook 不影响 PR1 和 PR3。
- **PR3 等前两个 API 稳定后再产品化**：registry AST analyzer 纯 query-time，但 MCP formatter 风格和 agent docs 需要等两个工具的 library API 都稳定后再统一处理。

> **补丁 vs 原建议**：PR2 比原拆分方案的 scope 略大——包含 `codegraph_import_candidates` 的 MCP handler + formatter，避免 PR2→PR3 窗口期代理无法通过 MCP 使用 import candidates。

### 分支策略

```text
PR1 → main（先合入）
PR2 和 PR3 可以提前从 main 分出分支并行开发
合入顺序固定：PR1 → PR2 → PR3
```

PR2 和 PR3 都改 `src/index.ts` + `src/mcp/tools.ts`，相邻行冲突好解但不值得并行合入 main。

继续沿用三个子能力标识：

```text
P3a  coverage/status explanation
P3b  workspace package import candidates
P3c  registry/resolver candidates
```

### 总体交付模式

- **先 query-time API，后 MCP formatter**：`CodeGraph.getCoverageReport()`、`getWorkspaceImportCandidates()`、`getRegistryCandidates()` 先独立可测；MCP handler 只做参数校验、调用 API、格式化。
- **不新增 DB schema**：P3 首版复用现有 `files`、`nodes`、`edges`、`unresolved_refs` 与 package/source 文件读取；不做 migration。
- **候选优先，唯一解析保守**：workspace import 可在高置信、唯一 source candidate 时接入 resolver；有歧义时只输出候选，不创建 misleading edge。
- **TS/JS registry 首版**：registry AST analyzer 首版只解析 TS/JS/TSX/JSX；其他语言使用已有 route nodes / graph facts 或明确降级。
- **coverage 不替代 filesystem**：status 可以可选扫描当前支持的 source files，但不承诺完整列出 docs、assets、ignored、unsupported 文件。
- **证据等级必须可审计**：每个 candidate 带 `evidence`、`confidence`、`range`、`indexed`、`caveat/note`，缺失时显示 `not-recorded` / `not-indexed` / `ambiguous`。
- **默认输出紧凑**：trace 不内联 registry/package 候选；只在 boundary/recommendations 中提示 `codegraph_registry_candidates` 或 `codegraph_import_candidates`。
- **agent-facing docs 同步**：新增 MCP 工具或改变 agent 使用方式时，同步更新 `src/mcp/server-instructions.ts`、`src/installer/instructions-template.ts`、`.cursor/rules/codegraph.mdc`、`__tests__/instructions.test.ts`、README / CHANGELOG。

### 数据流

```text
MCP tool / CLI status
  -> ToolHandler / CLI command
    -> CodeGraph API
      -> ecosystem analyzers
        -> QueryBuilder files/nodes/edges/unresolved_refs
        -> package.json / tsconfig / source files (bounded reads)
        -> optional TS/JS tree-sitter parser
      -> typed result with caveats + recommendations
    -> markdown / JSON formatter
```

### Stop conditions

遇到以下情况必须降级或停止扩展，不允许输出强结论：

- package export conditions 无法唯一选择 source entry：列多个 candidates，标注 `ambiguous-exports`，resolver 不创建 edge。
- package entry 指向 `dist/` 且没有 indexed source counterpart：输出 `not-indexed` 或 `dist-to-src-heuristic`，不声称源码已解析。
- registry key 是动态表达式、computed property、spread 或 callback 组装：输出 boundary / partial candidate，不声称完整 registry。
- registry handler 无法解析到 indexed node：保留 handler text 与 source range，推荐 `codegraph_search` / `codegraph_node` / `read`。
- coverage 需要完整 filesystem truth：只说明 CodeGraph indexed/source-scan 边界，建议 `find` / `git status` / `read`。
- query-time scan 超过安全阈值：返回 `partial`、skipped summary 与缩小 `scopePath` 建议。
- 默认 trace/context/search 输出明显膨胀：回退内联候选，只保留 follow-up recommendation。

---

## 产品决策

### 新增 / 增强工具形态

P3 不把所有能力塞入 `codegraph_trace`，而是新增两个按需候选工具，并增强 status：

```ts
codegraph_import_candidates({ specifier: "@scope/pkg", symbol?: "streamSimple", fromPath?: "src/a.ts" })
codegraph_registry_candidates({ query?: "provider", key?: "anthropic", kind?: "provider" })
codegraph_status({ detail: "coverage", checkFilesystem?: boolean })
```

原因：

- workspace import 与 registry 是横切查询，不属于单个 node detail。
- trace 默认应保持路径候选和边证据，不应承载大型 registry/package 列表。
- status/coverage 是索引健康与边界解释，适合增强现有 `codegraph_status` 而不是新增 `codegraph_coverage`。
- 独立工具便于 agent 在 boundary 处精准 follow-up。

### P3a：coverage/status explanation

增强 `codegraph_status`：

```ts
codegraph_status({ detail?: "summary" | "coverage", checkFilesystem?: boolean, limit?: number })
```

默认 `detail: "summary"` 保持当前简洁输出；`detail: "coverage"` 增加：

- indexed-only caveat；
- indexed files / nodes / edges / languages；
- top indexed roots；
- pending changes from `CodeGraph.getChangedFiles()`；
- extraction errors count + capped samples from `FileRecord.errors`；
- unresolved refs count + top names/kinds/evidence samples；
- workspace package summary from root `package.json` workspaces；
- tsconfig/jsconfig path alias summary；
- optional `checkFilesystem` source scan：当前可索引 source files count、missing-from-index samples、indexed-but-missing samples。

`checkFilesystem` 默认 `false`，因为它可能扫描大 repo；CLI 可通过 `codegraph status --coverage --check-filesystem` 显式启用。
- `checkFilesystem: true` 时加入硬 timeout（默认 5000ms），超时返回 `filesystem-scan-skipped` 并建议缩小 scope。

### P3b：workspace package import candidates

新增 MCP 工具：

```ts
codegraph_import_candidates({
  specifier: string;          // required, exact import specifier: "@scope/pkg" or "@scope/pkg/subpath"
  symbol?: string;            // optional imported symbol to chase through entry/re-export candidates
  fromPath?: string;          // optional source file path for display/future resolver context
  limit?: number;             // default 20, clamp 1..100
  includeUnindexed?: boolean; // default false; when true, show package entries that exist on disk but are not indexed
  projectPath?: string;
})
```

Library API：

```ts
await cg.getWorkspaceImportCandidates(specifier, options)
```

首版支持：

- npm/yarn/pnpm workspace：
  - `package.json` `workspaces`：string array 或 `{ packages: string[] }`；支持 `!negated` patterns；使用已有 `picomatch` 进行 glob matching。
  - `pnpm-workspace.yaml`：解析 `packages:` 列表；如果解析失败，降级返回 `no-workspaces` 并提示检查 workspace 配置。
- workspace package `package.json`：`name`、`exports`、`main`、`module`、`types`、`typings`。
- bare/scoped specifier：`pkg`、`pkg/subpath`、`@scope/pkg`、`@scope/pkg/subpath`。
- entry candidates：
  - exact `exports["."]` / `exports["./subpath"]` string；
  - exports condition object 中的 `source`、`types`、`import`、`module`、`require`、`default`；
  - `main` / `module` / `types` / `typings`；
  - conventional `src/index.ts(x)`、`index.ts(x)`、`src/<subpath>.ts(x)`；
  - conservative `dist/* -> src/*` counterpart heuristic，必须标为低置信。
- indexed/source 状态：`exists`、`indexed`、`language`、`nodeCount`。
- `symbol` follow-up：在 candidate file 或 re-export chain 中寻找 exported symbol，返回 node handle 或 ambiguous alternatives。
- re-export chain：复用 `extractReExports()` 和 `resolveImportPath()` 的相对 import 解析能力，深度沿用 `REEXPORT_MAX_DEPTH` 等级的 cycle-safe 策略。

保守 resolver integration：

- 在 query-time candidates 稳定后，允许把同一 workspace package resolver 接入 `resolveImportPath()`。
- 只有当 workspace specifier 对应**唯一 high-confidence indexed source candidate**时，`resolveImportPath()` 才返回该 path。
- 多 candidate、仅低置信、未索引、exports 条件冲突时返回 `null`，保留 unresolved ref；MCP 工具负责列候选。
- 该集成需独立测试，确保 npm external packages 不被误判为 workspace source。

### P3c：registry/resolver candidates

新增 MCP 工具：

```ts
codegraph_registry_candidates({
  query?: string;             // registry name / handler text / file term / broad query
  key?: string;               // exact runtime key, e.g. "anthropic", "toolName", "/api/chat"
  kind?: "provider" | "tool" | "extension" | "route" | "handler" | "all";
  scopePath?: string;
  limit?: number;             // default 50, clamp 1..200
  includeTests?: boolean;     // default true; tests/fixtures lower-ranked and labeled
  projectPath?: string;
})
```

Formatter 展示上限独立于 API `limit`：`maxDisplayCandidates = 20`，剩余用 `omittedCandidates` 计数。

Library API：

```ts
await cg.getRegistryCandidates(options)
```

首版候选来源：

1. **Indexed route nodes**：直接读取 `NodeKind === "route"`，结合 route node 的 references/calls edge 给 handler candidates。
2. **Object registry**：
   ```ts
   const providers = { anthropic: streamAnthropic, openai: streamOpenAIResponses }
   ```
3. **Map constructor registry**：
   ```ts
   const providers = new Map([["anthropic", streamAnthropic]])
   ```
4. **Map/set registration**：
   ```ts
   providers.set("anthropic", streamAnthropic)
   ```
5. **Register-like call**：
   ```ts
   registry.register("tool", toolHandler)
   registerProvider("anthropic", streamAnthropic)
   app.get("/api/chat", chatHandler)
   ```
6. **Definition array**：
   ```ts
   [{ name: "foo", handler: fooHandler }, { id: "bar", execute: runBar }]
   ```
   仅当 key field (`name`/`id`/`key`/`api`/`path`) 与 handler field (`handler`/`execute`/`run`/`stream`/`component`) 同在一个 object literal 时输出。

每个 registry candidate 必须包含：

- `kind` / `registryName` / `keyText` / `handlerText`；
- `evidence`：`route-node`、`object-literal`、`map-constructor`、`map-set`、`register-call`、`definition-array`；
- `confidence`：high / medium / low 或 0..1；
- exact `range` 与 enclosing node handle；
- handler node handle（可解析时）或 ambiguous handler alternatives；
- caveat：runtime key/config 选择分支，CodeGraph 只列静态 candidates。

匹配与排序：

- `key` exact match 权重最高；
- `kind` 通过 registry variable/callee/file path 名称启发式：provider/tool/extension/route/handler；
- route nodes 优先于 regex 推断；
- 同一 registry group 内按 key 字母序或 source order；
- tests/fixtures/examples/generated 降权并标注；
- handler 已解析到 node 的 candidate 高于仅有 handler text 的 candidate；
- dynamic/computed key candidate 保留为 boundary，不与 exact key candidate 混为一类。

---

## 非目标

P3 明确不做：

- 完整 Node package resolver 兼容，包括所有 conditional exports、self-references、imports field、symlink package manager layout、npm overrides；
- TypeScript compiler API / LSP / moduleResolution 完整模拟；
- runtime branch 唯一判定；
- registry lookup 的完整 dataflow / alias analysis / dependency injection 闭合；
- 自动证明 `model.api`、route path、extension name 在运行时取哪个值；
- 全语言 registry AST 支持；
- 完整文件系统视图或未索引 docs/assets 搜索；
- DB schema migration 或持久化 package/registry index；
- 默认 trace 输出大型候选列表。

P3 可以说：

```text
@earendil-works/pi-ai likely maps to packages/ai/src/index.ts via package.json exports.
model.api has static registry candidates anthropic/openai/google; runtime value selects one branch.
codegraph_status coverage is indexed source coverage, not a complete filesystem inventory.
```

P3 不可以说：

```text
This is the exact Node resolver result for every environment condition.
Anthropic is definitely the runtime provider branch.
No file exists because codegraph_files did not list it.
```

---

## Recon 结果：实施前代码切片

### 已有基础

- `src/index.ts`
  - 已有 `CodeGraph.getFiles()`、`getFile()`、`getNodesInFile()`、`getNodesByKind()`、`getChangedFiles()`、`getStats()`、`getJournalMode()`。
  - P2a/P2b 已建立 query-time analyzer API 模式：`getNodeStructure()`、`getFieldSites()`。
- `src/mcp/tools.ts`
  - 已有 `codegraph_status`、`codegraph_files`、`codegraph_field_sites` MCP schema/handler/formatter 模式。
  - `formatFieldSites()` 已有 caveat、skipped summary、section cap、recommendations 风格可复用。
- `src/resolution/import-resolver.ts`
  - 已有 `resolveImportPath()`、`extractImportMappings()`、`extractReExports()`、`resolveViaImport()`。
  - 当前 bare/scoped package 默认视为 external；workspace package import 不能通过 package.json workspaces 解析。
  - 已支持 local re-export chain 追踪。
- `src/resolution/path-aliases.ts`
  - 已读 tsconfig/jsconfig `compilerOptions.paths`，但 `stripJsonc()` 当前是 private helper。
- `src/resolution/types.ts`
  - `ResolutionContext` 已支持 `getProjectAliases()`、`getReExports()`、`listDirectories()` 可选能力；可加 optional workspace package candidate provider 保持兼容。
- `src/extraction/index.ts`
  - `scanDirectory()` / `scanDirectoryAsync()`、`isSourceFile()`、git-visible source scan 与 ignore 逻辑已存在。
  - `getChangedFiles()` 已可用于 pending source changes。
- `src/db/queries.ts`
  - 已有 `getUnresolvedReferences()`、`getUnresolvedReferencesCount()`、`getAllFiles()`、`getAllFilePaths()`、`getStats()`。
- `package.json`
  - 已有 `picomatch` 与 `jsonc-parser` 依赖；P3 不需要新增依赖。

### 关键缺口

- 没有 workspace package manifest model，也没有 package.json workspaces / exports / main/types 候选解释。
- `resolveImportPath()` 不能把 bare workspace package specifier 映射到 indexed source。
- 没有 registry/resolver pattern candidate analyzer。
- `codegraph_status` 只展示基础统计，缺少 coverage boundary、pending/missing/source errors/unresolved/workspace 摘要。
- trace boundary follow-up 不会建议 registry/import candidate 工具。

---

## 建议类型设计

在 `src/types.ts` 增加 additive exported types；不修改既有类型语义。

### Coverage types

```ts
export type CoverageDetail = 'summary' | 'coverage';
export type CoverageStatus = 'available' | 'partial' | 'no-index' | 'filesystem-scan-skipped';

export interface CoverageReportOptions {
  detail?: CoverageDetail;
  checkFilesystem?: boolean;
  limit?: number;
  /** Hard timeout for filesystem scan in ms to avoid blocking on large repos. */
  filesystemScanTimeoutMs?: number;
}

export interface CoverageReport {
  status: CoverageStatus;
  indexedOnly: true;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  filesByLanguage: Record<Language, number>;
  topIndexedRoots: Array<{ path: string; files: number }>;
  pendingChanges: { added: number; modified: number; removed: number; samples: string[] };
  extractionErrors: { count: number; samples: Array<{ path: string; errors: string[] }> };
  unresolvedRefs: { count: number; byKind: Record<string, number>; topNames: Array<{ name: string; count: number }> };
  workspaceSummary?: WorkspaceSummary;
  aliasSummary?: { source: 'tsconfig' | 'jsconfig'; patternCount: number; patterns: string[] };
  filesystemCheck?: {
    enabled: boolean;
    supportedSourceFiles?: number;
    missingFromIndex: { count: number; samples: string[] };
    indexedButMissing: { count: number; samples: string[] };
  };
  caveats: string[];
  recommendations: string[];
}
```

### Workspace import types

```ts
export type WorkspaceImportStatus = 'available' | 'no-workspaces' | 'package-not-found' | 'no-candidates' | 'partial' | 'invalid-specifier';

export interface UnresolvedReferencesSummary {
  count: number;
  byKind: Record<string, number>;
  topNames: Array<{ name: string; kind: string; count: number; samplePath: string }>;
}

export type WorkspaceImportEvidence =
  | 'exports-exact'
  | 'exports-condition'
  | 'main-field'
  | 'module-field'
  | 'types-field'
  | 'src-index-convention'
  | 'subpath-convention'
  | 'dist-to-src-heuristic'
  | 're-export-chain';

export interface WorkspacePackageInfo {
  name: string;
  packageDir: string;
  packageJsonPath: string;
  workspacePattern: string;
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
}

export interface WorkspaceImportCandidate {
  packageName: string;
  subpath: string | null;
  packageDir: string;
  sourcePath: string;
  exists: boolean;
  indexed: boolean;
  language?: Language;
  nodeCount?: number;
  evidence: WorkspaceImportEvidence;
  confidence: number;
  conditionPath?: string[];
  exportField?: string;
  symbol?: string;
  symbolNode?: NodeHandle;
  symbolAlternatives?: NodeHandle[];
  reExportChain?: Array<{ from: string; to: string; exportedName?: string; originalName?: string }>;
  note?: string;
}

export interface WorkspaceImportCandidatesResult {
  status: WorkspaceImportStatus;
  specifier: string;
  symbol?: string;
  package?: WorkspacePackageInfo;
  candidates: WorkspaceImportCandidate[];
  totalCandidates: number;
  omittedCandidates: number;
  caveats: string[];
  recommendations: string[];
}
```

### Registry candidate types

```ts
export type RegistryCandidateStatus = 'available' | 'no-matches' | 'partial' | 'invalid-query' | 'parser-unavailable';
export type RegistryKind = 'provider' | 'tool' | 'extension' | 'route' | 'handler' | 'all';
export type RegistryEvidence = 'route-node' | 'object-literal' | 'map-constructor' | 'map-set' | 'register-call' | 'definition-array';
export type RegistryConfidence = 'high' | 'medium' | 'low';

export interface RegistryCandidate {
  kind: RegistryKind;
  registryName?: string;
  keyText?: string;
  handlerText?: string;
  evidence: RegistryEvidence;
  confidence: RegistryConfidence;
  range: SourceRange;
  enclosingNode?: NodeHandle;
  handlerNode?: NodeHandle;
  handlerAlternatives?: NodeHandle[];
  handlerResolutionStatus?: 'resolved' | 'unsupported-language' | 'not-indexed' | 'ambiguous';
  routePath?: string;
  isDynamicKey?: boolean;
  isTestOrFixture?: boolean;
  note?: string;
}

export interface RegistryCandidatesResult {
  status: RegistryCandidateStatus;
  query?: string;
  key?: string;
  kind: RegistryKind;
  candidates: RegistryCandidate[];
  totalCandidates: number;
  omittedCandidates: number;
  searchedFiles: number;
  parsedFiles: number;
  skippedSummary: Record<string, number>;
  caveats: string[];
  recommendations: string[];
}
```

---

## 模块设计

### `src/ecosystem/package-workspace.ts`

职责：读取 root/workspace package manifests，解析 workspace package import specifier，生成 source candidates。

关键函数：

```ts
export function loadWorkspaceSummary(projectRoot: string, options?: WorkspaceLoadOptions): WorkspaceSummary;
export function parseWorkspaceSpecifier(specifier: string): { packageName: string; subpath: string | null } | null;
export function getWorkspaceImportCandidates(
  projectRoot: string,
  files: FileRecord[],
  loadNodesForFile: (path: string) => Node[],
  specifier: string,
  options?: WorkspaceImportOptions
): WorkspaceImportCandidatesResult;
```

实现要点：

- 读取 root `package.json`，支持：
  ```json
  { "workspaces": ["packages/*"] }
  { "workspaces": { "packages": ["packages/*"] } }
  ```
- 使用 `picomatch` 匹配 package directory；忽略 `node_modules`、`.git`、`.codegraph`、`dist`、`build`。
- workspace package 必须有 `package.json` 且 `name` 为字符串。
- package cache 使用 CodeGraph instance 生命周期内的 lazy cache；`sync` / `indexAll` 后清理。
- exports object 解析顺序固定：`source`、`types`、`import`、`module`、`require`、`default`；输出 condition path，不宣称与 runtime condition 一致。
- `dist-to-src-heuristic` 必须低置信，且只有 counterpart source path 存在或 indexed 时才输出。
- `symbol` chase 只沿 relative re-export chain；不追 external package；cycle-safe；超过深度 cap 输出 caveat。

### `src/ecosystem/coverage.ts`

职责：生成 index coverage/status explanation 的 typed result。

关键函数：

```ts
export function buildCoverageReport(
  projectRoot: string,
  stats: GraphStats,
  files: FileRecord[],
  queries: QueryBuilder,
  getChangedFiles: () => { added: string[]; modified: string[]; removed: string[] },
  options?: CoverageReportOptions
): CoverageReport;
```

实现要点：

- 默认不做 filesystem scan；只读 DB records、pending changes、package/alias summaries。
- `checkFilesystem: true` 时复用 `scanDirectory(projectRoot)`，只比较支持 source files，不统计 docs/assets。
- `unresolvedRefs` summary 需要新增 bounded query helper，避免加载超大 unresolved_refs 全表；如果先复用 `getUnresolvedReferences()`，必须加 result cap 与测试确认不会进入 MCP 默认 summary。
- top roots 使用 path 前 1-2 段聚合，避免输出过长。
- status formatter 必须包含 `indexed source view` caveat。

### `src/ecosystem/registry-candidates.ts`

职责：按需扫描 TS/JS indexed files，提取 registry/resolver pattern candidates。

关键类：

```ts
export class RegistryCandidatesAnalyzer {
  constructor(private readonly projectRoot: string, private readonly parserHost = defaultParserHost) {}

  async analyze(
    files: FileRecord[],
    loadNodesForFile: (path: string) => Node[],
    loadEdgesForNode: (nodeId: string) => Edge[],
    options: RegistryCandidatesOptions
  ): Promise<RegistryCandidatesResult>;
}
```

实现要点：

- 复用 P2b 的 source read / stale hash / size guard / parser unavailable / parse-error 降级模式。
- AST traversal top-down，父节点负责 dedupe，避免 object literal candidate 与 child identifier 重复输出。
- route nodes 从 DB 直接收集，不经过 AST parser。
- handler handle resolution 首版只做：
  - same-file node name exact；
  - imported local name exact 后尝试 workspace/local import resolution；
  - fallback 为 handler text + `codegraph_search` recommendation。
- dynamic key/computed key 输出 `isDynamicKey: true` 与 low confidence，不参与 exact `key` match 的 high-confidence 结果。
- `limit` 只影响输出；内部统计保留 total/omitted。

### `src/resolution/import-resolver.ts` 集成点

新增可选 workspace package 解析，不破坏外部 context：

```ts
export interface ResolutionContext {
  getWorkspaceImportCandidates?(
    specifier: string,
    options?: { fromFile?: string; symbol?: string; highConfidenceOnly?: boolean }
  ): WorkspaceImportCandidate[];
}
```

`isExternalImport()` 调整：

- relative import 仍非 external；
- tsconfig alias 仍优先；
- 若 `getWorkspaceImportCandidates(importPath, { highConfidenceOnly: true })` 返回唯一 indexed candidate，则该 bare specifier 视为 local；
- 否则 scoped/bare package 仍视为 external。

`resolveAliasedImport()` 或新增 `resolveWorkspaceImport()`：

- 在 hard-coded fallback alias 之前或之后均可，但必须在 external skip 之后仍能触发；建议在 `resolveImportPath()` 的 external 判断前单独检查 workspace candidate。
- 只返回唯一 high-confidence candidate 的 `sourcePath`。
- 不从 resolver 中输出候选列表；候选列表由 MCP tool 提供。

---

## TDD 任务拆解

P3 拆为三个 PR 实施，Checkpoint 按 PR 归属分组。

```text
PR1：CP0(coverage fixtures) → CP1 → CP2
PR2：CP0(workspace fixtures) → CP3 → CP4 + CP6(import_candidates MCP)
PR3：CP0(registry fixtures) → CP5a → 5b + CP6(registry_candidates MCP) + CP7
```

---

### PR1：Coverage / Status 增强（CP0 subset → CP1 → CP2）

#### Checkpoint 0 (PR1 子集)：Coverage fixture matrix

**目标：** 先为 coverage 建立测试 fixture，不涉及 workspace/registry。

**新增测试文件：**

- `__tests__/coverage-status.test.ts`
- `__tests__/mcp-ecosystem.test.ts`

**Fixture 覆盖（PR1）：**

- coverage：pending changes、missing-from-index、extraction errors、unresolved refs samples。

> PR2、PR3 各自在对应 CP0 追加 workspace/registry fixture，不重复。

**验证命令：**

```bash
npx vitest run __tests__/coverage-status.test.ts
```

---

### Checkpoint 1：CoverageReport library API

**目标：** 先实现低风险 coverage/status typed result。

**测试先行：** `__tests__/coverage-status.test.ts`

- `getCoverageReport({ detail: 'coverage' })` 返回 indexed-only caveat。
- 返回 languages、top indexed roots、pending changes summary。
- FileRecord errors 被聚合为 extraction error samples。
- unresolved refs count/top names/kinds 可展示且有 cap。
- `checkFilesystem: true` 只比较 supported source files，并返回 missing-from-index samples。
- 不扫描/声明 unsupported docs/assets 的完整覆盖。

**实现：**

- 新增 `src/ecosystem/coverage.ts`。
- `src/index.ts` 增加 `getCoverageReport(options?: CoverageReportOptions)`。
- `src/db/queries.ts` 增加 bounded unresolved summary helper，例如：
  - `getUnresolvedReferencesSummary(limit: number)`；
  - 或 `getUnresolvedReferences({ limit })` 风格 additive method。
- 保持 `getStats()` 现有行为不变。

**验收：**

```bash
npx vitest run __tests__/coverage-status.test.ts
```

---

### Checkpoint 2：`codegraph_status({ detail: "coverage" })` + CLI coverage 输出

**目标：** 把 CoverageReport 暴露给 MCP，并给 CLI status 一个显式 coverage 模式。

**测试先行：** `__tests__/mcp-ecosystem.test.ts`

- MCP schema 包含 `detail`、`checkFilesystem`、`limit`。
- `codegraph_status({ detail: 'coverage' })` 输出：
  - `indexed source view` / `indexed-only` caveat；
  - pending changes；
  - extraction errors；
  - unresolved refs；
  - workspace package summary（存在时）；
  - recommendations。
- `detail` 非法时报错。
- 默认 `codegraph_status({})` 仍保持 summary 输出，不包含大型 coverage sections。

**CLI 测试：** 可在现有 CLI 测试或新增 focused test 中覆盖 JSON contract。

**实现：**

- `src/mcp/tools.ts`：扩展 tool schema 与 `handleStatus()`。
- `src/bin/codegraph.ts`：`status` 增加：
  - `--coverage`；
  - `--check-filesystem`；
  - JSON 输出加入 coverage object（仅 `--coverage` 时）。
- CLI 子命令 `codegraph import-candidates` 和 `codegraph registry-candidates` 分别在 PR2/PR3 的对应 CP6 中添加；PR1 只新增 `codegraph status --coverage`。
- Formatter 使用 capped samples，避免大 repo 输出膨胀。

**验收：**

```bash
npx vitest run __tests__/mcp-ecosystem.test.ts __tests__/coverage-status.test.ts
```

---

### PR2：Workspace Import + resolver 集成 + MCP tool（CP0 subset → CP3 → CP4 → CP6 subset）

> **CP6 说明**：PR2 只交付 `codegraph_import_candidates` 的 MCP handler + formatter。细节见下方 Checkpoint 6 的 split table（CP6 文字位于 PR3 节内，对两个 PR 的交付做了统一描述）。

#### Checkpoint 0 (PR2 子集)：Workspace fixture matrix

在 PR1 已有 `__tests__/coverage-status.test.ts` 基础上，新增以下测试文件与 fixture。

**新增测试文件：**

- `__tests__/workspace-import-candidates.test.ts`

**Fixture 覆盖（PR2）：**

- npm/yarn `package.json workspaces` string array 与 `{ packages: [] }`；pnpm `pnpm-workspace.yaml`。
- scoped package `@scope/pkg` 与 subpath `@scope/pkg/stream`。
- exports string、exports condition object、main/module/types、dist-to-src counterpart。
- barrel re-export：`src/index.ts -> src/stream.ts`。

**验证命令：**

```bash
npx vitest run __tests__/workspace-import-candidates.test.ts
```

---

### Checkpoint 3：Workspace package loader 与 import candidate API

**目标：** 新增 query-time workspace import source candidates，不先改 resolver。

**测试先行：** `__tests__/workspace-import-candidates.test.ts`

- root `workspaces: ['packages/*']` 能发现 package `@scope/ai`。
- `specifier='@scope/ai'` 返回 package dir 与 `src/index.ts` candidate。
- `exports: { '.': './src/index.ts' }` 输出 `evidence=exports-exact` 且 indexed。
- condition object 输出 condition path，例如 `exports['.'].import`。
- `main: 'dist/index.js'` + `src/index.ts` 输出 low-confidence `dist-to-src-heuristic`。
- `specifier='@scope/ai/stream'` 能解析 subpath candidate。
- `symbol='streamSimple'` 能在 direct export 或 re-export chain 中返回 node handle。
- package 未找到时返回 `package-not-found`，并推荐检查 workspaces/package.json。
- external npm package 不返回 workspace candidate。

**实现：**

- 新增 `src/ecosystem/package-workspace.ts`。
- `src/index.ts` 增加 `getWorkspaceImportCandidates(specifier, options)`。
- 复用 `FileRecord` 判断 indexed/source status。
- 复用 `extractReExports()` 追 barrel，必要时把 private helper 抽到可复用 utility。
- tsconfig/jsconfig path aliases 优先于 workspace package 解析：当 workspace package name 恰好也是 alias pattern 时，保持现有 alias 规则以保证不回归。
- 给 CodeGraph instance 增加 workspace summary lazy cache，并在 `indexAll()` / `sync()` 后清理。

**验收：**

```bash
npx vitest run __tests__/workspace-import-candidates.test.ts
```

---

### Checkpoint 4：保守 workspace import resolver integration

**目标：** 让高置信唯一 workspace package import 能进入现有 graph resolution，同时保留候选工具处理歧义。

**测试先行：** 更新 `__tests__/resolution.test.ts` 或新增 dedicated cases。

- monorepo package import：
  ```ts
  import { streamSimple } from '@scope/ai';
  streamSimple();
  ```
  能通过 workspace package entry/re-export 解析到 `packages/ai/src/stream.ts::streamSimple`。
- ambiguous exports / multiple candidates 时不创建 edge，unresolved ref 保留。
- external package `react` / `fs` / `@types/foo` 不被误判为 workspace source。
- tsconfig path aliases 仍优先工作，现有 alias tests 不回归。
- scoped workspace subpath 能解析到 indexed source candidate。

**实现：**

- `src/resolution/types.ts`：为 `ResolutionContext` 增加 optional workspace candidate provider。
- `src/resolution/index.ts`：context 提供 high-confidence candidate lookup，复用 package-workspace cache。
- `src/resolution/import-resolver.ts`：在 external 判断前检查 high-confidence workspace candidate；唯一才返回 source path。
- Edge metadata 不新增 schema；resolvedBy 仍可为 `import`，metadata 可额外带 `workspacePackage` / `workspaceEvidence`，但必须 additive。

**验收：**

```bash
npx vitest run __tests__/resolution.test.ts __tests__/workspace-import-candidates.test.ts
```

---

### PR3：Registry 候选 + MCP 统一 + 文档收尾（CP0 subset → CP5a → 5b → CP6 rest → CP7）

> **前置依赖**：PR1 + PR2 已合入。CP5a/5b 可以基于 PR2 的 main 独立开发，但 CP6/7 需要等两个 API 稳定。

#### Checkpoint 0 (PR3 子集)：Registry fixture matrix

在 PR1+PR2 fixture 基础上，新增以下测试文件与 fixture。

**新增测试文件：**

- `__tests__/registry-candidates.test.ts`

**Fixture 覆盖（PR3）：**

- object registry、Map constructor、Map.set、register call、definition array、route node。
- dynamic registry key、computed key、spread object 降级。

**验证命令：**

```bash
npx vitest run __tests__/registry-candidates.test.ts
```

---

### Checkpoint 5a：RegistryCandidates core patterns（route nodes + object literal + Map constructor）

**目标：** 先实现最低风险的 registry candidate 来源：DB route nodes + 最明确的静态 AST 形态。

**测试先行：** `__tests__/registry-candidates.test.ts`

- object literal provider registry：列出 `anthropic -> streamAnthropic`，handler node 可解析。
- Map constructor：列出 string key 与 handler。
- route nodes（DB 直接读）：列出 route path 与 handler candidates；标注 `handlerResolutionStatus`。
- dynamic key / computed property：输出 low-confidence/dynamic boundary，不当作 exact key match。
- `kind='provider'`、`key='anthropic'`、`scopePath='src/providers'` 过滤正确。
- tests/fixtures 降权并标注；`includeTests:false` 排除。
- unsupported language / source-too-large / source-stale 返回 skipped summary，不抛异常。

**实现：**

- 新增 `src/ecosystem/registry-candidates.ts`。
- 复用 `loadGrammarsForLanguages()`、`getParser()`、`getChildByField()`、`getNodeText()`。
- 从 `getNodesByKind('route')` 收集 route nodes；从 outgoing edges 找 handler candidates。
- AST parser 只处理 TS/JS/TSX/JSX indexed files。
- `src/index.ts` 增加 `getRegistryCandidates(options)`。

**验收：**

```bash
npx vitest run __tests__/registry-candidates.test.ts
```

---

### Checkpoint 5b：RegistryCandidates advanced patterns（`.set()` / register-call / definition array / dynamic key）

**目标：** 在 MCP tool 形态已暴露后，补充跨 statement 追踪与复杂模式。

**测试先行：** `__tests__/registry-candidates.test.ts`

- `.set()` registration：列出 registry name、key、handler。
- `registerProvider('anthropic', streamAnthropic)`：列出 register-call candidate。
- definition array：`[{ name: 'foo', handler: fooHandler }]` 被识别。
- nested literals、spread、computed properties 的降级/边界处理。
- `maxDisplayCandidates = 20` formatter cap 生效；剩余用 `omittedCandidates` 计数。

**实现：**

- 在 `src/ecosystem/registry-candidates.ts` 中新增 advanced pattern matchers。
- top-down traversal 中由父节点 dedupe，避免与 CP5a 的 object-literal 重复输出。
- formatter 展示上限与 API `limit` 解耦。

**验收：**

```bash
npx vitest run __tests__/registry-candidates.test.ts
```

---

### Checkpoint 6：MCP tools 与 formatter（分 PR 交付）

**目标：** 暴露 `codegraph_import_candidates` 与 `codegraph_registry_candidates`。

由于 P3 拆为三个 PR，CP6 分两部分交付：

| 部分 | PR | 交付内容 |
|---|---|---|
| CP6 subset | **PR2** | `codegraph_import_candidates` MCP handler + formatter |
| CP6 rest | **PR3** | `codegraph_registry_candidates` MCP handler + formatter + 两个工具的风格统一 review |

两部分共享相同的测试文件 `__tests__/mcp-ecosystem.test.ts`，PR2 先加入 import_candidates 的测试用例，PR3 补充 registry_candidates 的用例。

**测试先行：** `__tests__/mcp-ecosystem.test.ts`

- tool list 包含当前 PR 交付的新工具及参数 schema。
- invalid `specifier`、`key` newline、absolute/escaping `scopePath`、非法 `kind`、非法 `limit` 都返回清楚 error。
- import candidates formatter 输出：
  - caveat：candidate hints, not full Node resolver；
  - package/package.json path；
  - evidence/confidence/indexed/source range；
  - symbol node handle / alternatives；
  - re-export chain；
  - next checks。
- registry candidates formatter 输出（PR3）：
  - caveat：runtime key selects branch；
  - group by registry/file/kind；
  - exact ranges and handler handles；
  - dynamic boundary notes；
  - omitted count。
- Formatter 不输出完整 source code。

**实现：**

- `src/mcp/tools.ts`：按 PR 逐步新增 tool definitions、handlers、formatters、validation helpers。
- `ToolHandler.execute()` switch 按 PR 增加新 tool cases。
- 对 cross-project `projectPath` 复用现有 `getCodeGraph()`。

**PR2 验收：**

```bash
npx vitest run __tests__/mcp-ecosystem.test.ts -t "import_candidates"
```

**PR3 验收：**

```bash
npx vitest run __tests__/mcp-ecosystem.test.ts
```

---

### Checkpoint 7：Trace recommendations 与 agent-facing docs

**目标：** 让 registry/workspace boundary 的下一步建议可复制，并同步 agent instructions。

**测试先行：** 更新 `__tests__/trace.test.ts` 与 `__tests__/instructions.test.ts`。

- 当 trace gap / low-evidence edge / import boundary metadata 中出现 bare workspace specifier，recommendations 包含：
  ```text
  codegraph_import_candidates({ specifier: "@scope/pkg" })
  ```
- 当 trace gap / property-call / callback / registry edge evidence 包含 registry/provider/tool/extension/route 线索，recommendations 包含：
  ```text
  codegraph_registry_candidates({ query: "provider" })
  ```
- **去重规则**：同 session 中同一种工具最多推荐一次；仅当 edge evidence 为 `property-call` / `callback` / `registry` 时才触发 registry 建议，避免对普通 `calls` edge 过度匹配。
- server instructions 与 installed agent instructions 提到：
  - workspace import candidates；
  - registry candidates；
  - coverage/status indexed-only boundary；
  - not runtime branch proof。

**实现：**

- `src/index.ts` 或 `src/graph/trace.ts`：在 recommendation builder 中加入 opt-in follow-up，不改变 path ranking。
- `src/mcp/server-instructions.ts` 更新工具使用指导。
- `src/installer/instructions-template.ts` 更新安装说明。
- `.cursor/rules/codegraph.mdc` 同步。
- `README.md` 增加新工具简短示例。
- `CHANGELOG.md` 添加用户视角条目。

**验收：**

```bash
npx vitest run __tests__/trace.test.ts __tests__/instructions.test.ts
```

---

## 输出形态约定

### `codegraph_import_candidates` 示例

```text
## Workspace import candidates: `@earendil-works/pi-ai`

> Static workspace package candidates only. This is not a complete Node/TypeScript resolver and not runtime proof.

Package: packages/ai/package.json (`@earendil-works/pi-ai`)
Specifier subpath: root

### Candidates
1. packages/ai/src/index.ts
   evidence=exports-exact confidence=0.95 indexed=yes language=typescript symbols=18
   export condition: exports["."].import
   symbol `streamSimple`: nodeId=function:... range=packages/ai/src/stream.ts:12-80
   re-export chain: packages/ai/src/index.ts -> packages/ai/src/stream.ts

### Recommended next
- codegraph_node({ nodeId: "function:..." })
- codegraph_trace({ fromNodeId: "...", toNodeId: "function:..." })
- read packages/ai/src/index.ts:1-40
```

### `codegraph_registry_candidates` 示例

```text
## Registry candidates

> Static registry/resolver candidates only. Runtime config/key selects one branch; CodeGraph does not choose a unique runtime implementation.

Query: provider; key: anthropic

### providers (src/providers/index.ts)
- key="anthropic" -> streamAnthropic
  evidence=object-literal confidence=high range=src/providers/index.ts:8:3-8:34
  handler: streamAnthropic nodeId=function:... range=src/providers/anthropic.ts:20-140

### Recommended next
- codegraph_node({ nodeId: "function:...", detail: "structure" })
- codegraph_field_sites({ field: "systemPrompt", scopePath: "src/providers" })
```

### `codegraph_status({ detail: "coverage" })` 示例

```text
## CodeGraph Coverage Status

> CodeGraph reports indexed source coverage, not a complete filesystem inventory.

Indexed files: 1,248; nodes: 18,430; edges: 27,004
Languages: typescript 904, tsx 120, markdown 0 (unsupported/non-source not indexed)
Top roots: src 612, packages 430, tests 206

Pending source changes: added=2 modified=4 removed=0
Extraction errors: 3 files (showing 3)
Unresolved refs: 128 (calls 77, references 51)
Workspace packages: 6 packages from package.json workspaces
Path aliases: 4 tsconfig paths patterns

### Coverage boundaries
- `codegraph_files` lists indexed files only.
- New, ignored, unsupported, non-source, or unsynced files may not appear.
- Use `git status`, `read <path>`, or `codegraph sync --quiet` to verify filesystem state.
```

---

## Acceptance criteria（分 PR）

### PR1 验收标准

1. `codegraph_status({ detail: 'coverage' })` explains indexed-only coverage and reports pending changes, extraction errors, unresolved refs, workspace summary, and recommendations without scanning full FS by default.
8. (PR1 subset) Coverage status output includes static-candidate caveats and copyable next checks.
9. (PR1 subset) CHANGELOG and README are updated for coverage enhancement.
10. No DB schema migration is required; rollback does not require data migration.

### PR2 验收标准（PR1 标准 + 以下）

2. `codegraph_import_candidates({ specifier })` lists package/source candidates for package.json workspaces, including evidence/confidence/indexed status and caveats.
3. `codegraph_import_candidates({ specifier, symbol })` can follow a simple barrel re-export chain and return exact node handles.
4. Conservative resolver integration resolves a unique high-confidence indexed workspace package import, while ambiguous/external packages remain unresolved/external.
8. (PR2 subset) `codegraph_import_candidates` MCP output includes static-candidate caveats and copyable next checks.
9. (PR2 subset) CHANGELOG and README are updated for import_candidates.

### PR3 验收标准（PR1 + PR2 标准 + 以下）

5. `codegraph_registry_candidates()` lists object registry, Map, `.set`, register-call, definition-array, and route-node candidates with exact ranges and handler handles when available.
6. Dynamic registry keys and ambiguous handlers are labeled as dynamic/ambiguous candidates, not runtime-selected implementations.
7. Trace boundary recommendations can suggest the new candidate tools without inflating default trace path output.
8. All new user-visible tools include static-candidate caveats and copyable next checks.
9. MCP instructions, installer instructions, Cursor rule, README, and CHANGELOG are updated when tools land.

---

## Focused validation commands（分 PR）

### PR1（Coverage / Status）

```bash
npx vitest run __tests__/coverage-status.test.ts
npx vitest run __tests__/mcp-ecosystem.test.ts -t "status\|coverage"
```

### PR2（Workspace Import + resolver）

```bash
npx vitest run __tests__/workspace-import-candidates.test.ts
npx vitest run __tests__/resolution.test.ts
npx vitest run __tests__/mcp-ecosystem.test.ts -t "import_candidates"
```

### PR3（Registry + MCP + docs）

```bash
npx vitest run __tests__/registry-candidates.test.ts
npx vitest run __tests__/mcp-ecosystem.test.ts
npx vitest run __tests__/trace.test.ts
npx vitest run __tests__/instructions.test.ts
```

### Before each PR handoff

```bash
npm run build
npm test
```

If implementation touches CLI status JSON contract, also run focused CLI tests or add one if missing.

---

## Rollback / failure handling（分 PR）

### PR1
- Coverage/status enhancement is formatter/API additive; default summary mode must remain backward-compatible.
- Failed rollout can be reverted by removing `codegraph_status({detail:'coverage'})` handler changes and `getCoverageReport()` API.

### PR2
- Workspace resolver integration is the only graph-behavior change in P3. If it causes false edges, revert the `resolveImportPath()` workspace hook; users can run `codegraph sync --quiet` or re-index to rebuild edges without migration.
- MCP tool `codegraph_import_candidates` is query-time only; remove tool definition/handler/formatter to revert.
- Package/workspace cache must be cleared on `indexAll()` / `sync()`; stale cache bugs should fail safe by returning candidates with lower confidence or requiring re-open.

### PR3
- Registry analyzer is query-time only; parse failures or performance issues should degrade to `partial` with skipped summary, not affect indexing or existing tools.
- Failed MCP tool rollout can be reverted by removing `codegraph_registry_candidates` tool definitions/handlers/formatters and associated docs.
- No DB schema migration is required across all three PRs; rollback does not require data migration.

---

## Release/documentation follow-through（分 PR）

每个 PR 更新自己对应的文档，agent-facing instructions 在 PR3 统一更新。

| PR | 文档更新 |
|---|---|
| **PR1** | `CHANGELOG.md`（coverage 条目）+ `README.md`（coverage 说明） |
| **PR2** | `CHANGELOG.md`（import_candidates 条目）+ `README.md`（import_candidates 说明） |
| **PR3** | `CHANGELOG.md`（registry_candidates 条目）+ `README.md`（registry_candidates 说明）+ `src/mcp/server-instructions.ts` + `src/installer/instructions-template.ts` + `.cursor/rules/codegraph.mdc` + `__tests__/instructions.test.ts` |

Changelog wording should be user-facing, for example:

```text
### Added
- Added workspace import candidate and registry candidate tools so agents can inspect monorepo package boundaries and provider/tool/route registries without treating static candidates as runtime proof.
- Expanded status coverage output with indexed-only boundary explanations, pending source changes, unresolved reference summaries, and workspace package hints.
```

Do not publish, tag, or push as part of implementation; release flow remains via GitHub Actions after version/changelog/package updates are explicitly requested.
