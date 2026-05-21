# CodeGraph 结构导航可用性增强设计

**Status:** draft design input for implementation planning; feasibility-calibrated  
**Scope:** CodeGraph 面向 Coding Agent 的结构导航、trace、搜索/上下文结果解释与验证边界  
**Focus:** what should exist and why; implementation details are deferred, but priorities distinguish minimum viable output improvements from later analysis capabilities

---

## 摘要

CodeGraph 在 Coding Agent 工作流中的核心定位应是**高信噪比结构导航层**：先用索引中的符号、边、范围、调用邻域和精确节点句柄，把问题收敛到少量高度相关的代码区域；再由 agent 通过少量 `codegraph_node(includeCode)`、`read`、运行命令和测试来确认最终控制流、数据流与运行时行为。

这份设计文档基于一次在 `pi` 自身代码库中追踪“用户输入如何进入 provider payload”的实际使用记录，沉淀 CodeGraph 需要补强的产品能力。它不是实施计划；它定义的是要提供什么能力、为什么需要这些能力、哪些边界不应被突破。

目标不是把 CodeGraph 做成完整的运行时语义分析器，而是让它更诚实、更可操作地回答：

- 哪些结构路径是静态图直接支持的？
- 哪些路径只是可能的候选？
- trace 在哪里遇到 callback、registry、对象字段、动态 provider 等边界？
- 下一步应该检查哪个精确节点或源码范围？
- 同名符号、长函数、字段流转和宽泛自然语言查询如何降低噪声？

---

## 背景：实际使用中暴露的问题

一次典型任务是追踪 `pi` 从用户输入到 LLM provider payload 的链路：

```text
InteractiveMode 用户输入
 -> AgentSession.prompt
 -> Agent.prompt / runAgentLoop
 -> streamAssistantResponse
 -> streamSimple / provider.streamSimple
 -> provider-specific payload builder
```

重点字段包括：

- `systemPrompt`
- `messages`
- `tools`

实际探索中，CodeGraph 已经能定位大量关键函数、调用边和候选文件，但仍存在几个影响 agent 判断的问题：

1. trace 返回的是静态可达路径，容易被误读为主业务路径；
2. callback、构造函数注入、对象字段和 provider registry 造成路径断点；
3. 字段级数据流需要源码确认，但 CodeGraph 缺少读写线索；
4. `prompt`、`systemPrompt`、`buildParams`、`convertMessages` 等同名符号需要人工消歧；
5. 长函数只有“签名/范围”和“完整源码”两档，缺少结构导航摘要；
6. `context` / `explore` 在宽泛任务下会返回浅层 UI/DTO 符号，缺少排序解释；
7. callers/callees/trace 边缺少“这是直接调用还是推断/回调绑定”的证据说明；
8. `codegraph_files` 是索引视图，不是完整文件系统视图，未索引文档或新建文件可能不可见。

这些不是单一 bug，而是 CodeGraph 作为 agent 工具从“能查结构”走向“能可靠引导阅读”的产品能力缺口。

---

## 设计定位

### CodeGraph 应承担的职责

CodeGraph 应承担以下结构导航职责：

- 定位符号定义、文件范围、签名、docstring 和精确节点句柄；
- 区分同名符号，帮助用户或 agent 选择当前上下文需要的节点；
- 展示 callers/callees 邻域和静态可达候选路径；
- 在长函数阅读前给出结构入口、关键分支和关键调用点；
- 标注边的证据强度、绑定来源和静态/动态边界；
- 给出可复制的下一步查询建议；
- 提示哪些位置需要通过源码阅读或测试补充验证。

### CodeGraph 不应承诺的职责

CodeGraph 不应承诺：

- 证明运行时真实路径一定发生；
- 完整执行或模拟 TypeScript/JavaScript 动态绑定、闭包、继承、多态和 registry 逻辑；
- 替代 `read` 对长函数控制流的最终确认；
- 自动生成跨 provider 的完整 payload 语义模型；
- 做完整字段级别 alias/dataflow 分析；
- 成为覆盖所有未索引、未跟踪、非代码文件的完整文件系统工具；
- 自动判断业务“主路径”一定正确。

设计原则是：**CodeGraph 给出结构证据、候选路径和下一步检查点；最终运行时语义由 agent 通过源码阅读、测试和人工推理确认。**

---

## 实施可行性校准

