/**
 * CodeGraph
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as path from 'path';
import {
  Node,
  Edge,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  Context,
  GraphStats,
  TaskInput,
  TaskContext,
  BuildContextOptions,
  FindRelevantContextOptions,
  NodeLocator,
  LocatorResolution,
  TraceOptions,
  TraceResult,
} from './types';
import { DatabaseConnection, getDatabasePath } from './db';
import { QueryBuilder } from './db/queries';
import {
  isInitialized,
  createDirectory,
  removeDirectory,
  validateDirectory,
} from './directory';
import {
  ExtractionOrchestrator,
  IndexProgress,
  IndexResult,
  SyncResult,
  extractFromSource,
  initGrammars,
} from './extraction';
import {
  ReferenceResolver,
  createResolver,
  ResolutionResult,
} from './resolution';
import { GraphTraverser, GraphQueryManager, GraphTracer } from './graph';
import { ContextBuilder, createContextBuilder } from './context';
import {
  formatNodeHandle,
  isQualifiedSymbol,
  lastQualifierPart,
  matchesSymbol,
  normalizeLocatorPath,
  parseFileLine,
  toNodeHandle,
} from './addressability/format';
import { Mutex, FileLock } from './utils';
import { FileWatcher, WatchOptions } from './sync';

// Re-export types for consumers
export * from './types';
export * from './addressability/format';
export { getDatabasePath } from './db';
export {
  getCodeGraphDir,
  isInitialized,
  findNearestCodeGraphRoot,
  CODEGRAPH_DIR,
} from './directory';
export { IndexProgress, IndexResult, SyncResult } from './extraction';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './extraction';
export { ResolutionResult } from './resolution';
export {
  CodeGraphError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  VectorError,
  ConfigError,
  Logger,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from './errors';
export { Mutex, FileLock, processInBatches, debounce, throttle, MemoryMonitor } from './utils';
export { FileWatcher, WatchOptions } from './sync';
export { MCPServer } from './mcp';

/**
 * Options for initializing a new CodeGraph project
 */
export interface InitOptions {
  /** Whether to run initial indexing after init */
  index?: boolean;

  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Options for opening an existing CodeGraph project
 */
export interface OpenOptions {
  /** Whether to run sync if files have changed */
  sync?: boolean;

  /** Whether to run in read-only mode */
  readOnly?: boolean;
}

/**
 * Options for indexing
 */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Enable verbose logging (worker lifecycle, memory, timeouts) */
  verbose?: boolean;
}

