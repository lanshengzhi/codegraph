# CodeGraph Addressability and Trace Design

**Status:** draft design input for implementation planning  
**Scope:** MCP/user-facing capabilities for precise node lookup and flow tracing  
**Focus:** what should exist and why; implementation details are intentionally deferred to a follow-up plan

---

## Summary

This design covers two related capabilities:

1. **Addressability** — every CodeGraph result should expose a precise, reusable way to refer to the underlying symbol or source location.
2. **Trace** — CodeGraph should offer a first-class flow-tracing tool that returns likely graph paths between an entry point and target code areas, instead of requiring agents to manually stitch together `callers`, `callees`, `node`, `explore`, and `read` calls.

These capabilities address the most common usability gaps observed when agents use CodeGraph for architecture and lifecycle questions:

- ambiguous same-name symbols;
- inability to jump from `file:line` to a symbol;
- search results that are not directly reusable as exact follow-up inputs;
- manual call-chain reconstruction across layers;
- shallow `codegraph_context` results for broad flow questions.

The intent is not to replace `read`, tests, compiler checks, LSP, or future embedding-based semantic search. The intent is to make the existing graph easier to address precisely and to make graph traversal a first-class workflow.

---

## Background and Problem Statement

CodeGraph already stores the core facts needed for precise navigation:

- node IDs;
- names and qualified names;
- file paths;
- start and end lines;
- call/reference/import/containment edges;
- edge callsite locations where available.

However, the current MCP-facing workflow often hides or underuses those facts. A typical agent session looks like this:

1. `codegraph_context` finds a few likely entry points.
2. The agent runs `codegraph_search` for better symbol names.
3. Search results show file and line, but not a reusable exact handle.
4. `codegraph_node("systemPrompt")` may select a different same-name symbol.
5. `file.ts:123` cannot be passed back to `codegraph_node`.
6. The agent uses several `codegraph_callees` calls and then `read` to manually assemble a flow.

This is not just an instruction problem. The usage guide can teach a staged workflow, but the tool surface should make the precise path the easiest path.

---

## Design Goals

### 1. Make every result actionable

A symbol returned by any CodeGraph tool should include enough information to be copied into the next tool call without relying on fuzzy name lookup.

### 2. Prefer explicit disambiguation over silent best-match selection

When a query matches multiple same-name symbols, CodeGraph should surface ambiguity as part of the response and offer exact handles for follow-up.

### 3. Support source-location-based navigation

Agents often start from compiler errors, stack traces, grep output, prior `read` output, or search results. All of those commonly identify code as `path:line`. CodeGraph should accept that as a first-class locator.

### 4. Keep natural language and exact lookup separate

`codegraph_context` can remain the orientation tool. Exact lookup tools should accept exact locators and should not depend on broad natural-language matching once a locator exists.

### 5. Make flow tracing a first-class graph operation

End-to-end questions should not require the agent to manually chain many local graph calls. CodeGraph should return candidate paths, confidence, gaps, and recommended next inspection steps.

### 6. Preserve progressive disclosure

Default responses should stay compact. Detailed code bodies, large traces, or multiple alternatives should be opt-in or capped.

### 7. Stay backward compatible

Existing symbol-string calls should continue working. New precise locators should enhance, not replace, current workflows.

---

## Capability 1: Addressability

### What Addressability Means

Addressability means CodeGraph exposes and accepts precise references to graph nodes and source ranges.

A CodeGraph result should not only say:

```text
systemPrompt (method) - packages/coding-agent/src/core/agent-session.ts:743
```

It should also expose a stable, reusable handle shape such as:

```text
nodeId: <opaque-node-id>
qualifiedName: AgentSession::systemPrompt
path: packages/coding-agent/src/core/agent-session.ts
startLine: 743
endLine: 746
```

The exact serialized format can be decided in the implementation plan. The important design property is that every result contains both:

- **machine-precise identity**: `nodeId`;
- **human-auditable identity**: `qualifiedName`, `path`, `startLine`, `endLine`.

### Locator Types

CodeGraph should conceptually support these locator types across applicable tools:

| Locator | Purpose |
|---|---|
| `nodeId` | Exact graph-node lookup. No ambiguity. |
| `qualifiedName` | Human-readable symbol identity when available. |
| `symbol + path` | Resolve same-name symbols by file scope. |
| `path + line` | Resolve the innermost symbol containing a source line. |
| `file:line` string | Convenience form for stack traces, grep output, and read output. |
| `symbol` | Backward-compatible fuzzy/current lookup mode. |