本设计定义目标体验，但不应被解读为“首版全部能力必须同时做到”。后续实施计划应把能力拆成三类：

1. **输出层增强**：把已有结构事实更清楚地暴露出来，例如 edge kind、callsite、provenance、resolution confidence、exact handles、static-only caveat 和 copyable next query。此类能力应优先落地，风险低、收益高。
2. **轻量索引/metadata 增强**：为边保留更多可审计来源，例如原始 `referenceName`、调用表达式形态、resolvedBy、confidence、unresolved reference 信息。此类能力支撑 property-call、callback、registry 等证据分类。
3. **按需 AST/模式分析**：长函数结构摘要、字段读写位置、对象构造线索、registry/resolver 候选绑定等能力。此类能力应按语言和模式逐步实现，首版不应承诺跨语言完整覆盖。

除非后续实施计划另有说明，AST-heavy 能力首版宜优先支持 TypeScript / JavaScript / TSX / JSX；其他语言可以降级为已有调用边、范围和“不支持该结构摘要/字段线索”的明确提示。

---

## 用户体验目标

### 1. 结构结果必须可操作

每个结果都应尽量回答：

- 我为什么看到这个节点？
- 我能用哪个精确 handle 继续查？
- 如果它只是候选，为什么不是确定答案？
- 下一步最小验证动作是什么？

### 2. Trace 必须避免“静态可达 = 运行时证明”的误导

Trace 输出应默认提醒：路径是静态图候选，不是运行时证明。对于可疑路径，应说明它为什么被纳入、为什么可能是旁路或可选路径。

### 3. 动态边界应变成可继续探索的线索

当路径断在 callback、对象字段、构造函数参数、registry lookup、framework hook 或 lazy provider 时，工具不应只说“没找到路径”，而应至少指出断点类型、callsite 和可检查位置；成熟阶段再补充更完整的可能绑定位置。

### 4. 同名符号应该被组织，而不是平铺

常见方法名、字段名和 provider helper 不应只作为长列表返回。结果应该按文件、包、调用方或所属 provider 分组，并展示每个候选的可验证上下文。

### 5. 长函数需要中间层导航

在“只看签名”和“读完整函数体”之间，应存在一个结构层，帮助 agent 决定是否需要读完整实现、读哪一段、关注哪些分支。

### 6. 输出应偏向低幻觉、可审计

所有“相关性”“置信度”“高排序静态候选”都应尽量绑定可解释信号，例如名称匹配、路径匹配、调用边、callsite、provenance、scope、候选目标匹配，而不是不可审计的语义猜测。

---

## 能力设计 1：Trace 边证据与绑定透明度

### What

Trace、callers、callees 以及影响路径中，每条边都应尽量展示结构证据。概念字段包括：

```text
edgeKind: calls | references | imports | contains | ...
edgeEvidence: direct-call | property-call | callback | registry | import | type-inferred | name-match
binding: exact | inferred | ambiguous | unresolved
callsite: path:line[:column]
provenance: tree-sitter | scip | heuristic | framework
caveat: short human-readable note
```

这些字段不要求所有边都完整填充；缺失时也应明确说明“未知/未记录”，避免用户误以为边被强证明。

首版可优先复用已有或容易补充的数据来源：

- `edge.kind` → `edgeKind`；
- `edge.line` / `edge.column` → `callsite`；
- `edge.provenance` → `provenance`；
- `edge.metadata.confidence` / `edge.metadata.resolvedBy` → confidence、resolution source、binding hint；
- 额外持久化的原始 `referenceName` 或 call expression shape → `property-call`、`callback`、`registry` 等更细 evidence。

如果缺少原始调用形态，不应猜测 edgeEvidence；应显示 `unknown` / `not-recorded` 并给出源码检查建议。

### Why

当前 trace 只展示路径时，用户很难判断：

- 这是源码里直接调用的函数吗？
- 这是通过对象字段调用的吗？
- 是 registry 里按字符串或 model api 选择的吗？
- 是 name matching 推断出来的吗？
- 这个边是否需要 `read` 确认？

边证据透明度可以显著降低误读风险，使 agent 能基于证据强弱决定下一步检查策略。

### Expected Outcome

用户看到路径时，可以立即区分：

```text
A -> B  direct-call, exact, callsite src/a.ts:42
B -> C  callback, inferred, binding source unknown
C -> D  registry, ambiguous, candidates available
```

