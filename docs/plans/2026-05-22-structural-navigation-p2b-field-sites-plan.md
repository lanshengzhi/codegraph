# CodeGraph 结构导航可用性增强 P2b：字段读写与对象构造线索 TDD 实施计划

> 关联设计：[`docs/codegraph-structural-navigation-usability-design.md`](../codegraph-structural-navigation-usability-design.md)  
> 拆解路线图：[`2026-05-21-structural-navigation-roadmap.md`](./2026-05-21-structural-navigation-roadmap.md)  
> 前置计划：[`2026-05-22-structural-navigation-p2a-node-structure-plan.md`](./2026-05-22-structural-navigation-p2a-node-structure-plan.md)  
> 状态：draft / ready for TDD implementation  
> 范围：新增按字段 / 属性 / payload key 查找读、写、解构、对象构造、return object 与 mapping hint 的按需结构导航能力；首版支持 TS/JS/TSX/JSX；不做完整 dataflow、alias analysis 或 runtime payload proof。

---

## 目标

P2b 聚焦“字段/key 级阅读导航”。P0/P0b/P1 已让 trace、edge evidence、ranking reason 更可信；P2a 已提供单个长函数内部的结构摘要。但用户经常关心的不是“函数 A 调用函数 B”，而是：

```text
systemPrompt 在哪里被写入、读取、组装进对象、映射到 provider payload？
tools 在哪里进入 context，又在哪里变成请求参数？
messages 在哪些 object literal / return object / payload builder 中出现？
```

P2b 的目标是新增一个 field/key sites 工具，把这类问题从 grep/read 盲搜变成结构化候选线索：

```text
codegraph_field_sites({ field: "systemPrompt" })
```

核心目标：

1. 在 TS/JS/TSX/JSX indexed source 中按字段名 / 属性名 / payload key 查找结构化 sites。
2. 覆盖首版高价值语法形态：property assignment、property read、object literal key、destructuring、return object fields、field/key mapping hints。
3. 每个 site 返回明确语义的 exact range、site kind/category/access、syntax-derived label/snippet、enclosing node handle 与可复制 next checks。
4. 输出按 Writes / Mapping hints / Object construction / Reads 分组，并明确 caveat：这是 field sites hints，不是 full field flow。
5. 不新增 DB schema；默认按需读取并解析当前 indexed files。
6. 不把结果塞进 `codegraph_trace`；trace 只可在 future follow-up 中建议调用 `codegraph_field_sites`。

一句话边界：**P2b 提供 field sites，不提供 full field flow。**

---

## 实施策略与执行 Gate

P2b 建议作为一个独立 PR / 分支交付，但必须按 checkpoint TDD 推进。每个 checkpoint 先写红测试，再实现最小通过代码，跑 focused validation 后再进入下一阶段。

### 交付模式

- **先 library API，后 MCP**：`CodeGraph.getFieldSites()` 与 analyzer 独立可测；MCP handler 只做参数校验、调用 API、格式化。
- **先精确语法事实，后 heuristic mapping**：assignment/read/object/destructuring 先落地；mapping hint 必须使用中性命名并带 caveat，不能声称 dataflow proof。
- **按需 query-time parse**：首版不做 schema migration，不持久化 field index；从 `files` 表获取 indexed file list，按 scope/language/size guard 读取并解析。
- **source safety 优先**：unsafe path、source-too-large、source-stale、parser-unavailable 先有降级分支，不允许抛异常或输出误导性结果。
- **不在 AST traversal 中提前裁剪事实**：P2b 首版不做 collection hard cap；analyzer 在通过 file-size guard 的文件中完整收集 sites，再做 ranking、`limit` 与 section cap，因此 `totalSites` 与分类统计是精确值。
- **docs 最后同步**：只有 MCP schema/文案稳定后，再更新 server instructions、installer instructions、README/CHANGELOG。

### Checkpoint 顺序

```text
Checkpoint 0  AST shape probe / golden fixture matrix
  → Checkpoint 1  Types + analyzer skeleton + source scanning guards
    → Checkpoint 2  property assignment/read + exact matching
      → Checkpoint 3  object literal / destructuring / return object
        → Checkpoint 4  mapping hints + caveats
          → Checkpoint 5  lazy enclosing handles + ranking/grouping/statistics
            → Checkpoint 6  MCP tool + formatter
              → Checkpoint 7  instructions/docs/build
```

### Stop conditions

遇到以下情况应停止扩展并降级或缩小范围：

- AST shape 无法高置信判断为 field site：不要输出该 site。
- source 与 indexed `FileRecord.contentHash` 不一致：跳过该文件并记录 `source-stale`，不要用 stale coordinates 输出。
- 文件超过 query-time size guard：跳过该文件并记录 `source-too-large`，不要 parse。
- mapping hint 文案可能被误读为 dataflow：收紧 label/note，保留 caveat，不新增跨函数推断。
- 输出过长：调整 formatter cap 与 omitted count，不让 analyzer 少收集事实。
- 默认 trace/node/search 行为受影响：立即回退 MCP wiring，保持 P2b 只新增 opt-in 工具。

---

## 产品决策

### 工具形态

新增独立 MCP 工具：

```ts
codegraph_field_sites({ field: "systemPrompt" })
```

原因：

- field/key sites 是项目级横切查询，不属于单个 node detail；不适合塞进 `codegraph_node`。
- 默认 trace 应保持紧凑；field sites 可作为 trace/read 的按需 follow-up。
- 独立工具能提供专门参数：`scopePath`、`limit`、`includeTests`；`maxSourceBytes` 首版只保留在 library/analyzer API 中作为安全/测试选项，不暴露给 MCP。

Library API：

```ts
await cg.getFieldSites("systemPrompt", options)
```

MCP input schema 首版：

```ts
{
  field: string;              // required, non-empty; exact field/key text
  scopePath?: string;         // optional indexed path prefix
  limit?: number;             // default 80, clamp 1..300
  includeTests?: boolean;     // default true; tests/fixtures lower-ranked and labeled
  projectPath?: string;
}
```

