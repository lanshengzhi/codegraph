/**
 * Context Builder
 *
 * Builds rich context for tasks by combining FTS search with graph traversal.
 * Outputs structured context ready to inject into Claude.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Node,
  Edge,
  NodeKind,
  EdgeKind,
  Subgraph,
  CodeBlock,
  TaskContext,
  TaskInput,
  BuildContextOptions,
  FindRelevantContextOptions,
  SearchResult,
  RelevanceReason,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from '../graph';
import { formatContextAsMarkdown, formatContextAsJson } from './formatter';
import { logDebug } from '../errors';
import { validatePathWithinRoot } from '../utils';
import { isTestFile, isGeneratedFile, extractSearchTerms, scorePathRelevance, getStemVariants } from '../search/query-utils';

/**
 * Extract likely symbol names from a natural language query
 *
 * Identifies potential code symbols using patterns:
 * - CamelCase: UserService, signInWithGoogle
 * - snake_case: user_service, sign_in
 * - SCREAMING_SNAKE: MAX_RETRIES
 * - dot.notation: app.isPackaged (extracts both sides)
 * - Single words that look like identifiers (no spaces, not common English words)
 *
 * @param query - Natural language query
 * @returns Array of potential symbol names
 */
function extractSymbolsFromQuery(query: string): string[] {
  const symbols = new Set<string>();

  // Extract CamelCase identifiers (2+ chars, starts with letter)
  const camelCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)*|[a-z]+(?:[A-Z][a-z]*)+)\b/g;
  let match;
  while ((match = camelCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 2) {
      symbols.add(match[1]);
    }
  }

  // Extract snake_case identifiers
  const snakeCasePattern = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi;
  while ((match = snakeCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      symbols.add(match[1]);
    }
  }

  // Extract SCREAMING_SNAKE_CASE
  const screamingPattern = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
  while ((match = screamingPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Extract ALL_CAPS acronyms (2+ chars, e.g., REST, HTTP, LRU, API)
  const acronymPattern = /\b([A-Z]{2,})\b/g;
  while ((match = acronymPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Extract dot.notation and split into parts (e.g., "app.isPackaged" -> ["app", "isPackaged"])
  const dotPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\b/g;
  while ((match = dotPattern.exec(query)) !== null) {
    if (match[1]) {
      // Add both the full path and individual parts
      symbols.add(match[1]);
      const parts = match[1].split('.');
      for (const part of parts) {
        if (part.length >= 2) {
          symbols.add(part);
        }
      }
    }
  }

  // Extract plain lowercase identifiers (3+ chars, not already matched)
  // Catches symbol names like "undo", "redo", "history", "render", "parse"
  const lowercasePattern = /\b([a-z][a-z0-9]{2,})\b/g;
  while ((match = lowercasePattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // Filter out common English words that aren't likely symbol names
  const commonWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'been',
    'will', 'would', 'could', 'should', 'does', 'done', 'make', 'made',
    'use', 'used', 'using', 'work', 'works', 'find', 'found', 'show',
    'call', 'called', 'calling', 'get', 'set', 'add', 'all', 'any',
    'how', 'what', 'when', 'where', 'which', 'who', 'why',
    'not', 'but', 'are', 'was', 'were', 'has', 'had', 'its',
    'can', 'did', 'may', 'also', 'into', 'than', 'then', 'them',
    'each', 'other', 'some', 'such', 'only', 'same', 'about',
    'after', 'before', 'between', 'through', 'during', 'without',
    'again', 'further', 'once', 'here', 'there', 'both', 'just',
    'more', 'most', 'very', 'being', 'having', 'doing',
    'system', 'need', 'needs', 'want', 'wants', 'like', 'look',
    'change', 'changes', 'changed', 'changing',
    // Common English nouns/verbs that match thousands of unrelated code symbols
    'layer', 'handle', 'handles', 'handling', 'incoming', 'outgoing',
    'data', 'flow', 'flows', 'level', 'levels', 'request', 'requests',
    'response', 'responses', 'implement', 'implements', 'implementation',
    'interface', 'interfaces', 'class', 'classes', 'method', 'methods',
    'trigger', 'triggers', 'affected', 'affect', 'affects',
    'else', 'code', 'failing', 'failed', 'silently', 'decide', 'decides',
    'return', 'returns', 'returned', 'take', 'takes', 'taken',
    'check', 'checks', 'checked', 'create', 'creates', 'created',
    'read', 'reads', 'write', 'writes', 'written',
    'start', 'starts', 'stop', 'stops', 'run', 'runs', 'running',
  ]);

  return Array.from(symbols).filter(s => !commonWords.has(s.toLowerCase()));
}

/**
 * Default options for context building
 *
 * Tuned for minimal context usage while still providing useful results:
 * - Fewer nodes and code blocks by default
 * - Smaller code block size limit
 * - Shallower traversal
 */
const DEFAULT_BUILD_OPTIONS: Required<BuildContextOptions> = {
  maxNodes: 20,           // Reduced from 50 - most tasks don't need 50 symbols
  maxCodeBlocks: 5,       // Reduced from 10 - only show most relevant code
  maxCodeBlockSize: 1500, // Reduced from 2000
  includeCode: true,
  format: 'markdown',
  searchLimit: 3,         // Reduced from 5 - fewer entry points
  traversalDepth: 1,      // Reduced from 2 - shallower graph expansion
  minScore: 0.3,
};

/**
 * Node kinds that provide high information value in context results.
 * Imports/exports are excluded because they have near-zero information density -
 * they tell you something exists, not how it works.
 */
const HIGH_VALUE_NODE_KINDS: NodeKind[] = [
  'function', 'method', 'class', 'interface', 'type_alias', 'struct', 'trait',
  'component', 'route', 'variable', 'constant', 'enum', 'module', 'namespace',
];

/**
 * Default options for finding relevant context
 */
const DEFAULT_FIND_OPTIONS: Required<FindRelevantContextOptions> = {
  searchLimit: 3,        // Reduced from 5
  traversalDepth: 1,     // Reduced from 2
  maxNodes: 20,          // Reduced from 50
  minScore: 0.3,
  edgeKinds: [],
  nodeKinds: HIGH_VALUE_NODE_KINDS, // Filter out imports/exports by default
};

const GENERIC_SYMBOL_NAMES = new Set([
  'run', 'main', 'init', 'start', 'stop', 'setup', 'teardown', 'handler', 'handle',
  'helper', 'util', 'utils', 'text', 'data', 'value', 'item', 'node', 'entry',
  'process', 'execute', 'call', 'get', 'set', 'list', 'test', 'spec',
]);

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function relevanceLabel(signals: string[], penalties: string[], score?: number): RelevanceReason['label'] {
  if (signals.length === 0 && penalties.length === 0) return 'not-recorded';

  const strongSignals = new Set([
    'exact name match',
    'exact symbol extracted from query',
    'entry point',
    'directly connected to entry point',
    'compound multi-term match',
    'file contains multiple query symbols',
  ]);
  const hasStrongSignal = signals.some((signal) => strongSignals.has(signal));
  const hasOnlyWeakSignals = signals.length > 0 && !hasStrongSignal;
  const hasWeakPenalty = penalties.includes('lexical-only match') || penalties.includes('low graph proximity');

  if (!hasStrongSignal && (penalties.length > 0 || hasOnlyWeakSignals)) return 'low-signal';
  if (hasStrongSignal && penalties.length === 0 && (score === undefined || score >= 1)) return 'high-signal';
  if (hasStrongSignal && penalties.length <= 1 && !hasWeakPenalty) return 'medium-signal';
  return penalties.length > 0 ? 'medium-signal' : 'medium-signal';
}

function mergeRelevanceReason(
  existing: RelevanceReason | undefined,
  patch: { signals?: string[]; penalties?: string[]; score?: number; scoreMode?: 'max' | 'override' } = {}
): RelevanceReason {
  const signals = uniqueStrings([...(existing?.signals ?? []), ...(patch.signals ?? [])]);
  const penalties = uniqueStrings([...(existing?.penalties ?? []), ...(patch.penalties ?? [])]);
  const score = patch.scoreMode === 'override'
    ? patch.score
    : Math.max(existing?.score ?? Number.NEGATIVE_INFINITY, patch.score ?? Number.NEGATIVE_INFINITY);
  const normalizedScore = typeof score === 'number' && Number.isFinite(score) ? score : undefined;
  return {
    label: relevanceLabel(signals, penalties, normalizedScore),
    ...(normalizedScore !== undefined ? { score: normalizedScore } : {}),
    signals,
    penalties,
  };
}

function withReason(
  result: SearchResult,
  patch: { signals?: string[]; penalties?: string[]; score?: number }
): SearchResult {
  return {
    ...result,
    reason: mergeRelevanceReason(result.reason, { ...patch, score: patch.score ?? result.score }),
  };
}

function addReasonSignal(result: SearchResult, signal: string): void {
  result.reason = mergeRelevanceReason(result.reason, { signals: [signal], score: result.score });
}

function addReasonPenalty(result: SearchResult, penalty: string): void {
  result.reason = mergeRelevanceReason(result.reason, { penalties: [penalty], score: result.score });
}

function setReasonScore(result: SearchResult): void {
  if (!result.reason) return;
  result.reason = mergeRelevanceReason(result.reason, {
    score: result.score,
    scoreMode: 'override',
  });
}

function mergeSearchResultReason(existing: SearchResult, incoming: SearchResult): void {
  existing.score = Math.max(existing.score, incoming.score);
  existing.reason = mergeRelevanceReason(existing.reason, {
    signals: incoming.reason?.signals,
    penalties: incoming.reason?.penalties,
    score: Math.max(existing.reason?.score ?? existing.score, incoming.reason?.score ?? incoming.score),
  });
}

function hasQueryNameOrPathMatch(node: Node, queryTerms: string[]): boolean {
  if (queryTerms.length === 0) return false;
  const nameLower = node.name.toLowerCase();
  const pathLower = node.filePath.toLowerCase();
  return queryTerms.some((term) => nameLower.includes(term) || pathLower.includes(term));
}

function annotateCommonRelevance(
  result: SearchResult,
  queryTerms: string[],
  symbolsFromQuery: string[],
  isTestQuery: boolean
): void {
  const node = result.node;
  const symbolSet = new Set(symbolsFromQuery.map((symbol) => symbol.toLowerCase()));
  const nodeNameLower = node.name.toLowerCase();
  const signals: string[] = [];
  const penalties: string[] = [];

  if (symbolSet.has(nodeNameLower)) {
    signals.push('exact name match');
  }
  if (hasQueryNameOrPathMatch(node, queryTerms)) {
    signals.push('path/name text match');
  }
  if (GENERIC_SYMBOL_NAMES.has(nodeNameLower)) {
    penalties.push('generic symbol name');
  }
  if (!isTestQuery && isTestFile(node.filePath)) {
    penalties.push('test/fixture/example path');
  }
  if (isGeneratedFile(node.filePath)) {
    penalties.push('generated path');
  }

  const existingSignals = result.reason?.signals ?? [];
  const hasStructuredSignal = existingSignals.some((signal) => signal !== 'path/name text match');
  if (!hasStructuredSignal && !hasQueryNameOrPathMatch(node, queryTerms)) {
    penalties.push('lexical-only match');
  }

  result.reason = mergeRelevanceReason(result.reason, { signals, penalties, score: result.score });
}

function isDirectlyConnectedToAnyRoot(nodeId: string, rootIds: Set<string>, edges: Edge[]): boolean {
  return edges.some((edge) =>
    (edge.source === nodeId && rootIds.has(edge.target)) ||
    (edge.target === nodeId && rootIds.has(edge.source))
  );
}

function buildFileRelevanceReasons(
  nodes: Map<string, Node>,
  roots: string[],
  nodeReasons: Record<string, RelevanceReason>,
  query: string,
  isTestQuery: boolean
): Record<string, RelevanceReason> {
  const byFile = new Map<string, Node[]>();
  const rootSet = new Set(roots);
  const queryTerms = extractSearchTerms(query, { stems: false });

  for (const node of nodes.values()) {
    const list = byFile.get(node.filePath) ?? [];
    list.push(node);
    byFile.set(node.filePath, list);
  }

  const fileReasons: Record<string, RelevanceReason> = {};
  for (const [filePath, fileNodes] of byFile) {
    let reason: RelevanceReason | undefined;
    const signals: string[] = [];
    const penalties: string[] = [];
    const scores: number[] = [];

    if (fileNodes.some((node) => rootSet.has(node.id))) signals.push('entry point');
    if (fileNodes.some((node) => nodeReasons[node.id]?.signals.includes('directly connected to entry point'))) {
      signals.push('directly connected to entry point');
    }
    if (fileNodes.some((node) => nodeReasons[node.id]?.signals.includes('graph proximity to entry point'))) {
      signals.push('graph proximity to entry point');
    }
    if (fileNodes.some((node) => nodeReasons[node.id]?.signals.includes('exact name match'))) {
      signals.push('exact name match');
    }
    if (fileNodes.some((node) => nodeReasons[node.id]?.signals.includes('exact symbol extracted from query'))) {
      signals.push('exact symbol extracted from query');
    }
    if (fileNodes.some((node) => nodeReasons[node.id]?.signals.includes('prefix/camel-case match'))) {
      signals.push('prefix/camel-case match');
    }
    if (fileNodes.some((node) => nodeReasons[node.id]?.signals.includes('compound multi-term match'))) {
      signals.push('compound multi-term match');
    }

    const matchedTerms = new Set<string>();
    const fileLower = filePath.toLowerCase();
    for (const term of queryTerms) {
      if (fileLower.includes(term) || fileNodes.some((node) => node.name.toLowerCase().includes(term))) {
        matchedTerms.add(term);
      }
    }
    if (matchedTerms.size > 0) signals.push('path/name text match');
    if (matchedTerms.size >= 2 || fileNodes.filter((node) => rootSet.has(node.id)).length >= 2) {
      signals.push('file contains multiple query symbols');
    }

    for (const node of fileNodes) {
      const nodeReason = nodeReasons[node.id];
      if (nodeReason?.score !== undefined) scores.push(nodeReason.score);
      for (const penalty of nodeReason?.penalties ?? []) penalties.push(penalty);
    }
    if (!isTestQuery && isTestFile(filePath)) penalties.push('test/fixture/example path');
    if (isGeneratedFile(filePath)) penalties.push('generated path');
    if (signals.length === 0) penalties.push('low graph proximity');

    reason = mergeRelevanceReason(reason, {
      signals,
      penalties,
      score: scores.length > 0 ? Math.max(...scores) : undefined,
    });
    fileReasons[filePath] = reason;
  }

  return fileReasons;
}

/**
 * Context Builder
 *
 * Coordinates semantic search and graph traversal to build
 * comprehensive context for tasks.
 */
export class ContextBuilder {
  private projectRoot: string;
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  constructor(
    projectRoot: string,
    queries: QueryBuilder,
    traverser: GraphTraverser
  ) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.traverser = traverser;
  }

  /**
   * Build context for a task
   *
   * Pipeline:
   * 1. Parse task input (string or {title, description})
   * 2. Run semantic search to find entry points
   * 3. Expand graph around entry points
   * 4. Extract code blocks for key nodes
   * 5. Format output for Claude
   *
   * @param input - Task description or object with title/description
   * @param options - Build options
   * @returns TaskContext (structured) or formatted string
   */
  async buildContext(
    input: TaskInput,
    options: BuildContextOptions = {}
  ): Promise<TaskContext | string> {
    const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };

    // Parse input
    const query = typeof input === 'string' ? input : `${input.title}${input.description ? `: ${input.description}` : ''}`;

    // Find relevant context (semantic search + graph expansion)
    const subgraph = await this.findRelevantContext(query, {
      searchLimit: opts.searchLimit,
      traversalDepth: opts.traversalDepth,
      maxNodes: opts.maxNodes,
      minScore: opts.minScore,
    });

    // Get entry points (nodes from semantic search)
    const entryPoints = this.getEntryPoints(subgraph);

    // Extract code blocks for key nodes
    const codeBlocks = opts.includeCode
      ? await this.extractCodeBlocks(subgraph, opts.maxCodeBlocks, opts.maxCodeBlockSize)
      : [];

    // Get related files
    const relatedFiles = this.getRelatedFiles(subgraph);

    // Generate summary
    const summary = this.generateSummary(query, subgraph, entryPoints);

    // Calculate stats
    const stats = {
      nodeCount: subgraph.nodes.size,
      edgeCount: subgraph.edges.length,
      fileCount: relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
    };

    const context: TaskContext = {
      query,
      subgraph,
      entryPoints,
      codeBlocks,
      relatedFiles,
      summary,
      stats,
    };

    // Return formatted output or raw context
    if (opts.format === 'markdown') {
      return formatContextAsMarkdown(context);
    } else if (opts.format === 'json') {
      return formatContextAsJson(context);
    }

    return context;
  }

  /**
   * Find relevant subgraph for a query
   *
   * Uses hybrid search combining exact symbol lookup with semantic search:
   * 1. Extract potential symbol names from query
   * 2. Look up exact matches for those symbols (high confidence)
   * 3. Use semantic search for concept matching
   * 4. Merge results, prioritizing exact matches
   * 5. Traverse graph from entry points
   *
   * @param query - Natural language query
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options: FindRelevantContextOptions = {}
  ): Promise<Subgraph> {
    const opts = { ...DEFAULT_FIND_OPTIONS, ...options };

    // Start with empty subgraph
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const roots: string[] = [];
    const nodeReasons: Record<string, RelevanceReason> = {};
    const mergeNodeReason = (nodeId: string, patch: { signals?: string[]; penalties?: string[]; score?: number }) => {
      nodeReasons[nodeId] = mergeRelevanceReason(nodeReasons[nodeId], patch);
    };

    // Handle empty query - return empty subgraph
    if (!query || query.trim().length === 0) {
      return { nodes, edges, roots, reasons: { nodes: {}, files: {} } };
    }

    // === HYBRID SEARCH ===

    // Step 1: Extract potential symbol names from query
    const symbolsFromQuery = extractSymbolsFromQuery(query);
    logDebug('Extracted symbols from query', { query, symbols: symbolsFromQuery });

    // Step 2: Look up exact matches for extracted symbols
    let exactMatches: SearchResult[] = [];
    if (symbolsFromQuery.length > 0) {
      try {
        // Get more results so we can apply co-location boosting before trimming
        exactMatches = this.queries.findNodesByExactName(symbolsFromQuery, {
          limit: Math.ceil(opts.searchLimit * 5),
          kinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        }).map((result) => withReason(result, {
          signals: ['exact symbol extracted from query', 'exact name match'],
        }));

        // Co-location boost: when multiple extracted symbols appear in the same file,
        // those results are much more likely to be what the user is looking for.
        // E.g., "scrapeLoop" + "run" both in scrape/scrape.go → boost both.
        if (exactMatches.length > 1) {
          // Build a map of files → how many distinct symbol names matched in that file
          const fileSymbolCounts = new Map<string, Set<string>>();
          for (const r of exactMatches) {
            const names = fileSymbolCounts.get(r.node.filePath) || new Set();
            names.add(r.node.name.toLowerCase());
            fileSymbolCounts.set(r.node.filePath, names);
          }
          // Boost results in files where multiple query symbols co-occur
          exactMatches = exactMatches.map(r => {
            const symbolCount = fileSymbolCounts.get(r.node.filePath)?.size || 1;
            const scored = {
              ...r,
              score: symbolCount > 1 ? r.score + (symbolCount - 1) * 20 : r.score,
            };
            return symbolCount > 1
              ? withReason(scored, { signals: ['file contains multiple query symbols'], score: scored.score })
              : withReason(scored, { score: scored.score });
          });
          exactMatches.sort((a, b) => b.score - a.score);
        }

        // Trim back to reasonable size
        exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 2));
        logDebug('Exact symbol matches', { count: exactMatches.length });
      } catch (error) {
        logDebug('Exact symbol lookup failed', { error: String(error) });
      }
    }

    // Step 2b: Search for extracted symbols as definition (class/interface) prefixes.
    // When the user writes "REST", "bulk", or "allocation", they usually mean classes
    // like RestController, BulkRequest, AllocationService — not nodes named exactly that.
    // Also tries stem variants: "caching" → "cache" finds Cache, CacheBuilder.
    if (symbolsFromQuery.length > 0) {
      const definitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait',
        'protocol', 'enum', 'type_alias'];
      // Expand symbols with stem variants for broader definition matching
      const expandedSymbols = new Set(symbolsFromQuery);
      for (const sym of symbolsFromQuery) {
        for (const variant of getStemVariants(sym)) {
          expandedSymbols.add(variant);
        }
      }
      for (const sym of expandedSymbols) {
        // Title-case the symbol: "REST" → "Rest", "bulk" → "Bulk", "allocation" → "Allocation"
        const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
        if (titleCased === sym) continue; // already title-case (e.g., "Engine") — handled by exact match
        // Fetch more results since popular prefixes have many matches
        const prefixResults = this.queries.searchNodes(titleCased, {
          limit: 30,
          kinds: definitionKinds,
        });
        const matched: SearchResult[] = [];
        for (const r of prefixResults) {
          if (r.node.name.toLowerCase().startsWith(titleCased.toLowerCase())) {
            // Favor shorter names: "AllocationService" (18 chars) over
            // "AllocationBalancingRoundMetrics" (31 chars). Core classes tend
            // to have concise names; test/helper classes are verbose.
            const brevityBonus = Math.max(0, 10 - (r.node.name.length - titleCased.length) / 3);
            const scored = { ...r, score: r.score + 15 + brevityBonus };
            matched.push(withReason(scored, { signals: ['prefix/camel-case match'], score: scored.score }));
          }
        }
        matched.sort((a, b) => b.score - a.score);
        for (const r of matched.slice(0, Math.ceil(opts.searchLimit))) {
          const existing = exactMatches.find(e => e.node.id === r.node.id);
          if (existing) {
            mergeSearchResultReason(existing, r);
          } else {
            exactMatches.push(r);
          }
        }
      }
      exactMatches.sort((a, b) => b.score - a.score);
      exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 3));
    }

    // Step 3: Run text search for natural language term matching
    // This catches file-name and node-name matches that semantic search may miss,
    // which is critical for template-heavy codebases (e.g., Liquid/Shopify themes)
    // where file names are the primary identifiers.
    let textResults: SearchResult[] = [];
    try {
      const searchTerms = extractSearchTerms(query);
      if (searchTerms.length > 0) {
        // Search each term individually to get broader coverage,
        // then boost results that match multiple terms
        const termResultsMap = new Map<string, { result: SearchResult; termHits: number }>();
        // When no explicit kind filter is set, exclude imports — they flood FTS
        // results with qualified name matches (e.g., "REST" matches 445K import paths)
        // but are almost never what exploration queries want.
        const searchKinds = opts.nodeKinds && opts.nodeKinds.length > 0
          ? opts.nodeKinds
          : ['file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
             'function', 'method', 'property', 'field', 'variable', 'constant',
             'enum', 'enum_member', 'type_alias', 'namespace', 'export',
             'route', 'component'] as NodeKind[];
        for (const term of searchTerms) {
          const termResults = this.queries.searchNodes(term, {
            limit: opts.searchLimit * 2,
            kinds: searchKinds,
          });
          for (const r of termResults) {
            const existing = termResultsMap.get(r.node.id);
            if (existing) {
              existing.termHits++;
              existing.result.score = Math.max(existing.result.score, r.score);
            } else {
              termResultsMap.set(r.node.id, { result: withReason(r, { score: r.score }), termHits: 1 });
            }
          }
        }
        // Boost results matching multiple terms and sort
        textResults = Array.from(termResultsMap.values())
          .map(({ result, termHits }) => {
            const scored = {
              ...result,
              score: result.score + (termHits - 1) * 5,
            };
            return withReason(scored, {
              signals: termHits > 1 ? ['compound multi-term match'] : undefined,
              score: scored.score,
            });
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, opts.searchLimit * 2);
      }
      logDebug('Text search results', { count: textResults.length });
    } catch (error) {
      logDebug('Text search failed', { query, error: String(error) });
    }

    // Step 4: Merge results, taking the max score when duplicates appear
    // across search channels. Exact matches may have lower scores than FTS
    // results for the same node — use the best score from any channel.
    const resultById = new Map<string, SearchResult>();
    let searchResults: SearchResult[] = [];

    // Add exact matches first
    for (const result of exactMatches) {
      const existing = resultById.get(result.node.id);
      if (existing) {
        mergeSearchResultReason(existing, result);
      } else {
        resultById.set(result.node.id, result);
        searchResults.push(result);
      }
    }

    // Add text search results, upgrading scores for duplicates
    for (const result of textResults) {
      const existing = resultById.get(result.node.id);
      if (existing) {
        mergeSearchResultReason(existing, result);
      } else {
        resultById.set(result.node.id, result);
        searchResults.push(result);
      }
    }

    const queryLower = query.toLowerCase();
    const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');

    // Deprioritize test files early so they don't take multi-term boost slots
    if (!isTestQuery) {
      for (const result of searchResults) {
        if (isTestFile(result.node.filePath)) {
          result.score *= 0.3;
        }
      }
    }

    // Step 5a: Multi-term co-occurrence re-ranking (applied BEFORE truncation).
    // For multi-word queries like "search execution from request to shard",
    // nodes matching 2+ query terms in their name or path are far more relevant
    // than nodes matching just one generic term. Without this, "ExecutionUtils"
    // (matches only "execution") fills budget slots meant for "ShardSearchRequest"
    // (matches "shard" + "search" + "request").
    const queryTermsForBoost = extractSearchTerms(query);
    if (queryTermsForBoost.length >= 2) {
      // Group terms that are substrings of each other (stem variants of the same
      // root word). "indexed", "indexe", "index" should count as ONE concept match,
      // not three. Without this, stem variants inflate matchCount and give false
      // multi-term boosts to symbols matching one root word multiple times.
      const termGroups: string[][] = [];
      const sorted = [...queryTermsForBoost].sort((a, b) => b.length - a.length);
      const assigned = new Set<string>();
      for (const term of sorted) {
        if (assigned.has(term)) continue;
        const group = [term];
        assigned.add(term);
        for (const other of sorted) {
          if (assigned.has(other)) continue;
          if (term.includes(other) || other.includes(term)) {
            group.push(other);
            assigned.add(other);
          }
        }
        termGroups.push(group);
      }

      // Build a set of exact-match node IDs so we can exempt them from dampening.
      // When the query is "LiveEditMode DevServerPreview", these are specific
      // symbols the user asked for — dampening them because they only match 1
      // term group is counter-productive.
      const exactMatchIds = new Set(exactMatches.map(r => r.node.id));

      for (const result of searchResults) {
        // Check term matches in name (substring) and path DIRECTORIES (exact).
        // Directory segments must match exactly — "search" matches directory
        // "search/" but NOT "elasticsearch/". The class name is checked
        // separately via substring match on the node name.
        const nameLower = result.node.name.toLowerCase();
        const dirSegments = path.dirname(result.node.filePath).toLowerCase().split('/');
        let matchCount = 0;
        for (const group of termGroups) {
          const groupMatches = group.some(term => {
            const inName = nameLower.includes(term);
            const inDir = dirSegments.some(seg => seg === term);
            return inName || inDir;
          });
          if (groupMatches) matchCount++;
        }
        if (matchCount >= 2) {
          // Multiplicative boost — 2 terms → 2x, 3 terms → 2.5x
          result.score *= 1 + matchCount * 0.5;
          addReasonSignal(result, 'compound multi-term match');
        } else if (!exactMatchIds.has(result.node.id)) {
          // Mild dampen for single-term matches — they might be generic
          // but could also be the right result (e.g., "Protocol" class for an IPC query).
          // Exempt exact name matches: they are specific symbols the user queried for.
          result.score *= 0.6;
          addReasonPenalty(result, 'lexical-only match');
        }
        result.reason = mergeRelevanceReason(result.reason, { score: result.score });
      }
      searchResults.sort((a, b) => b.score - a.score);
    }

    // Step 5b: CamelCase-boundary matching via LIKE query.
    // FTS can't find "Search" inside "TransportSearchAction" (one FTS token).
    // LIKE reliably finds these substring matches. Results are appended with
    // guaranteed slots so they don't compete with higher-scoring prefix matches.
    if (symbolsFromQuery.length > 0) {
      const camelDefinitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait',
        'protocol', 'enum', 'type_alias'];
      const camelSearchedTerms = new Set<string>();
      const searchIdSet = new Set(searchResults.map(r => r.node.id));
      // Track per-node term hits for multi-term boosting
      const camelNodeTerms = new Map<string, { result: SearchResult; termCount: number }>();
      const maxCamelPerTerm = Math.ceil(opts.searchLimit / 2);

      for (const sym of symbolsFromQuery) {
        const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
        if (titleCased.length < 3) continue;
        const termKey = titleCased.toLowerCase();
        if (camelSearchedTerms.has(termKey)) continue;
        camelSearchedTerms.add(termKey);

        // Fetch a large batch — popular terms like "Search" in Elasticsearch
        // have hundreds of substring matches. The LIKE scan cost is the same
        // regardless of LIMIT (SQLite scans all matches to sort), so we fetch
        // generously and let path-relevance scoring pick the best ones.
        const likeResults = this.queries.findNodesByNameSubstring(titleCased, {
          limit: 200,
          kinds: camelDefinitionKinds,
          excludePrefix: true,
        });

        // Filter to CamelCase boundaries, score by path relevance, and take top N
        const termCandidates: SearchResult[] = [];
        for (const r of likeResults) {
          const name = r.node.name;
          const idx = name.indexOf(titleCased);
          if (idx <= 0) continue;
          // Accept CamelCase boundary (lowercase before match) OR
          // acronym boundary (uppercase before match, e.g., RPCProtocol)
          if (!/[a-zA-Z]/.test(name.charAt(idx - 1))) continue;
          if (searchIdSet.has(r.node.id)) continue;
          if (isTestFile(r.node.filePath) && !isTestQuery) continue;

          const pathScore = scorePathRelevance(r.node.filePath, query);
          const brevityBonus = Math.max(0, 6 - (name.length - titleCased.length) / 4);
          const scored = { node: r.node, score: 8 + brevityBonus + pathScore };
          termCandidates.push(withReason(scored, { signals: ['prefix/camel-case match'], score: scored.score }));
        }
        termCandidates.sort((a, b) => b.score - a.score);

        // Widen the per-term pool for accumulation so multi-term co-occurrences
        // can be discovered. A class matching 3 query terms at CamelCase boundaries
        // is far more relevant than one matching just 1, but it needs to survive
        // the per-term cut for EACH term to accumulate its count.
        const accumPerTerm = maxCamelPerTerm * 4;
        for (const r of termCandidates.slice(0, accumPerTerm)) {
          const existing = camelNodeTerms.get(r.node.id);
          if (existing) {
            existing.termCount++;
          } else {
            camelNodeTerms.set(r.node.id, {
              result: r,
              termCount: 1,
            });
          }
        }
      }

      // Append CamelCase matches with multi-term boost.
      // These are structurally important (class names containing query terms at
      // CamelCase boundaries) but score much lower than FTS results. Scale their
      // scores up so multi-term CamelCase matches can compete with FTS results.
      const camelResults: SearchResult[] = [];
      for (const [, info] of camelNodeTerms) {
        // Multi-term CamelCase matches are extremely relevant — a class matching
        // 3+ query terms in its name (e.g., ExtensionHostProcess) is almost
        // certainly what the user wants. Scale aggressively.
        info.result.score = info.result.score * (1 + info.termCount) + (info.termCount - 1) * 30;
        const signals = ['prefix/camel-case match'];
        if (info.termCount > 1) signals.push('compound multi-term match');
        camelResults.push(withReason(info.result, { signals, score: info.result.score }));
      }
      camelResults.sort((a, b) => b.score - a.score);
      const maxCamelTotal = opts.searchLimit;
      for (const r of camelResults.slice(0, maxCamelTotal)) {
        searchResults.push(r);
        searchIdSet.add(r.node.id);
      }

      // Step 5c: Compound term matching — find classes whose name contains 2+
      // query terms at ANY position (not just CamelCase boundaries).
      // The CamelCase step above requires idx > 0, which misses classes that
      // START with a query term (e.g., "SearchShardsRequest" starts with "Search").
      // For multi-word queries, a class matching multiple query terms in its name
      // is almost certainly relevant regardless of position.
      if (symbolsFromQuery.length >= 2) {
        // Collect ALL LIKE results per term (reusing findNodesByNameSubstring)
        // but without the CamelCase boundary or prefix exclusion filters.
        const compoundTermMap = new Map<string, { node: Node; terms: Set<string> }>();
        for (const sym of symbolsFromQuery) {
          const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
          if (titleCased.length < 3) continue;

          const likeResults = this.queries.findNodesByNameSubstring(titleCased, {
            limit: 200,
            kinds: camelDefinitionKinds,
            excludePrefix: false,
          });

          for (const r of likeResults) {
            if (searchIdSet.has(r.node.id)) continue;
            if (isTestFile(r.node.filePath) && !isTestQuery) continue;
            const entry = compoundTermMap.get(r.node.id);
            if (entry) {
              entry.terms.add(titleCased);
            } else {
              compoundTermMap.set(r.node.id, { node: r.node, terms: new Set([titleCased]) });
            }
          }
        }

        // Keep only nodes matching 2+ distinct terms
        const compoundResults: SearchResult[] = [];
        for (const [, entry] of compoundTermMap) {
          if (entry.terms.size >= 2) {
            const pathScore = scorePathRelevance(entry.node.filePath, query);
            const brevityBonus = Math.max(0, 6 - entry.node.name.length / 8);
            const scored = {
              node: entry.node,
              score: 10 + (entry.terms.size - 1) * 20 + pathScore + brevityBonus,
            };
            compoundResults.push(withReason(scored, {
              signals: ['compound multi-term match'],
              score: scored.score,
            }));
          }
        }
        compoundResults.sort((a, b) => b.score - a.score);
        const maxCompound = Math.ceil(opts.searchLimit / 2);
        for (const r of compoundResults.slice(0, maxCompound)) {
          searchResults.push(r);
          searchIdSet.add(r.node.id);
        }
      }
    }

    // Final sort and truncation — all search channels (exact, text, CamelCase,
    // compound) have now contributed. Sort by score so multi-term matches from
    // later steps can outrank dampened single-term matches from earlier steps.
    searchResults.sort((a, b) => b.score - a.score);
    searchResults = searchResults.slice(0, opts.searchLimit * 3);

    const queryTermsForReason = extractSearchTerms(query, { stems: false });
    for (const result of searchResults) {
      annotateCommonRelevance(result, queryTermsForReason, symbolsFromQuery, isTestQuery);
      setReasonScore(result);
    }

    // Filter by minimum score
    let filteredResults = searchResults.filter((r) => r.score >= opts.minScore);

    // Resolve imports/exports to their actual definitions
    // If someone searches "terminal" and finds `import { TerminalPanel }`,
    // they want the TerminalPanel class, not the import statement
    filteredResults = this.resolveImportsToDefinitions(filteredResults);

    // Cap entry points so traversal budget isn't spread too thin.
    // With 36 entry points and maxNodes=120, each gets only 3 nodes — useless.
    // Cap to searchLimit so each entry point gets a meaningful traversal budget.
    if (filteredResults.length > opts.searchLimit) {
      filteredResults = filteredResults.slice(0, opts.searchLimit);
    }

    // Add entry points to subgraph
    for (const result of filteredResults) {
      nodes.set(result.node.id, result.node);
      roots.push(result.node.id);
      mergeNodeReason(result.node.id, {
        signals: [...(result.reason?.signals ?? []), 'entry point'],
        penalties: result.reason?.penalties,
        score: result.score,
      });
    }

    // Expand type hierarchy for class/interface entry points.
    // BFS often exhausts its per-entry-point budget on contained methods
    // before reaching extends/implements neighbors. This dedicated step
    // ensures subclasses and superclasses always appear in results.
    // Budget: up to maxNodes/4 hierarchy nodes to avoid flooding.
    const typeHierarchyKinds = new Set<string>(['class', 'interface', 'struct', 'trait', 'protocol']);
    const maxHierarchyNodes = Math.ceil(opts.maxNodes / 4);
    let hierarchyNodesAdded = 0;
    for (const result of filteredResults) {
      if (hierarchyNodesAdded >= maxHierarchyNodes) break;
      if (typeHierarchyKinds.has(result.node.kind)) {
        const hierarchy = this.traverser.getTypeHierarchy(result.node.id);
        for (const [id, node] of hierarchy.nodes) {
          if (!nodes.has(id)) {
            nodes.set(id, node);
            hierarchyNodesAdded++;
          }
          if (id !== result.node.id) {
            mergeNodeReason(id, {
              signals: [isDirectlyConnectedToAnyRoot(id, new Set([result.node.id]), hierarchy.edges)
                ? 'directly connected to entry point'
                : 'graph proximity to entry point'],
            });
          }
        }
        for (const edge of hierarchy.edges) {
          const exists = edges.some(
            (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
          );
          if (!exists) {
            edges.push(edge);
          }
        }
      }
    }

    // Pass 2: expand hierarchy of newly-discovered parent types to find siblings.
    // E.g., InternalEngine → Engine (parent, from pass 1) → ReadOnlyEngine (sibling).
    if (hierarchyNodesAdded > 0) {
      const pass2Candidates = [...nodes.values()].filter(
        n => typeHierarchyKinds.has(n.kind) && !roots.includes(n.id)
      );
      for (const candidate of pass2Candidates) {
        if (hierarchyNodesAdded >= maxHierarchyNodes) break;
        const siblingHierarchy = this.traverser.getTypeHierarchy(candidate.id);
        for (const [id, node] of siblingHierarchy.nodes) {
          if (!nodes.has(id) && hierarchyNodesAdded < maxHierarchyNodes) {
            nodes.set(id, node);
            hierarchyNodesAdded++;
          }
          if (!roots.includes(id)) {
            mergeNodeReason(id, { signals: ['graph proximity to entry point'] });
          }
        }
        for (const edge of siblingHierarchy.edges) {
          if (nodes.has(edge.source) && nodes.has(edge.target)) {
            const exists = edges.some(
              (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
            );
            if (!exists) {
              edges.push(edge);
            }
          }
        }
      }
    }

    // Traverse from each entry point
    for (const result of filteredResults) {
      const traversalResult = this.traverser.traverseBFS(result.node.id, {
        maxDepth: opts.traversalDepth,
        edgeKinds: opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined,
        nodeKinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        direction: 'both',
        limit: Math.ceil(opts.maxNodes / Math.max(1, filteredResults.length)),
      });

      const traversalRootIds = new Set([result.node.id]);

      // Merge nodes
      for (const [id, node] of traversalResult.nodes) {
        if (!nodes.has(id)) {
          nodes.set(id, node);
        }
        if (id !== result.node.id) {
          mergeNodeReason(id, {
            signals: [isDirectlyConnectedToAnyRoot(id, traversalRootIds, traversalResult.edges)
              ? 'directly connected to entry point'
              : 'graph proximity to entry point'],
          });
        }
      }

      // Merge edges (avoid duplicates)
      for (const edge of traversalResult.edges) {
        const exists = edges.some(
          (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
        );
        if (!exists) {
          edges.push(edge);
        }
      }
    }

    // Trim to max nodes if needed
    let finalNodes = nodes;
    let finalEdges = edges;
    if (nodes.size > opts.maxNodes) {
      // Prioritize entry points and their direct neighbors
      const priorityIds = new Set(roots);
      for (const edge of edges) {
        if (priorityIds.has(edge.source)) {
          priorityIds.add(edge.target);
        }
        if (priorityIds.has(edge.target)) {
          priorityIds.add(edge.source);
        }
      }

      // Keep priority nodes, then fill remaining slots
      finalNodes = new Map<string, Node>();
      for (const id of priorityIds) {
        const node = nodes.get(id);
        if (node && finalNodes.size < opts.maxNodes) {
          finalNodes.set(id, node);
        }
      }

      // Fill remaining from other nodes
      for (const [id, node] of nodes) {
        if (finalNodes.size >= opts.maxNodes) break;
        if (!finalNodes.has(id)) {
          finalNodes.set(id, node);
        }
      }

      // Filter edges to only include kept nodes
      finalEdges = edges.filter(
        (e) => finalNodes.has(e.source) && finalNodes.has(e.target)
      );
    }

    // Per-file diversity cap: prevent any single file from monopolizing the
    // node budget. When BFS traverses from a method, it follows `contains`
    // to the parent class, then back down to all sibling methods. With
    // multiple entry points in the same class, one file can consume 30-40%
    // of maxNodes. Cap each file to ~20% to ensure cross-file diversity.
    const maxPerFile = Math.max(5, Math.ceil(opts.maxNodes * 0.2));
    const fileCounts = new Map<string, string[]>();
    for (const [id, node] of finalNodes) {
      const ids = fileCounts.get(node.filePath) || [];
      ids.push(id);
      fileCounts.set(node.filePath, ids);
    }
    const rootSet = new Set(roots);
    for (const [, nodeIds] of fileCounts) {
      if (nodeIds.length <= maxPerFile) continue;
      // Sort: entry points first, then classes/interfaces, then others
      const kindPriority: Record<string, number> = {
        class: 3, interface: 3, struct: 3, trait: 3, protocol: 3, enum: 3,
        method: 1, function: 1, property: 0, field: 0, variable: 0,
      };
      nodeIds.sort((a, b) => {
        const aRoot = rootSet.has(a) ? 10 : 0;
        const bRoot = rootSet.has(b) ? 10 : 0;
        const aKind = kindPriority[finalNodes.get(a)!.kind] ?? 0;
        const bKind = kindPriority[finalNodes.get(b)!.kind] ?? 0;
        return (bRoot + bKind) - (aRoot + aKind);
      });
      // Remove excess nodes (keep the highest-priority ones)
      for (const id of nodeIds.slice(maxPerFile)) {
        finalNodes.delete(id);
      }
    }
    // Non-production node cap: limit test/sample/integration/example files to
    // at most 15% of the budget. Many codebases have dozens of near-identical
    // test implementations (e.g., 6 Guard classes in integration tests) that
    // individually survive score dampening but collectively flood the result.
    // Test entry points are NOT exempt — they should be evicted too.
    if (!isTestQuery) {
      const maxNonProd = Math.max(3, Math.ceil(opts.maxNodes * 0.15));
      const nonProdIds: string[] = [];
      for (const [id, node] of finalNodes) {
        if (isTestFile(node.filePath)) {
          nonProdIds.push(id);
        }
      }
      if (nonProdIds.length > maxNonProd) {
        for (const id of nonProdIds.slice(maxNonProd)) {
          finalNodes.delete(id);
          // Also remove from roots — test file entry points shouldn't anchor results
          const rootIdx = roots.indexOf(id);
          if (rootIdx !== -1) roots.splice(rootIdx, 1);
        }
      }
    }

    // Re-filter edges after per-file and non-production caps
    finalEdges = finalEdges.filter(
      (e) => finalNodes.has(e.source) && finalNodes.has(e.target)
    );

    // Edge recovery: BFS with many entry points leaves most nodes disconnected.
    // Discover edges between already-selected nodes to recover connectivity.
    const recoveryKinds: EdgeKind[] = ['calls', 'extends', 'implements', 'references', 'overrides'];
    const recoveredEdges = this.queries.findEdgesBetweenNodes(
      [...finalNodes.keys()],
      recoveryKinds,
    );
    const existingEdgeKeys = new Set(
      finalEdges.map((e) => `${e.source}:${e.target}:${e.kind}`)
    );
    for (const edge of recoveredEdges) {
      const key = `${edge.source}:${edge.target}:${edge.kind}`;
      if (!existingEdgeKeys.has(key)) {
        finalEdges.push(edge);
        existingEdgeKeys.add(key);
      }
    }

    const finalRoots = roots.filter((id) => finalNodes.has(id));
    const finalNodeReasons: Record<string, RelevanceReason> = {};
    for (const id of finalNodes.keys()) {
      if (nodeReasons[id]) {
        finalNodeReasons[id] = nodeReasons[id]!;
      }
    }
    const fileReasons = buildFileRelevanceReasons(finalNodes, finalRoots, finalNodeReasons, query, isTestQuery);

    return {
      nodes: finalNodes,
      edges: finalEdges,
      roots: finalRoots,
      reasons: { nodes: finalNodeReasons, files: fileReasons },
    };
  }

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    const node = this.queries.getNodeById(nodeId);
    if (!node) {
      return null;
    }

    return this.extractNodeCode(node);
  }

  /**
   * Extract code from a node's source file
   */
  private async extractNodeCode(node: Node): Promise<string | null> {
    const filePath = validatePathWithinRoot(this.projectRoot, node.filePath);

    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Extract lines (1-indexed to 0-indexed)
      const startIdx = Math.max(0, node.startLine - 1);
      const endIdx = Math.min(lines.length, node.endLine);

      return lines.slice(startIdx, endIdx).join('\n');
    } catch (error) {
      logDebug('Failed to extract code from node', { nodeId: node.id, filePath: node.filePath, error: String(error) });
      return null;
    }
  }

  /**
   * Get entry points from a subgraph (the root nodes)
   */
  private getEntryPoints(subgraph: Subgraph): Node[] {
    return subgraph.roots
      .map((id) => subgraph.nodes.get(id))
      .filter((n): n is Node => n !== undefined);
  }

  /**
   * Extract code blocks for key nodes in the subgraph
   */
  private async extractCodeBlocks(
    subgraph: Subgraph,
    maxBlocks: number,
    maxBlockSize: number
  ): Promise<CodeBlock[]> {
    const blocks: CodeBlock[] = [];

    // Prioritize entry points, then functions/methods
    const priorityNodes: Node[] = [];

    // First: entry points
    for (const id of subgraph.roots) {
      const node = subgraph.nodes.get(id);
      if (node) {
        priorityNodes.push(node);
      }
    }

    // Then: functions and methods
    for (const node of subgraph.nodes.values()) {
      if (!subgraph.roots.includes(node.id)) {
        if (node.kind === 'function' || node.kind === 'method') {
          priorityNodes.push(node);
        }
      }
    }

    // Then: classes
    for (const node of subgraph.nodes.values()) {
      if (!subgraph.roots.includes(node.id)) {
        if (node.kind === 'class') {
          priorityNodes.push(node);
        }
      }
    }

    // Extract code for priority nodes
    for (const node of priorityNodes) {
      if (blocks.length >= maxBlocks) break;

      const code = await this.extractNodeCode(node);
      if (code) {
        // Truncate if too long. Language-neutral marker (no `//` — not a
        // comment in Python, Ruby, etc.); this renders inside a fenced
        // source block whose language varies.
        const truncated = code.length > maxBlockSize
          ? code.slice(0, maxBlockSize) + '\n... (truncated) ...'
          : code;

        blocks.push({
          content: truncated,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
          language: node.language,
          node,
        });
      }
    }

    return blocks;
  }

  /**
   * Get unique files from a subgraph
   */
  private getRelatedFiles(subgraph: Subgraph): string[] {
    const files = new Set<string>();
    for (const node of subgraph.nodes.values()) {
      files.add(node.filePath);
    }
    return Array.from(files).sort();
  }

  /**
   * Generate a summary of the context
   */
  private generateSummary(_query: string, subgraph: Subgraph, entryPoints: Node[]): string {
    const nodeCount = subgraph.nodes.size;
    const edgeCount = subgraph.edges.length;
    const files = this.getRelatedFiles(subgraph);

    const entryPointNames = entryPoints
      .slice(0, 3)
      .map((n) => n.name)
      .join(', ');

    const remaining = entryPoints.length > 3 ? ` and ${entryPoints.length - 3} more` : '';

    return `Found ${nodeCount} relevant code symbols across ${files.length} files. ` +
      `Key entry points: ${entryPointNames}${remaining}. ` +
      `${edgeCount} relationships identified.`;
  }

  /**
   * Resolve import/export nodes to their actual definitions
   *
   * When search returns `import { TerminalPanel }`, users want the TerminalPanel
   * class definition, not the import statement. This follows the `imports` edge
   * to find and return the actual definition instead.
   *
   * @param results - Search results that may include import/export nodes
   * @returns Results with imports resolved to definitions where possible
   */
  private resolveImportsToDefinitions(results: SearchResult[]): SearchResult[] {
    const resolved: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const result of results) {
      const { node, score } = result;

      // If it's not an import/export, keep it as-is
      if (node.kind !== 'import' && node.kind !== 'export') {
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id);
          resolved.push(result);
        }
        continue;
      }

      // For imports/exports, try to find what they reference
      // Imports have outgoing 'imports' edges to the definition
      // Exports have outgoing 'exports' edges to the definition
      const edgeKind = node.kind === 'import' ? 'imports' : 'exports';
      const outgoingEdges = this.queries.getOutgoingEdges(node.id, [edgeKind as EdgeKind]);

      let foundDefinition = false;
      for (const edge of outgoingEdges) {
        const targetNode = this.queries.getNodeById(edge.target);
        if (targetNode) {
          const resolutionSignal = node.kind === 'import'
            ? 'resolved from import match'
            : 'resolved from export match';
          const resolvedReason = mergeRelevanceReason(result.reason, {
            signals: [resolutionSignal],
            score,
          });
          const existing = resolved.find((r) => r.node.id === targetNode.id);
          if (existing) {
            existing.score = Math.max(existing.score, score);
            existing.reason = mergeRelevanceReason(existing.reason, {
              signals: resolvedReason.signals,
              penalties: resolvedReason.penalties,
              score: existing.score,
            });
            foundDefinition = true;
            continue;
          }
          if (!seenIds.has(targetNode.id)) {
            // Found the definition - use it instead of the import
            seenIds.add(targetNode.id);
            resolved.push({
              node: targetNode,
              score: score, // Preserve the original score
              reason: resolvedReason,
            });
            foundDefinition = true;
            logDebug('Resolved import to definition', {
              import: node.name,
              definition: targetNode.name,
              kind: targetNode.kind,
            });
          }
        }
      }

      // If we couldn't resolve the import, skip it (it's low-value on its own)
      if (!foundDefinition) {
        logDebug('Skipping unresolved import', { name: node.name, file: node.filePath });
      }
    }

    return resolved;
  }
}

/**
 * Create a context builder
 */
export function createContextBuilder(
  projectRoot: string,
  queries: QueryBuilder,
  traverser: GraphTraverser
): ContextBuilder {
  return new ContextBuilder(projectRoot, queries, traverser);
}

// Re-export formatter
export { formatContextAsMarkdown, formatContextAsJson } from './formatter';