而不是把三者都当成同等强度的调用链。

---

## 能力设计 2：动态边界提示与候选绑定线索

### What

当 trace 或 callees 遇到以下模式时，应把它标记为动态边界，并至少给出精确 callsite、enclosing node 和下一步检查点；候选绑定来源应分阶段增强，不能作为首版完整性承诺：

- 函数参数作为 callback 被调用；
- 构造函数 options 赋值到实例字段；
- 对象字段函数调用，例如 `config.streamFn(...)`；
- provider registry / resolver / lookup；
- extension hook、event handler、middleware、route handler；
- lazy registration 或 plugin 注册；
- framework 自动调用的生命周期方法。

成熟输出形态（候选绑定推断可作为后续增强逐步补齐）：

```text
Trace reached dynamic boundary: config.streamFn
Boundary type: callback-property-call
Callsite: packages/agent/src/loop.ts:123
Possible binding sites:
- Agent.constructor options.streamFn -> this.streamFn
- createAgentSession new Agent({ streamFn })
- streamAssistantResponse passes streamSimple as streamFn
Next checks:
- codegraph_node({ nodeId: "..." })
- codegraph_callees({ fileLine: "..." })
```

P0 最小版只需做到：指出动态边界类型、callsite、所在节点、未闭合原因，并给出可复制 next checks。完整列出所有构造函数参数、对象字段赋值和注册点候选应作为后续增强。

### Why

动态边界是 TypeScript/JavaScript agent code 中最常见的 trace 断点。要求 CodeGraph 自动闭合所有运行时绑定不现实，但要求它把断点变成可操作线索是合理的。

这会把“trace 失败”转化为“下一步该看哪里”，减少 agent 回到盲目 grep 的概率。

### Expected Outcome

在无法静态闭合路径时，用户仍能得到：

- 断在哪个符号/字段/参数；
- 为什么这里不是强静态边；
- 首版给出可检查的赋值、构造调用或注册点线索；后续再扩展为更完整的候选绑定链；
- 下一步应检查哪些精确位置。

---

## 能力设计 3：Trace 路径排序、旁路提示与证据化理由

### What

Trace 应返回候选路径，而不是单一“答案路径”。每条路径应包含排序理由和 caveat。

路径可被标记为：

- `higher-ranked-static-candidate`：静态证据排序更靠前的候选；不是运行时主路径证明；
- `alternate-static-candidate`：静态可达但可能是旁路；
- `optional-branch`：位于 preflight、retry、compaction、cleanup、error handling 等条件分支；
- `low-evidence`：依赖推断、宽泛匹配或动态边界；
- `incomplete`：到达某个边界后未闭合到目标。

排序理由应尽量基于可审计信号：

- endpoint 是否由 exact locator 指定；
- 路径长度；
- direct-call 边比例；
- 是否在用户指定 scope 内；
- 是否经过名称上暗示旁路的节点，例如 `compact`、`retry`、`cleanup`、`fallback`、`error`；
- callsite 顺序与包含关系；
- 是否经过用户指定的中间锚点；
- 是否涉及 tests、fixtures、examples、generated files。

### Why

在实际案例中，`AgentSession.prompt -> _checkCompaction -> _runAutoCompaction -> compact -> completeSimple -> streamSimple` 是静态可达路径，但不是“用户本轮输入发给 provider”的主流程。

CodeGraph 不应假装一定知道业务主路径，但可以通过可解释排序和旁路提示，避免把旁路路径放在最像答案的位置。

### Expected Outcome

Trace 结果不再只说“找到了路径”，而是说：

```text
Path 1: higher-ranked-static-candidate
Reason: shorter direct-call chain, stays in requested scope, reaches target through agent loop. Static ranking only, not runtime proof.

Path 2: optional-branch
Reason: passes through compaction/preflight names and is guarded by context-size checks.
Caveat: static path exists, but likely not the normal user-turn provider path.
```

---

## 能力设计 4：同名符号消歧增强

### What

当搜索、node lookup、trace endpoint 或 target discovery 命中多个同名/近名符号时，结果应被组织成有上下文的候选组。

每个候选至少应显示：

- `nodeId`；
- `qualifiedName`；
- `kind`；
- `range`；
- `signature`（如有）；
- 所在文件/包；
- 直接 callers/callees 摘要；
- 与当前查询相关的 reason；
- 是否为 exact、partial、lexical、path 或 graph-proximity match。