### Required Behavior

#### Search results should return handles

`codegraph_search` should return each match with:

- node ID;
- name;
- kind;
- qualified name;
- path;
- start line;
- end line;
- signature when available.

Why: search is often the first step. If it does not expose an exact handle, every follow-up repeats an ambiguous lookup.

#### Node lookup should accept exact locators

`codegraph_node` should support exact lookup by `nodeId` and source location, in addition to the existing `symbol` lookup.

Why: once an agent has a handle or a `path:line`, the next call should not go through search ranking again.

#### Call graph tools should accept exact locators

`codegraph_callers`, `codegraph_callees`, and `codegraph_impact` should accept the same locator family.

Why: ambiguous symbol names are common for methods like `run`, `execute`, `prompt`, `systemPrompt`, `build`, and `render`. Call graph questions are where ambiguity is most damaging.

#### Ambiguous symbol lookup should return alternatives with handles

If a symbol-only query matches multiple exact symbols, CodeGraph should return or append an ambiguity section containing exact handles for all plausible matches.

Why: the current behavior may choose a deterministic first result, but the user/agent cannot reliably turn the alternatives into exact follow-up calls.

#### `path + line` should resolve to the innermost symbol

Given a file and line, CodeGraph should select the smallest source range that contains that line. For example, a line inside a method should resolve to the method rather than the class or file node.

If no symbol contains the line, the result should identify that no exact symbol covers the line and may return nearby symbols as alternatives.

Why: compiler errors and stack traces usually point inside function bodies; the useful target is the nearest executable or defining symbol.

#### Result ranges should be explicit

Node detail responses should include start and end lines even when code is not included.

Why: agents can choose a precise `read` range without first retrieving a full body.

### Why Addressability Should Come First

Addressability is foundational. It directly improves existing tools without requiring new indexing technology.

It solves or reduces:

- same-name symbol ambiguity;
- inability to use `file:line` from external tools;
- repeated fuzzy lookup across tool calls;
- unnecessary `read` calls just to recover line ranges;
- low operability of search results.

It also provides the input model needed by `codegraph_trace`. A trace tool is much less useful if its entry and target endpoints cannot be specified exactly.

### Non-Goals for Addressability

Addressability does not require:

- embedding search;
- LSP integration;
- new semantic resolution;
- long-function summarization;
- changes to the underlying graph schema, unless the implementation plan finds missing fields.

It also should not claim that node IDs are permanent across all future re-indexes and code moves unless the implementation plan explicitly guarantees that. Treat `nodeId` as an opaque exact handle for the current indexed graph, with `qualifiedName + path + line` as human-readable context.

---

## Capability 2: Trace

### What Trace Means

Trace means CodeGraph can answer questions of the form:

```text
Starting from this entry point, what likely graph paths lead toward this target area?
```

Example:

```text
from: AgentSession.prompt
to: provider payload
scope: packages/coding-agent, packages/agent, packages/ai
```

A useful trace result might be:

```text
AgentSession.prompt
→ Agent.prompt
→ runPromptMessages
→ runAgentLoop
→ runLoop
→ streamAssistantResponse
→ streamSimple
→ provider.streamSimple / provider-specific streamSimple implementation
```

The trace should include enough metadata to inspect and verify the chain:

- node names and exact handles;
- file and line ranges;
- edge kind;
- callsite line when known;
- confidence or caveat for each step;
- gaps or dynamic-dispatch boundaries;
- recommended next `codegraph_explore`, `codegraph_node`, or `read` targets.

### Trace Inputs

The trace capability should conceptually accept:

| Input | Purpose |
|---|---|
| `from` | Required entry locator: nodeId, symbol, qualified name, or path+line. |
| `to` | Optional target: symbol, path, keyword query, kind, or package/path area. |
| `scopePath` / `includePaths` | Limit search to relevant packages or directories. |
| `excludePaths` | Avoid tests, fixtures, generated files, or unrelated packages. |
| `maxDepth` | Bound traversal. |
| `maxPaths` | Bound output. |
| `edgeKinds` | Restrict to calls/references/imports/etc. when needed. |
| `direction` | Usually outgoing for flow; incoming/both for impact or reverse tracing. |

