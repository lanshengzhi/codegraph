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
 *   - Anti-patterns (don't grep when codegraph_search is faster)
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
qualifiedName, range/path:line) you can pass to node/callers/callees/
impact/trace follow-ups.

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
- **"What's the deal with this task / feature / area?"** → \`codegraph_context\` (PRIMARY — composes search + node + callers + callees in one call)
- **"What calls this?"** → \`codegraph_callers\` (includes edge evidence/callsite when recorded)
- **"What does this call?"** → \`codegraph_callees\` (includes edge evidence/callsite when recorded)
- **"What would changing this break?"** → \`codegraph_impact\`
- **"Show me this symbol's source / signature / docstring."** → \`codegraph_node\`
- **"Trace this lifecycle / path from entry to target."** → \`codegraph_trace\` (path-shaped static graph guidance with handles, edge evidence, and boundary/low-evidence caveats; not runtime proof)
- **"Show me several related symbols' source / survey an area."** → \`codegraph_explore\` (ONE capped call; prefer over many codegraph_node/Read)
- **"What's in directory X?"** → \`codegraph_files\`
- **"Is the index ready / what's its size?"** → \`codegraph_status\`

## Common chains

- **Onboarding**: \`codegraph_context\` first. If still unclear, \`codegraph_explore\` for breadth, then \`codegraph_node\` on specific symbols.
- **Architecture/lifecycle flow**: \`codegraph_context\` to find entry points → \`codegraph_trace\` with nodeId/file:line handles → inspect any boundary/low-evidence handles → \`codegraph_explore\` or Read on returned ranges.
- **Refactor planning**: \`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`. The blast-radius answer comes from impact, not from walking callers manually.
- **Debugging a regression**: \`codegraph_callers\` of the suspected symbol; widen with \`codegraph_impact\` if an unexpected call appears.

## Anti-patterns

- **Don't grep first** when looking up a symbol by name — \`codegraph_search\` is faster and returns kind + location + signature + exact handles.
- **Don't re-resolve by fuzzy symbol once you have a handle** — pass nodeId, fileLine, or path+line directly.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** when you just want context — \`codegraph_context\` is one round-trip.
- **Don't loop \`codegraph_node\` over many symbols** — one \`codegraph_explore\` call returns them all grouped by file, while each separate call re-reads the whole context and costs far more. Use \`codegraph_node\` for a single symbol.
- **Don't query the index immediately after editing a file** — the watcher needs ~500ms to debounce + sync. Wait for the next turn.

## Limitations

- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- Trace/callers/callees edge evidence reflects indexed static edges; \`not-recorded\` means the index did not capture that fact, not that runtime behavior is absent. Trace may show boundary / low-evidence entries with exact handles for source inspection.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
`;