示例：

```text
buildParams candidates:
1. providers/anthropic.ts::buildParams
   Reason: called by streamAnthropic; provider-specific payload builder.
2. providers/openai-responses.ts::buildParams
   Reason: called by streamOpenAIResponses; provider-specific payload builder.
3. providers/google.ts::buildParams
   Reason: called by streamGoogle; provider-specific payload builder.
```

### Why

同名符号是 agent 误读的高频来源。`prompt`、`run`、`execute`、`buildParams`、`convertMessages`、`systemPrompt` 这类名称在大型 TypeScript codebase 中必然重复。

只返回平铺列表会迫使 agent 通过多轮调用自行判断；结构化分组可以直接把选择依据展示出来。

### Expected Outcome

用户能按当前问题快速选择候选，例如：

- 若 `model.api` 是 `anthropic`，选择 Anthropic provider 的 `buildParams`；
- 若起点是 `AgentSession.prompt`，优先选择同一 flow 中被调用的 `Agent.prompt`，而非 UI 或 harness 的 `prompt`。

---

## 能力设计 5：长函数结构摘要

### What

`codegraph_node` 应提供介于“签名/范围”和“完整源码”之间的结构摘要模式，例如 `detail: "structure"` / `structure: true`。首版宜优先支持 TypeScript / JavaScript / TSX / JSX；其他语言可以降级为“关键调用点/范围”或明确说明暂不支持。

结构摘要应聚焦阅读导航，而不是语义证明。它应尽量列出：

- early returns；
- major branches；
- guard/preflight/check blocks；
- loop；
- try/catch/finally；
- 关键调用点；
- callback 调用点；
- 对象字面量构造；
- 字段读写；
- 返回值构造；
- 长函数中的大致源码范围。

示例目标形态：

```text
AgentSession.prompt structure:
1. extension command early return
2. input hook transform/handled branch
3. skill/template expansion
4. streaming steer/followUp branch
5. model/auth validation
6. compaction preflight
7. build user message
8. inject nextTurn/custom messages
9. apply per-turn systemPrompt
10. run agent prompt
```

### Why

长函数往往是架构流的入口，但直接 `includeCode:true` 会消耗大量上下文；只看签名又无法判断关键分支。

结构摘要让 agent 先知道函数内部有哪些主要区域，再决定是否读完整函数、读哪个范围、或者先追哪个 callee。

### Expected Outcome

对于长函数，agent 的流程从：

```text
node -> includeCode full body -> 手动扫读
```

变成：

```text
node -> structure summary -> targeted read/includeCode -> 验证关键分支
```

---

## 能力设计 6：字段读写位置与对象构造线索

### What

CodeGraph 应提供轻量字段线索能力，给定字段名、属性名或 payload key，返回相关读写与对象构造位置。该能力适合独立为 `codegraph_field_sites` 或作为 node/explore 的 follow-up mode；首版宜优先支持 TypeScript / JavaScript 的 assignment、object literal、destructuring 和 property read/write。

它应覆盖线索级别的信息：

- property assignment，例如 `state.systemPrompt = ...`；
- object literal key，例如 `{ systemPrompt, messages, tools }`；
- destructuring，例如 `const { systemPrompt } = context`；
- property read，例如 `context.systemPrompt`；
- array map/filter/reduce 中涉及的字段；
- provider payload 中字段映射，例如 `systemPrompt -> system`；
- 相关函数参数名和返回对象字段。

输出应明确分类：

```text
systemPrompt related sites:
Writes:
- AgentSession._rebuildSystemPrompt writes base/custom prompt options
- AgentSession.setActiveToolsByName writes agent.state.systemPrompt
Reads:
- Agent.createContextSnapshot reads this._state.systemPrompt
Object construction:
- streamAssistantResponse constructs Context.systemPrompt
Provider mapping:
- Anthropic buildParams writes params.system from context.systemPrompt
```

### Why

字段流转是理解 provider payload、request/response transform、state snapshot 等代码的核心。但完整 dataflow 和 alias analysis 代价很高，也容易给出错误保证。

线索级能力足以把 agent 带到关键读写点，再由源码阅读确认实际数据流。

### Expected Outcome