The implementation plan can choose the final MCP schema. The design requirement is that trace must support precise endpoints and scoped traversal.

### Trace Outputs

A trace response should be structured around candidate paths, not flat symbol lists.

Each candidate path should include:

- path rank;
- path confidence;
- ordered steps;
- per-step node handle;
- edge metadata;
- callsite location when available;
- reason the path matched the target;
- caveats.

A response should also include:

- unresolved or dynamic boundaries, if any;
- target candidates considered;
- recommended next exploration handles;
- a short note on completeness.

### Candidate Paths, Not Proofs

Trace should return likely paths, not claim whole-program proof.

Why: CodeGraph extraction is static and best-effort. Dynamic dispatch, registry lookups, provider maps, callback parameters, and dependency injection may not produce a single explicit static call edge.

A trace result should therefore distinguish:

- **direct graph edge**: known call/reference/import edge;
- **registry or dynamic boundary**: path continues through a known pattern but not a direct call;
- **inferred bridge**: high-signal connection based on type, name, path, or known framework/provider pattern;
- **gap**: no reliable edge found; inspect suggested code.

This makes trace useful without overstating precision.

### Why Trace Is Needed

Current local graph tools answer local questions well:

- What calls this?
- What does this call?
- What would changing this affect?

But architecture questions are often path questions:

- How does a prompt become an LLM payload?
- How does a request reach a handler?
- How does a CLI command trigger an index update?
- How does a tool call get executed and returned to the model?

Without trace, agents must manually perform a sequence like:

```text
search → node → callees → callees → search → explore → read
```

This is slow, token-heavy, and error-prone. It also makes agents more likely to fall back to grep/read loops even though the graph has much of the needed structure.

Trace should compress that workflow into one graph-oriented response.

### Relationship to `codegraph_context`

`codegraph_context` should remain the orientation tool for natural-language tasks. It gives entry points and nearby context.

`codegraph_trace` should be used when the user asks for a lifecycle, pipeline, architecture path, or end-to-end flow.

The tools are complementary:

1. `codegraph_context` can identify likely entry points.
2. `codegraph_trace` can connect an entry point to a target area.
3. `codegraph_explore` or `read` can inspect the source behind the returned path.

Trace should not require `context` first when the user already provides a precise `from` locator.

### Relationship to `codegraph_explore`

`codegraph_explore` groups relevant source by file. It is useful after candidate symbols are known.

Trace should not dump large source bodies by default. Instead, it should return compact path structure and recommended exact handles for follow-up exploration.

Why: trace answers “what chain should I inspect?”; explore answers “show me the source around these symbols.”

### Scope Filtering

Trace should support path/package scoping from the start.

Why: large monorepos often contain many unrelated symbols named `prompt`, `run`, `execute`, `stream`, `context`, or `provider`. Scope filtering is the most effective way to make graph traversal useful and predictable.

Scope filters also address a known limitation of broad natural-language queries: if the agent knows the relevant package, it should be able to restrict the candidate graph before ranking.

### Trace Ranking Principles

A trace result should prefer paths that are:

- shorter, but not at the expense of obviously wrong dynamic jumps;
- within requested scope;
- connected by higher-confidence edge kinds such as direct calls;
- anchored by exact endpoint locators;
- matching target terms in node name, qualified name, path, signature, or docstring;
- avoiding tests/non-production files unless requested;
- preserving call direction for flow questions.

The implementation plan can decide scoring details. The design requirement is that ranking criteria be explainable in the output.

### Non-Goals for Trace

Trace does not need to solve these in its first version:

- full whole-program control-flow analysis;
- runtime-accurate dynamic dispatch;
- all framework-specific routing patterns;
- embedding-powered semantic target discovery;
- LSP-grade cross-language reference precision;
- replacing `read` for long function bodies.

Trace should be honest about gaps and provide exact next inspection steps.

---

## Relationship to LSP, Compiler APIs, and Embeddings

These two capabilities do not require LSP or embeddings as prerequisites.

### Addressability

Addressability is mostly an MCP/API surfacing problem. The graph already records IDs, paths, names, and ranges. The missing capability is exposing and accepting those facts consistently.

### Trace

Trace can start with existing graph edges and pathfinding. LSP, TypeScript compiler APIs, SCIP/LSIF, or language-specific analyzers can improve edge precision later, but the user-facing trace workflow should exist independently.

### Embeddings