兼容/validation 规则：

- `field` 必须是非空字符串，trim 后长度建议 `<= 120`；不能包含换行。
- 字段匹配默认 case-sensitive exact match；不做 substring match。
- 支持 identifier key、string literal key、computed string literal key；动态 computed key 只在 literal 精确匹配时输出。
- `scopePath` 必须是 index-relative path prefix，使用 directory segment boundary 匹配：`file.path === scopePath || file.path.startsWith(scopePath + '/')`；例如 `scopePath='src/foo'` 不匹配 `src/foobar.ts` 或 `src/foobar/a.ts`。不接受 absolute path 或 `..` escape。如果 `scopePath` 恰好指向一个文件，允许精确匹配该文件。
- `limit` 仅影响收集后的 top result display / MCP 输出规模；result metadata 必须保留 total/omitted count。
- `maxSourceBytes` 在 library/analyzer API 中可配置，用于测试和内部调用；MCP 首版不暴露该参数，固定使用安全默认值（建议 1 MiB），避免用户通过 MCP 绕过 parse guard。

### 首版支持范围

语言：

- `typescript`
- `javascript`
- `tsx`
- `jsx`

语法：

- `state.systemPrompt = value` / `state.systemPrompt += value` / `state.systemPrompt++`
- `context.systemPrompt`
- `context['systemPrompt']`
- `{ systemPrompt }`
- `{ systemPrompt: value }`
- `{ system: context.systemPrompt }` mapping hint
- `const { systemPrompt } = context`
- `const { systemPrompt: prompt } = context`
- `return { systemPrompt }`
- `return { system: context.systemPrompt }` mapping hint
- `params.system = context.systemPrompt` mapping hint

明确降级/不支持：

- 非 TS/JS/TSX/JSX 文件不解析；计入 skipped/unsupported summary。
- 动态 key：`obj[fieldName]` 不匹配，除非 key 是 string literal 且等于 query field。
- alias chain：`const sp = ctx.systemPrompt; params.system = sp` 不连接成 mapping。
- spread dataflow：`{ ...ctx }` 只可作为 spread hint，不证明包含 field。
- interprocedural flow：不追函数参数、返回值、callback、provider registry 的跨函数绑定。

---

## 非目标

P2b 明确不做：

- 完整 field flow / dataflow graph；
- 完整 alias analysis；
- 跨函数、跨 provider、跨 registry 的 runtime branch 判定；
- 证明字段一定到达 runtime payload；
- LSP / TypeScript compiler API；
- DB schema migration 或持久化 field index；
- 对所有语言的字段级覆盖；
- 替代 `read`、测试或人工确认。

P2b 可以说：

```text
Line 42 reads context.systemPrompt.
Line 77 constructs object key system from context.systemPrompt; mapping hint only.
```

P2b 不可以说：

```text
systemPrompt definitely reaches Anthropic payload at runtime.
This is the complete field flow across all aliases and provider branches.
```

---

## Recon 结果：实施前代码切片

### 已有基础

- `src/types.ts`
  - 已有 `SourceRange`、`NodeHandle`、`FileRecord`、`NodeStructure*` types 可参考。
  - 尚无 field-sites 相关 result / item 类型。
- `src/index.ts`
  - `CodeGraph.getFiles()` 可返回 indexed file list。
  - `CodeGraph.getFile(path)` 可获得 `FileRecord.contentHash`，P2b 可用来检测 stale source。
  - `CodeGraph.getNodesInFile(path)` 可返回 indexed nodes，P2b 可从 line range 推导 enclosing node。
  - 已有 `getNodeStructure()` 作为 query-time AST analyzer API 模板。
- `src/structure/node-structure.ts`
  - 已有 query-time parser host、safe source read、hash stale check、range formatting、object key extraction、call/member text extraction 等可参考。
  - 这些 helper 多为 private；P2b 首版可复制最小 helper，后续再抽 shared utils，避免 P2b 被大 refactor 阻塞。
- `src/extraction/grammars.ts`
  - `loadGrammarsForLanguages()` 与 `getParser()` 可按需加载 TS/JS parser。
- `src/extraction/tree-sitter-helpers.ts`
  - `getChildByField()`、`getNodeText()` 可复用。
- `src/utils.ts`
  - `validatePathWithinRoot()`、`normalizePath()` 可用于安全路径与 project-relative 输出。
- `src/mcp/tools.ts`
  - `tools` 数组是 MCP schema 注册点。
  - `ToolHandler` 已有 `getCodeGraph()`、`textResult()`、`errorResult()`、`truncateOutput()`、`formatSourceRange()` 等可复用模式。
  - `formatNodeStructure()` 提供 section cap / omitted count 风格参考。
- `__tests__/node-structure.test.ts`
  - 已有临时项目、grammar、MCP handler、degradation path 的测试模式，可复用。
- `__tests__/instructions.test.ts`
  - agent-facing instructions 有同步测试；新增工具后必须更新。

### 关键缺口

- 没有项目级 field/key sites API。
- MCP tool list 中没有 `codegraph_field_sites`。
- 当前 P2a object literal hints 只在单个 node 内部使用，不能跨 indexed files 搜索 field/key。
- 没有 field site classification、mapping hint caveat、enclosing node handle 或 field-specific output formatter。

---

## 建议类型设计

在 `src/types.ts` 增加 additive exported types。