当用户问“`tools` 最终如何进入 provider payload？”时，CodeGraph 不必完整证明跨函数数据流，但应能返回关键读写/构造/映射位置，让 agent 用少量 `read` 验证。

---

## 能力设计 7：Registry / resolver 模式候选提示

### What

对于 provider、tool、extension、route、framework handler 等 registry/resolver 模式，CodeGraph 应在识别到明确模式时展示候选注册项和对应处理函数；无法识别时应把 resolver/lookup 标为动态边界，并给出 next checks，而不是假装选中唯一实现。

概念输出：

```text
Provider registry candidates for model.api:
- anthropic -> streamAnthropic -> buildParams
- openai -> streamOpenAIResponses -> buildParams
- google -> streamGoogle -> buildParams

Resolver:
- resolveApiProvider(model.api)
Caveat:
- Runtime value of model.api selects one provider; CodeGraph lists candidates, not a unique runtime branch.
```

### Why

大量现代 agent 或 server code 使用 registry/resolver 把字符串、配置、model id、route、extension name 映射到实现。静态调用图通常只能到 resolver，无法知道运行时选择哪一个。

列出候选注册项比尝试假装选中唯一实现更可靠，也更适合人/agent 按上下文继续判断。

### Expected Outcome

用户可以按已知 runtime condition 选择候选，例如：

- `model.api = anthropic` 时看 Anthropic stream；
- route path 是 `/api/chat` 时看对应 route handler；
- extension name 是 `foo` 时看对应 hook。

---

## 能力设计 8：`context` / `explore` 排名解释

### What

`codegraph_context` 和 `codegraph_explore` 在返回候选 entry points、files、symbols 时，应提供简短 reason 和证据等级。实施上需要尽量保留搜索/排序阶段的来源信号；如果 reason 未被记录，应明确显示 `reason: not recorded`，不要事后编造。

Reason 应基于可解释信号，例如：

- exact symbol/name match；
- qualifiedName/path match；
- file path/package scope match；
- docstring/signature match；
- caller/callee proximity；
- route/provider/framework role；
- graph centrality；
- lexical-only match；
- generic/common symbol penalty。

示例：

```text
InteractiveMode.setupEditorSubmitHandler
Reason: high signal; writes editor submit handler and reaches AgentSession.prompt.

Text
Reason: low signal; lexical/UI component match only; generic symbol name.
```

### Why

自然语言任务很容易匹配到浅层 UI 组件、DTO、类型别名或泛用名字。没有 reason 时，agent 需要额外多轮查询才能判断哪些结果值得读。

Ranking reason 让用户可以快速筛掉“词面相关但流程无关”的结果。

### Expected Outcome

宽泛查询下，即使返回了一些噪声结果，agent 也能根据 reason 优先选择真正的入口函数、调用中枢和 provider 构造点。

---

## 能力设计 9：可复制的下一步查询建议

### What

当 CodeGraph 输出 caveat、dynamic boundary、ambiguity 或 incomplete trace 时，应给出可直接复制的下一步查询建议。

建议应尽量使用 exact handles：

```text
Next suggested checks:
- codegraph_node({ nodeId: "..." })
- codegraph_callees({ nodeId: "..." })
- codegraph_trace({ fromNodeId: "...", toNodeId: "...", maxDepth: 8 })
- read packages/foo/src/bar.ts:120-180
```

不要只说：

```text
Try explore.
```

### Why

CodeGraph 的价值在于减少 agent 的探索成本。泛泛建议会把选择负担还给 agent；可复制查询则把结构证据直接转化为下一步动作。

### Expected Outcome

用户或 agent 可以从一个不完整 trace 无缝进入下一轮精确定位，而不是回到 grep/read 盲搜。

---

## 能力设计 10：索引覆盖提示与文件定位辅助

### What

CodeGraph 应明确展示它返回的是索引视图，而不是完整文件系统视图。文件相关工具应帮助用户判断“没有结果”的原因。

期望能力包括：

- 显示 indexed files only 的提示；
- 显示索引语言、路径覆盖和排除规则摘要；
- 支持按 filename/glob/path 过滤索引文件；
- 当文件不在索引中时，提示可能原因：未同步、新建文件、非支持语言、被 ignore、非代码文件；
- 必要时建议使用 `git status`、`find`、`read` 或重新 sync。

### Why