Embeddings can improve natural-language target discovery and ranking, especially for cross-language or Chinese queries. They are not a substitute for exact handles or graph paths.

A reasonable layering is:

1. exact addressability;
2. graph trace over current edges;
3. richer semantic edges from compiler/LSP/SCIP where valuable;
4. embedding-assisted query rewrite and reranking.

---

## Expected User Experience

### Example 1: Disambiguating same-name symbols

User or agent searches:

```text
codegraph_search: systemPrompt
```

Expected result includes multiple matches, each with exact handles. The agent can then ask:

```text
codegraph_node: nodeId=<agent-session-systemPrompt-node-id>
```

or:

```text
codegraph_node: path=packages/coding-agent/src/core/agent-session.ts line=743
```

No fuzzy symbol reranking is involved in the follow-up.

### Example 2: Jumping from a compiler error

Input:

```text
packages/coding-agent/src/core/agent-session.ts:961
```

Expected result resolves to the innermost symbol containing that line, such as `AgentSession.prompt`, and returns its handle and line range.

### Example 3: Tracing prompt-to-provider flow

Input:

```text
from: AgentSession.prompt
to: provider streamSimple payload
scopePath: packages
maxDepth: 8
```

Expected output is a ranked list of candidate paths through `Agent.prompt`, loop execution, assistant response streaming, generic stream dispatch, and provider-specific stream implementations, with caveats around dynamic provider resolution.

The result should also recommend a compact follow-up such as:

```text
codegraph_explore: AgentSession.prompt Agent.prompt runAgentLoop streamAssistantResponse streamSimple provider.streamSimple
```

or exact `read` ranges for long provider functions.

---

## Acceptance Criteria for the Design

An implementation plan based on this design should preserve these outcomes:

### Addressability outcomes

- Search results expose exact reusable handles.
- Node lookup accepts exact handles and source locations.
- Call graph and impact tools accept exact handles.
- Same-name ambiguity can be resolved without guessing.
- `file:line` can locate the innermost symbol.
- Node detail output includes line ranges.
- Existing symbol-only calls remain supported.

### Trace outcomes

- A caller can request candidate paths from an entry point to a target query or target locator.
- Results are path-shaped, not just symbol lists.
- Each path step is inspectable through exact handles.
- Direct edges and inferred/dynamic gaps are distinguishable.
- Scope filters can reduce unrelated paths.
- Output includes recommended next exploration or read targets.
- Trace is framed as likely static graph guidance, not runtime proof.

---

## Risks and Open Questions

### Node ID stability

Should node IDs be documented as stable only within a current index, or stable across re-indexes unless the file path/qualified name changes? The implementation plan should verify current ID generation before making a user-facing promise.

### MCP text vs structured content

MCP tool responses are currently text-oriented. The implementation plan should decide whether exact handles are rendered as readable text, machine-readable JSON blocks, or both.

### Backward-compatible schemas

Current tools accept simple parameters such as `symbol`. The implementation plan should choose whether to add parallel optional fields (`nodeId`, `path`, `line`) or introduce a nested `locator` object.

### Ambiguous symbol-only behavior

Should symbol-only `codegraph_node` continue showing the first match with an ambiguity note, or should it return an ambiguity response requiring a follow-up exact locator? The design favors explicitness, but backward compatibility may favor retaining the current behavior with better alternatives.

### Trace target discovery

When `to` is a natural-language phrase, how broad should trace search be before it becomes noisy? The implementation plan should define caps and fallback behavior.

### Dynamic boundaries

Provider registries, callbacks, dependency injection, and framework routers may not be direct graph edges. The trace output should represent these as caveats or inferred bridges rather than pretending they are direct calls.

---

## Out of Scope for the First Implementation Plan

The following are valuable but should not block Addressability and Trace:

- embedding index construction;
- LSP server orchestration;
- TypeScript compiler API integration;
- LLM-generated long-function summaries;
- full control-flow analysis;
- new persistent schema for historical node identity;
- UI/TUI affordances for clickable handles.

---

## Design Principle Recap

Addressability makes CodeGraph results precise and reusable.

Trace makes CodeGraph paths visible without manual stitching.

Together, they turn CodeGraph from a fast symbol/context finder into a more reliable workflow tool for architecture questions, while keeping the implementation grounded in deterministic graph data and preserving `read` as the right fallback for full source inspection.
