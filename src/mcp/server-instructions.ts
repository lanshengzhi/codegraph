/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Tool selection by intent (which tool for which question)
 *   - Common chains (refactor planning = X then Y)
 *   - Anti-patterns (don't grep when search is faster)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. Reference only tools that exist on `main`; gate any
 * conditional tools behind feature checks if/when they ship.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph is a SQLite knowledge graph of every symbol, edge, and file
in the workspace. Reads are sub-millisecond; the index lags writes by
about a second through the file watcher. Consult it BEFORE writing or
editing code, not during. Results include exact handles (nodeId,
qualifiedName, range/path:line) you can pass to codegraph_node/codegraph_callers/codegraph_callees/
codegraph_impact/codegraph_trace follow-ups. Raw MCP advertises suffix names like
\`search\` and \`status\`; Pi and other global tool gateways expose them with the
server prefix, e.g. \`codegraph_search\` and \`codegraph_status\`. Use the name
your client shows; examples below use the prefixed Pi form.

## Answer directly — don't delegate exploration

For "how does X work", architecture, trace, or where-is-X questions,
answer DIRECTLY using 2-3 codegraph calls: \`codegraph_context\` first,
\`codegraph_trace\` for entry→target flow when a path is needed, then ONE
\`codegraph_explore\` for the source of the symbols it surfaces.
Codegraph IS the pre-built search index — so delegating the lookup to a
separate file-reading sub-task/agent, or running your own grep + read
loop, repeats work codegraph already did and costs more for the same
answer. Reach for raw Read/Grep only to confirm a specific detail
codegraph didn't cover. A direct codegraph answer is typically a handful
of calls; a grep/read exploration is dozens.

## Tool selection by intent

- **"What is the symbol named X?"** → \`codegraph_search\`
- **"What's the deal with this task / feature / area?"** → \`codegraph_context\` (PRIMARY — composes search + node + callers + callees in one call; entry points may include static relevance reasons)
- **"What calls this?"** → \`codegraph_callers\` (includes edge evidence/callsite when recorded, e.g. \`direct-call\`, \`property-call\`, \`constructor-call\`, \`import\`, \`decorator\`, \`bare-call\`, or resolver fallback)
- **"What does this call?"** → \`codegraph_callees\` (includes edge evidence/callsite when recorded, e.g. \`direct-call\`, \`property-call\`, \`constructor-call\`, \`import\`, \`decorator\`, \`bare-call\`, or resolver fallback)
- **"What would changing this break?"** → \`codegraph_impact\`
- **"Show me this symbol's source / signature / docstring."** → \`codegraph_node\` (for long TS/JS functions, try \`detail: "structure"\` first for a static structure summary, then includeCode/read only where needed)
- **"Trace this lifecycle / path from entry to target."** → \`codegraph_trace\` (path-shaped static graph guidance with handles, edge evidence, static ranking score/reason, and boundary/low-evidence caveats; not runtime proof)
- **"Show me several related symbols' source / survey an area."** → \`codegraph_explore\` (ONE capped call; prefer over many node/Read; file headers may include static relevance reasons)
- **"What's in directory X?"** → \`codegraph_files\`
- **"Is the index ready / what's its size / what's indexed vs filesystem?"** → \`codegraph_status\` (pass \`detail: "coverage"\` for indexed-source boundary explanations with pending changes, extraction errors, unresolved refs, and workspace/alias summaries. CodeGraph reports indexed source coverage, not a complete filesystem inventory.)
- **"Where is field/key X written, read, or mapped?"** → \`codegraph_field_sites\` (static AST-level navigation hints grouped by write/mapping/construction/read; not full dataflow or runtime proof)
- **"Which workspace package file does import X resolve to?"** → \`codegraph_import_candidates\` (static workspace package entry candidates; not a complete Node/TypeScript resolver)
- **"What provider/tool/route registries exist?"** → \`codegraph_registry_candidates\` (static registry/resolver candidates from AST pattern matching; not runtime branch proof)

## Common chains

- **Onboarding**: \`codegraph_context\` first. If still unclear, \`codegraph_explore\` for breadth, then \`codegraph_node\` on specific symbols.
- **Long function inspection**: \`codegraph_node({ nodeId, detail: "structure" })\` for a static AST structure summary with exact ranges; use targeted Read or \`includeCode=true\` only after choosing the relevant range.
- **Architecture/lifecycle flow**: \`codegraph_context\` to find entry points → \`codegraph_trace\` with nodeId/file:line handles → inspect any boundary/low-evidence handles → \`codegraph_explore\` or Read on returned ranges.
- **Refactor planning**: \`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`. The blast-radius answer comes from impact, not from walking callers manually.
- **Debugging a regression**: \`codegraph_callers\` of the suspected symbol; widen with \`codegraph_impact\` if an unexpected call appears.
- **Provider payload / field flow debugging**: \`codegraph_context\` for structural overview → \`codegraph_trace\` for entry→target paths → \`codegraph_field_sites({ field: "systemPrompt" })\` to find all read/write/construction/mapping locations → targeted Read on the returned ranges.

## Anti-patterns

- **Don't grep first** when looking up a symbol by name — \`codegraph_search\` is faster and returns kind + location + signature + exact handles.
- **Don't re-resolve by fuzzy symbol once you have a handle** — pass nodeId, fileLine, or path+line directly.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** when you just want context — \`codegraph_context\` is one round-trip.
- **Don't loop \`codegraph_node\` over many symbols** — one \`codegraph_explore\` call returns them all grouped by file, while each separate call re-reads the whole context and costs far more. Use \`codegraph_node\` for a single symbol.
- **Don't query the index immediately after editing a file** — the watcher needs ~500ms to debounce + sync. Wait for the next turn.
- **Don't use Codegraph as a git diff tool.** For current working-tree changes, run git status/diff first, then use codegraph handles/tools on the changed symbols for structural impact.

## Limitations

- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- \`codegraph_trace\`/\`codegraph_callers\`/\`codegraph_callees\` edge evidence reflects indexed static edges. When recorded, \`evidence=\` may show source syntax such as \`direct-call\`, \`property-call\`, \`constructor-call\`, \`import\`, \`decorator\`, or \`bare-call\`; otherwise resolver fallback may show \`name-match\`, \`framework\`, or \`fuzzy\`. \`not-recorded\` means the index did not capture that fact, not that runtime behavior is absent. Trace ranks candidate paths with a static score/reason from recorded evidence (direct-call ratio, edge confidence, scope, low-evidence, optional/test/generated penalties); this is sorting guidance, not runtime main-path proof. Trace may show boundary / low-evidence entries with exact handles for source inspection.
- codegraph_context/codegraph_explore relevance reasons are static ranking explanations from recorded search/graph signals (exact name/path matches, query-symbol extraction, entry-point proximity, generic-name or test/generated penalties). They explain why candidates were returned, not complete semantic proof.
- \`codegraph_node({ nodeId, detail: "structure" })\` is static AST navigation for long TS/JS function/method bodies. It highlights ranges, control-flow syntax, callsites, callback-like hints, and local object/return construction; it is not runtime proof, a complete control-flow/dataflow graph, or an LLM summary.
- \`codegraph_field_sites\` returns static AST navigation hints (exact identifier match, not substring). It covers writes, reads, object construction, destructuring, return-object fields, and syntax-level mapping hints — not full dataflow, alias analysis, or runtime payload proof. A "no-matches" result only means the exact string wasn't found in searchable TS/JS files; dynamic/computed/alias cases are not covered.
- \`codegraph_import_candidates\` returns static workspace package entry candidates, not a complete Node/TypeScript resolver. Exports conditions, dist→src heuristics, and unindexed packages are labeled with evidence and confidence.
- \`codegraph_registry_candidates\` returns static AST pattern matches (object-literal, Map, .set(), register-call, definition-array) in TS/JS files. Dynamic/computed keys are low-confidence and labeled; the tool does not prove which registry key is active at runtime.
- \`codegraph_status({ detail: "coverage" })\` reports indexed source coverage, not a complete filesystem inventory. Use \`git status\`, \`find\`, or \`read\` for filesystem-level checks.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
`;