```ts
export type FieldSiteStatus =
  | 'available'
  | 'partial'
  | 'no-matches'
  | 'no-searchable-files'
  | 'all-skipped'
  | 'invalid-field'
  | 'parser-unavailable';

export type FieldSiteKind =
  | 'assignment'
  | 'property-read'
  | 'object-literal-key'
  | 'destructuring'
  | 'return-object-field'
  | 'field-mapping';

export type FieldSiteCategory =
  | 'write'
  | 'read'
  | 'construction'
  | 'mapping';

export type FieldSiteAccess =
  | 'read'
  | 'write'
  | 'readwrite'
  | 'construction'
  | 'mapping';

export type FieldSiteEvidence =
  | 'exact-identifier'
  | 'string-literal-key'
  | 'computed-string-literal-key'
  | 'shorthand-key'
  | 'destructuring-pattern'
  | 'mapping-heuristic';

export type FieldSiteSkippedReason =
  | 'unsupported-language'
  | 'source-unavailable'
  | 'source-too-large'
  | 'source-stale'
  | 'parser-unavailable'
  | 'parse-error'
  | 'outside-root';

export type FieldSiteCategoryCounts = Partial<Record<FieldSiteCategory, number>>;
export type FieldSiteSkippedSummary = Partial<Record<FieldSiteSkippedReason, number>>;

export interface FieldSite {
  field: string;
  kind: FieldSiteKind;
  category: FieldSiteCategory;
  /** Access semantics for this site; compound/update writes use readwrite. */
  access: FieldSiteAccess;
  evidence: FieldSiteEvidence;
  range: SourceRange;
  /** Short syntax-derived label/snippet, capped and single-line. */
  label: string;
  /** Receiver/object for property reads/writes, e.g. context in context.systemPrompt. */
  receiverText?: string;
  /** Matched property/key text, e.g. systemPrompt. */
  propertyText?: string;
  /** Object literal keys when local and cheap to extract. */
  objectKeys?: string[];
  /** For mapping hints: target key/property, e.g. system, header, temperature. */
  targetKey?: string;
  /** For mapping hints: source field/key, e.g. systemPrompt. */
  sourceField?: string;
  /** Enclosing indexed symbol, preferably smallest function/method/class range containing site. */
  enclosingNode?: NodeHandle;
  /** Syntax-only caveat for heuristic/mapping/readwrite sites. */
  note?: string;
  /** True when path is test/spec/fixture/example/generated-like. */
  isTestOrFixture?: boolean;
}

export interface FieldSiteSkippedFile {
  path: string;
  language?: Language;
  reason: FieldSiteSkippedReason;
  detail?: string;
}

export interface FieldSitesOptions {
  scopePath?: string;
  limit?: number;
  includeTests?: boolean;
  maxSourceBytes?: number;
  maxLabelChars?: number;
  maxObjectKeys?: number;
  /** Maximum skipped-file samples to return; summary counts remain complete. */
  maxSkippedFileSamples?: number;
}

export interface FieldSitesResult {
  status: FieldSiteStatus;
  field: string;
  sites: FieldSite[];
  /** Indexed files considered after scope/includeTests filtering. */
  searchedFiles: number;
  /** Supported TS/JS/TSX/JSX files among searchedFiles before source guards. */
  searchableFiles: number;
  /** Files that actually reached parser.parse after source guards and cheap prefilter. */
  parsedFiles: number;
  /** Files that produced at least one site before result limit. */
  matchedFiles: number;
  skippedFileCount: number;
  skippedFilesOmitted: number;
  skippedSummary: FieldSiteSkippedSummary;
  /** Sample of skipped files only; capped to avoid large-repo output blowups. */
  skippedFiles: FieldSiteSkippedFile[];
  /** Total matched sites before requested display/result limit. */
  totalSites: number;
  /** Total matched sites by category before requested limit. */
  totalSitesByCategory: FieldSiteCategoryCounts;
  /** Sites omitted after sorting because of requested limit. Totals are exact in P2b because there is no collection hard cap. */
  omittedSites: number;
  /** Omitted sites by category after requested limit. Totals are exact in P2b because there is no collection hard cap. */
  omittedSitesByCategory: FieldSiteCategoryCounts;
  caveats: string[];
  recommendations: string[];
}
```

设计约束：

- `FieldSite` 只记录 AST 中直接观察到的事实。
- `field-mapping` 必须带 `note`，说明是 syntax-only mapping hint。
- `range.path` 使用 project-relative path；line 1-indexed；column 沿用现有 0-indexed convention。
- `range` 语义必须按本计划的“Range 语义”执行，避免测试、formatter 与用户理解不一致。
- Analyzer 不应在 AST traversal 过程中因为 section cap 提前跳过事实；先收集、排序，再按 requested `limit` 形成 `sites`。
- `totalSites` / `omittedSites` 与 `totalSitesByCategory` / `omittedSitesByCategory` 必须反映排序后被 `limit` 省略的数量；P2b 首版不做 collection hard cap，因此这些 total/category counts 必须是精确值。
- `skippedFiles` 必须只是 capped sample；`skippedSummary` / `skippedFileCount` 是完整统计。

---

## Source scanning 与 parser 流程

建议新增 `src/structure/field-sites.ts`：

```ts
export interface FieldSitesParserHost {
  loadGrammarsForLanguages(languages: Language[]): Promise<void>;
  getParser(language: Language): Parser | null;
}

export class FieldSitesAnalyzer {
  constructor(
    private readonly projectRoot: string,
    private readonly parserHost: FieldSitesParserHost = defaultParserHost
  ) {}

  async analyze(
    field: string,
    files: FileRecord[],
    loadNodesForFile: (path: string) => Node[],
    options?: FieldSitesOptions
  ): Promise<FieldSitesResult>;
}
```

`CodeGraph.getFieldSites()` 负责准备 indexed file list，但 **不得** 先对所有 scoped files 调 `getNodesInFile()`。Enclosing node resolution 必须 lazy：只有某个文件通过 safety guards、prefilter、parse 且产生 sites 后，才查询该文件的 nodes。

```ts
async getFieldSites(field: string, options?: FieldSitesOptions): Promise<FieldSitesResult> {
  const files = this.getFiles();
  const scoped = filterFilesByScopeAndLanguage(files, options);
  const analyzer = new FieldSitesAnalyzer(this.projectRoot);
  return analyzer.analyze(
    field,
    scoped,
    (path) => this.getNodesInFile(path),
    options
  );
}
```