在实际使用中，新建 Markdown 文档或未索引文件可能不会出现在 `codegraph_files` 中。如果工具沉默地返回空结果，agent 容易误判文件不存在。

这不是要求 CodeGraph 替代文件系统工具，而是要求它诚实说明索引覆盖边界。

### Expected Outcome

用户看到：

```text
No indexed files matched docs/foo.md.
Note: codegraph_files only lists indexed files. The file may be new, ignored, unsupported, or not synced.
Suggested checks: git status, read docs/foo.md, codegraph sync.
```

---

## 能力设计 11：Workspace package import 链接提示

### What

在 monorepo 中，当代码 import workspace package 时，CodeGraph 应尽量提示 import specifier 对应的源文件候选。

示例：

```ts
import { streamSimple } from "@earendil-works/pi-ai";
```

期望提示：

```text
Workspace import candidate:
- packages/ai/src/stream.ts
- packages/ai/src/index.ts re-export streamSimple
```

### Why

Agent 在 monorepo 中经常遇到 package-level import。如果 CodeGraph 只停在 package specifier，用户仍需手动查 package.json、exports、tsconfig paths 和 index re-export。

源文件候选可以显著缩短跨 package 调用链探索。

### Expected Outcome

Trace 或 explore 遇到 workspace import 时，可以把用户带到实际源码候选，而不是停在包名。

---

## 工具形态建议

不建议把所有能力都塞进 `codegraph_trace`。后续实施计划可以采用渐进式工具形态：

- `codegraph_trace`：保留为路径候选、边证据、gaps、dynamic boundaries 和 next checks 的主工具；
- `codegraph_node({ detail: "structure" })` 或等价选项：提供长函数结构摘要；
- `codegraph_field_sites`：按字段/属性/payload key 返回读写、对象构造和映射线索；
- trace boundary follow-up：当 trace 断在 callback/property/registry 时，建议具体 `node` / `callees` / `field_sites` 查询。

这样可以保持默认 trace 输出紧凑，并让字段线索、结构摘要、registry 候选按需展开。

---

## 优先级建议（设计层面）

这不是实施计划，但为了给后续 plan 提供输入，设计上建议按风险和依赖关系分阶段。

### P0a：输出层可信度与可操作性

P0a 应聚焦“避免误导”和“让下一步可执行”，优先利用已有图数据：

1. trace/callees/callers 输出 edge kind、callsite、provenance、resolution confidence / resolvedBy（如有）；
2. 每条 trace 输出明确 static-only / not runtime proof caveat；
3. ambiguity 输出 exact handles，并按文件、包、调用方或 provider 分组；
4. caveat、ambiguity、incomplete trace 附带可复制 next query；
5. `codegraph_files` 和 no-match 结果明确 indexed-only 边界。

这部分应作为首批实现，因为它主要是 API / formatter / metadata 暴露问题，风险低且直接提升可信度。

### P0b：动态边界最小版

P0b 不要求自动闭合动态绑定链，只要求把断点变成可操作线索：

1. 识别 unresolved / low-evidence / property-call-like / callback-like / registry-like 边界；
2. 输出 boundary type、callsite、enclosing node、为什么未闭合；
3. 给出 exact next checks，例如 `codegraph_node`、`codegraph_callees`、`read path:start-end`；
4. 当缺少原始调用形态时，明确显示 `not-recorded` 而不是猜测。

完整候选绑定来源（constructor options、object field assignment、registry map）应进入后续阶段。

### P1：排序与轻量候选推断

P1 应聚焦减少误读和噪声：

1. trace 路径排序、旁路提示和证据化 reason；
2. 保存或利用原始 `referenceName` / call expression shape 来区分 direct-call、property-call、callback、name-match；
3. 针对常见 constructor option、object field assignment、registry map 的候选绑定提示；
4. `context` / `explore` 排名解释，保留 search channel / graph proximity / generic-name penalty 等 reason。

### P2：按需阅读导航能力

P2 应聚焦降低源码阅读成本，且应明确语言和模式覆盖范围：

1. 长函数结构摘要；
2. 字段读写位置与对象构造线索；
3. registry/resolver 候选提示的更多模式；
4. 针对 TS/JS 以外语言的逐步支持或明确降级提示。

### P3：边界说明与生态增强

P3 应聚焦边界清晰和 monorepo 体验：

1. workspace package import 源文件候选提示；
2. 更丰富的 coverage/status 解释；
3. package.json workspaces / exports / main/types 等解析提示。