/**
 * Main CodeGraph class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class CodeGraph {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private projectRoot: string;
  private orchestrator: ExtractionOrchestrator;
  private resolver: ReferenceResolver;
  private graphManager: GraphQueryManager;
  private traverser: GraphTraverser;
  private contextBuilder: ContextBuilder;

  // Mutex for preventing concurrent indexing operations (in-process)
  private indexMutex = new Mutex();

  // File lock for preventing concurrent writes across processes (CLI, MCP, git hooks)
  private fileLock: FileLock;

  // File watcher for auto-sync on file changes
  private watcher: FileWatcher | null = null;

  private constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    projectRoot: string
  ) {
    this.db = db;
    this.queries = queries;
    this.projectRoot = projectRoot;
    this.fileLock = new FileLock(
      path.join(projectRoot, '.codegraph', 'codegraph.lock')
    );
    this.orchestrator = new ExtractionOrchestrator(projectRoot, queries);
    this.resolver = createResolver(projectRoot, queries);
    this.graphManager = new GraphQueryManager(queries);
    this.traverser = new GraphTraverser(queries);
    this.contextBuilder = createContextBuilder(
      projectRoot,
      queries,
      this.traverser
    );
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new CodeGraph project
   *
   * Creates the .CodeGraph directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new CodeGraph instance
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, resolvedRoot);

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }

  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, resolvedRoot);
  }

  /**
   * Open an existing CodeGraph project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A CodeGraph instance
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, resolvedRoot);

    // Sync if requested
    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, resolvedRoot);
  }

  /**
   * Check if a directory has been initialized as a CodeGraph project
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  /**
   * Close the CodeGraph instance and release resources
   */
  close(): void {
    this.unwatch();
    // Release file lock if held
    this.fileLock.release();
    this.db.close();
  }

  /**
   * Get the project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  // ===========================================================================
  // Indexing
  // ===========================================================================

  /**
   * Index all files in the project
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.indexAll(options.onProgress, options.signal, options.verbose);

        // Resolve references to create call/import/extends edges
        if (result.success && result.filesIndexed > 0) {
          // Get count without loading all refs into memory
          const unresolvedCount = this.queries.getUnresolvedReferencesCount();

          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedCount,
          });

          await this.resolveReferencesBatched((current, total) => {
            options.onProgress?.({
              phase: 'resolving',
              current,
              total,
            });
          });
        }

        // Refresh planner stats + checkpoint the WAL after bulk writes.
        // Cheap and non-blocking; never load-bearing for correctness.
        if (result.success && result.filesIndexed > 0) {
          this.db.runMaintenance();
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        return this.orchestrator.indexFiles(filePaths);
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.sync(options.onProgress);

        // Resolve references if files were updated
        if (result.filesAdded > 0 || result.filesModified > 0) {
          if (result.changedFilePaths) {
            // Scope resolution to changed files (git fast path — bounded set)
            const unresolvedRefs = this.queries.getUnresolvedReferencesByFiles(result.changedFilePaths);

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedRefs.length,
            });

            this.resolver.resolveAndPersist(unresolvedRefs, (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          } else {
            // No git info — use batched resolution to avoid OOM
            const unresolvedCount = this.queries.getUnresolvedReferencesCount();

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedCount,
            });

            await this.resolveReferencesBatched((current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          }
        }

        // Refresh planner stats + checkpoint the WAL after bulk writes.
        if (result.filesAdded > 0 || result.filesModified > 0 || result.filesRemoved > 0) {
          this.db.runMaintenance();
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Check if an indexing operation is currently in progress
   */
  isIndexing(): boolean {
    return this.indexMutex.isLocked();
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  /**
   * Start watching for file changes and auto-syncing.
   *
   * Uses native OS file events (FSEvents on macOS, inotify on Linux 19+,
   * ReadDirectoryChangesW on Windows) with debouncing to avoid thrashing.
   *
   * @param options - Watch options (debounce delay, callbacks)
   * @returns true if watching started successfully
   */
  watch(options: WatchOptions = {}): boolean {
    if (this.watcher?.isActive()) return true;

    this.watcher = new FileWatcher(
      this.projectRoot,
      async () => {
        const result = await this.sync();
        const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options
    );

    return this.watcher.start();
  }

  /**
   * Stop watching for file changes.
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  /**
   * Check if the file watcher is active.
   */
  isWatching(): boolean {
    return this.watcher?.isActive() ?? false;
  }

  /**
   * Get files that have changed since last index
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.orchestrator.getChangedFiles();
  }

  /**
   * Extract nodes and edges from source code (without storing)
   */
  extractFromSource(filePath: string, source: string): ExtractionResult {
    return extractFromSource(filePath, source);
  }

  // ===========================================================================
  // Reference Resolution
  // ===========================================================================

  /**
   * Resolve unresolved references and create edges
   *
   * This method takes unresolved references from extraction and attempts
   * to resolve them using multiple strategies:
   * - Framework-specific patterns (React, Express, Laravel)
   * - Import-based resolution
   * - Name-based symbol matching
   */
  resolveReferences(onProgress?: (current: number, total: number) => void): ResolutionResult {
    // Get all unresolved references from the database
    const unresolvedRefs = this.queries.getUnresolvedReferences();
    return this.resolver.resolveAndPersist(unresolvedRefs, onProgress);
  }

  /**
   * Resolve references in batches to keep memory bounded on large codebases.
   * Processes chunks of unresolved refs, persisting results after each batch.
   */
  async resolveReferencesBatched(onProgress?: (current: number, total: number) => void): Promise<ResolutionResult> {
    return this.resolver.resolveAndPersistBatched(onProgress);
  }

  /**
   * Get detected frameworks in the project
   */
  getDetectedFrameworks(): string[] {
    return this.resolver.getDetectedFrameworks();
  }

  /**
   * Re-initialize the resolver (useful after adding new files)
   */
  reinitializeResolver(): void {
    this.resolver.initialize();
  }

  // ===========================================================================
  // Graph Statistics
  // ===========================================================================

  /**
   * Get statistics about the knowledge graph
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  /**
   * Active SQLite backend for this project's connection (`node-sqlite` — Node's
   * built-in real-SQLite module). Surfaced via `codegraph status` and the
   * `codegraph_status` MCP tool alongside the effective journal mode.
   */
  getBackend(): import('./db').SqliteBackend {
    return this.db.getBackend();
  }

  /**
   * The journal mode actually in effect ('wal', 'delete', …). 'wal' means
   * readers never block on a concurrent writer; anything else means they can,
   * which is the precondition for the "database is locked" failures in issue
   * #238. Surfaced via `codegraph status` and the `codegraph_status` MCP tool.
   */
  getJournalMode(): string {
    return this.db.getJournalMode();
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * Get all nodes in a file
   */
  getNodesInFile(filePath: string): Node[] {
    return this.queries.getNodesByFile(filePath);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: Node['kind']): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * Search nodes by text
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  /**
   * Resolve a precise or backward-compatible node locator.
   */
  resolveNodeLocator(locator: NodeLocator): LocatorResolution {
    const normalized = this.normalizeNodeLocator(locator);

    if (normalized.nodeId) {
      const node = this.queries.getNodeById(normalized.nodeId);
      if (!node) {
        return {
          status: 'not_found',
          locator: normalized,
          message: `No node found for nodeId ${normalized.nodeId}`,
        };
      }
      if (normalized.kind && node.kind !== normalized.kind) {
        return {
          status: 'not_found',
          locator: normalized,
          alternatives: [node],
          message: `Node ${normalized.nodeId} exists but is kind ${node.kind}, not ${normalized.kind}`,
        };
      }
      return { status: 'resolved', locator: normalized, node };
    }

    if (normalized.path && normalized.line !== undefined) {
      return this.resolvePathLineLocator(normalized);
    }

    if (normalized.qualifiedName) {
      return this.finalizeLocatorResolution(
        normalized,
        this.filterCandidates(
          this.queries.getNodesByQualifiedNameExact(normalized.qualifiedName),
          normalized
        ),
        `No node found for qualifiedName ${normalized.qualifiedName}`
      );
    }

    if (normalized.symbol) {
      const candidates = this.findLocatorSymbolCandidates(normalized.symbol, normalized);
      return this.finalizeLocatorResolution(
        normalized,
        candidates,
        `No symbol found for ${normalized.symbol}`
      );
    }

    return {
      status: 'not_found',
      locator: normalized,
      message: 'No locator fields provided. Use nodeId, fileLine, path+line, qualifiedName, or symbol.',
    };
  }

  /**
   * Backward-compatible plural alias for callers that want the resolution envelope.
   */
  resolveNodeLocators(locator: NodeLocator): LocatorResolution {
    return this.resolveNodeLocator(locator);
  }

  /**
   * Trace candidate static graph paths from an entry locator to a target locator/query.
   */
  trace(
    from: NodeLocator,
    to?: NodeLocator | string,
    options: TraceOptions = {}
  ): TraceResult {
    const fromResolution = this.resolveNodeLocator(from);
    const completenessNote = 'Static graph guidance only; dynamic dispatch, callbacks, registries, and dependency injection may hide runtime paths.';

    if (fromResolution.status !== 'resolved' || !fromResolution.node) {
      return {
        status: fromResolution.status === 'ambiguous' ? 'ambiguous' : 'not_found',
        fromResolution,
        targetCandidates: [],
        paths: [],
        boundaries: [],
        gaps: [fromResolution.message ?? `Unable to resolve trace entry (${fromResolution.status}).`],
        recommendations: this.recommendResolutionFollowup(fromResolution),
        completenessNote,
      };
    }

    const target = this.resolveTraceTarget(to);
    if (target.targetCandidates.length === 0) {
      return {
        status: 'resolved',
        from: toNodeHandle(fromResolution.node),
        fromResolution,
        targetResolution: target.resolution,
        targetCandidates: [],
        paths: [],
        boundaries: [],
        gaps: target.gaps.length > 0 ? target.gaps : ['No target candidates found.'],
        recommendations: [
          ...target.recommendations,
          `Inspect the entry: ${formatNodeHandle(fromResolution.node)}`,
        ],
        completenessNote,
      };
    }

    const tracer = new GraphTracer(this.queries);
    const traced = tracer.trace(fromResolution.node, target.targetCandidates, options);
    const pathRecommendations = traced.paths.length > 0
      ? this.recommendTraceFollowup(traced.paths[0]!.steps.map((s) => s.node.name))
      : [];

    return {
      status: 'resolved',
      from: toNodeHandle(fromResolution.node),
      fromResolution,
      targetResolution: target.resolution,
      targetCandidates: traced.targetCandidates.map(toNodeHandle),
      paths: traced.paths,
      boundaries: traced.boundaries,
      gaps: [...target.gaps, ...traced.gaps],
      recommendations: [
        ...target.recommendations,
        ...traced.recommendations,
        ...pathRecommendations,
      ],
      completenessNote,
    };
  }

  private normalizeNodeLocator(locator: NodeLocator): NodeLocator {
    const normalized: NodeLocator = { ...locator };

    if (normalized.fileLine) {
      const parsed = parseFileLine(normalized.fileLine);
      if (parsed) {
        normalized.path = parsed.path;
        normalized.line = parsed.line;
      }
    }

    if (normalized.path) {
      normalized.path = normalizeLocatorPath(normalized.path, this.projectRoot);
    }

    return normalized;
  }

  private resolvePathLineLocator(locator: NodeLocator): LocatorResolution {
    const filePath = locator.path!;
    const line = locator.line!;
    const containing = this.filterCandidates(
      this.queries.getNodesContainingLine(filePath, line),
      locator
    ).filter((node) => node.kind !== 'file');

    const best = this.pickBestContainingNode(containing);
    if (best) {
      return { status: 'resolved', locator, node: best, alternatives: containing.filter((n) => n.id !== best.id).slice(0, 10) };
    }

    const nearby = this.queries
      .getNearbyNodes(filePath, line, 5)
      .filter((node) => node.kind !== 'file' && node.kind !== 'import' && node.kind !== 'export');

    return {
      status: 'not_found',
      locator,
      alternatives: nearby,
      message: `No symbol covers ${filePath}:${line}`,
    };
  }

  private pickBestContainingNode(nodes: Node[]): Node | null {
    if (nodes.length === 0) return null;

    const priority = (node: Node): number => {
      switch (node.kind) {
        case 'method':
        case 'function':
        case 'route':
          return 0;
        case 'class':
        case 'struct':
        case 'interface':
        case 'trait':
        case 'protocol':
        case 'component':
          return 1;
        case 'variable':
        case 'constant':
        case 'property':
        case 'field':
          return 2;
        case 'import':
        case 'export':
          return 9;
        default:
          return 4;
      }
    };

    return [...nodes].sort((a, b) => {
      const rangeA = Math.max(0, a.endLine - a.startLine);
      const rangeB = Math.max(0, b.endLine - b.startLine);
      if (rangeA !== rangeB) return rangeA - rangeB;
      const priorityDiff = priority(a) - priority(b);
      if (priorityDiff !== 0) return priorityDiff;
      return b.startLine - a.startLine;
    })[0] ?? null;
  }

  private findLocatorSymbolCandidates(symbol: string, locator: NodeLocator): Node[] {
    let candidates: Node[] = [];
    const pathFilter = locator.path;

    if (pathFilter) {
      candidates = this.queries.getNodesByFile(pathFilter).filter((node) => matchesSymbol(node, symbol));
    } else if (isQualifiedSymbol(symbol)) {
      const tail = lastQualifierPart(symbol);
      candidates = this.queries.getNodesByName(tail).filter((node) => matchesSymbol(node, symbol));
      if (candidates.length === 0) {
        candidates = this.queries.searchNodes(tail, { limit: 50 }).map((r) => r.node).filter((node) => matchesSymbol(node, symbol));
      }
    } else {
      candidates = this.queries.getNodesByName(symbol);
      if (candidates.length === 0) {
        candidates = this.queries.searchNodes(symbol, { limit: 20 }).map((r) => r.node);
      }
    }

    return this.filterCandidates(candidates, locator);
  }

  private filterCandidates(candidates: Node[], locator: NodeLocator): Node[] {
    const seen = new Set<string>();
    const filtered: Node[] = [];
    for (const node of candidates) {
      if (seen.has(node.id)) continue;
      if (locator.kind && node.kind !== locator.kind) continue;
      if (locator.path && normalizeLocatorPath(node.filePath, this.projectRoot) !== locator.path) continue;
      seen.add(node.id);
      filtered.push(node);
    }
    return filtered.sort((a, b) => {
      if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.name.localeCompare(b.name);
    });
  }

  private finalizeLocatorResolution(locator: NodeLocator, candidates: Node[], notFoundMessage: string): LocatorResolution {
    if (candidates.length === 0) {
      return { status: 'not_found', locator, message: notFoundMessage };
    }
    if (candidates.length === 1) {
      return { status: 'resolved', locator, node: candidates[0] };
    }
    return {
      status: 'ambiguous',
      locator,
      alternatives: candidates,
      message: `Locator matched ${candidates.length} nodes. Use nodeId or fileLine to disambiguate.`,
    };
  }

  private resolveTraceTarget(to?: NodeLocator | string): {
    resolution?: LocatorResolution;
    targetCandidates: Node[];
    gaps: string[];
    recommendations: string[];
  } {
    if (to === undefined) {
      return {
        targetCandidates: [],
        gaps: ['No trace target provided.'],
        recommendations: ['Provide a target symbol/query or exact target locator.'],
      };
    }

    if (typeof to === 'string') {
      const resolution = this.resolveNodeLocator({ symbol: to });
      if (resolution.status === 'resolved' && resolution.node) {
        return { resolution, targetCandidates: [resolution.node], gaps: [], recommendations: [] };
      }
      if (resolution.status === 'ambiguous' && resolution.alternatives) {
        return {
          resolution,
          targetCandidates: resolution.alternatives,
          gaps: [`Target symbol "${to}" is ambiguous; tracing to ${resolution.alternatives.length} candidates.`],
          recommendations: this.recommendResolutionFollowup(resolution),
        };
      }
      const searchCandidates = this.queries.searchNodes(to, { limit: 20 }).map((r) => r.node);
      return {
        resolution,
        targetCandidates: searchCandidates,
        gaps: searchCandidates.length === 0 ? [`No target candidates found for "${to}".`] : [],
        recommendations: searchCandidates.length === 0 ? [`Try codegraph_search with a narrower query than "${to}".`] : [],
      };
    }

    const resolution = this.resolveNodeLocator(to);
    if (resolution.status === 'resolved' && resolution.node) {
      return { resolution, targetCandidates: [resolution.node], gaps: [], recommendations: [] };
    }
    if (resolution.status === 'ambiguous' && resolution.alternatives) {
      return {
        resolution,
        targetCandidates: resolution.alternatives,
        gaps: ['Target locator is ambiguous; tracing to all candidate targets.'],
        recommendations: this.recommendResolutionFollowup(resolution),
      };
    }
    return {
      resolution,
      targetCandidates: [],
      gaps: [resolution.message ?? 'Target locator was not found.'],
      recommendations: this.recommendResolutionFollowup(resolution),
    };
  }

  private recommendResolutionFollowup(resolution: LocatorResolution): string[] {
    if (resolution.status === 'ambiguous' && resolution.alternatives && resolution.alternatives.length > 0) {
      return [
        'Resolve ambiguity with an exact handle:',
        ...resolution.alternatives.slice(0, 10).map((node) => `- ${formatNodeHandle(node)}`),
      ];
    }
    if (resolution.alternatives && resolution.alternatives.length > 0) {
      return [
        'Nearby alternatives:',
        ...resolution.alternatives.slice(0, 5).map((node) => `- ${formatNodeHandle(node)}`),
      ];
    }
    return [];
  }

  private recommendTraceFollowup(pathNames: string[]): string[] {
    if (pathNames.length === 0) return [];
    const uniqueNames = Array.from(new Set(pathNames));
    return [
      `Recommended next: codegraph_explore query "${uniqueNames.join(' ')}"`,
      'Use codegraph_node with a returned nodeId for exact source ranges.',
    ];
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(nodeId: string): Edge[] {
    return this.queries.getOutgoingEdges(nodeId);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(nodeId: string): Edge[] {
    return this.queries.getIncomingEdges(nodeId);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get a file record by path
   */
  getFile(filePath: string): FileRecord | null {
    return this.queries.getFileByPath(filePath);
  }

  /**
   * Get all tracked files
   */
  getFiles(): FileRecord[] {
    return this.queries.getAllFiles();
  }

  // ===========================================================================
  // Graph Query Methods
  // ===========================================================================

  /**
   * Get the context for a node (ancestors, children, references)
   *
   * Returns comprehensive context about a node including its containment
   * hierarchy, children, incoming/outgoing references, type information,
   * and relevant imports.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    return this.graphManager.getContext(nodeId);
  }

  /**
   * Traverse the graph from a starting node
   *
   * Uses breadth-first search by default. Supports filtering by edge types,
   * node types, and traversal direction.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.traverser.traverseBFS(startId, options);
  }

  /**
   * Get the call graph for a function
   *
   * Returns both callers (functions that call this function) and
   * callees (functions called by this function) up to the specified depth.
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.traverser.getCallGraph(nodeId, depth);
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * Returns both ancestors (types this extends/implements) and
   * descendants (types that extend/implement this).
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return this.traverser.getTypeHierarchy(nodeId);
  }

  /**
   * Find all usages of a symbol
   *
   * Returns all nodes that reference the specified symbol through
   * any edge type (calls, references, type_of, etc.).
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.traverser.findUsages(nodeId);
  }

  /**
   * Get callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }

  /**
   * Get callees of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.traverser.getImpactRadius(nodeId, maxDepth);
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds?: Edge['kind'][]
  ): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }

  /**
   * Get ancestors of a node in the containment hierarchy
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    return this.traverser.getAncestors(nodeId);
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    return this.traverser.getChildren(nodeId);
  }

  /**
   * Get dependencies of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    return this.graphManager.getFileDependencies(filePath);
  }

  /**
   * Get dependents of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    return this.graphManager.getFileDependents(filePath);
  }

  /**
   * Find circular dependencies in the codebase
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
  findCircularDependencies(): string[][] {
    return this.graphManager.findCircularDependencies();
  }

  /**
   * Find dead code (unreferenced symbols)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return this.graphManager.findDeadCode(kinds);
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    return this.contextBuilder.getCode(nodeId);
  }

  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions
  ): Promise<Subgraph> {
    return this.contextBuilder.findRelevantContext(query, options);
  }

  /**
   * Build context for a task
   *
   * Creates comprehensive context by:
   * 1. Running FTS search to find entry points
   * 2. Expanding the graph around entry points
   * 3. Extracting code blocks for key nodes
   * 4. Formatting output for Claude
   *
   * @param input - Task description (string or {title, description})
   * @param options - Build options (maxNodes, includeCode, format, etc.)
   * @returns TaskContext object or formatted string (markdown/JSON)
   */
  async buildContext(
    input: TaskInput,
    options?: BuildContextOptions
  ): Promise<TaskContext | string> {
    return this.contextBuilder.buildContext(input, options);
  }

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Optimize the database (vacuum and analyze)
   */
  optimize(): void {
    this.db.optimize();
  }

  /**
   * Clear all data from the graph
   */
  clear(): void {
    this.queries.clear();
  }

  /**
   * Alias for close() for backwards compatibility.
   * @deprecated Use close() instead
   */
  destroy(): void {
    this.close();
  }

  /**
   * Completely remove CodeGraph from the project.
   * This closes the database and deletes the .CodeGraph directory.
   *
   * WARNING: This permanently deletes all CodeGraph data for the project.
   */
  uninitialize(): void {
    this.close();
    removeDirectory(this.projectRoot);
  }
}

// Default export
export default CodeGraph;