Parser grammar 也应按 distinct languages 预加载一次，或至少由 analyzer 内部缓存 language load/getParser 结果；不要每个文件重复无意义加载。

### 每个文件处理顺序

1. 过滤 language：仅 TS/JS/TSX/JSX 进入 parser；其他语言固定计入 `skippedSummary.unsupported-language` / `skippedFileCount`，但 `skippedFiles` 只保留 capped sample。
2. `validatePathWithinRoot(projectRoot, file.path)`；失败则 skip `outside-root`。
3. `fs.stat()`；非 regular file 或 missing 则 skip `source-unavailable`。
4. size guard：超过 `maxSourceBytes`（默认建议 1 MiB）则 skip `source-too-large`。
5. `fs.readFile()`。
6. `hashContent(source) !== file.contentHash` 则 skip `source-stale`，不 parse。
7. cheap prefilter：如果 source 不包含 field 字符串，且不包含 quoted field 可能形态，则 skip parse。注意 source prefilter 只能跳过明显无关文件，不能替代 AST exact match；如果 supported files 都被 prefilter 排除，状态应为 `no-matches`，并输出 caveat：`No source text contained the exact field string; dynamic/computed/alias cases are not covered.`
8. `await loadGrammarsForLanguages(distinctLanguages)` 应在文件循环前完成，或对每个 language 缓存 load/getParser 结果；parser 缺失则相关文件 skip `parser-unavailable`。
9. `parser.parse(source)`，`finally tree?.delete()`；每个实际进入 `parser.parse` 的文件计入 `parsedFiles`。
10. AST traversal 收集 sites；P2b 首版不做 collection hard cap，因此遍历完成后的 `totalSites*` 统计是精确值。
11. 如果该文件产生 sites，才调用 `loadNodesForFile(file.path)` 找 enclosing node：选择包含 `site.range.startLine` 的最小 range；优先 function/method，再 class/component/module/file。

File count 与 skipped 统计规则：

- `searchedFiles` = scope/includeTests 过滤后被考虑的 indexed files。
- `searchableFiles` = `searchedFiles` 中语言为 TS/JS/TSX/JSX 的 supported files，尚未经过 source guards / prefilter。
- `parsedFiles` = 实际进入 `parser.parse` 的 files；source guard failed 或 cheap prefilter 阴性的文件不计入。
- `matchedFiles` = 在 result limit 之前至少产生一个 site 的 files。
- `unsupported-language` 固定计入 `skippedSummary` / `skippedFileCount`，但不触发 `partial`；`partial` 只由 supported files 的 stale/too-large/unavailable/parser/limit 问题触发。
- `skippedSummary` 与 `skippedFileCount` 必须完整统计所有 skipped files。
- `skippedFiles` 只保留 sample，默认 cap 建议 20；超出数量写入 `skippedFilesOmitted`。
- 非 TS/JS 文件数量很大时，MCP 输出默认只展示 summary，不逐个列出 unsupported-language 文件。

### Result status

状态语义必须避免把“没有可靠搜索”误读成“字段不存在”：

- `available`：至少一个 site，且没有影响已支持语言搜索完整性的 skipped supported files / parser failures / limit 截断。单纯存在非 TS/JS unsupported-language 文件不应强制降为 partial。
- `partial`：搜索结果不完整；可以有 zero or more sites。触发条件包括 skipped supported files、parser failures、source-stale/too-large、或 limit 截断。当存在 supported files 被跳过，即使 totalSites=0，也应返回 `partial`（而非 `no-matches`）并说明搜索不完整。
- `no-matches`：所有 supported TS/JS files 均被成功搜索（无 skipped supported files、无 parser failure），且没有 sites；包括 cheap prefilter 全阴性场景。此时必须说明 exact field string 未出现不代表动态/computed/alias 场景不存在。
- `no-searchable-files`：scope/language/includeTests 过滤后没有任何 TS/JS/TSX/JSX indexed file 可搜索；不能用于 cheap prefilter 全阴性。
- `all-skipped`：存在 supported candidate files，但全部因 stale、too-large、unavailable、outside-root、parse-error 等原因被跳过；`skippedSummary` 必须说明原因分布。
- `invalid-field`：field 参数非法（library API 可返回，MCP 可直接 error）。
- `parser-unavailable`：所有 otherwise-searchable supported files 都因 parser unavailable 无法解析；如果 parser-unavailable 与其他 skipped reason 混合，则优先 `all-skipped` 并在 `skippedSummary` 展示。

Caveat 固定包含：

```text
Field sites are static AST navigation hints, not full dataflow, alias analysis, or runtime payload proof.
```

---

## AST shape probe 与 Range 语义

### AST shape probe

正式实现具体 matcher 前，应先用 golden fixtures 确认 TS/JS/TSX/JSX 下关键语法的 tree-sitter node shape。测试不必 snapshot 整棵 AST，但必须覆盖并断言 analyzer 能识别这些形态：

- assignment / compound assignment / update expression；
- dot member、optional chain、subscript string literal；
- object literal shorthand、key/value property、computed string literal key；
- object pattern destructuring、alias destructuring、parameter destructuring；
- return object field；
- TS public class field / JS field definition 附近的 object/member syntax；
- TSX expression 中的 object/member syntax。

### Range 语义

所有 `FieldSite.range` 必须是“用户下一步最小可读/可验证的语法范围”，并按 site kind 固定：

- `assignment`：整条 assignment / compound assignment / update expression；`propertyText` 指向命中的属性。
- `property-read`：完整 member/subscript expression，例如 `context.systemPrompt` 或 `context['systemPrompt']`。
- `object-literal-key`：对应 object property pair / shorthand property，而不是整个 object literal；`objectKeys` 可列同一 object 的 key 摘要。
- `destructuring`：对应 object pattern property / parameter property；alias destructuring range 包含 key 和 local alias。
- `return-object-field`：return object 中对应 property pair / shorthand property；不是整条 `return`，除非 tree-sitter 无法稳定定位 property。
- `field-mapping`：整条 assignment 或 object property pair（target key + source expression），因为 mapping hint 需要同时看到 target 与 source。

