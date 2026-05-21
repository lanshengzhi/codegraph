# CodeGraph 结构导航可用性增强：拆解路线图

> 关联设计：[`docs/codegraph-structural-navigation-usability-design.md`](../codegraph-structural-navigation-usability-design.md)  
> 前置基础：[`docs/codegraph-addressability-and-trace-design.md`](../codegraph-addressability-and-trace-design.md)、[`docs/plans/2026-05-21-codegraph-addressability-and-trace-tdd-plan.md`](./2026-05-21-codegraph-addressability-and-trace-tdd-plan.md)  
> 状态：roadmap / P0 implemented, P0b+ planning input  
> 范围：把结构导航可用性设计拆解成可独立验收、可 TDD 实施的计划批次。

---

## 结论

`codegraph-structural-navigation-usability-design.md` 不应作为单个实施计划一次落地。它覆盖了多类工作：

1. MCP / formatter 输出增强；
2. trace 结果排序、证据化与下一步建议；
3. extraction / resolution metadata 增强；
4. TS/JS AST 按需分析；
5. 新工具能力，例如字段读写线索、registry 候选、workspace import 辅助。

这些工作的风险、测试方式、触及模块和上线顺序都不同。应拆成多个 plan，先实施低风险且收益最高的输出层增强，再逐步进入索引 metadata 与 AST-heavy 能力。

---

## 当前基础

当前代码已经具备以下前置能力：

- Addressability：结果中已有 `nodeId`、`qualifiedName`、`range` 等 handle 输出；`node` / `callers` / `callees` / `impact` / `trace` 支持 exact locator。
- Trace：已有 `CodeGraph.trace()`、`GraphTracer` 与 MCP `codegraph_trace`，可返回 path-shaped 结果、edge kind、callsite line、target candidates、gaps、recommendations。
- Edge metadata：resolution 阶段已为 resolved edge 写入 `metadata.confidence` 与 `metadata.resolvedBy`；`Edge` 类型也支持 `provenance`、`line`、`column`。
- 文件视图：`codegraph_files` 已从索引返回 tree/flat/grouped 视图；P0 已增强 no-match 输出，明确 indexed-only 边界与 sync/read 检查建议。

因此首批增强应优先复用已有数据，而不是先引入 schema migration、LSP、compiler API 或完整 dataflow。

---

## 拆解原则

1. **先输出层，后分析层**：先把已有图事实说清楚，再决定是否增加索引字段或 AST 分析。
2. **先避免误导，后提升智能**：static-only、confidence、resolvedBy、callsite、unknown/not-recorded 的明确展示优先于复杂推断。
3. **每批可独立验收**：每个 plan 都应有自己的测试 fixture、acceptance criteria 和非目标。
4. **不把 trace 做成万能工具**：字段线索、长函数结构摘要、registry 候选应按需工具化或 follow-up 化，避免默认 trace 输出膨胀。
5. **语言覆盖诚实**：AST-heavy 能力首版优先 TS/JS/TSX/JSX；其他语言明确降级。
6. **不承诺运行时证明**：所有 trace / ranking / dynamic boundary 输出都必须说明是静态候选，不是 runtime proof。

---

## Roadmap 分期

### P0：输出层可信度与可操作性（已完成）

**状态：** implemented / validated (2026-05-21)。详见 [`2026-05-21-structural-navigation-p0-output-plan.md`](./2026-05-21-structural-navigation-p0-output-plan.md) 的实施结果与验收清单。

**目标：** 不改变索引 schema，不引入新分析器，只把现有结构事实更清楚地暴露给 agent。

**主要能力：**

- trace / callers / callees 输出 edge kind、callsite、provenance、confidence、resolvedBy；缺失时显示 `unknown` / `not-recorded`。
- trace 输出更显眼的 static-only / not runtime proof caveat。
- ambiguity / incomplete trace / no path 附带可复制 next checks。
- ambiguity 输出按文件或上下文更易读地组织 exact handles。
- `codegraph_files` no-match 明确 indexed-only 边界，并建议 `git status` / `read` / `codegraph sync`。

**预计触及：**

- `src/types.ts`
- `src/graph/trace.ts`
- `src/index.ts`
- `src/mcp/tools.ts`
- `__tests__/trace.test.ts`
- 可能新增 MCP files / ambiguity 相关测试

**明确不做：**

- schema migration；
- call expression shape 持久化；
- dynamic binding 自动闭合；
- long-function structure；
- field-sites 工具；
- registry candidates。

**详细计划：** [`2026-05-21-structural-navigation-p0-output-plan.md`](./2026-05-21-structural-navigation-p0-output-plan.md)

---

### P0b：动态边界最小版

**目标：** 不要求自动闭合动态绑定链，只把 trace 断点变成可操作线索。

**主要能力：**

- 对 low-confidence / fuzzy / framework / unresolved / not-recorded edge 给出边界或低证据 caveat。
- 当 trace 未闭合时，输出可能的 boundary type、enclosing node、callsite、未闭合原因。
- 给出 exact follow-up：`codegraph_node`、`codegraph_callees`、`read path:start-end`。
- 缺少原始调用形态时明确 `not-recorded`，不猜测 callback/property/registry。