这些能力重要，但可以在核心 trace 可信度能力之后实施。

---

## 非目标

以下能力不应作为近期硬性目标：

- 完整运行时路径证明；
- 自动执行或模拟 JavaScript/TypeScript 动态行为；
- 完整跨 provider payload schema 抽象；
- 完整字段级 dataflow、alias analysis 和 interprocedural analysis；
- 自动判断业务主路径一定正确；
- 替代 `read`、测试或人工代码审查；
- 覆盖所有未索引/未跟踪文件的完整文件系统能力；
- 依赖 LLM 生成不可审计的语义解释作为核心证据。

这些能力可以由 Coding Agent 在 CodeGraph 结构定位之后，通过源码阅读、运行命令、测试和人工推理补齐。

---

## 与既有 Addressability / Trace 设计的关系

已有设计文档 [`docs/codegraph-addressability-and-trace-design.md`](./codegraph-addressability-and-trace-design.md) 定义了两个基础能力：

1. 所有结果应暴露可复用 exact handles；
2. trace 应成为一等图操作，返回候选路径、handles、gaps 和 recommendations。

本设计建立在这些基础之上，进一步强调真实 agent 使用中的可用性与可信度：

- addressability 解决“怎么精确指向节点”；
- base trace 解决“怎么返回候选路径”；
- 本设计解决“怎么让路径证据、动态边界、排序理由、字段线索和下一步动作足够清楚，不误导 agent”。

因此，后续实施计划可以把已有 addressability/trace 能力作为前置基础，再分阶段补充本设计中的证据透明度、动态边界、结构摘要和线索能力。

---

## 验收结果：一个好用的 CodeGraph 应如何表现

实施完成后，在类似“用户输入到 provider payload”的任务中，理想体验应是：

1. 用户或 agent 用 `context` 找到入口候选；
2. 候选带 reason，浅层 UI/DTO 结果被标为低信号；
3. agent 用 exact handle 从 `AgentSession.prompt` trace 到 provider 目标；
4. trace 返回多条路径，并标注高排序静态候选、旁路候选和动态边界；
5. 每条边展示 callsite、evidence、binding 和 caveat；
6. 在 `streamFn`、provider registry、callback 等位置，输出可能绑定来源；
7. 对 `systemPrompt`、`messages`、`tools`，工具返回字段读写和对象构造线索；
8. 对 `buildParams`、`convertMessages` 等同名函数，结果按 provider 分组；
9. 对长函数，agent 先看结构摘要，再精准读取关键范围；
10. 所有不确定点都附带可复制的下一步查询；
11. 回答中能清楚区分“CodeGraph 静态证明的结构边”和“源码阅读补齐的运行时判断”。

### 可测试验收标准

后续实施计划应把理想体验拆成可测试的 acceptance criteria，例如：

- trace path 中每条 edge 都显示 `edgeKind`，并显示 `callsite` 或明确 `callsite: unknown`；
- 当 edge 来源为 fuzzy/name-match/heuristic 时，输出 `low-evidence` 或等价 caveat；
- ambiguous symbol lookup 返回 exact handles，不 silently 选择唯一答案；
- incomplete trace 返回至少一个 exact next check；
- `codegraph_files` no-match 输出必须提示 indexed-only，并建议 `git status` / `read` / `codegraph sync`；
- TS/JS long-function structure fixture 至少识别 major branches、early returns、try/catch、关键调用点；
- TS/JS field-sites fixture 至少覆盖 assignment、object literal key、destructuring、property read/write；
- registry fixture 能列出 pattern-recognized candidates；无法识别时必须输出 resolver boundary，而不是唯一 runtime branch。

---

## 设计原则回顾

1. **结构优先**：CodeGraph 先定位结构节点和边，不替代最终源码确认。  
2. **证据透明**：每条路径和排序理由都应尽量可审计。  
3. **边界诚实**：动态、推断、registry、callback 必须显式标注。  
4. **逐步披露**：默认输出紧凑，必要时再展开源码或结构摘要。  
5. **可复制操作**：结果应直接给下一步 exact query。  
6. **不夸大能力**：静态候选路径不是运行时证明，字段线索不是完整 dataflow。  
7. **服务 agent 工作流**：核心目标是减少盲搜、降低误读、把阅读集中到最相关的代码范围。