Formatter 可显示 `read path:start-end` 建议时扩展到 enclosing node 或附近行，但 site range 本身必须保持上述语义。

---

## AST 分析规则

### 1. Exact field/key matching

匹配 helper：

```ts
matchesFieldKey(node, field): { matched: boolean; evidence: FieldSiteEvidence; text: string }
```

支持：

- identifier / property_identifier / shorthand_property_identifier exact text；
- private field 首版可按原 text 匹配（`#foo`），不做 `foo` fallback；
- string literal key：去掉 quote 后 exact match；
- computed_property_name 若内部是 string literal 且 exact match，则 `computed-string-literal-key`；
- 不做 substring：`systemPromptExtra` 不匹配 `systemPrompt`；`getSystemPrompt` 不匹配 `systemPrompt`。

### 2. Property assignment / write

识别：

```ts
state.systemPrompt = value
state.systemPrompt += value
state.systemPrompt++
++state.systemPrompt
state['systemPrompt'] = value
```

输出：

```ts
kind: 'assignment'
category: 'write'
access: 'write' // compound/update forms use 'readwrite'
receiverText: 'state'
propertyText: 'systemPrompt'
label: 'state.systemPrompt = ...'
```

规则：

- LHS member expression 命中 field 时输出 write。
- LHS member expression 不再同时输出 property-read，避免同一 syntax 被误解为 read+write。
- simple assignment `=` 使用 `access: 'write'`。
- compound assignment（`+=` 等）与 update expression（`++`/`--`）使用 `access: 'readwrite'`，并加 note：`compound/update assignment also reads previous value; not separately emitted as read`。

### 3. Property read

识别：

```ts
context.systemPrompt
context?.systemPrompt
context['systemPrompt']
context.systemPrompt ?? defaultPrompt
convert(context.systemPrompt)
```

输出：

```ts
kind: 'property-read'
category: 'read'
access: 'read'
receiverText: 'context'
propertyText: 'systemPrompt'
label: 'context.systemPrompt'
```

规则：

- 如果 member expression 是 assignment/update LHS，则不算 read。
- 如果 member expression 是 object literal key，不算 property-read。
- 嵌套 member expression 中的 inner field 应能被识别：`ctx.tools.map(...)` 对 field `tools` 是 read。
- Optional chain 只影响 label，不增加 runtime 结论。
- `delete obj.field` 首版不作为 property-read 或 write；可作为后续 write-like/delete site enhancement。

### 4. Object literal key / construction

识别：

```ts
const ctx = { systemPrompt }
const ctx = { systemPrompt: buildPrompt() }
send({ systemPrompt, messages, tools })
```

输出：

```ts
kind: 'object-literal-key'
category: 'construction'
access: 'construction'
evidence: 'shorthand-key' | 'exact-identifier' | 'string-literal-key'
objectKeys: ['systemPrompt', 'messages', 'tools']
label: 'object key systemPrompt in { ... }'
```

规则：

- Shorthand `{ systemPrompt }` 既是 object construction，也暗含 local identifier read；首版只输出 `object-literal-key`，note 可写 `shorthand key; local value read not traced`。
- `objectKeys` cap 默认 12；computed dynamic key 显示 `[computed]`。
- Object literal 中的 value expression 仍会被遍历，因此 `{ system: context.systemPrompt }` 可同时输出 mapping/read。

### 5. Destructuring

识别：

```ts
const { systemPrompt } = context
const { systemPrompt: prompt } = context
({ systemPrompt } = context)
function f({ systemPrompt }: Options) {}
```

输出：

```ts
kind: 'destructuring'
category: 'read'
access: 'read'
evidence: 'destructuring-pattern'
label: 'destructure systemPrompt from context'
```

规则：

- Object pattern key 命中 field 时输出 destructuring site。
- Function parameter destructuring 也输出；note：`parameter destructuring site; caller value not inferred`。
- 不追踪 destructured local alias 后续流向。

### 6. Return object fields

识别：

```ts
return { systemPrompt }
return { systemPrompt: prompt }
return { system: context.systemPrompt }
```

输出：

- field/key 本身命中：

```ts
kind: 'return-object-field'
category: 'construction'
access: 'construction'
label: 'return object key systemPrompt'
```

- source field 出现在 returned value 中且 target key 不同：另见 mapping hint。

规则：

- `return { systemPrompt }` 不重复输出为 generic object literal + return object field 两个 construction sites；首版以 `return-object-field` 优先。
- `return build({ systemPrompt })` 中的 argument object 不属于 direct return object field，仍可输出 object-literal-key。

### 7. Mapping hints

识别 syntax-only mapping：

```ts
params.system = context.systemPrompt
const params = { system: context.systemPrompt }
return { system: context.systemPrompt }
```

当 query field 命中 source side `systemPrompt`，且 target key/property 是不同静态 key `system`，输出：

```ts
kind: 'field-mapping'
category: 'mapping'
access: 'mapping'
evidence: 'mapping-heuristic'
sourceField: 'systemPrompt'
targetKey: 'system'
label: 'system <- context.systemPrompt'
note: 'syntax-only mapping hint; not dataflow or runtime payload proof'
```

规则：

- Mapping hint 只在同一 assignment/object property/return object syntax 内生成。
- Query field 命中 target key（例如 `field: "system"`）时，输出 assignment/object/return site；是否额外输出 mapping 可作为 later enhancement。首版优先 source-field mapping。
- 不跨 alias：`const sp = context.systemPrompt; params.system = sp` 只输出 read 和 assignment/object key，不输出 mapping。
- 不用 provider、HTTP、DTO、config 等业务名词猜测运行时含义；即使出现在 `buildParams` 中，也只说 mapping hint。

---

## Ranking 与输出形态

### 排序