**预计触及：**

- `src/graph/trace.ts`
- `src/index.ts`
- `src/mcp/tools.ts`
- trace 相关测试 fixture

**明确不做：**

- constructor option / object field assignment 的完整候选绑定；
- provider registry 全自动解析；
- framework lifecycle 全覆盖。

---

### P1：edge metadata 与排序理由

**目标：** 增加更可审计的索引 metadata，并让 trace/context/explore 的排序理由更透明。

**主要能力：**

- resolution/extraction 为 edge metadata 保留更多来源信号，例如 `referenceName`、`referenceKind`、可能的 receiver/property/callee text。
- 区分 direct-call、property-call、name-match、framework、fuzzy 等 edge evidence。
- trace path 排序理由：direct-call ratio、edge confidence、scope match、test/generated penalty、optional-branch keyword penalty。
- `codegraph_context` / `codegraph_explore` entry/file/symbol reason 最小版：exact name/path match、graph proximity、generic name penalty。

**预计触及：**

- `src/extraction/*`
- `src/resolution/*`
- `src/db/queries.ts`
- `src/types.ts`
- `src/context/*`
- `src/mcp/tools.ts`
- extraction / resolution / trace / context tests

**明确不做：**

- 完整控制流；
- 完整 alias/dataflow；
- registry runtime branch 唯一判定。

---

### P2a：长函数结构摘要

**目标：** 为 `codegraph_node` 提供介于签名和完整源码之间的结构导航层。

**建议形态：**

```text
codegraph_node({ nodeId, detail: "structure" })
```

或等价选项。

**首版范围：** TS/JS/TSX/JSX。

**主要能力：**

- early returns；
- major branches / guards；
- loops；
- try/catch/finally；
- 关键 callsites；
- callback invocation hints；
- object literal construction hints；
- 返回值构造位置。

**明确不做：**

- LLM summary；
- 跨语言完整支持；
- 语义证明；
- 替代 `read`。

---

### P2b：字段读写与对象构造线索

**目标：** 新增按字段 / payload key 定位读写、对象构造、映射位置的线索能力。

**建议形态：**

```text
codegraph_field_sites({ field: "systemPrompt" })
```

或作为 node/explore follow-up mode，但默认不塞进 trace。

**首版范围：** TS/JS/TSX/JSX。

**主要能力：**

- assignment；
- object literal key；
- destructuring；
- property read/write；
- return object fields；
- provider payload key mapping hints。

**明确不做：**

- 完整 interprocedural dataflow；
- 完整 alias analysis；
- 证明字段一定到达 runtime payload。

---

### P3：registry / workspace import / coverage 生态增强

**目标：** 改善 monorepo、registry/resolver 和索引覆盖边界体验。

**主要能力：**

- registry/resolver pattern candidates；
- provider/tool/extension/route candidate listing；
- workspace package import source candidate；
- package.json workspaces / exports / main/types 解析提示；
- richer coverage/status explanation。

**明确不做：**

- runtime branch 唯一判定；
- 完整 Node package resolver 兼容；
- 替代文件系统视图。

---

## 推荐实施顺序

1. ✅ P0 输出层计划已完成并通过验证。
2. 基于 P0 实际输出痛点细化 P0b。
3. P0b 完成后，再决定 P1 metadata 是否需要 schema migration 或仅扩展 JSON metadata。
4. P2a 与 P2b 可并行规划，但应分开实现，因为一个是 node structure，一个是 field/key sites。
5. P3 等核心 trace 可信度体验稳定后再做。

---

## 每阶段通用验收门槛

每个 plan 至少应包含：

- TDD 测试列表；
- 明确非目标；
- 受影响文件；
- focused validation 命令；
- 是否需要更新：
  - `src/mcp/server-instructions.ts`
  - `src/installer/instructions-template.ts`
  - `.cursor/rules/codegraph.mdc`
  - README / CHANGELOG

按照仓库规则：如果改变 MCP 工具行为或 agent 使用方式，实施阶段必须同步更新上述 agent-facing instructions；如果是发布前用户可见能力变化，还应补 CHANGELOG。

---

## 全局非目标

本 roadmap 不把以下能力作为近期硬性目标：

- 完整运行时路径证明；
- JavaScript/TypeScript 动态行为模拟；
- 完整字段级 dataflow / alias analysis；
- 跨 provider payload 语义模型；
- 自动判断业务主路径一定正确；
- 替代源码阅读、测试或人工审查；
- 覆盖所有未索引/未跟踪文件的完整文件系统能力。

---

## 待细化问题

1. P1 是否需要 schema migration，还是继续使用 edge `metadata` JSON 承载新增字段？
2. `codegraph_node` 的结构摘要参数采用 `detail: "structure"`、`structure: true`，还是独立工具？
3. `codegraph_field_sites` 是否作为 MCP 新工具，还是先做库 API 后接 MCP？
4. registry candidates 的首批 pattern 选择 provider registry、route registry，还是 workspace imports？
5. context/explore 的 reason 是直接在 markdown 中输出，还是先增加结构化内部结果再格式化？
