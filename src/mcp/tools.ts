/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the CodeGraph MCP server.
 */

import CodeGraph, { findNearestCodeGraphRoot } from '../index';
import { REFERENCE_SOURCE_EVIDENCE_VALUES } from '../types';
import type {
  Node,
  Edge,
  NodeHandle,
  SearchResult,
  Subgraph,
  TaskContext,
  NodeKind,
  NodeLocator,
  LocatorResolution,
  EdgeKind,
  TraceOptions,
  TraceResult,
  TraceEdge,
  TraceBoundary,
  ReferenceSourceEvidence,
  NodeStructureFormatOptions,
  NodeStructureItem,
  NodeStructureResult,
  SourceRange,
} from '../types';
import { formatNodeHandle, matchesSymbol as nodeMatchesSymbol } from '../addressability/format';
import { createHash } from 'crypto';
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'fs';
import { clamp, validatePathWithinRoot, validateProjectPath } from '../utils';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatRelevanceReason } from '../context/formatter';

/** Maximum output length to prevent context bloat (characters) */
const MAX_OUTPUT_LENGTH = 15000;
const REFERENCE_SOURCE_EVIDENCE_SET: ReadonlySet<string> = new Set(REFERENCE_SOURCE_EVIDENCE_VALUES);
const NAME_MATCH_RESOLVERS = new Set(['exact-match', 'qualified-name', 'instance-method', 'import', 'file-path']);
const EDGE_TEXT_FIELD_CAP = 120;

/**
 * Maximum length for free-form string inputs (query, task, symbol).
 * Bounds memory and CPU when a buggy or hostile MCP client sends a
 * huge payload — without this an attacker could ship a 100MB string
 * and force a full FTS5 scan / OOM the server. 10 000 characters is
 * far beyond any realistic legitimate query.
 */
const MAX_INPUT_LENGTH = 10_000;

/**
 * Maximum length for path-like string inputs (projectPath, path
 * filter, glob pattern). Paths beyond a few thousand chars are
 * never legitimate and signal abuse or a bug upstream.
 */
const MAX_PATH_LENGTH = 4_096;

/**
 * Rust path roots that have no file-system equivalent — `crate` is the
 * current crate, `super` is the parent module, `self` is the current
 * module. Used by `matchesSymbol` to strip these before file-path
 * matching so `crate::configurator::stage_apply::run` resolves the
 * same as `configurator::stage_apply::run`.
 */
const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/**
 * Node kinds that contain other symbols. For these, `codegraph_node` with
 * `includeCode=true` returns a structural outline (member names + signatures
 * + line numbers) instead of the full body, which for a large class is a
 * multi-thousand-character wall of source that bloats the agent's context.
 */
const CONTAINER_NODE_KINDS = new Set<NodeKind>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
]);

interface NodeEdgeListItem {
  node: Node;
  edge: Edge;
  root: Node;
  sourceNode?: Node | null;
}

/** Last `::` / `.` / `/`-separated segment of a qualified symbol. */
function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Calculate the recommended number of codegraph_explore calls based on project size.
 * Larger codebases need more exploration calls to cover their surface area,
 * but smaller ones should use fewer to avoid unnecessary overhead.
 */
export function getExploreBudget(fileCount: number): number {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15000) return 3;
  if (fileCount < 25000) return 4;
  return 5;
}

/**
 * Adaptive output budget for `codegraph_explore`, scaled to project size.
 *
 * Smaller codebases get a tighter total cap, fewer default files, smaller
 * per-file cap, and tighter clustering — so a focused query on a 100-file
 * project doesn't dump a whole file's worth of source into the agent's
 * context. Larger codebases keep the generous defaults because the
 * agent's native discovery cost (grep + find + many Reads) genuinely
 * dwarfs a fat explore call at that scale.
 *
 * Meta-text (relationships map, "additional relevant files" list,
 * completeness signal, budget note) is gated off for tiny projects
 * where one rich call is the whole story and the extra prose is just
 * overhead.
 *
 * Tier breakpoints mirror `getExploreBudget` so a project sits in the
 * same tier across both knobs.
 */
export interface ExploreOutputBudget {
  /** Hard cap on total output characters. */
  maxOutputChars: number;
  /** Default `maxFiles` when the caller didn't specify one. */
  defaultMaxFiles: number;
  /** Cap on contiguous source returned per file (across all its clusters). */
  maxCharsPerFile: number;
  /** Cluster gap threshold in lines — tighter clustering on small projects. */
  gapThreshold: number;
  /** Max symbols listed in the per-file header (`#### path — sym(kind), ...`). */
  maxSymbolsInFileHeader: number;
  /** Max edges shown per relationship kind in the Relationships section. */
  maxEdgesPerRelationshipKind: number;
  /** Include the "Relationships" section. */
  includeRelationships: boolean;
  /** Include the "Additional relevant files (not shown)" trailing list. */
  includeAdditionalFiles: boolean;
  /** Include the "Complete source code is included above…" reminder. */
  includeCompletenessSignal: boolean;
  /** Include the explore-budget reminder at the end. */
  includeBudgetNote: boolean;
}

export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  if (fileCount < 500) {
    return {
      maxOutputChars: 18000,
      defaultMaxFiles: 5,
      maxCharsPerFile: 3800,
      gapThreshold: 8,
      maxSymbolsInFileHeader: 6,
      maxEdgesPerRelationshipKind: 6,
      includeRelationships: true,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
    };
  }
  if (fileCount < 5000) {
    return {
      maxOutputChars: 13000,
      defaultMaxFiles: 6,
      maxCharsPerFile: 2500,
      gapThreshold: 10,
      maxSymbolsInFileHeader: 8,
      maxEdgesPerRelationshipKind: 8,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
    };
  }
  if (fileCount < 15000) {
    return {
      maxOutputChars: 35000,
      defaultMaxFiles: 12,
      maxCharsPerFile: 7000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
    };
  }
  return {
    maxOutputChars: 38000,
    defaultMaxFiles: 14,
    maxCharsPerFile: 7000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
  };
}

/**
 * Whether `codegraph_explore` should prefix source lines with their line
 * numbers (cat -n style: `<num>\t<code>`).
 *
 * Line numbers let the agent cite `file:line` straight from the explore
 * payload instead of re-Reading the file just to find a line number — the
 * dominant residual cost on precise-tracing questions (#185 follow-up).
 *
 * Defaults ON. Set `CODEGRAPH_EXPLORE_LINENUMS=0` to disable (used by the
 * A/B harness to measure the payload-cost vs. read-savings tradeoff).
 */
function exploreLineNumbersEnabled(): boolean {
  return process.env.CODEGRAPH_EXPLORE_LINENUMS !== '0';
}

/**
 * Prefix each line of a source slice with its 1-based line number, matching
 * the Read tool's `cat -n` convention (number + tab) so the agent treats it
 * the same way it treats Read output.
 *
 * @param slice  contiguous source text (already extracted from the file)
 * @param firstLineNumber  the 1-based line number of the slice's first line
 */
function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split('\n');
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join('\n');
}

/**
 * Mark a Claude session as having consulted MCP tools.
 * This enables Grep/Glob/Bash commands that would otherwise be blocked.
 *
 * Why the explicit openSync + O_NOFOLLOW dance instead of plain writeFileSync:
 * tmpdir() is world-writable on Linux (mode 1777), so on a shared multi-user
 * machine any other local user can pre-create `codegraph-consulted-<hash>` as
 * a symlink pointing at a file the victim owns. The old `writeFileSync` would
 * happily follow that link and overwrite the target's contents with the ISO
 * timestamp string (CWE-59). The session-id hash provides the predictability
 * gate, but it's defense-in-depth: if a session id ever surfaces in logs,
 * argv, or telemetry the attack becomes trivial, and the right fix is to not
 * follow links from /tmp paths in the first place.
 */
function markSessionConsulted(sessionId: string): void {
  try {
    const hash = createHash('md5').update(sessionId).digest('hex').slice(0, 16);
    const markerPath = join(tmpdir(), `codegraph-consulted-${hash}`);
    // Refuse to follow a pre-planted symlink at the marker path (CWE-59).
    // O_NOFOLLOW (below) is the atomic, TOCTOU-free guard on POSIX, but it is
    // `undefined` on Windows (libuv ignores it), so the bitwise-OR silently
    // drops it and openSync would follow the link. This lstat check closes that
    // gap cross-platform; ENOENT (path is free) falls through to create it.
    try {
      if (lstatSync(markerPath).isSymbolicLink()) return;
    } catch {
      // No existing entry (or stat failed) — nothing to refuse; proceed.
    }
    // O_NOFOLLOW makes openSync throw ELOOP if markerPath is already a symlink.
    // O_CREAT + O_TRUNC keep the original "create-or-overwrite" semantics, and
    // mode 0o600 prevents readback by other local users (the marker payload is
    // benign, but narrowing the exposure costs nothing).
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
    const fd = openSync(markerPath, flags, 0o600);
    try {
      writeSync(fd, new Date().toISOString());
    } finally {
      closeSync(fd);
    }
  } catch {
    // Silently fail - don't break MCP on marker write failure. ELOOP from a
    // planted symlink lands here too, which is the intended behavior: refuse
    // to write rather than overwrite an attacker-chosen target.
  }
}

/**
 * MCP Tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
}

interface PropertySchema {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string; enum?: string[] };
}

/**
 * Tool execution result
 */
export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

/**
 * Common projectPath property for cross-project queries
 */
const projectPathProperty: PropertySchema = {
  type: 'string',
  description: 'Path to a different project with .codegraph/ initialized. If omitted, uses current project. Use this to query other codebases.',
};

const locatorProperties: Record<string, PropertySchema> = {
  symbol: {
    type: 'string',
    description: 'Backward-compatible symbol/name lookup. Prefer nodeId or fileLine when available.',
  },
  nodeId: {
    type: 'string',
    description: 'Exact opaque node ID from a previous CodeGraph result handle.',
  },
  qualifiedName: {
    type: 'string',
    description: 'Exact qualifiedName from a previous CodeGraph result handle.',
  },
  path: {
    type: 'string',
    description: 'Project-relative file path for path+line lookup.',
  },
  line: {
    type: 'number',
    description: '1-indexed source line for path+line lookup.',
  },
  fileLine: {
    type: 'string',
    description: 'Convenience source location such as "src/a.ts:123" or "src/a.ts:123:9".',
  },
};

const traceLocatorProperties: Record<string, PropertySchema> = {
  from: { type: 'string', description: 'Entry symbol/query shorthand. Prefer fromNodeId/fromFileLine when available.' },
  fromNodeId: { type: 'string', description: 'Exact entry nodeId.' },
  fromQualifiedName: { type: 'string', description: 'Exact entry qualifiedName.' },
  fromPath: { type: 'string', description: 'Entry file path for fromPath+fromLine lookup.' },
  fromLine: { type: 'number', description: 'Entry source line for fromPath+fromLine lookup.' },
  fromFileLine: { type: 'string', description: 'Entry source location, e.g. "src/a.ts:123".' },
  to: { type: 'string', description: 'Target symbol/query shorthand.' },
  toNodeId: { type: 'string', description: 'Exact target nodeId.' },
  toQualifiedName: { type: 'string', description: 'Exact target qualifiedName.' },
  toPath: { type: 'string', description: 'Target file path for toPath+toLine lookup.' },
  toLine: { type: 'number', description: 'Target source line for toPath+toLine lookup.' },
  toFileLine: { type: 'string', description: 'Target source location, e.g. "src/a.ts:123".' },
};

const EDGE_KIND_VALUES: EdgeKind[] = [
  'contains', 'calls', 'imports', 'exports', 'extends', 'implements', 'references',
  'type_of', 'returns', 'instantiates', 'overrides', 'decorates',
];

/**
 * All CodeGraph MCP tools
 *
 * Designed for minimal context usage - use codegraph_context as the primary tool,
 * and only use other tools for targeted follow-up queries.
 *
 * All tools support cross-project queries via the optional `projectPath` parameter.
 */