Analyzer 先收集所有 sites，再按可审计信号排序：

1. production path before test/fixture/example/generated path unless `includeTests=false` filters them out；
2. category priority：`write` → `mapping` → `construction` → `read`；
3. enclosing function/method/class present before top-level/no handle；
4. path/name deterministic order；
5. source order within file。

`includeTests`：

- 默认 `true`：test/fixture sites 低排序并标注 `test/fixture path`。
- 若 `false`：过滤 test/spec/fixture/example/generated paths；如果没有结果，recommendation 提示重试 `includeTests: true`。

### MCP markdown 目标形态

```text
## Field sites: systemPrompt

Searched indexed files: 104 (scope: src)
Searchable TS/JS files: 84; parsed files: 22; matched files: 6
Sites: 38 total exact (writes 3, mappings 4, construction 9, reads 22; showing 20)
Skipped summary: source-stale=2, source-too-large=1 (showing 3 skipped-file samples)

> Field sites are static AST navigation hints, not full dataflow, alias analysis, or runtime payload proof.

### Writes
- assignment src/agent/session.ts:118 — this.state.systemPrompt = ...
  enclosing: AgentSession._rebuildSystemPrompt nodeId=method:...
  next: codegraph_node({ nodeId: "method:...", detail: "structure" })

### Mapping hints
- field-mapping src/providers/anthropic.ts:42 — system <- context.systemPrompt
  enclosing: buildParams nodeId=function:...
  note: syntax-only mapping hint; not dataflow or runtime payload proof
  next: read src/providers/anthropic.ts:35-55

### Object construction
- return-object-field src/agent/context.ts:77 — return object key systemPrompt
  enclosing: createContextSnapshot nodeId=method:...

### Reads
- property-read src/providers/anthropic.ts:42 — context.systemPrompt
  enclosing: buildParams nodeId=function:...

### Recommended next
- codegraph_node({ nodeId: "method:...", detail: "structure" })
- read src/providers/anthropic.ts:35-55
- codegraph_trace({ fromNodeId: "...", toNodeId: "...", maxDepth: 8 })
```

Formatter rules：

- 始终显示 caveat。
- 每个 site 显示 `kind range — label`，必要时显示 `access=readwrite`。
- 如有 `enclosingNode`，显示 name/kind/nodeId/range。
- 如有 mapping，必须显示 note。
- 顶部显示 `totalSitesByCategory` / `omittedSitesByCategory` 的紧凑统计，避免全局 limit 截断后用户误以为某类 site 不存在。
- `skippedFiles` 默认只展示 capped sample；完整原因分布用 `skippedSummary`。
- 每个 section cap 默认 40；超过则输出 `... N more sites omitted`。
- 全局仍走 `truncateOutput()`。
- 不输出完整源码代码块。

---

## TDD 任务拆解

### 任务 0：AST shape probe、测试 fixture 与 harness

**目标：** 新增专门测试文件，先确认 TS/JS/TSX/JSX 关键语法 shape，再覆盖 library API 与 MCP 输出。

**测试先行：** 新增 `__tests__/field-sites.test.ts`：

- 使用临时目录写入 `src/session.ts`、`src/providers/anthropic.ts`、`src/context.ts`、`src/plain.js`、`src/component.tsx`。
- `CodeGraph.initSync(root, { config: { include: ['src/**/*.{ts,tsx,js,jsx,py}'], exclude: [] } })` 后 `await cg.indexAll()`。
- 增加 AST shape / golden fixture matrix：assignment、compound/update、optional chain、computed string key、object shorthand、object pattern alias、parameter destructuring、return object、TSX expression。测试应断言 analyzer 识别结果，而不是依赖整棵 AST snapshot。
- 复用 existing grammar init pattern；parser-unavailable 使用 injected parserHost seam 稳定测试。
- `afterEach` close/destroy + cleanup。

### 任务 1：Types + library API skeleton + source guards

**测试先行：**

- `cg.getFieldSites('systemPrompt')` 返回 `FieldSitesResult`，包含 `field`、`sites`、`searchedFiles`、`searchableFiles`、`parsedFiles`、`matchedFiles`、`skippedSummary`、`skippedFileCount`、`skippedFiles`、`totalSitesByCategory`、`omittedSitesByCategory`、`caveats`、`recommendations`。
- invalid field：空字符串、仅空白、包含换行、过长字符串返回 `invalid-field` 或 MCP error。
- unsupported language fixture（Python）不会抛异常；无 TS/JS searchable files 时返回 `no-searchable-files`，并说明首版支持 TS/JS/TSX/JSX。
- cheap prefilter 全阴性 fixture：scope 下有 supported files 且源码均不包含 exact field string 时返回 `no-matches`，不得返回 `no-searchable-files`。
- all skipped fixture：scope 下 supported files 全部 stale/too-large/unavailable 时返回 `all-skipped`，不得返回 `no-matches`。
- mixed no-match + skipped fixture：scope 下部分 supported files 成功搜索且无 sites，另有部分 supported files stale/too-large/unavailable 被跳过 → 返回 `partial`（非 `no-matches`），`totalSites=0`，caveat 说明搜索不完整。
- missing source / unsafe path / source-too-large / source-stale / parser-unavailable 都作为 skipped file 记录；`skippedFiles` 为 capped sample，`skippedSummary` 保留完整计数。

**实现：**

- `src/types.ts` 增加 FieldSites types。
- 新增 `src/structure/field-sites.ts` analyzer skeleton。
- `src/index.ts` import analyzer/types，新增 `getFieldSites(field, options?)`。
- Analyzer 实现 file filtering、safe read、size guard、hash stale check、cheap prefilter no-match caveat、distinct-language parser loading/cache、parse tree deletion。
- Enclosing node resolution 使用 lazy `loadNodesForFile(path)`；只有文件产生 sites 后才查询 nodes，避免大 repo 中 N 个无关文件触发 N 次 DB 查询。

**验证：**