export const tools: ToolDefinition[] = [
  {
    name: 'codegraph_search',
    description: 'Quick symbol search by name. Returns locations only (no code). Use codegraph_context instead for comprehensive task context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name or partial name (e.g., "auth", "signIn", "UserService")',
        },
        kind: {
          type: 'string',
          description: 'Filter by node kind',
          enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'],
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
          default: 10,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'codegraph_context',
    description: 'PRIMARY TOOL — call this FIRST for any "how does X work", architecture, feature, or bug-context question. Composes search + node + callers + callees and returns entry points, related symbols, and key code in ONE call — usually enough to answer with no further search/Read/Grep. Prefer this over chaining codegraph_search + codegraph_node, and over codegraph_explore. NOTE: provides CODE context, not product requirements; for new features still clarify UX/edge cases with the user.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of the task, bug, or feature to build context for',
        },
        maxNodes: {
          type: 'number',
          description: 'Maximum symbols to include (default: 20)',
          default: 20,
        },
        includeCode: {
          type: 'boolean',
          description: 'Include code snippets for key symbols (default: true)',
          default: true,
        },
        projectPath: projectPathProperty,
      },
      required: ['task'],
    },
  },
  {
    name: 'codegraph_callers',
    description: 'Find all functions/methods that call a specific symbol or exact locator. Accepts symbol, nodeId, qualifiedName, path+line, or fileLine.',
    inputSchema: {
      type: 'object',
      properties: {
        ...locatorProperties,
        limit: {
          type: 'number',
          description: 'Maximum number of callers to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'codegraph_callees',
    description: 'Find all functions/methods that a specific symbol or exact locator calls. Accepts symbol, nodeId, qualifiedName, path+line, or fileLine.',
    inputSchema: {
      type: 'object',
      properties: {
        ...locatorProperties,
        limit: {
          type: 'number',
          description: 'Maximum number of callees to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'codegraph_impact',
    description: 'Analyze the impact radius of changing a symbol or exact locator. Accepts symbol, nodeId, qualifiedName, path+line, or fileLine.',
    inputSchema: {
      type: 'object',
      properties: {
        ...locatorProperties,
        depth: {
          type: 'number',
          description: 'How many levels of dependencies to traverse (default: 2)',
          default: 2,
        },
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'codegraph_node',
    description: 'Get detailed info about ONE symbol or exact locator (location, range, handle, signature, docstring). Accepts symbol, nodeId, qualifiedName, path+line, or fileLine. For long TS/JS functions/methods, pass detail="structure" for a static AST structure summary without full source. Pass includeCode=true for source: a function/method returns its body; a class/interface/struct/enum returns a compact member OUTLINE.',
    inputSchema: {
      type: 'object',
      properties: {
        ...locatorProperties,
        includeCode: {
          type: 'boolean',
          description: 'Include full source code (default: false to minimize context)',
          default: false,
        },
        detail: {
          type: 'string',
          description: 'Optional detail mode. Use "structure" for a static AST-derived structure summary of long TS/JS function/method bodies without full source.',
          enum: ['structure'],
        },
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'codegraph_explore',
    description: 'Returns source for SEVERAL related symbols grouped by file, plus a relationship map, in ONE capped call. This is the efficient way to inspect many related symbols at once — strongly prefer it over a series of codegraph_node or Read calls (each separate call re-reads the whole context, so 8 node calls cost far more than 1 explore). Use it after codegraph_context when you need to see the actual source of several symbols. Query with specific symbol/file/code terms, NOT natural-language sentences — run codegraph_search first to find names. Bad: "how are agent prompts loaded and passed to the CLI". Good: "renderStaticScene drawElementOnCanvas ShapeCache renderElement.ts".',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol names, file names, or short code terms to explore (e.g., "AuthService loginUser session-manager", "GraphTraverser BFS impact traversal.ts"). Use codegraph_search first to find relevant names.',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of files to include source code from (default: 12)',
          default: 12,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'codegraph_trace',
    description: 'Trace likely static graph paths from an entry locator to a target symbol/query/locator. Returns ranked path steps with nodeId/range handles, static score/reason, edge kinds, callsite lines when available, gaps, and recommended next inspections. This is guidance over the indexed graph, not runtime proof.',
    inputSchema: {
      type: 'object',
      properties: {
        ...traceLocatorProperties,
        scopePath: {
          type: 'string',
          description: 'Restrict traversal and target candidates to a path prefix/scope.',
        },
        includePaths: {
          type: 'array',
          description: 'Only include nodes under these path prefixes.',
          items: { type: 'string' },
        },
        excludePaths: {
          type: 'array',
          description: 'Exclude nodes under these path prefixes.',
          items: { type: 'string' },
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 6)',
          default: 6,
        },
        maxPaths: {
          type: 'number',
          description: 'Maximum paths to return (default: 5)',
          default: 5,
        },
        edgeKinds: {
          type: 'array',
          description: 'Edge kinds to traverse (default: calls, references, imports)',
          items: { type: 'string', enum: EDGE_KIND_VALUES },
        },
        direction: {
          type: 'string',
          description: 'Traversal direction (default: outgoing)',
          enum: ['outgoing', 'incoming', 'both'],
          default: 'outgoing',
        },
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'codegraph_status',
    description: 'Get the status of the CodeGraph index, including statistics about indexed files, nodes, and edges.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'codegraph_files',
    description: 'REQUIRED for file/folder exploration. Get the project file structure from the CodeGraph index. Returns a tree view of all indexed files with metadata (language, symbol count). Much faster than Glob/filesystem scanning. Use this FIRST when exploring project structure, finding files, or understanding codebase organization.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Filter to files under this directory path (e.g., "src/components"). Returns all files if not specified.',
        },
        pattern: {
          type: 'string',
          description: 'Filter files matching this glob pattern (e.g., "*.tsx", "**/*.test.ts")',
        },
        format: {
          type: 'string',
          description: 'Output format: "tree" (hierarchical, default), "flat" (simple list), "grouped" (by language)',
          enum: ['tree', 'flat', 'grouped'],
          default: 'tree',
        },
        includeMetadata: {
          type: 'boolean',
          description: 'Include file metadata like language and symbol count (default: true)',
          default: true,
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory depth to show (default: unlimited)',
        },
        projectPath: projectPathProperty,
      },
    },
  },
];

/**
 * Tool handler that executes tools against a CodeGraph instance
 *
 * Supports cross-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
export class ToolHandler {
  // Cache of opened CodeGraph instances for cross-project queries
  private projectCache: Map<string, CodeGraph> = new Map();
  // The directory the server last searched for a default project. Surfaced in
  // the "not initialized" error so users can see why detection missed.
  private defaultProjectHint: string | null = null;

  constructor(private cg: CodeGraph | null) {}

  /**
   * Update the default CodeGraph instance (e.g. after lazy initialization)
   */
  setDefaultCodeGraph(cg: CodeGraph): void {
    this.cg = cg;
  }

  /**
   * Record the directory the server tried to resolve the default project from.
   * Used only to make the "no default project" error actionable.
   */
  setDefaultProjectHint(searchedPath: string): void {
    this.defaultProjectHint = searchedPath;
  }

  /**
   * Whether a default CodeGraph instance is available
   */
  hasDefaultCodeGraph(): boolean {
    return this.cg !== null;
  }

  /**
   * Get tool definitions with dynamic descriptions based on project size.
   * The codegraph_explore tool description includes a budget recommendation
   * scaled to the number of indexed files.
   */
  getTools(): ToolDefinition[] {
    if (!this.cg) return tools;

    try {
      const stats = this.cg.getStats();
      const budget = getExploreBudget(stats.fileCount);

      return tools.map(tool => {
        if (tool.name === 'codegraph_explore') {
          return {
            ...tool,
            description: `${tool.description} Budget: make at most ${budget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).`,
          };
        }
        return tool;
      });
    } catch {
      return tools;
    }
  }

  /**
   * Get CodeGraph instance for a project
   *
   * If projectPath is provided, opens that project's CodeGraph (cached).
   * Otherwise returns the default CodeGraph instance.
   *
   * Walks up parent directories to find the nearest .codegraph/ folder,
   * similar to how git finds .git/ directories.
   */
  private getCodeGraph(projectPath?: string): CodeGraph {
    if (!projectPath) {
      if (!this.cg) {
        const searched = this.defaultProjectHint ?? process.cwd();
        throw new Error(
          'No CodeGraph project is loaded for this session.\n' +
          `Searched for a .codegraph/ directory starting from: ${searched}\n` +
          'The index is likely fine — this is a working-directory detection issue: ' +
          "the MCP client launched the server outside your project and didn't report the " +
          'workspace root. Fix it either way:\n' +
          '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project"\n' +
          '  • Or add --path to the server\'s MCP config args: ["serve", "--mcp", "--path", "/absolute/path/to/your/project"]'
        );
      }
      return this.cg;
    }

    // Check cache first (using original path as key)
    if (this.projectCache.has(projectPath)) {
      return this.projectCache.get(projectPath)!;
    }

    // Reject sensitive system directories before opening. Only validate a
    // path that actually exists — a nested or not-yet-created sub-path of a
    // real project must still be allowed to resolve UP to its .codegraph/
    // root below (issue #238), so we don't run the existence-checking
    // validator on paths that are meant to walk up.
    if (existsSync(projectPath)) {
      const pathError = validateProjectPath(projectPath);
      if (pathError) {
        throw new Error(pathError);
      }
    }

    // Walk up parent directories to find nearest .codegraph/
    const resolvedRoot = findNearestCodeGraphRoot(projectPath);

    if (!resolvedRoot) {
      throw new Error(`CodeGraph not initialized in ${projectPath}. Run 'codegraph init' in that project first.`);
    }

    // If the path resolves to the default project, reuse the already-open
    // default instance rather than opening a SECOND connection to the same DB.
    // A duplicate connection serializes reads against the watcher's auto-sync
    // writes; on the wasm backend (no WAL) that surfaces as intermittent
    // "database is locked" on concurrent tool calls. See issue #238. Deliberately
    // not cached under projectPath — the server owns and closes the default
    // instance, so routing it through projectCache.closeAll() would double-close it.
    if (this.cg && this.cg.getProjectRoot() === resolvedRoot) {
      return this.cg;
    }

    // Check if we already have this resolved root cached (different path, same project)
    if (this.projectCache.has(resolvedRoot)) {
      const cg = this.projectCache.get(resolvedRoot)!;
      // Cache under original path too for faster future lookups
      this.projectCache.set(projectPath, cg);
      return cg;
    }

    // Open and cache under both paths
    const cg = CodeGraph.openSync(resolvedRoot);
    this.projectCache.set(resolvedRoot, cg);
    if (projectPath !== resolvedRoot) {
      this.projectCache.set(projectPath, cg);
    }
    return cg;
  }

  /**
   * Close all cached project connections
   */
  closeAll(): void {
    for (const cg of this.projectCache.values()) {
      cg.close();
    }
    this.projectCache.clear();
  }

  private isToolResult(value: unknown): value is ToolResult {
    return Boolean(value) && typeof value === 'object' && Array.isArray((value as ToolResult).content);
  }

  /**
   * Validate that a value is a non-empty string within length bounds.
   *
   * The `maxLength` cap protects against MCP clients that ship huge
   * payloads (10MB+ query strings either by accident or maliciously).
   * Without this, a single oversized input can pin the FTS5 index or
   * exhaust memory before any real work runs.
   */
  private validateString(
    value: unknown,
    name: string,
    maxLength: number = MAX_INPUT_LENGTH
  ): string | ToolResult {
    if (typeof value !== 'string' || value.length === 0) {
      return this.errorResult(`${name} must be a non-empty string`);
    }
    if (value.length > maxLength) {
      return this.errorResult(
        `${name} exceeds maximum length of ${maxLength} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * Validate an optional path-like string input. Returns the value if
   * valid (or undefined), or a ToolResult with the error.
   */
  private validateOptionalPath(
    value: unknown,
    name: string
  ): string | undefined | ToolResult {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      return this.errorResult(`${name} must be a string`);
    }
    if (value.length > MAX_PATH_LENGTH) {
      return this.errorResult(
        `${name} exceeds maximum length of ${MAX_PATH_LENGTH} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * Execute a tool by name
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      // Cross-cutting input validation. All tools accept an optional
      // `projectPath` and most accept either `query`, `task`, or
      // `symbol` — bound their lengths centrally so individual handlers
      // can stay focused on tool-specific logic.
      const pathCheck = this.validateOptionalPath(args.projectPath, 'projectPath');
      if (typeof pathCheck === 'object' && pathCheck !== undefined) {
        return pathCheck;
      }
      // The `path` and `pattern` properties used by codegraph_files are
      // also path-shaped — apply the same cap.
      if (args.path !== undefined) {
        const check = this.validateOptionalPath(args.path, 'path');
        if (typeof check === 'object' && check !== undefined) return check;
      }
      if (args.pattern !== undefined) {
        const check = this.validateOptionalPath(args.pattern, 'pattern');
        if (typeof check === 'object' && check !== undefined) return check;
      }

      switch (toolName) {
        case 'codegraph_search':
          return await this.handleSearch(args);
        case 'codegraph_context':
          return await this.handleContext(args);
        case 'codegraph_callers':
          return await this.handleCallers(args);
        case 'codegraph_callees':
          return await this.handleCallees(args);
        case 'codegraph_impact':
          return await this.handleImpact(args);
        case 'codegraph_explore':
          return await this.handleExplore(args);
        case 'codegraph_trace':
          return await this.handleTrace(args);
        case 'codegraph_node':
          return await this.handleNode(args);
        case 'codegraph_status':
          return await this.handleStatus(args);
        case 'codegraph_files':
          return await this.handleFiles(args);
        default:
          return this.errorResult(`Unknown tool: ${toolName}`);
      }
    } catch (err) {
      return this.errorResult(`Tool execution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Handle codegraph_search
   */
  private async handleSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const kind = args.kind as string | undefined;
    const rawLimit = Number(args.limit) || 10;
    const limit = clamp(rawLimit, 1, 100);

    const results = cg.searchNodes(query, {
      limit,
      kinds: kind ? [kind as NodeKind] : undefined,
    });

    if (results.length === 0) {
      return this.textResult(`No results found for "${query}"`);
    }

    const formatted = this.formatSearchResults(results);
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_context
   */
  private async handleContext(args: Record<string, unknown>): Promise<ToolResult> {
    const task = this.validateString(args.task, 'task');
    if (typeof task !== 'string') return task;

    // Mark session as consulted (enables Grep/Glob/Bash)
    const sessionId = process.env.CLAUDE_SESSION_ID;
    if (sessionId) {
      markSessionConsulted(sessionId);
    }

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const maxNodes = (args.maxNodes as number) || 20;
    const includeCode = args.includeCode !== false;

    const context = await cg.buildContext(task, {
      maxNodes,
      includeCode,
      format: 'markdown',
    });

    // Detect if this looks like a feature request (vs bug fix or exploration)
    const isFeatureQuery = this.looksLikeFeatureRequest(task);
    const reminder = isFeatureQuery
      ? '\n\n⚠️ **Ask user:** UX preferences, edge cases, acceptance criteria'
      : '';

    // buildContext returns string when format is 'markdown'
    if (typeof context === 'string') {
      return this.textResult(this.truncateOutput(context + reminder));
    }

    // If it returns TaskContext, format it
    return this.textResult(this.truncateOutput(this.formatTaskContext(context) + reminder));
  }

  /**
   * Heuristic to detect if a query looks like a feature request
   */
  private looksLikeFeatureRequest(task: string): boolean {
    const featureKeywords = [
      'add', 'create', 'implement', 'build', 'enable', 'allow',
      'new feature', 'support for', 'ability to', 'want to',
      'should be able', 'need to add', 'swap', 'edit', 'modify'
    ];
    const bugKeywords = [
      'fix', 'bug', 'error', 'broken', 'crash', 'issue', 'problem',
      'not working', 'fails', 'undefined', 'null'
    ];
    const explorationKeywords = [
      'how does', 'where is', 'what is', 'find', 'show me',
      'explain', 'understand', 'explore'
    ];

    const lowerTask = task.toLowerCase();

    // If it's clearly a bug or exploration, not a feature
    if (bugKeywords.some(k => lowerTask.includes(k))) return false;
    if (explorationKeywords.some(k => lowerTask.includes(k))) return false;

    // If it matches feature keywords, it's likely a feature request
    return featureKeywords.some(k => lowerTask.includes(k));
  }

  /**
   * Handle codegraph_callers
   */
  private async handleCallers(args: Record<string, unknown>): Promise<ToolResult> {
    const locator = this.argsToLocator(args);
    if (this.isToolResult(locator)) return locator;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);

    const roots = this.resolveCallGraphRoots(cg, locator);
    if (roots.nodes.length === 0) {
      return this.textResult(roots.note.trim() || `Symbol or locator "${this.locatorLabel(locator)}" not found in the codebase`);
    }

    const seen = new Set<string>();
    const allCallers: NodeEdgeListItem[] = [];
    for (const root of roots.nodes) {
      for (const c of cg.getCallers(root.id)) {
        const key = this.edgeListDedupKey(c.node, c.edge, root);
        if (!seen.has(key)) {
          seen.add(key);
          allCallers.push({
            node: c.node,
            edge: c.edge,
            root,
            sourceNode: c.node.id === c.edge.source ? c.node : cg.getNode(c.edge.source),
          });
        }
      }
    }

    const label = this.locatorLabel(locator);
    if (allCallers.length === 0) {
      return this.textResult(`No callers found for "${label}"${roots.note}`);
    }

    const formatted = this.formatNodeEdgeList(allCallers.slice(0, limit), `Callers of ${label}`) + roots.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_callees
   */
  private async handleCallees(args: Record<string, unknown>): Promise<ToolResult> {
    const locator = this.argsToLocator(args);
    if (this.isToolResult(locator)) return locator;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);

    const roots = this.resolveCallGraphRoots(cg, locator);
    if (roots.nodes.length === 0) {
      return this.textResult(roots.note.trim() || `Symbol or locator "${this.locatorLabel(locator)}" not found in the codebase`);
    }

    const seen = new Set<string>();
    const allCallees: NodeEdgeListItem[] = [];
    for (const root of roots.nodes) {
      for (const c of cg.getCallees(root.id)) {
        const key = this.edgeListDedupKey(c.node, c.edge, root);
        if (!seen.has(key)) {
          seen.add(key);
          allCallees.push({
            node: c.node,
            edge: c.edge,
            root,
            sourceNode: root.id === c.edge.source ? root : cg.getNode(c.edge.source),
          });
        }
      }
    }

    const label = this.locatorLabel(locator);
    if (allCallees.length === 0) {
      return this.textResult(`No callees found for "${label}"${roots.note}`);
    }

    const formatted = this.formatNodeEdgeList(allCallees.slice(0, limit), `Callees of ${label}`) + roots.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_impact
   */
  private async handleImpact(args: Record<string, unknown>): Promise<ToolResult> {
    const locator = this.argsToLocator(args);
    if (this.isToolResult(locator)) return locator;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const depth = clamp((args.depth as number) || 2, 1, 10);

    const roots = this.resolveCallGraphRoots(cg, locator);
    if (roots.nodes.length === 0) {
      return this.textResult(roots.note.trim() || `Symbol or locator "${this.locatorLabel(locator)}" not found in the codebase`);
    }

    const mergedNodes = new Map<string, Node>();
    const mergedEdges: Edge[] = [];
    const seenEdges = new Set<string>();

    for (const node of roots.nodes) {
      const impact = cg.getImpactRadius(node.id, depth);
      for (const [id, n] of impact.nodes) {
        mergedNodes.set(id, n);
      }
      for (const e of impact.edges) {
        const key = `${e.source}->${e.target}:${e.kind}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          mergedEdges.push(e);
        }
      }
    }

    const mergedImpact = {
      nodes: mergedNodes,
      edges: mergedEdges,
      roots: roots.nodes.map((n: Node) => n.id),
    };

    const formatted = this.formatImpact(this.locatorLabel(locator), mergedImpact) + roots.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_explore — deep exploration in a single call
   *
   * Strategy: find relevant symbols via graph traversal, group by file,
   * then read contiguous file sections covering all symbols per file.
   * This replaces multiple codegraph_node + Read calls.
   *
   * Output size is adaptive to project file count via
   * `getExploreOutputBudget` — see #185 for why a fixed 35k cap was a
   * tax on small projects while earning its keep on large ones.
   */
  private async handleExplore(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const projectRoot = cg.getProjectRoot();

    // Resolve adaptive output budget from project size. Falls back to the
    // largest-tier defaults if stats aren't available, which preserves
    // pre-#185 behavior for callers that hit the rare stats failure.
    let budget: ExploreOutputBudget;
    try {
      budget = getExploreOutputBudget(cg.getStats().fileCount);
    } catch {
      budget = getExploreOutputBudget(Infinity);
    }
    const maxFiles = clamp((args.maxFiles as number) || budget.defaultMaxFiles, 1, 20);

    // Step 1: Find relevant context with generous parameters.
    // Use a large maxNodes budget — explore has its own 35k char output limit
    // that prevents context bloat, so more nodes just means better coverage
    // across entry points (especially for large files like Svelte components).
    const subgraph = await cg.findRelevantContext(query, {
      searchLimit: 8,
      traversalDepth: 3,
      maxNodes: 200,
      minScore: 0.2,
    });

    if (subgraph.nodes.size === 0) {
      return this.textResult(`No relevant code found for "${query}"`);
    }

    // Step 2: Group nodes by file, score by relevance
    const fileGroups = new Map<string, { nodes: Node[]; score: number }>();
    const entryNodeIds = new Set(subgraph.roots);

    // Build a set of nodes directly connected to entry points (depth 1)
    const connectedToEntry = new Set<string>();
    for (const edge of subgraph.edges) {
      if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
      if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
    }

    for (const node of subgraph.nodes.values()) {
      // Skip import/export nodes — they add noise without information
      if (node.kind === 'import' || node.kind === 'export') continue;

      const group = fileGroups.get(node.filePath) || { nodes: [], score: 0 };
      group.nodes.push(node);
      // Score: entry point nodes worth 10, directly connected worth 3, others worth 1
      if (entryNodeIds.has(node.id)) {
        group.score += 10;
      } else if (connectedToEntry.has(node.id)) {
        group.score += 3;
      } else {
        group.score += 1;
      }
      fileGroups.set(node.filePath, group);
    }

    // Only include files that have entry points or nodes directly connected to entry points
    const relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= 3);

    // Extract query terms for relevance checking
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

    // Sort files: highest relevance first, deprioritize low-value files
    const sortedFiles = relevantFiles.sort((a, b) => {
      const aPath = a[0].toLowerCase();
      const bPath = b[0].toLowerCase();

      // Check if any node name or file path relates to query terms
      const hasQueryRelevance = (filePath: string, nodes: Node[]) => {
        const fp = filePath.toLowerCase();
        if (queryTerms.some(t => fp.includes(t))) return true;
        return nodes.some(n => queryTerms.some(t => n.name.toLowerCase().includes(t)));
      };

      const aRelevant = hasQueryRelevance(aPath, a[1].nodes);
      const bRelevant = hasQueryRelevance(bPath, b[1].nodes);
      if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;

      // Deprioritize test files, icon files, and i18n files
      const isLowValue = (p: string) =>
        /\/(tests?|__tests?__|spec)\//i.test(p) ||
        /\bicons?\b/i.test(p) ||
        /\bi18n\b/i.test(p);
      const aLow = isLowValue(aPath);
      const bLow = isLowValue(bPath);
      if (aLow !== bLow) return aLow ? 1 : -1;

      if (a[1].score !== b[1].score) return b[1].score - a[1].score;
      return b[1].nodes.length - a[1].nodes.length;
    });

    // Step 3: Build relationship map
    const lines: string[] = [
      `## Exploration: ${query}`,
      '',
      `Found ${subgraph.nodes.size} symbols across ${fileGroups.size} files.`,
      '',
    ];

    // Relationship map — show how symbols connect
    const significantEdges = subgraph.edges.filter(e =>
      e.kind !== 'contains' // skip contains — it's implied by file grouping
    );

    if (budget.includeRelationships && significantEdges.length > 0) {
      lines.push('### Relationships');
      lines.push('');

      // Group edges by kind for readability
      const byKind = new Map<string, Array<{ source: string; target: string }>>();
      for (const edge of significantEdges) {
        const sourceNode = subgraph.nodes.get(edge.source);
        const targetNode = subgraph.nodes.get(edge.target);
        if (!sourceNode || !targetNode) continue;

        const group = byKind.get(edge.kind) || [];
        group.push({ source: sourceNode.name, target: targetNode.name });
        byKind.set(edge.kind, group);
      }

      for (const [kind, edges] of byKind) {
        const cap = budget.maxEdgesPerRelationshipKind;
        const shown = edges.slice(0, cap);
        lines.push(`**${kind}:**`);
        for (const e of shown) {
          lines.push(`- ${e.source} → ${e.target}`);
        }
        if (edges.length > cap) {
          lines.push(`- ... and ${edges.length - cap} more`);
        }
        lines.push('');
      }
    }

    // Step 4: Read contiguous file sections
    lines.push('### Source Code');
    lines.push('');

    let totalChars = lines.join('\n').length;
    let filesIncluded = 0;
    let anyFileTrimmed = false;

    for (const [filePath, group] of sortedFiles) {
      if (filesIncluded >= maxFiles) break;
      if (totalChars > budget.maxOutputChars * 0.9) break;

      const absPath = validatePathWithinRoot(projectRoot, filePath);
      if (!absPath || !existsSync(absPath)) continue;

      let fileContent: string;
      try {
        fileContent = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const fileLines = fileContent.split('\n');
      const lang = group.nodes[0]?.language || '';

      // Cluster nearby symbols to avoid reading huge gaps between distant symbols.
      // Sort by start line, then merge overlapping/adjacent ranges (within the
      // adaptive gap threshold). Include both node ranges AND edge source
      // locations so template sections with component usages/calls are
      // covered (not just script block symbols).
      //
      // Each range carries an `importance` score so we can rank clusters
      // when the per-file budget forces us to drop some: entry-point nodes
      // are worth 10, directly-connected nodes 3, peripheral nodes 1, and
      // bare edge-source lines 2 (less than a connected node but more than
      // a peripheral one — they hint at a reference but aren't a definition).
      // Container kinds whose body can span most/all of a file. When such a
      // node covers most of the file we drop it from the ranges: keeping it
      // would merge every method inside it into one giant cluster spanning
      // the whole file, which then tail-trims down to just the container's
      // opening lines (its header/declarations) and buries the methods the
      // query actually asked about (#185 follow-up — Session.swift in
      // Alamofire is the canonical case: the `Session` class spans ~1,400
      // lines). We want the granular symbols inside, not the envelope.
      const ENVELOPE_KINDS = new Set(['file', 'module', 'class', 'struct', 'interface', 'enum', 'namespace', 'protocol', 'trait', 'component']);
      const ranges: Array<{ start: number; end: number; name: string; kind: string; importance: number }> = group.nodes
        .filter(n => n.startLine > 0 && n.endLine > 0)
        // Drop whole-file envelope nodes (containers covering >50% of the file).
        .filter(n => !(ENVELOPE_KINDS.has(n.kind) && (n.endLine - n.startLine + 1) > fileLines.length * 0.5))
        .map(n => {
          let importance = 1;
          if (entryNodeIds.has(n.id)) importance = 10;
          else if (connectedToEntry.has(n.id)) importance = 3;
          return { start: n.startLine, end: n.endLine, name: n.name, kind: n.kind, importance };
        });

      // Add edge source locations in this file — captures template references
      // (component usages, event handlers) that aren't nodes themselves.
      // Query edges directly from the DB (not just the subgraph) because BFS
      // traversal may have pruned template reference targets due to node budget.
      const edgeLines = new Set<string>(); // dedup by "line:name"
      for (const node of group.nodes) {
        const outgoing = cg.getOutgoingEdges(node.id);
        for (const edge of outgoing) {
          if (!edge.line || edge.line <= 0 || edge.kind === 'contains') continue;
          const key = `${edge.line}:${edge.target}`;
          if (edgeLines.has(key)) continue;
          edgeLines.add(key);
          // Look up target name from subgraph first, fall back to edge kind
          const targetNode = subgraph.nodes.get(edge.target);
          const targetName = targetNode?.name ?? edge.kind;
          ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2 });
        }
      }

      ranges.sort((a, b) => a.start - b.start);

      if (ranges.length === 0) continue;

      const gapThreshold = budget.gapThreshold;
      const clusters: Array<{ start: number; end: number; symbols: string[]; score: number; maxImportance: number }> = [];
      let current = {
        start: ranges[0]!.start,
        end: ranges[0]!.end,
        symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
        score: ranges[0]!.importance,
        maxImportance: ranges[0]!.importance,
      };

      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i]!;
        if (r.start <= current.end + gapThreshold) {
          current.end = Math.max(current.end, r.end);
          current.symbols.push(`${r.name}(${r.kind})`);
          current.score += r.importance;
          current.maxImportance = Math.max(current.maxImportance, r.importance);
        } else {
          clusters.push(current);
          current = {
            start: r.start,
            end: r.end,
            symbols: [`${r.name}(${r.kind})`],
            score: r.importance,
            maxImportance: r.importance,
          };
        }
      }
      clusters.push(current);

      // Build file section output from clusters, capped by per-file budget.
      // The pathological case (#185): a file like Session.swift where every
      // method is adjacent collapses into one cluster spanning the whole
      // file, and dumping that into the agent's context is most of the
      // token cost on small projects. We pick clusters in priority order
      // until the per-file char cap is hit. Truly enormous single clusters
      // get tail-trimmed with a marker.
      const contextPadding = 3;
      const withLineNumbers = exploreLineNumbersEnabled();
      const buildSection = (c: { start: number; end: number }): string => {
        const startIdx = Math.max(0, c.start - 1 - contextPadding);
        const endIdx = Math.min(fileLines.length, c.end + contextPadding);
        const slice = fileLines.slice(startIdx, endIdx).join('\n');
        // startIdx is 0-based, so the slice's first line is line startIdx + 1.
        return withLineNumbers ? numberSourceLines(slice, startIdx + 1) : slice;
      };
      // Language-neutral separator (no `//` — not a comment in Python, Ruby,
      // etc.). With line numbers on, the line-number jump also signals the gap.
      const GAP_MARKER = '\n\n... (gap) ...\n\n';

      // Rank clusters for inclusion under the per-file cap. Entry-point
      // clusters come first: a cluster containing a query entry point
      // (importance 10) must outrank a dense block of mere declarations,
      // otherwise on a large file like Session.swift the top-of-file class
      // header + property list (many adjacent low-importance nodes, high
      // density) wins the budget and buries the actual methods the query
      // asked about (perform/didCreateURLRequest/task live deep in the
      // file). Within the same importance tier, prefer density (score per
      // line) so we still favor focused clusters over sprawling ones, then
      // smaller span as a cheap-to-include tiebreak.
      const rankedClusters = clusters
        .map((c, i) => ({ idx: i, span: c.end - c.start + 1, c }))
        .sort((a, b) => {
          if (b.c.maxImportance !== a.c.maxImportance) return b.c.maxImportance - a.c.maxImportance;
          const densityA = a.c.score / a.span;
          const densityB = b.c.score / b.span;
          if (densityB !== densityA) return densityB - densityA;
          if (b.c.score !== a.c.score) return b.c.score - a.c.score;
          return a.span - b.span;
        });

      const chosenIndices = new Set<number>();
      let projectedChars = 0;
      for (const rc of rankedClusters) {
        const sectionLen = buildSection(rc.c).length + (chosenIndices.size > 0 ? GAP_MARKER.length : 0);
        // Always take the top-ranked cluster, even if oversize, so we don't
        // return an empty file section (agent would then re-Read the file,
        // negating the savings).
        if (chosenIndices.size === 0) {
          chosenIndices.add(rc.idx);
          projectedChars += sectionLen;
          continue;
        }
        if (projectedChars + sectionLen > budget.maxCharsPerFile) continue;
        chosenIndices.add(rc.idx);
        projectedChars += sectionLen;
      }

      // Emit chosen clusters in source order so the file reads top-to-bottom.
      let fileSection = '';
      const allSymbols: string[] = [];
      let fileTrimmed = false;
      for (let i = 0; i < clusters.length; i++) {
        if (!chosenIndices.has(i)) continue;
        const cluster = clusters[i]!;
        const section = buildSection(cluster);
        if (fileSection.length > 0) fileSection += GAP_MARKER;
        fileSection += section;
        allSymbols.push(...cluster.symbols);
      }

      // If a single chosen cluster is still oversize (long monolithic
      // function), tail-trim it. Better one trimmed view than nothing.
      if (fileSection.length > budget.maxCharsPerFile) {
        fileSection = fileSection.slice(0, budget.maxCharsPerFile) + '\n... (trimmed) ...';
        fileTrimmed = true;
      }
      if (chosenIndices.size < clusters.length || fileTrimmed) {
        anyFileTrimmed = true;
      }

      // Dedupe + cap the symbols list shown in the per-file header. Some
      // files (Session.swift in Alamofire) produced 3.4KB symbol lists
      // from cluster scoring + edge-source lines, dwarfing the per-file
      // body cap. Show top names by frequency, with a "+N more" tail.
      const symbolCounts = new Map<string, number>();
      for (const s of allSymbols) {
        symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
      }
      const sortedSymbols = [...symbolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);
      const headerCap = budget.maxSymbolsInFileHeader;
      const headerSymbols = sortedSymbols.slice(0, headerCap);
      const omittedCount = sortedSymbols.length - headerSymbols.length;
      const headerSuffix = omittedCount > 0
        ? `${headerSymbols.join(', ')}, +${omittedCount} more`
        : headerSymbols.join(', ');
      const fileHeader = `#### ${filePath} — ${headerSuffix}`;

      // Respect the total output cap on a file-by-file basis.
      if (totalChars + fileSection.length + 200 > budget.maxOutputChars) {
        const remaining = budget.maxOutputChars - totalChars - 200;
        if (remaining < 500) break;
        const trimmed = fileSection.slice(0, remaining) + '\n... (trimmed) ...';

        lines.push(fileHeader);
        lines.push(`Reason: ${formatRelevanceReason(subgraph.reasons?.files[filePath])}`);
        lines.push('');
        lines.push('```' + lang);
        lines.push(trimmed);
        lines.push('```');
        lines.push('');
        totalChars += trimmed.length + 200;
        filesIncluded++;
        anyFileTrimmed = true;
        break;
      }

      lines.push(fileHeader);
      lines.push(`Reason: ${formatRelevanceReason(subgraph.reasons?.files[filePath])}`);
      lines.push('');
      lines.push('```' + lang);
      lines.push(fileSection);
      lines.push('```');
      lines.push('');

      totalChars += fileSection.length + 200;
      filesIncluded++;
    }

    // Add remaining files as references (from both relevant and peripheral files).
    // Small projects (per budget) skip this — the relevant story already fits
    // in the source section, and a trailing pointer list is pure overhead.
    if (budget.includeAdditionalFiles) {
      const remainingRelevant = sortedFiles.slice(filesIncluded);
      const peripheralFiles = [...fileGroups.entries()]
        .filter(([, group]) => group.score < 3)
        .sort((a, b) => b[1].score - a[1].score);
      const remainingFiles = [...remainingRelevant, ...peripheralFiles];
      if (remainingFiles.length > 0) {
        lines.push('### Additional relevant files (not shown)');
        lines.push('');
        for (const [filePath, group] of remainingFiles.slice(0, 10)) {
          const symbols = group.nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
          lines.push(`- ${filePath}: ${symbols}`);
        }
        if (remainingFiles.length > 10) {
          lines.push(`- ... and ${remainingFiles.length - 10} more files`);
        }
      }
    }

    // Add completeness signal so agents know they don't need to re-read these files.
    // On small projects the budget gates this off — but if we actually had to
    // trim or drop clusters, surface a brief note so the agent knows it can
    // still Read for more detail.
    if (budget.includeCompletenessSignal) {
      lines.push('');
      lines.push('---');
      lines.push(`> **Complete source code is included above for ${filesIncluded} files.** You do NOT need to re-read these files — the relevant sections are already shown in full. Only use Read/Grep for files listed under "Additional relevant files" if you need more detail.`);
    } else if (anyFileTrimmed) {
      lines.push('');
      lines.push(`> Some file sections were trimmed for size. Use \`codegraph_node\` or Read for the full source if needed.`);
    }

    // Add explore budget note based on project size
    if (budget.includeBudgetNote) {
      try {
        const stats = cg.getStats();
        const callBudget = getExploreBudget(stats.fileCount);
        lines.push('');
        lines.push(`> **Explore budget: ${callBudget} calls max for this project (${stats.fileCount.toLocaleString()} files indexed).** Stop exploring and synthesize your answer once you've used ${callBudget} calls — do NOT make additional explore calls beyond this budget.`);
      } catch {
        // Stats unavailable — skip budget note
      }
    }

    // Hard-cap to the adaptive budget. The per-file loop bounds the source
    // sections, but the relationship map, additional-files list, and
    // completeness/budget notes can still push the assembled output past
    // maxOutputChars (observed 30k against a 28k tier cap). A fat explore
    // payload persists in the agent's context and is re-read as cache-input
    // on every subsequent turn, so the overrun is paid many times over.
    const output = lines.join('\n');
    if (output.length > budget.maxOutputChars) {
      const cut = output.slice(0, budget.maxOutputChars);
      const lastNewline = cut.lastIndexOf('\n');
      const safe = lastNewline > budget.maxOutputChars * 0.8 ? cut.slice(0, lastNewline) : cut;
      return this.textResult(safe + '\n\n... (explore output truncated to budget — use codegraph_node or Read for more)');
    }
    return this.textResult(output);
  }

  /**
   * Handle codegraph_trace
   */
  private async handleTrace(args: Record<string, unknown>): Promise<ToolResult> {
    const from = this.argsToTraceLocator(args, 'from');
    if (this.isToolResult(from)) return from;

    const to = this.argsToTraceTarget(args);
    if (to && typeof to !== 'string' && this.isToolResult(to)) return to;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const options = this.argsToTraceOptions(args);
    if (this.isToolResult(options)) return options;

    const result = cg.trace(from, to, options);
    return this.textResult(this.truncateOutput(this.formatTraceResult(result)));
  }

  /**
   * Handle codegraph_node
   */
  private async handleNode(args: Record<string, unknown>): Promise<ToolResult> {
    const locator = this.argsToLocator(args);
    if (this.isToolResult(locator)) return locator;

    const detail = this.parseNodeDetail(args.detail);
    if (this.isToolResult(detail)) return detail;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    // Default to false to minimize context usage
    const includeCode = args.includeCode === true;

    if (detail === 'structure') {
      const resolution = cg.resolveNodeLocator(locator);
      if (resolution.status !== 'resolved' || !resolution.node) {
        return this.textResult(this.formatResolutionFailure(resolution));
      }
      const result = await cg.getNodeStructure(resolution.node.id);
      const formatted = this.formatNodeStructure(result, { includeCodeIgnored: includeCode });
      return this.textResult(this.truncateOutput(formatted));
    }

    let match: { node: Node; note: string } | null;
    if (this.isSymbolOnlyLocator(locator)) {
      match = this.findSymbol(cg, locator.symbol!);
      if (!match) {
        return this.textResult(`Symbol "${locator.symbol}" not found in the codebase`);
      }
    } else {
      const resolution = cg.resolveNodeLocator(locator);
      if (resolution.status !== 'resolved' || !resolution.node) {
        return this.textResult(this.formatResolutionFailure(resolution));
      }
      match = { node: resolution.node, note: '' };
    }

    let code: string | null = null;
    let outline: string | null = null;

    if (includeCode) {
      // For container symbols (class/interface/struct/…), the full body is the
      // sum of every method body — a wall of source (e.g. a 10k-char class)
      // that bloats context and is rarely needed in full. Return a structural
      // outline (members + signatures + line numbers) instead; the agent can
      // Read or codegraph_node a specific method for its body. Leaf symbols
      // (function/method/etc.) return their full body as before.
      if (CONTAINER_NODE_KINDS.has(match.node.kind)) {
        outline = this.buildContainerOutline(cg, match.node);
      }
      if (!outline) {
        code = await cg.getCode(match.node.id);
      }
    }

    const formatted = this.formatNodeDetails(match.node, code, outline) + match.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_status
   */
  private async handleStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const stats = cg.getStats();

    const lines: string[] = [
      '## CodeGraph Status',
      '',
      `**Files indexed:** ${stats.fileCount}`,
      `**Total nodes:** ${stats.nodeCount}`,
      `**Total edges:** ${stats.edgeCount}`,
      `**Database size:** ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
    ];

    // Surface the active SQLite backend (node:sqlite, Node's built-in real
    // SQLite — full WAL + FTS5, no native build).
    lines.push(`**Backend:** node:sqlite (Node built-in) — full WAL + FTS5`);

    // Effective journal mode. 'wal' ⇒ concurrent reads never block on a writer;
    // anything else ⇒ they can ("database is locked"). node:sqlite supports WAL
    // everywhere, so a non-wal mode means the filesystem can't (network/
    // virtualized mounts, WSL2 /mnt). See issue #238.
    const journalMode = cg.getJournalMode();
    if (journalMode === 'wal') {
      lines.push(`**Journal mode:** wal (concurrent reads safe)`);
    } else {
      lines.push(
        `**Journal mode:** ⚠ ${journalMode || 'unknown'} — WAL not active, so reads ` +
        `can block on a concurrent write (WAL appears unsupported on this filesystem)`
      );
    }

    lines.push('', '### Nodes by Kind:');

    for (const [kind, count] of Object.entries(stats.nodesByKind)) {
      if ((count as number) > 0) {
        lines.push(`- ${kind}: ${count}`);
      }
    }

    lines.push('', '### Languages:');
    for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
      if ((count as number) > 0) {
        lines.push(`- ${lang}: ${count}`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  /**
   * Handle codegraph_files - get project file structure from the index
   */
  private async handleFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const pathFilter = args.path as string | undefined;
    const pattern = args.pattern as string | undefined;
    const format = (args.format as 'tree' | 'flat' | 'grouped') || 'tree';
    const includeMetadata = args.includeMetadata !== false;
    const maxDepth = args.maxDepth != null ? clamp(args.maxDepth as number, 1, 20) : undefined;

    // Get all files from the index
    const allFiles = cg.getFiles();

    if (allFiles.length === 0) {
      return this.textResult('No files indexed. Run `codegraph index` first.');
    }

    // Filter by path prefix
    let files = pathFilter
      ? allFiles.filter(f => f.path.startsWith(pathFilter) || f.path.startsWith('./' + pathFilter))
      : allFiles;

    // Filter by glob pattern
    if (pattern) {
      const regex = this.globToRegex(pattern);
      files = files.filter(f => regex.test(f.path));
    }

    if (files.length === 0) {
      return this.textResult(this.formatFilesNoMatch(pathFilter, pattern));
    }

    // Format output
    let output: string;
    switch (format) {
      case 'flat':
        output = this.formatFilesFlat(files, includeMetadata);
        break;
      case 'grouped':
        output = this.formatFilesGrouped(files, includeMetadata);
        break;
      case 'tree':
      default:
        output = this.formatFilesTree(files, includeMetadata, maxDepth);
        break;
    }

    return this.textResult(this.truncateOutput(output));
  }

  private formatFilesNoMatch(pathFilter?: string, pattern?: string): string {
    const lines: string[] = [
      'No indexed files matched the criteria.',
      '',
    ];

    const criteria: string[] = [];
    if (pathFilter) criteria.push(`path=${pathFilter}`);
    if (pattern) criteria.push(`pattern=${pattern}`);
    if (criteria.length > 0) {
      lines.push(`Criteria: ${criteria.join(' ')}`, '');
    }

    lines.push(
      'Note: codegraph_files lists indexed files only, not the complete filesystem. A file may be new, ignored, unsupported, non-code, or not synced yet.',
      'Use index-relative paths like `src/foo.ts`, not `./src/foo.ts` or absolute paths.',
      'Suggested checks:',
      '- git status'
    );
    if (pathFilter) lines.push(`- read ${pathFilter}`);
    lines.push('- codegraph sync --quiet');

    return lines.join('\n');
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars except * and ?
      .replace(/\*\*/g, '{{GLOBSTAR}}')       // Temp placeholder for **
      .replace(/\*/g, '[^/]*')                // * matches anything except /
      .replace(/\?/g, '[^/]')                 // ? matches single char except /
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');    // ** matches anything including /
    return new RegExp(escaped);
  }

  /**
   * Format files as a flat list
   */
  private formatFilesFlat(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const lines: string[] = [`## Files (${files.length})`, ''];

    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format files grouped by language
   */
  private formatFilesGrouped(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const byLang = new Map<string, typeof files>();

    for (const file of files) {
      const existing = byLang.get(file.language) || [];
      existing.push(file);
      byLang.set(file.language, existing);
    }

    const lines: string[] = [`## Files by Language (${files.length} total)`, ''];

    // Sort languages by file count (descending)
    const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [lang, langFiles] of sortedLangs) {
      lines.push(`### ${lang} (${langFiles.length})`);
      for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
        if (includeMetadata) {
          lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
        } else {
          lines.push(`- ${file.path}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format files as a tree structure
   */
  private formatFilesTree(
    files: { path: string; language: string; nodeCount: number }[],
    includeMetadata: boolean,
    maxDepth?: number
  ): string {
    // Build tree structure
    interface TreeNode {
      name: string;
      children: Map<string, TreeNode>;
      file?: { language: string; nodeCount: number };
    }

    const root: TreeNode = { name: '', children: new Map() };

    for (const file of files) {
      const parts = file.path.split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        if (!current.children.has(part)) {
          current.children.set(part, { name: part, children: new Map() });
        }
        current = current.children.get(part)!;

        // If this is the last part, it's a file
        if (i === parts.length - 1) {
          current.file = { language: file.language, nodeCount: file.nodeCount };
        }
      }
    }

    // Render tree
    const lines: string[] = [`## Project Structure (${files.length} files)`, ''];

    const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
      if (maxDepth !== undefined && depth > maxDepth) return;

      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (node.name) {
        let line = prefix + connector + node.name;
        if (node.file && includeMetadata) {
          line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
        }
        lines.push(line);
      }

      const children = [...node.children.values()];
      // Sort: directories first, then files, both alphabetically
      children.sort((a, b) => {
        const aIsDir = a.children.size > 0 && !a.file;
        const bIsDir = b.children.size > 0 && !b.file;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const nextPrefix = node.name ? prefix + childPrefix : prefix;
        renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
      }
    };

    renderNode(root, '', true, 0);

    return lines.join('\n');
  }

  // =========================================================================
  // Symbol resolution helpers
  // =========================================================================

  private argsToLocator(args: Record<string, unknown>): NodeLocator | ToolResult {
    const locator: NodeLocator = {};
    let hasField = false;

    const readString = (key: keyof NodeLocator): ToolResult | undefined => {
      const value = args[key];
      if (value === undefined) return undefined;
      hasField = true;
      const valid = this.validateString(value, key);
      if (typeof valid !== 'string') return valid;
      (locator as Record<string, unknown>)[key] = valid;
      return undefined;
    };

    for (const key of ['symbol', 'nodeId', 'qualifiedName', 'path', 'fileLine'] as Array<keyof NodeLocator>) {
      const error = readString(key);
      if (error) return error;
    }

    if (args.line !== undefined) {
      hasField = true;
      const line = Number(args.line);
      if (!Number.isInteger(line) || line <= 0) {
        return this.errorResult('line must be a positive integer');
      }
      locator.line = line;
    }

    if (!hasField) {
      return this.errorResult('At least one locator field is required: nodeId, fileLine, path+line, qualifiedName, or symbol');
    }

    return locator;
  }

  private isSymbolOnlyLocator(locator: NodeLocator): boolean {
    return Boolean(locator.symbol) &&
      !locator.nodeId &&
      !locator.qualifiedName &&
      !locator.path &&
      locator.line === undefined &&
      !locator.fileLine;
  }

  private locatorLabel(locator: NodeLocator): string {
    if (locator.nodeId) return `nodeId=${locator.nodeId}`;
    if (locator.fileLine) return locator.fileLine;
    if (locator.path && locator.line !== undefined) return `${locator.path}:${locator.line}`;
    if (locator.qualifiedName) return locator.qualifiedName;
    if (locator.symbol) return locator.symbol;
    return 'locator';
  }

  private resolveCallGraphRoots(cg: CodeGraph, locator: NodeLocator): { nodes: Node[]; note: string } {
    if (this.isSymbolOnlyLocator(locator)) {
      return this.findAllSymbols(cg, locator.symbol!);
    }

    const resolution = cg.resolveNodeLocator(locator);
    if (resolution.status !== 'resolved' || !resolution.node) {
      return { nodes: [], note: this.formatResolutionFailure(resolution) };
    }
    return { nodes: [resolution.node], note: '' };
  }

  private argsToTraceLocator(args: Record<string, unknown>, prefix: 'from' | 'to'): NodeLocator | ToolResult {
    const locator: NodeLocator = {};
    let hasField = false;

    const shorthand = args[prefix];
    if (shorthand !== undefined) {
      hasField = true;
      const valid = this.validateString(shorthand, prefix);
      if (typeof valid !== 'string') return valid;
      locator.symbol = valid;
    }

    const stringFields: Array<[string, keyof NodeLocator]> = [
      [`${prefix}NodeId`, 'nodeId'],
      [`${prefix}QualifiedName`, 'qualifiedName'],
      [`${prefix}Path`, 'path'],
      [`${prefix}FileLine`, 'fileLine'],
    ];

    for (const [argName, locatorKey] of stringFields) {
      const value = args[argName];
      if (value === undefined) continue;
      hasField = true;
      const valid = this.validateString(value, argName);
      if (typeof valid !== 'string') return valid;
      (locator as Record<string, unknown>)[locatorKey] = valid;
    }

    const lineArg = args[`${prefix}Line`];
    if (lineArg !== undefined) {
      hasField = true;
      const line = Number(lineArg);
      if (!Number.isInteger(line) || line <= 0) {
        return this.errorResult(`${prefix}Line must be a positive integer`);
      }
      locator.line = line;
    }

    if (!hasField) {
      return this.errorResult(`${prefix} locator is required`);
    }

    return locator;
  }

  private argsToTraceTarget(args: Record<string, unknown>): NodeLocator | string | undefined | ToolResult {
    const hasTarget = ['to', 'toNodeId', 'toQualifiedName', 'toPath', 'toLine', 'toFileLine']
      .some((key) => args[key] !== undefined);
    if (!hasTarget) return undefined;

    const locator = this.argsToTraceLocator(args, 'to');
    if (this.isToolResult(locator)) return locator;

    if (locator.symbol && this.isSymbolOnlyLocator(locator)) {
      return locator.symbol;
    }
    return locator;
  }

  private argsToTraceOptions(args: Record<string, unknown>): TraceOptions | ToolResult {
    const direction = args.direction as string | undefined;
    if (direction && !['outgoing', 'incoming', 'both'].includes(direction)) {
      return this.errorResult('direction must be outgoing, incoming, or both');
    }

    const edgeKinds = this.parseStringArray(args.edgeKinds, 'edgeKinds');
    if (this.isToolResult(edgeKinds)) return edgeKinds;
    const invalidEdgeKind = edgeKinds.find((kind: string) => !(EDGE_KIND_VALUES as string[]).includes(kind));
    if (invalidEdgeKind) return this.errorResult(`Invalid edge kind: ${invalidEdgeKind}`);

    const includePaths = this.parseStringArray(args.includePaths, 'includePaths');
    if (this.isToolResult(includePaths)) return includePaths;
    const excludePaths = this.parseStringArray(args.excludePaths, 'excludePaths');
    if (this.isToolResult(excludePaths)) return excludePaths;

    const options: TraceOptions = {
      maxDepth: args.maxDepth !== undefined ? clamp(Number(args.maxDepth), 1, 20) : undefined,
      maxPaths: args.maxPaths !== undefined ? clamp(Number(args.maxPaths), 1, 20) : undefined,
      edgeKinds: edgeKinds.length > 0 ? edgeKinds as EdgeKind[] : undefined,
      direction: direction as TraceOptions['direction'] | undefined,
      includePaths: includePaths.length > 0 ? includePaths : undefined,
      excludePaths: excludePaths.length > 0 ? excludePaths : undefined,
      scopePath: typeof args.scopePath === 'string' ? args.scopePath : undefined,
    };

    if (args.scopePath !== undefined && typeof args.scopePath !== 'string') {
      return this.errorResult('scopePath must be a string');
    }

    return options;
  }

  private parseStringArray(value: unknown, name: string): string[] | ToolResult {
    if (value === undefined) return [];
    if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
    if (!Array.isArray(value)) return this.errorResult(`${name} must be an array of strings`);
    const result: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string' || item.length === 0) {
        return this.errorResult(`${name} must be an array of non-empty strings`);
      }
      result.push(item);
    }
    return result;
  }

  private parseNodeDetail(value: unknown): 'structure' | undefined | ToolResult {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return this.errorResult('detail must be a string');
    if (value !== 'structure') return this.errorResult('Invalid detail: expected "structure"');
    return 'structure';
  }

  /**
   * Find a symbol by name, handling disambiguation when multiple matches exist.
   * Returns the best match and a note about alternatives if any.
   */
  /**
   * Check if a node matches a symbol query.
   *
   * Accepts simple names (`run`) and three flavors of qualifier:
   *   - dotted     `Session.request`         (TS/JS/Python)
   *   - colon-pair `stage_apply::run`        (Rust, C++, Ruby)
   *   - slash      `configurator/stage_apply` (path-ish)
   *
   * Multi-level qualifiers compose: `crate::configurator::stage_apply::run`
   * works. Rust path prefixes (`crate`, `super`, `self`) are stripped so
   * the canonical `crate::module::symbol` form resolves.
   *
   * Resolution order, last part must always equal `node.name`:
   *   1. Suffix-match against `qualifiedName` (handles class-scoped methods
   *      where the extractor builds the qualified name from the AST stack)
   *   2. File-path containment (handles file-derived modules in Rust/
   *      Python — `stage_apply::run` matches a `run` in `stage_apply.rs`)
   */
  private matchesSymbol(node: Node, symbol: string): boolean {
    return nodeMatchesSymbol(node, symbol);
  }

  private findSymbol(cg: CodeGraph, symbol: string): { node: Node; note: string } | null {
    // Use higher limit for qualified lookups (e.g., "Session.request",
    // "stage_apply::run") since the target may rank lower in FTS when
    // there are many partial matches across the qualifier parts.
    const isQualified = /[.\/]|::/.test(symbol);
    const limit = isQualified ? 50 : 10;
    let results = cg.searchNodes(symbol, { limit });

    // FTS strips colons as a special char, so `stage_apply::run` searches
    // for the literal `stage_applyrun` and finds nothing. Re-search by
    // the bare last part and let `matchesSymbol` filter by qualifier.
    if (isQualified && results.length === 0) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
    }

    if (results.length === 0 || !results[0]) {
      return null;
    }

    const exactMatches = results.filter(r => this.matchesSymbol(r.node, symbol));

    if (exactMatches.length === 1) {
      return { node: exactMatches[0]!.node, note: '' };
    }

    if (exactMatches.length > 1) {
      // Multiple exact matches - pick first for backward compatibility, but
      // include copyable handles for exact follow-up.
      const picked = exactMatches[0]!.node;
      const alternatives = exactMatches.map(r => r.node);
      const note = this.formatAmbiguity(alternatives, symbol, `Showing first match: ${formatNodeHandle(picked)}`);
      return { node: picked, note };
    }

    // No exact match. For qualified lookups, don't silently fall back
    // to a fuzzy result — the user typed a specific qualifier, and
    // resolving `stage_apply::nonexistent_fn` to the unrelated
    // `stage_apply.rs` file would be actively misleading (#173).
    if (isQualified) return null;
    return { node: results[0]!.node, note: '' };
  }

  /**
   * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
   * results across all matching symbols (e.g., multiple classes with an `execute` method).
   */
  private findAllSymbols(cg: CodeGraph, symbol: string): { nodes: Node[]; note: string } {
    let results = cg.searchNodes(symbol, { limit: 50 });

    // Mirror the fallback in `findSymbol` for qualified queries — FTS
    // strips colons, so a module-qualified lookup needs a second pass
    // by the bare last part.
    if (results.length === 0 && /[.\/]|::/.test(symbol)) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
    }

    if (results.length === 0) {
      return { nodes: [], note: '' };
    }

    const exactMatches = results.filter(r => this.matchesSymbol(r.node, symbol));

    if (exactMatches.length <= 1) {
      const node = exactMatches[0]?.node ?? results[0]!.node;
      return { nodes: [node], note: '' };
    }

    const nodes = exactMatches.map(r => r.node);
    const note = this.formatAmbiguity(
      nodes,
      symbol,
      `Aggregated results across ${exactMatches.length} symbols named "${symbol}".`
    );
    return { nodes, note };
  }

  private formatAmbiguity(nodes: Node[], query: string, intro?: string): string {
    const cap = 10;
    const lines = [
      '',
      `> **Note:** ${nodes.length} symbols named "${query}" (ambiguous locator) matched ${nodes.length} nodes. ${intro ?? 'Use an exact handle for follow-up:'}`,
      ...this.formatGroupedNodeHandles(nodes, cap, '> '),
    ];
    return '\n' + lines.join('\n');
  }

  private formatGroupedNodeHandles(nodes: Node[], cap: number = 10, prefix: string = ''): string[] {
    const shown = [...nodes]
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine || a.name.localeCompare(b.name))
      .slice(0, cap);
    const byFile = new Map<string, Node[]>();

    for (const node of shown) {
      const existing = byFile.get(node.filePath) ?? [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    const lines: string[] = [];
    for (const [file, fileNodes] of byFile) {
      lines.push(`${prefix}${file}:`);
      for (const node of fileNodes) {
        lines.push(`${prefix}- ${node.name} (${node.kind}) ${formatNodeHandle(node)}`);
      }
    }
    if (nodes.length > cap) {
      lines.push(`${prefix}- ... and ${nodes.length - cap} more`);
    }
    return lines;
  }

  private formatResolutionFailure(resolution: LocatorResolution): string {
    const label = this.locatorLabel(resolution.locator);
    const lines: string[] = [
      resolution.status === 'ambiguous'
        ? `Ambiguous locator "${label}".`
        : (resolution.message ?? `Node not found for "${label}".`),
    ];

    if (resolution.alternatives && resolution.alternatives.length > 0) {
      lines.push(
        '',
        resolution.status === 'ambiguous' ? 'Alternatives:' : 'Nearby alternatives:',
        ...this.formatGroupedNodeHandles(resolution.alternatives, 10)
      );
    }

    return lines.join('\n');
  }

  private formatTraceResult(result: TraceResult): string {
    const lines: string[] = [
      '## Trace',
      '',
      '> Static graph candidate only. This is not runtime proof; dynamic dispatch, callbacks, registries, and dependency injection may hide or reorder runtime paths. Resolution confidence is static, not runtime probability.',
      '',
    ];

    if (result.from) {
      lines.push(`From: ${result.from.name} (${result.from.kind}) nodeId=${result.from.nodeId} range=${result.from.path}:${result.from.startLine}-${result.from.endLine}`);
    }

    if (result.status !== 'resolved') {
      lines.push(`Status: ${result.status}`);
      lines.push('', this.formatResolutionFailure(result.fromResolution));
      const recs = this.buildTraceNextChecks(result);
      if (recs.length > 0) {
        lines.push('', '### Recommended next');
        for (const rec of recs) lines.push(`- ${rec.replace(/^[-•]\s*/, '')}`);
      }
      lines.push('', `> ${result.completenessNote}`);
      return lines.join('\n');
    }

    if (result.targetCandidates.length > 0) {
      lines.push(`Targets considered: ${result.targetCandidates.length}`);
      for (const target of result.targetCandidates.slice(0, 5)) {
        lines.push(`- ${target.name} (${target.kind}) nodeId=${target.nodeId} range=${target.path}:${target.startLine}-${target.endLine}`);
      }
      if (result.targetCandidates.length > 5) {
        lines.push(`- ... and ${result.targetCandidates.length - 5} more`);
      }
      lines.push('');
    }

    if (result.paths.length === 0) {
      lines.push('No complete path found.');
    }

    for (let i = 0; i < result.paths.length; i++) {
      const path = result.paths[i]!;
      const ranking = path.ranking;
      if (ranking) {
        lines.push(`### Path ${i + 1} — ${ranking.label} (static score ${ranking.score.toFixed(2)}, edge confidence ${path.confidence.toFixed(2)})`);
        lines.push(`Reason: ${this.formatTraceRankingReasons(path)}`);
        if (ranking.penalties.length > 0) {
          lines.push(`Penalties: ${this.formatTraceRankingPenalties(path)}`);
        }
        lines.push(`Caveat: ${this.formatTraceRankingCaveat(path)}`);
      } else {
        lines.push(`### Path ${i + 1} (confidence ${path.confidence.toFixed(2)})`);
        lines.push(path.reason);
      }
      lines.push('');

      for (let stepIndex = 0; stepIndex < path.steps.length; stepIndex++) {
        const step = path.steps[stepIndex]!;
        if (stepIndex > 0) {
          const edge = path.edges[stepIndex - 1];
          if (edge) {
            const sourceStep = path.steps.find((s) => s.node.nodeId === edge.sourceNodeId);
            lines.push(`   └─ ${this.formatEdgeEvidence(edge, sourceStep?.node ?? null)}`);
          }
        }
        lines.push(`${stepIndex + 1}. ${step.node.name} (${step.node.kind}) nodeId=${step.node.nodeId} qualifiedName=${step.node.qualifiedName} range=${step.node.path}:${step.node.startLine}-${step.node.endLine}`);
      }
      lines.push('');
    }

    const boundaryLines = this.formatTraceBoundaries(result.boundaries);
    if (boundaryLines.length > 0) {
      lines.push(...boundaryLines, '');
    }

    if (result.gaps.length > 0) {
      lines.push('### Gaps / caveats');
      for (const gap of result.gaps) lines.push(`- ${gap}`);
      lines.push('');
    }

    lines.push('### Recommended next');
    for (const rec of this.buildTraceNextChecks(result)) {
      lines.push(`- ${rec.replace(/^[-•]\s*/, '')}`);
    }

    lines.push('', `> ${result.completenessNote}`);
    return lines.join('\n');
  }

  private formatTraceRankingReasons(path: TraceResult['paths'][number]): string {
    const reasons = path.ranking?.reasons ?? [];
    const text = reasons.length > 0 ? reasons.slice(0, 5).join('; ') : path.reason;
    return this.compactTraceRankingText(text || 'not recorded');
  }

  private formatTraceRankingPenalties(path: TraceResult['paths'][number]): string {
    const penalties = path.ranking?.penalties ?? [];
    return this.compactTraceRankingText(penalties.length > 0 ? penalties.slice(0, 5).join('; ') : 'none');
  }

  private formatTraceRankingCaveat(path: TraceResult['paths'][number]): string {
    if (path.ranking?.label === 'optional-branch') {
      return 'Static path exists; inspect guards/source before treating it as the normal runtime path.';
    }
    if (path.ranking?.label === 'low-evidence') {
      return 'Static path exists, but low-evidence or missing metadata means source inspection is required before relying on it.';
    }
    return 'Static ranking only, not runtime main-path proof.';
  }

  private compactTraceRankingText(text: string): string {
    const cleaned = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length > 220 ? `${cleaned.slice(0, 220)}…` : cleaned;
  }

  private formatTraceBoundaries(boundaries: TraceBoundary[]): string[] {
    if (boundaries.length === 0) return [];

    const lines: string[] = ['### Boundaries / low-evidence edges'];
    for (const boundary of boundaries.slice(0, 5)) {
      const parts = [
        `type=${boundary.type}`,
        `node=${boundary.node.name}`,
        `nodeId=${boundary.node.nodeId}`,
        `range=${boundary.node.path}:${boundary.node.startLine}-${boundary.node.endLine}`,
      ];
      if (boundary.enclosingNode) {
        parts.push(`enclosing=${boundary.enclosingNode.name}`);
      }
      parts.push(`callsite=${boundary.edge ? this.formatCallsite(boundary.edge.line, boundary.edge.column, boundary.enclosingNode ?? null) : 'unknown'}`);
      if (boundary.edge) {
        parts.push(`edgeKind=${boundary.edge.kind}`);
      }
      lines.push(`- ${parts.join(' ')}`);
      lines.push(`  reason=${boundary.reason}`);
    }
    return lines;
  }

  private buildTraceNextChecks(result: TraceResult): string[] {
    const recs: string[] = [];
    const firstPath = result.paths[0];

    for (const boundary of result.boundaries.slice(0, 3)) {
      this.addUniqueRecommendation(recs, `codegraph_node({ nodeId: "${boundary.node.nodeId}" })`);
      this.addUniqueRecommendation(recs, `codegraph_callees({ nodeId: "${boundary.node.nodeId}" })`);
      this.addUniqueRecommendation(recs, `read ${boundary.node.path}:${boundary.node.startLine}-${boundary.node.endLine}`);
      if (boundary.enclosingNode) {
        this.addUniqueRecommendation(recs, `codegraph_node({ nodeId: "${boundary.enclosingNode.nodeId}" })`);
        this.addUniqueRecommendation(recs, `read ${boundary.enclosingNode.path}:${boundary.enclosingNode.startLine}-${boundary.enclosingNode.endLine}`);
      }
    }

    if (firstPath) {
      for (const node of this.selectTraceNodes(firstPath.steps.map((s) => s.node), 5)) {
        this.addUniqueRecommendation(recs, `codegraph_node({ nodeId: "${node.nodeId}" })`);
      }
      for (const readCheck of this.formatTraceReadChecks(firstPath.steps.map((s) => s.node))) {
        this.addUniqueRecommendation(recs, readCheck);
      }
      const query = this.traceExploreQuery(firstPath.steps.map((s) => s.node.name));
      if (query) this.addUniqueRecommendation(recs, `codegraph_explore query "${query}"`);
    } else {
      if (result.from) {
        this.addUniqueRecommendation(recs, `codegraph_node({ nodeId: "${result.from.nodeId}" })`);
        this.addUniqueRecommendation(recs, `codegraph_callees({ nodeId: "${result.from.nodeId}" })`);
        this.addUniqueRecommendation(recs, `codegraph_callers({ nodeId: "${result.from.nodeId}" })`);
      }

      for (const target of result.targetCandidates.slice(0, 3)) {
        this.addUniqueRecommendation(recs, `codegraph_node({ nodeId: "${target.nodeId}" })`);
      }

      const alternatives = [
        ...(result.fromResolution.alternatives ?? []),
        ...(result.targetResolution?.alternatives ?? []),
      ];
      for (const node of alternatives.slice(0, 5)) {
        this.addUniqueRecommendation(recs, `codegraph_node({ nodeId: "${node.id}" })`);
      }

      const query = this.traceExploreQuery([
        result.from?.name,
        ...result.targetCandidates.map((target) => target.name),
        ...alternatives.slice(0, 5).map((node) => node.name),
      ]);
      if (query) this.addUniqueRecommendation(recs, `codegraph_explore query "${query}"`);
    }

    for (const rec of result.recommendations) {
      const normalized = this.normalizeTraceRecommendation(rec);
      if (normalized) this.addUniqueRecommendation(recs, normalized);
    }

    return recs;
  }

  private selectTraceNodes(nodes: NodeHandle[], cap: number): NodeHandle[] {
    if (nodes.length <= cap) return nodes;
    const indexes = [0, 1, Math.floor((nodes.length - 1) / 2), nodes.length - 2, nodes.length - 1];
    return Array.from(new Set(indexes))
      .sort((a, b) => a - b)
      .slice(0, cap)
      .map((index) => nodes[index]!)
      .filter(Boolean);
  }

  private formatTraceReadChecks(nodes: NodeHandle[]): string[] {
    const byPath = new Map<string, { start: number; end: number }>();
    for (const node of nodes) {
      const existing = byPath.get(node.path);
      if (!existing) {
        byPath.set(node.path, { start: node.startLine, end: node.endLine });
      } else {
        existing.start = Math.min(existing.start, node.startLine);
        existing.end = Math.max(existing.end, node.endLine);
      }
    }

    return Array.from(byPath.entries())
      .slice(0, 3)
      .map(([filePath, range]) => `read ${filePath}:${range.start}-${range.end}`);
  }

  private traceExploreQuery(names: Array<string | undefined>): string {
    return Array.from(new Set(names.filter((name): name is string => Boolean(name))))
      .slice(0, 8)
      .join(' ')
      .replace(/"/g, '\\"');
  }

  private normalizeTraceRecommendation(rec: string): string | null {
    const cleaned = rec
      .replace(/^[-•]\s*/, '')
      .replace(/^Recommended next:\s*/i, '')
      .trim();
    if (!cleaned) return null;
    if (/^Resolve ambiguity with an exact handle:?$/i.test(cleaned)) return null;
    if (/^Nearby alternatives:?$/i.test(cleaned)) return null;
    if (/^Use codegraph_node with a returned nodeId/i.test(cleaned)) return null;
    if (/^nodeId=/.test(cleaned)) return null;
    if (/^Inspect the entry: nodeId=/.test(cleaned)) return null;
    return cleaned;
  }

  private addUniqueRecommendation(recs: string[], rec: string): void {
    if (!recs.includes(rec)) recs.push(rec);
  }

  private formatEdgeEvidence(edge: Edge | TraceEdge, sourceNode?: Node | NodeHandle | null): string {
    const confidence = this.edgeConfidence(edge);
    const resolvedBy = this.edgeResolvedBy(edge);
    const evidence = this.edgeEvidenceDisplay(edge, resolvedBy);
    const reference = this.edgeTextField(edge, 'referenceName');
    const receiver = this.edgeTextField(edge, 'receiverText');
    const property = this.edgeTextField(edge, 'propertyText');
    const callee = this.edgeTextField(edge, 'calleeText');

    const parts = [
      `edgeKind=${edge.kind}`,
      `evidence=${evidence}`,
    ];
    if (reference) parts.push(`reference=${reference}`);
    if (receiver) parts.push(`receiver=${receiver}`);
    if (property) parts.push(`property=${property}`);
    if (callee && callee !== reference) parts.push(`callee=${callee}`);
    parts.push(
      `callsite=${this.formatCallsite(edge.line, edge.column, sourceNode)}`,
      `provenance=${edge.provenance ?? 'unknown'}`,
      `confidence=${confidence === undefined ? 'not-recorded' : confidence.toFixed(2)}`,
      `resolvedBy=${resolvedBy ?? 'not-recorded'}`
    );
    return parts.join(' ');
  }

  private edgeConfidence(edge: Edge | TraceEdge): number | undefined {
    if ('confidence' in edge && typeof edge.confidence === 'number' && Number.isFinite(edge.confidence)) {
      return edge.confidence;
    }
    if ('metadata' in edge && edge.metadata && typeof edge.metadata.confidence === 'number' && Number.isFinite(edge.metadata.confidence)) {
      return edge.metadata.confidence;
    }
    return undefined;
  }

  private edgeResolvedBy(edge: Edge | TraceEdge): string | undefined {
    if ('resolvedBy' in edge && typeof edge.resolvedBy === 'string' && edge.resolvedBy.length > 0) {
      return edge.resolvedBy;
    }
    if ('metadata' in edge && edge.metadata && typeof edge.metadata.resolvedBy === 'string' && edge.metadata.resolvedBy.length > 0) {
      return edge.metadata.resolvedBy;
    }
    return undefined;
  }

  private edgeEvidenceDisplay(edge: Edge | TraceEdge, resolvedBy: string | undefined): string {
    const sourceEvidence = this.edgeSourceEvidence(edge);
    if (sourceEvidence && sourceEvidence !== 'not-recorded') return sourceEvidence;
    if (resolvedBy === 'fuzzy') return 'fuzzy';
    if (resolvedBy === 'framework') return 'framework';
    if (resolvedBy && NAME_MATCH_RESOLVERS.has(resolvedBy)) return 'name-match';
    return 'not-recorded';
  }

  private edgeSourceEvidence(edge: Edge | TraceEdge): ReferenceSourceEvidence | undefined {
    const direct = (edge as { sourceEvidence?: unknown }).sourceEvidence;
    if (typeof direct === 'string' && REFERENCE_SOURCE_EVIDENCE_SET.has(direct)) {
      return direct as ReferenceSourceEvidence;
    }
    if ('metadata' in edge && edge.metadata) {
      const value = edge.metadata.sourceEvidence;
      if (typeof value === 'string' && REFERENCE_SOURCE_EVIDENCE_SET.has(value)) {
        return value as ReferenceSourceEvidence;
      }
    }
    return undefined;
  }

  private edgeTextField(edge: Edge | TraceEdge, field: 'referenceName' | 'calleeText' | 'receiverText' | 'propertyText'): string | undefined {
    const direct = (edge as unknown as Record<string, unknown>)[field];
    if (typeof direct === 'string' && direct.length > 0) return this.formatEdgeText(direct);
    if ('metadata' in edge && edge.metadata) {
      const value = edge.metadata[field];
      if (typeof value === 'string' && value.length > 0) return this.formatEdgeText(value);
    }
    return undefined;
  }

  private formatEdgeText(value: string): string {
    const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length > EDGE_TEXT_FIELD_CAP ? cleaned.slice(0, EDGE_TEXT_FIELD_CAP) : cleaned;
  }

  private formatCallsite(line?: number, column?: number, sourceNode?: Node | NodeHandle | null): string {
    const sourcePath = sourceNode
      ? ('filePath' in sourceNode ? sourceNode.filePath : sourceNode.path)
      : undefined;
    if (!sourcePath || line === undefined) return 'unknown';
    return `${sourcePath}:${line}${column !== undefined ? `:${column}` : ''}`;
  }

  private edgeListDedupKey(node: Node, edge: Edge, root: Node): string {
    return [node.id, root.id, edge.source, edge.target, edge.kind, edge.line ?? '', edge.column ?? ''].join('|');
  }

  /**
   * Truncate output if it exceeds the maximum length
   */
  private truncateOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    const truncated = text.slice(0, MAX_OUTPUT_LENGTH);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH;
    return truncated.slice(0, cutPoint) + '\n\n... (output truncated)';
  }

  // =========================================================================
  // Formatting helpers (compact by default to reduce context usage)
  // =========================================================================

  private formatSearchResults(results: SearchResult[]): string {
    const lines: string[] = [`## Search Results (${results.length} found)`, ''];

    for (const result of results) {
      const { node } = result;
      lines.push(`### ${node.name} (${node.kind})`);
      lines.push(formatNodeHandle(node));
      if (node.signature) lines.push(`\`${node.signature}\``);
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatNodeEdgeList(items: NodeEdgeListItem[], title: string): string {
    const lines: string[] = [`## ${title} (${items.length} found)`, ''];

    for (const item of items) {
      lines.push(`- ${item.node.name} (${item.node.kind}) - ${formatNodeHandle(item.node)}`);
      lines.push(`  └─ ${this.formatEdgeEvidence(item.edge, item.sourceNode)} sourceNodeId=${item.edge.source} targetNodeId=${item.edge.target}`);
      if (item.root.id !== item.edge.source && item.root.id !== item.edge.target) {
        lines.push(`     root=${item.root.name} (${item.root.kind}) nodeId=${item.root.id}`);
      }
    }

    return lines.join('\n');
  }

  private formatImpact(symbol: string, impact: Subgraph): string {
    const nodeCount = impact.nodes.size;

    // Compact format: just list affected symbols grouped by file
    const lines: string[] = [
      `## Impact: "${symbol}" affects ${nodeCount} symbols`,
      '',
    ];

    // Group by file
    const byFile = new Map<string, Node[]>();
    for (const node of impact.nodes.values()) {
      const existing = byFile.get(node.filePath) || [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    for (const [file, nodes] of byFile) {
      lines.push(`**${file}:**`);
      for (const node of nodes) {
        lines.push(`- ${node.name} (${node.kind}) ${formatNodeHandle(node)}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatNodeStructure(
    result: NodeStructureResult,
    options: NodeStructureFormatOptions & { includeCodeIgnored?: boolean } = {}
  ): string {
    const lines: string[] = [];
    const node = result.node;
    if (node) {
      lines.push(`## ${node.name} (${node.kind}) — structure`, '');
      lines.push(`Location: ${node.path}:${node.startLine}`);
      lines.push(`Range: ${node.path}:${node.startLine}-${node.endLine}`);
      lines.push(`Handle: nodeId=${node.nodeId} qualifiedName=${node.qualifiedName} range=${node.path}:${node.startLine}-${node.endLine}`);
    } else {
      lines.push('## Node structure', '');
    }

    if (options.includeCodeIgnored) {
      lines.push('', '> Note: includeCode ignored because detail=structure.');
    }

    lines.push('', '> Static AST structure only. This is reading-navigation guidance, not runtime proof or an LLM summary.');

    for (const caveat of result.caveats) {
      if (!/Static AST structure only/.test(caveat)) lines.push(`> ${caveat}`);
    }

    if (result.status !== 'available') {
      lines.push('', `Status: ${result.status}`);
      if (result.recommendations.length > 0) {
        lines.push('', '### Recommended next');
        for (const rec of result.recommendations) lines.push(`- ${rec}`);
      }
      return lines.join('\n');
    }

    const cap = options.maxItemsPerSection ?? 40;
    const controlKinds = new Set(['guard', 'branch', 'switch', 'loop', 'try', 'catch', 'finally']);
    const callKinds = new Set(['callsite', 'callback-invocation']);
    const constructionKinds = new Set(['early-return', 'object-literal', 'return-value']);

    this.formatStructureSection(lines, 'Control flow', result.items.filter((item) => controlKinds.has(item.kind)), cap);
    this.formatStructureSection(lines, 'Key callsites', result.items.filter((item) => callKinds.has(item.kind)), cap);
    this.formatStructureSection(lines, 'Construction / returns', result.items.filter((item) => constructionKinds.has(item.kind)), cap);

    if (result.recommendations.length > 0) {
      lines.push('', '### Recommended next');
      for (const rec of result.recommendations) lines.push(`- ${rec}`);
    }

    return lines.join('\n');
  }

  private formatStructureSection(lines: string[], title: string, items: NodeStructureItem[], cap: number): void {
    lines.push('', `### ${title}`);
    if (items.length === 0) {
      lines.push('- (none found)');
      return;
    }

    const shown = items.slice(0, cap);
    for (const item of shown) {
      lines.push(...this.formatStructureItem(item));
    }
    if (items.length > shown.length) {
      lines.push(`- ... ${items.length - shown.length} more items omitted; use includeCode/read for full source`);
    }
  }

  private formatStructureItem(item: NodeStructureItem): string[] {
    const indent = '  '.repeat(Math.min(item.depth, 4));
    const keys = item.objectKeys && item.objectKeys.length > 0 ? ` keys: ${item.objectKeys.join(', ')}` : '';
    const lines = [`${indent}- ${item.kind} ${this.formatSourceRange(item.range)} — ${item.label}${keys}`];
    if (item.enclosing && item.enclosing.length > 0) {
      lines.push(`${indent}  within: ${item.enclosing.map((ctx) => `${ctx.kind} ${this.formatSourceRange(ctx.range)}`).join(' > ')}`);
    }
    if (item.note) lines.push(`${indent}  note: ${item.note}`);
    return lines;
  }

  private formatSourceRange(range: SourceRange): string {
    if (range.startLine === range.endLine) return `${range.path}:${range.startLine}`;
    return `${range.path}:${range.startLine}-${range.endLine}`;
  }

  /**
   * Build a compact structural outline of a container symbol from its
   * indexed children (methods, fields, properties, …) — name, kind,
   * line number, and signature — so the agent gets the shape of a class
   * without the full source of every method. Returns '' when the container
   * has no indexed children, so the caller can fall back to full source.
   */
  private buildContainerOutline(cg: CodeGraph, node: Node): string {
    const children = cg.getChildren(node.id)
      .filter(c => c.kind !== 'import' && c.kind !== 'export')
      .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
    if (children.length === 0) return '';

    const lines = [`**Members (${children.length}):**`, ''];
    for (const c of children) {
      const sig = c.signature ? ` — \`${c.signature}\`` : '';
      lines.push(`- ${c.name} (${c.kind}) ${formatNodeHandle(c)}${sig}`);
    }
    return lines.join('\n');
  }

  private formatNodeDetails(node: Node, code: string | null, outline?: string | null): string {
    const location = node.startLine ? `:${node.startLine}` : '';
    const lines: string[] = [
      `## ${node.name} (${node.kind})`,
      '',
      `**Location:** ${node.filePath}${location}`,
      `Range: ${node.filePath}:${node.startLine}-${node.endLine}`,
      `Handle: ${formatNodeHandle(node)}`,
    ];

    if (node.signature) {
      lines.push(`**Signature:** \`${node.signature}\``);
    }

    // Only include docstring if it's short and useful
    if (node.docstring && node.docstring.length < 200) {
      lines.push('', node.docstring);
    }

    if (outline) {
      lines.push('', outline, '',
        `> Structural outline only. Read \`${node.filePath}\` or call codegraph_node on a specific member for its body.`);
    } else if (code) {
      lines.push('', '```' + node.language, code, '```');
    }

    return lines.join('\n');
  }

  private formatTaskContext(context: TaskContext): string {
    return context.summary || 'No context found';
  }

  private textResult(text: string): ToolResult {
    return {
      content: [{ type: 'text', text }],
    };
  }

  private errorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