```bash
npx vitest run __tests__/field-sites.test.ts -t "invalid|unsupported|source-unavailable|source-too-large|source-stale|parser-unavailable"
```

### 任务 2：Property assignment/read exact matching

**测试先行 fixture：**

```ts
export function update(context: Context, state: State) {
  state.systemPrompt = context.systemPrompt;
  state.systemPrompt += "\nextra";
  state.systemPrompt++;
  const value = context['systemPrompt'];
  const ignored = context.systemPromptExtra;
  const alsoIgnored = getSystemPrompt(context);
}
```

断言：

- `state.systemPrompt = ...` 是 `assignment` + `category=write` + `access=write`。
- `state.systemPrompt += ...` / `state.systemPrompt++` 是 `assignment` + `category=write` + `access=readwrite`，并带 previous-value read note。
- `context.systemPrompt` 与 `context['systemPrompt']` 是 `property-read`。
- assignment LHS 不额外输出 property-read。
- `systemPromptExtra`、`getSystemPrompt` 不匹配。
- 每个 site 有按“Range 语义”定义的 exact range 与 enclosing node handle。

**实现：**

- AST traversal；member expression property/key matcher；assignment/update parent 判断。
- `findEnclosingNode(loadNodesForFile(path), line)` helper；node lookup 必须 lazy 且 per-file cached only after that file has sites。
- label/snippet cap 和 single-line sanitization。

### 任务 3：Object literal、destructuring、return object

**测试先行 fixture：**

```ts
export function build(context: Context) {
  const { systemPrompt, messages: localMessages } = context;
  const snapshot = { systemPrompt, messages: localMessages, tools: context.tools };
  send({ systemPrompt, tools: context.tools });
  return { systemPrompt, messages: localMessages };
}

export function param({ systemPrompt }: Options) {
  return systemPrompt;
}
```

断言：

- `const { systemPrompt } = context` 是 `destructuring`。
- `{ systemPrompt }` 是 `object-literal-key`，evidence `shorthand-key`。
- `return { systemPrompt }` 是 `return-object-field`，不重复输出 generic object-literal construction。
- Function parameter destructuring 输出 note：caller value not inferred。
- `objectKeys` 包含相关 static keys，cap 生效。

**实现：**

- object pattern traversal；object literal property/shorthand detection；return object special-case。
- Dedupe helper：same syntax node + same kind + same category 只输出一次。

### 任务 4：Mapping hints

**测试先行 fixture：**

```ts
export function buildParams(context: Context) {
  const params = {
    system: context.systemPrompt,
    messages: convertMessages(context.messages),
  };
  params.prompt = context.systemPrompt;
  return { system: context.systemPrompt };
}

export function alias(context: Context) {
  const sp = context.systemPrompt;
  return { system: sp };
}
```

断言：

- Query `systemPrompt` 返回 `field-mapping`：`system <- context.systemPrompt`、`prompt <- context.systemPrompt`。
- Mapping note 包含 `syntax-only mapping hint` 和 `not dataflow or runtime payload proof`。
- `alias()` 不输出 `system <- sp` mapping，只输出 `context.systemPrompt` read。
- Query `system` 返回 object/return key site，但不声称 runtime payload。

**实现：**

- assignment mapping：LHS static property/key + RHS contains source field property-read。
- object property mapping：key static target + value contains source field property-read。
- direct return object mapping 使用同一 object property helper。
- mapping sites 与 property-read 可同时存在； formatter 将 mapping 分到单独 section。

### 任务 5：Ranking、scope、includeTests、limit

**测试先行：**

- `scopePath: 'src/providers'` 只搜索 provider files；`scopePath: 'src/foo'` 不匹配 `src/foobar.ts` 或 `src/foobar/a.ts`（segment boundary 测试）。
- test fixture `src/__tests__/payload.test.ts` 的 sites 默认出现但 lower-ranked / labeled `test/fixture path`。
- `includeTests: false` 过滤 test/fixture path；无 production results 时 recommendation 提示 retry with includeTests true。
- `limit: 2` 返回/展示 `omittedSites`、`omittedSitesByCategory`；MCP section cap 输出 `... N more sites omitted`。
- 即使全局 limit 截掉 Reads，也能通过 `totalSitesByCategory.read` / `omittedSitesByCategory.read` 看出 reads 存在。
- Sorting：writes before mappings before construction before reads within production files。

**实现：**

- path classification helper，可复用/抽取现有 test/generated path helpers（如已有）。
- result sorting + limit/omitted count + category counts。
- recommendations based on top enclosing nodes and scoped/no-match/all-skipped/no-searchable state。

### 任务 6：MCP `codegraph_field_sites` tool 与 formatter

**测试先行：**

- `tools` schema 中存在 `codegraph_field_sites`，required `field`。
- `handler.execute('codegraph_field_sites', { field: 'systemPrompt' })` 输出：
  - `## Field sites: systemPrompt`；
  - static field-sites caveat；
  - `### Writes`、`### Mapping hints`、`### Object construction`、`### Reads`；
  - exact ranges；
  - total/omitted by category；
  - skipped summary with capped skipped-file samples；
  - enclosing nodeId / next query；
  - mapping note；
  - 不包含完整源码 fenced block。
- invalid args：missing field、non-string field、bad scopePath、bad limit 返回 MCP error。
- MCP 首版不暴露 `maxSourceBytes`；tool schema 不应包含该属性，source-size guard 使用固定安全默认值。
- no matches / no-searchable-files / all-skipped 输出 indexed/source caveat 与 suggestions：`codegraph sync --quiet`、adjust scope、try includeTests。

**实现：**

- `src/mcp/tools.ts`：tools array 新增 schema。
- `ToolHandler.execute` switch 增加 `codegraph_field_sites`。
- `handleFieldSites(args)` 参数校验，调用 `cg.getFieldSites()`。
- `formatFieldSites(result)` + `formatFieldSite(site)`。
- 输出走 `truncateOutput()`。

### 任务 7：agent-facing instructions、README、CHANGELOG

**测试先行：** 更新 `__tests__/instructions.test.ts`：

- `SERVER_INSTRUCTIONS` 包含 `codegraph_field_sites`。
- instructions 明确：用于 field/key read/write/construction/mapping sites。
- instructions 明确：not full dataflow / alias analysis / runtime proof。

**实现：**

- 更新 `src/mcp/server-instructions.ts`：
  - Tool selection 增加 field/payload key 问题 → `codegraph_field_sites`。
  - Common chains 增加 provider payload debugging：context/trace → field_sites → targeted read。
  - Limitations 增加 field sites caveat。
- 更新 `src/installer/instructions-template.ts` 同步 guidance。
- 更新 `README.md` MCP tools 描述。
- 若仓库存在 `.cursor/rules/codegraph.mdc`，同步更新；当前若不存在，在实施总结中说明 not applicable。
- 若作为用户可见能力发布，补 `CHANGELOG.md`。

---

## 最小验收标准

P2b 完成时至少满足：

- [ ] `CodeGraph.getFieldSites(field)` library API 存在，默认不影响现有 API。
- [ ] MCP tool `codegraph_field_sites` 存在，schema required `field`，支持 `scopePath`、`limit`、`includeTests`；MCP schema 不暴露 `maxSourceBytes`。
- [ ] TS/JS/TSX/JSX fixture 覆盖 assignment、compound/update readwrite、property read、object literal key、destructuring、return object field、field mapping hint。
- [ ] AST shape / golden fixture matrix 覆盖 optional chain、computed string key、object pattern alias、parameter destructuring、TSX expression。
- [ ] 每个 site 显示按本计划定义语义的 exact project-relative range。
- [ ] 每个 site 尽量包含 enclosing node handle；无 enclosing node 时明确降级。
- [ ] Mapping hint 必须显示 syntax-only caveat，不声称 dataflow/runtime proof。
- [ ] Exact matching 不误匹配 substring / camel getter。
- [ ] LHS assignment 不重复标为 read；compound/update assignment 使用 `access=readwrite` 并带 note。
- [ ] Source-stale / too-large / unavailable / parser-unavailable 文件被跳过并记录原因；`skippedSummary` 完整，`skippedFiles` capped。
- [ ] `no-matches`、`no-searchable-files`、`all-skipped`、mixed no-match+skipped→`partial` 状态语义有测试，且不会把未搜索误报为字段不存在。
- [ ] `scopePath`、`includeTests`、`limit` 行为有测试；`scopePath` segment-boundary 匹配有测试；`totalSitesByCategory` / `omittedSitesByCategory` 可说明全局 limit 截断了哪些类别，且 total/category counts 精确。
- [ ] No-match 输出说明 indexed/source scope 边界，并给可复制 next checks。
- [ ] Formatter 按 Writes / Mapping hints / Object construction / Reads 分组并 cap。
- [ ] `src/mcp/server-instructions.ts`、`src/installer/instructions-template.ts`、README（和必要时 CHANGELOG）同步更新。
- [ ] 不新增 DB schema，不修改 trace 默认输出，不引入完整 alias/dataflow。

---

## 验证命令

Focused validation：

```bash
npx vitest run __tests__/field-sites.test.ts
npx vitest run __tests__/instructions.test.ts
```

Regression around adjacent features：

```bash
npx vitest run __tests__/node-structure.test.ts __tests__/addressability.test.ts
npx vitest run __tests__/trace.test.ts
```

Final validation：

```bash
npm run build
npm test
```

---

## 风险与缓解

### 风险 1：项目级 parse 太慢

**缓解：** 仅扫描 indexed TS/JS files；先 size guard，再 cheap `source.includes(field)` prefilter，再 parse；支持 `scopePath`；默认 `limit`；输出 skipped/omitted summary。若后续仍慢，再考虑 persistent field index 或 FTS source cache，但不放入 P2b 首版。

### 风险 2：mapping hint 被误读成 dataflow proof

**缓解：** API 层使用中性 kind `field-mapping`，section 使用 `Mapping hints`，evidence 为 `mapping-heuristic`；每条 mapping site 必带 `syntax-only mapping hint; not dataflow or runtime payload proof` note；instructions/README 同步强调。

### 风险 3：重复 sites 噪声过高

**缓解：** LHS write suppress read；return object field suppress generic object-literal duplicate；same syntax node/kind/category dedupe；formatter 分组+cap。

### 风险 4：exact matching 漏掉 alias / computed dynamic cases

**缓解：** 这是明确非目标；no-match/recommendations 提示可用 targeted read/grep 补充动态/alias cases。不要为“看起来聪明”做 substring 或 low-confidence alias 推断。

### 风险 5：stale source 坐标误导

**缓解：** 每个 file 在 parse 前比较 `hashContent(source)` 与 indexed `FileRecord.contentHash`；mismatch skip `source-stale`，recommend `codegraph sync --quiet`。

### 风险 6：helper 复制导致 P2a/P2b 漂移

**缓解：** P2b 首版可复制最小 AST helper 以降低 refactor 风险；若复制超过少量函数，后续单独抽 `src/structure/ast-utils.ts`，并跑 `node-structure` + `field-sites` 双测试。

---

## P2b 完成后的下一步

P2b 交付后再评估：

- 是否需要 `codegraph_field_sites({ field, fromNodeId })` 做单函数/单类范围搜索；
- 是否需要 alias-light follow-up，例如同函数内 `const sp = context.systemPrompt` 后 `system: sp` 的局部 mapping hint；
- 是否将 high-signal mapping sites 接入 trace boundary recommendations；
- 是否为 P3 registry/provider candidates 复用 field-sites mapping output；
- 是否需要持久化 field index 来优化大型 monorepo 查询。

这些都不属于 P2b 首版验收。P2b 首版的成功标准是：**能可靠返回字段/key 的高价值读写、构造和 mapping 位置，并诚实说明它不是完整 flow。**
