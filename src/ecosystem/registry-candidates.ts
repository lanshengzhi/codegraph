/**
 * Registry Candidates Analyzer (P3c)
 *
 * Query-time AST analysis for registry/resolver patterns (provider, tool,
 * extension, route, handler mappings). Detects object-literal registries,
 * Map construction, .set() registration, register-like calls, and
 * definition arrays. Produces static candidates with confidence, evidence,
 * and handler resolution — not runtime branch proof.
 */

import * as fs from 'fs/promises';
import type { Parser, Tree, Node as SyntaxNode } from 'web-tree-sitter';
import {
  RegistryCandidate,
  RegistryCandidatesOptions,
  RegistryCandidatesResult,
  RegistryCandidateStatus,
  RegistryConfidence,
  RegistryEvidence,
  RegistryKind,
  FileRecord,
  Language,
  Node,
  NodeHandle,
  SourceRange,
  Edge,
} from '../types';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { hashContent } from '../extraction';
import { getChildByField, getNodeText } from '../extraction/tree-sitter-helpers';
import { toNodeHandle } from '../addressability/format';
import { validatePathWithinRoot } from '../utils';

const SUPPORTED_LANGUAGES = new Set<Language>(['typescript', 'javascript', 'tsx', 'jsx']);
const DEFAULT_LIMIT = 50;
const MAX_DISPLAY_CANDIDATES = 20;
const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES_TO_PARSE = 5000;
const DEFAULT_BATCH_SIZE = 8;
const CAVEAT =
  'Registry/resolver candidates are static code structure suggestions only, not runtime branch proof. ' +
  'Runtime config or dynamic key selection chooses the active implementation at runtime.';

// =============================================================================
// Registry name hints for kind classification
// =============================================================================

const KIND_HINT_PATTERNS: Array<{ kind: RegistryKind; regex: RegExp }> = [
  { kind: 'provider', regex: /provider/i },
  { kind: 'tool', regex: /\b(tools?|tool_)/i },
  { kind: 'extension', regex: /\b(extensions?|plugins?|middlewares?)/i },
  { kind: 'route', regex: /\b(routes?|routers?|router_)/i },
  { kind: 'handler', regex: /\b(handlers?|handler_)/i },
];

// Register-like call patterns
const REGISTER_CALL_PATTERNS = [
  /\bregister/i,       // registerProvider, registerTool, etc.
  /\baddTool\b/i,
  /\baddProvider\b/i,
  /\baddExtension\b/i,
  /\baddPlugin\b/i,
  /\baddHandler\b/i,
  /\baddRoute\b/i,
  /\buse\b/i,
];

// HTTP method-like patterns (for framework route registration)
const ROUTE_METHOD_PATTERNS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all', 'route'];

// Key field names in definition arrays
const KEY_FIELD_NAMES = new Set(['name', 'id', 'key', 'api', 'path', 'method', 'model', 'provider']);
const HANDLER_FIELD_NAMES = new Set(['handler', 'execute', 'run', 'stream', 'component', 'fn', 'callback', 'action', 'implementation', 'resolve']);

// =============================================================================
// Types for internal use
// =============================================================================

interface CandidateCollector {
  candidates: RegistryCandidate[];
  skippedFiles: Array<{ path: string; reason: string; detail?: string }>;
  skippedSummary: Record<string, number>;
  parsedCount: number;
  searchedCount: number;
}

interface KindClassification {
  kind: RegistryKind;
  registryName?: string;
}

type ResolvedOptions = {
  query: string | undefined;
  key: string | undefined;
  kind: RegistryKind;
  scopePath: string | undefined;
  limit: number;
  includeTests: boolean;
  maxDisplayCandidates: number;
  maxFilesToParse: number;
  maxSourceBytes: number;
};

function normalizeOptions(options: RegistryCandidatesOptions): ResolvedOptions {
  return {
    query: options.query ?? undefined,
    key: options.key ?? undefined,
    kind: options.kind ?? 'all',
    scopePath: options.scopePath ?? undefined,
    limit: Math.max(1, Math.min(200, options.limit ?? DEFAULT_LIMIT)),
    includeTests: options.includeTests !== false,
    maxDisplayCandidates: Math.max(1, Math.min(100, options.maxDisplayCandidates ?? MAX_DISPLAY_CANDIDATES)),
    maxFilesToParse: DEFAULT_MAX_FILES_TO_PARSE,
    maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
  };
}

// =============================================================================
// RegistryCandidatesAnalyzer
// =============================================================================

export interface RegistryParserHost {
  loadGrammarsForLanguages(languages: Language[]): Promise<void>;
  getParser(language: Language): Parser | null;
}

const defaultParserHost: RegistryParserHost = {
  loadGrammarsForLanguages,
  getParser,
};

export class RegistryCandidatesAnalyzer {
  constructor(
    private readonly projectRoot: string,
    private readonly parserHost: RegistryParserHost = defaultParserHost,
  ) {}

  async analyze(
    files: FileRecord[],
    loadNodesForFile: (path: string) => Node[],
    loadEdgesForNode: (nodeId: string) => Edge[],
    getNodeById: (id: string) => Node | null,
    options: RegistryCandidatesOptions = {},
  ): Promise<RegistryCandidatesResult> {
    const opts = normalizeOptions(options);

    // Validate inputs
    if (opts.key != null && opts.key.includes('\n')) {
      return {
        status: 'invalid-query',
        query: opts.query,
        key: opts.key,
        kind: opts.kind,
        candidates: [],
        totalCandidates: 0,
        omittedCandidates: 0,
        searchedFiles: 0,
        parsedFiles: 0,
        skippedSummary: {},
        caveats: ['Key must not contain newlines.', CAVEAT],
        recommendations: ['Check that the project has TypeScript/JavaScript files indexed.'],
      };
    }

    const collector: CandidateCollector = {
      candidates: [],
      skippedFiles: [],
      skippedSummary: {},
      parsedCount: 0,
      searchedCount: 0,
    };

    // -----------------------------------------------------------------------
    // 1. Collect route nodes from DB (no AST parsing needed)
    // -----------------------------------------------------------------------
    this.collectRouteNodes(loadNodesForFile, loadEdgesForNode, getNodeById, files, opts, collector);

    // -----------------------------------------------------------------------
    // 2. Collect object-literal / Map / register-call / definition-array
    //    candidates via AST parsing
    // -----------------------------------------------------------------------
    await this.collectAstCandidates(files, loadNodesForFile, opts, collector);

    // -----------------------------------------------------------------------
    // 3. Filter, sort, deduplicate
    // -----------------------------------------------------------------------
    this.filterAndSortCandidates(collector, opts);

    return this.buildResult(collector, opts);
  }

  // ===========================================================================
  // Route node collection
  // ===========================================================================

  private collectRouteNodes(
    loadNodesForFile: (path: string) => Node[],
    loadEdgesForNode: (nodeId: string) => Edge[],
    getNodeById: (id: string) => Node | null,
    files: FileRecord[],
    opts: ResolvedOptions,
    collector: CandidateCollector,
  ): void {
    // Resolve all route nodes across all indexed files
    for (const file of files) {
      collector.searchedCount++;
      const nodes = loadNodesForFile(file.path);
      for (const node of nodes) {
        if (node.kind !== 'route') continue;

        // Kind filter
        if (opts.kind !== 'all' && opts.kind !== 'route') continue;

        // Key filter
        const routeName = node.name;
        if (opts.key && routeName !== opts.key) continue;
        if (opts.query && !routeName.toLowerCase().includes(opts.query.toLowerCase())) continue;

        // Test/fixture filter
        const isTest = this.isTestOrFixturePath(file.path);
        if (!opts.includeTests && isTest) continue;

        // Collect handler candidates from edges
        const edges = loadEdgesForNode(node.id);
        const handlerRefs = edges.filter((e) => e.kind === 'references' || e.kind === 'calls');
        const handlerCandidates: NodeHandle[] = [];
        for (const edge of handlerRefs) {
          const targetNode = getNodeById(edge.target);
          if (targetNode) {
            handlerCandidates.push(toNodeHandle(targetNode));
          }
        }

        const candidate: RegistryCandidate = {
          kind: 'route',
          keyText: routeName,
          evidence: 'route-node',
          confidence: 'high',
          range: {
            path: file.path,
            startLine: node.startLine,
            endLine: node.endLine,
            startColumn: node.startColumn,
            endColumn: node.endColumn,
          },
          enclosingNode: toNodeHandle(node),
          routePath: routeName,
          handlerAlternatives: handlerCandidates.length > 0 ? handlerCandidates : undefined,
          handlerResolutionStatus:
            handlerCandidates.length === 1
              ? 'resolved'
              : handlerCandidates.length > 1
                ? 'ambiguous'
                : 'not-indexed',
          isTestOrFixture: isTest,
        };
        collector.candidates.push(candidate);
      }
    }
  }

  // ===========================================================================
  // AST-based candidate collection
  // ===========================================================================

  private async collectAstCandidates(
    files: FileRecord[],
    loadNodesForFile: (path: string) => Node[],
    opts: ResolvedOptions,
    collector: CandidateCollector,
  ): Promise<void> {
    // Separate supported vs unsupported
    const supportedFiles: FileRecord[] = [];
    for (const file of files) {
      if (SUPPORTED_LANGUAGES.has(file.language)) {
        // Apply scopePath
        if (opts.scopePath && file.path !== opts.scopePath && !file.path.startsWith(opts.scopePath + '/')) {
          continue;
        }
        supportedFiles.push(file);
      } else {
        this.addSkipped(collector, { path: file.path, reason: 'unsupported-language' });
      }
    }

    if (supportedFiles.length === 0) return;

    // Load parsers
    const distinctLanguages = [...new Set(supportedFiles.map((f) => f.language))].filter((l): l is Language =>
      SUPPORTED_LANGUAGES.has(l),
    );

    try {
      await this.parserHost.loadGrammarsForLanguages(distinctLanguages);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      for (const file of supportedFiles) {
        this.addSkipped(collector, { path: file.path, reason: 'parser-unavailable', detail: msg });
      }
      return;
    }

    const parsers = new Map<Language, Parser | null>();
    for (const lang of distinctLanguages) {
      parsers.set(lang, this.parserHost.getParser(lang));
    }

    // Process in batches
    for (let i = 0; i < supportedFiles.length; i += DEFAULT_BATCH_SIZE) {
      const batch = supportedFiles.slice(i, i + DEFAULT_BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map((file) => this.processFile(file, loadNodesForFile, parsers, opts, collector)),
      );

      for (const res of batchResults) {
        // parsedCount tracked inside processFile
        if (res.candidates.length > 0) {
          collector.candidates.push(...res.candidates);
        }
      }

      if (collector.parsedCount >= opts.maxFilesToParse) {
        for (let j = i + DEFAULT_BATCH_SIZE; j < supportedFiles.length; j++) {
          const f = supportedFiles[j]!;
          this.addSkipped(collector, { path: f.path, reason: 'too-many-files' });
        }
        break;
      }
    }
  }

  private async processFile(
    file: FileRecord,
    loadNodesForFile: (path: string) => Node[],
    parsers: Map<Language, Parser | null>,
    opts: ResolvedOptions,
    collector: CandidateCollector,
  ): Promise<{ candidates: RegistryCandidate[] }> {
    const safePath = validatePathWithinRoot(this.projectRoot, file.path);
    if (!safePath) {
      this.addSkipped(collector, { path: file.path, reason: 'outside-root' });
      return { candidates: [] };
    }

    let stat;
    try {
      stat = await fs.stat(safePath);
    } catch {
      this.addSkipped(collector, { path: file.path, reason: 'source-unavailable' });
      return { candidates: [] };
    }
    if (!stat.isFile()) {
      this.addSkipped(collector, { path: file.path, reason: 'source-unavailable' });
      return { candidates: [] };
    }
    if (stat.size > opts.maxSourceBytes) {
      this.addSkipped(collector, { path: file.path, reason: 'source-too-large' });
      return { candidates: [] };
    }

    let source: string;
    try {
      source = await fs.readFile(safePath, 'utf8');
    } catch {
      this.addSkipped(collector, { path: file.path, reason: 'source-unavailable' });
      return { candidates: [] };
    }

    if (hashContent(source) !== file.contentHash) {
      this.addSkipped(collector, { path: file.path, reason: 'source-stale' });
      return { candidates: [] };
    }

    const parser = parsers.get(file.language) ?? null;
    if (!parser) {
      this.addSkipped(collector, { path: file.path, reason: 'parser-unavailable' });
      return { candidates: [] };
    }

    if (collector.parsedCount >= opts.maxFilesToParse) {
      this.addSkipped(collector, { path: file.path, reason: 'too-many-files' });
      return { candidates: [] };
    }
    collector.parsedCount++;

    let tree: Tree | null = null;
    try {
      tree = parser.parse(source);
      if (!tree || tree.rootNode.hasError) {
        this.addSkipped(collector, { path: file.path, reason: 'parse-error' });
        return { candidates: [] };
      }

      // Collect registry candidates from AST
      const candidates = this.collectCandidates(tree.rootNode, file, source, opts);
      collector.searchedCount++;

      // Resolve handler nodes
      const nodes = loadNodesForFile(file.path);
      this.resolveHandlerNodes(candidates, nodes);

      return { candidates };
    } catch {
      this.addSkipped(collector, { path: file.path, reason: 'parse-error' });
      return { candidates: [] };
    } finally {
      tree?.delete();
    }
  }

  // ===========================================================================
  // AST candidate collection
  // ===========================================================================

  private collectCandidates(
    root: SyntaxNode,
    file: FileRecord,
    source: string,
    opts: ResolvedOptions,
  ): RegistryCandidate[] {
    const candidates: RegistryCandidate[] = [];
    const isTest = this.isTestOrFixturePath(file.path);

    // Skip test/fixture paths early when not included
    if (!opts.includeTests && isTest) return candidates;

    const visit = (node: SyntaxNode): void => {
      // Variable declaration with object value
      if (node.type === 'variable_declaration' || node.type === 'lexical_declaration') {
        // The name and value are nested inside variable_declarator child
        for (let i = 0; i < node.namedChildCount; i++) {
          const decl = node.namedChild(i);
          if (!decl) continue;
          if (decl.type !== 'variable_declarator') continue;

          const name = getChildByField(decl, 'name');
          const value = getChildByField(decl, 'value');
          if (!name || !value) continue;

          const varName = getNodeText(name, source);
          if (value.type === 'object') {
            this.checkObjectLiteralRegistry(varName, value, node, file, source, opts, candidates, isTest);
          } else if (value.type === 'new_expression') {
            const constructor = getChildByField(value, 'constructor');
            if (constructor && constructor.text === 'Map') {
              this.checkMapConstructorRegistry(varName, value, node, file, source, opts, candidates, isTest);
            }
          } else if (value.type === 'array') {
            this.checkDefinitionArray(value, node, file, source, opts, candidates, isTest);
          }
        }
        // Still visit children inside value for nested patterns
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) visit(child);
        }
        return;
      }

      // Expression statement: Map.set(), register(), app.get(), etc.
      if (node.type === 'expression_statement') {
        const expr = node.namedChild(0);
        if (expr) {
          if (expr.type === 'call_expression') {
            this.checkMapSetCall(expr, node, file, source, opts, candidates, isTest);
            this.checkRegisterCall(expr, node, file, source, opts, candidates, isTest);
          }
          if (expr.type === 'array' || expr.type === 'assignment_expression') {
            const arrNode = expr.type === 'assignment_expression' ? getChildByField(expr, 'right') : expr;
            if (arrNode && arrNode.type === 'array') {
              this.checkDefinitionArray(arrNode, node, file, source, opts, candidates, isTest);
            } else if (expr.type === 'array') {
              this.checkDefinitionArray(expr, node, file, source, opts, candidates, isTest);
            }
          }
        }
        return;
      }

      // Export declaration might contain register calls
      if (node.type === 'export_statement') {
        const decl = node.namedChild(0);
        if (decl && decl.type === 'expression_statement') {
          const expr = decl.namedChild(0);
          if (expr && expr.type === 'call_expression') {
            this.checkRegisterCall(expr, node, file, source, opts, candidates, isTest);
            this.checkMapSetCall(expr, node, file, source, opts, candidates, isTest);
          }
        }
        return;
      }

      // Visit children for other node types
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) visit(child);
      }
    };

    visit(root);
    return candidates;
  }

  // ---------------------------------------------------------------------------
  // Object literal registry
  // ---------------------------------------------------------------------------

  private checkObjectLiteralRegistry(
    varName: string,
    objNode: SyntaxNode,
    _declNode: SyntaxNode,
    file: FileRecord,
    source: string,
    opts: ResolvedOptions,
    candidates: RegistryCandidate[],
    isTest: boolean,
  ): void {
    const kindClass = this.classifyKind(varName);
    if (opts.kind !== 'all' && kindClass.kind !== opts.kind) return;

    for (let i = 0; i < objNode.namedChildCount; i++) {
      const child = objNode.namedChild(i);
      if (!child) continue;
      if (child.type === 'spread_element') continue;

      // pair node
      if (child.type === 'pair') {
        const key = getChildByField(child, 'key');
        const val = getChildByField(child, 'value');
        if (!key || !val) continue;

        const keyText = this.extractKeyText(key, source);
        const handlerText = getNodeText(val, source);

        if (keyText == null) {
          // Dynamic/computed key
          candidates.push(this.makeCandidate({
            kind: kindClass.kind,
            registryName: varName,
            keyText: getNodeText(key, source),
            handlerText,
            evidence: 'object-literal',
            confidence: 'low',
            range: this.rangeFor(child, file.path),
            isDynamicKey: true,
            isTestOrFixture: isTest,
            note: 'dynamic/computed key; static value unknown',
          }));
          continue;
        }

        // Key/query filter
        if (opts.key && keyText !== opts.key) continue;
        if (opts.query && !keyText.toLowerCase().includes(opts.query.toLowerCase())) continue;

        candidates.push(this.makeCandidate({
          kind: kindClass.kind,
          registryName: varName,
          keyText,
          handlerText,
          evidence: 'object-literal',
          confidence: 'high',
          range: this.rangeFor(child, file.path),
          isTestOrFixture: isTest,
        }));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Map constructor registry: new Map([["key", value], ...])
  // ---------------------------------------------------------------------------

  private checkMapConstructorRegistry(
    varName: string,
    newExpr: SyntaxNode,
    _declNode: SyntaxNode,
    file: FileRecord,
    source: string,
    opts: ResolvedOptions,
    candidates: RegistryCandidate[],
    isTest: boolean,
  ): void {
    const args = getChildByField(newExpr, 'arguments');
    if (!args || args.namedChildCount === 0) return;

    const arr = args.namedChild(0);
    if (!arr || arr.type !== 'array') return;

    const kindClass = this.classifyKind(varName);
    if (opts.kind !== 'all' && kindClass.kind !== opts.kind) return;

    for (let i = 0; i < arr.namedChildCount; i++) {
      const element = arr.namedChild(i);
      if (!element || element.type !== 'array') continue;

      if (element.namedChildCount < 2) continue;
      const keyNode = element.namedChild(0);
      const valNode = element.namedChild(1);
      if (!keyNode || !valNode) continue;

      const keyText = this.extractKeyText(keyNode, source);
      const handlerText = getNodeText(valNode, source);

      if (keyText == null) {
        candidates.push(this.makeCandidate({
          kind: kindClass.kind,
          registryName: varName,
          keyText: getNodeText(keyNode, source),
          handlerText,
          evidence: 'map-constructor',
          confidence: 'low',
          range: this.rangeFor(element, file.path),
          isDynamicKey: true,
          isTestOrFixture: isTest,
          note: 'dynamic key; static value unknown',
        }));
        continue;
      }

      // Key/query filter
      if (opts.key && keyText !== opts.key) continue;
      if (opts.query && !keyText.toLowerCase().includes(opts.query.toLowerCase())) continue;

      candidates.push(this.makeCandidate({
        kind: kindClass.kind,
        registryName: varName,
        keyText,
        handlerText,
        evidence: 'map-constructor',
        confidence: 'high',
        range: this.rangeFor(element, file.path),
        isTestOrFixture: isTest,
      }));
    }
  }

  // ---------------------------------------------------------------------------
  // Map.set() registration
  // ---------------------------------------------------------------------------

  private checkMapSetCall(
    expr: SyntaxNode,
    statementNode: SyntaxNode,
    file: FileRecord,
    source: string,
    opts: ResolvedOptions,
    candidates: RegistryCandidate[],
    isTest: boolean,
  ): void {
    if (expr.type !== 'call_expression') return;
    const fn = getChildByField(expr, 'function');
    if (!fn) return;

    // obj.set(key, value) — fn should be a member_expression ending in .set
    if (fn.type !== 'member_expression') return;
    const prop = getChildByField(fn, 'property') ?? fn.namedChild(1);
    if (!prop || prop.text !== 'set') return;

    const obj = getChildByField(fn, 'object') ?? fn.namedChild(0);
    if (!obj) return;
    const registryName = getNodeText(obj, source);

    const argsNode = getChildByField(expr, 'arguments');
    if (!argsNode || argsNode.namedChildCount < 2) return;

    const keyNode = argsNode.namedChild(0);
    const valNode = argsNode.namedChild(1);
    if (!keyNode || !valNode) return;

    const keyText = this.extractKeyText(keyNode, source);
    const handlerText = getNodeText(valNode, source);

    const kindClass = this.classifyKind(registryName);
    if (opts.kind !== 'all' && kindClass.kind !== opts.kind) return;

    if (keyText == null) {
      candidates.push(this.makeCandidate({
        kind: kindClass.kind,
        registryName,
        keyText: getNodeText(keyNode, source),
        handlerText,
        evidence: 'map-set',
        confidence: 'low',
        range: this.rangeFor(statementNode, file.path),
        isDynamicKey: true,
        isTestOrFixture: isTest,
        note: 'dynamic key; static value unknown',
      }));
      return;
    }

    if (opts.key && keyText !== opts.key) return;
    if (opts.query && !keyText.toLowerCase().includes(opts.query.toLowerCase())) return;

    candidates.push(this.makeCandidate({
      kind: kindClass.kind,
      registryName,
      keyText,
      handlerText,
      evidence: 'map-set',
      confidence: 'high',
      range: this.rangeFor(statementNode, file.path),
      isTestOrFixture: isTest,
    }));
  }

  // ---------------------------------------------------------------------------
  // Register-like calls: register('key', handler), app.get('/path', handler)
  // ---------------------------------------------------------------------------

  private checkRegisterCall(
    expr: SyntaxNode,
    statementNode: SyntaxNode,
    file: FileRecord,
    source: string,
    opts: ResolvedOptions,
    candidates: RegistryCandidate[],
    isTest: boolean,
  ): void {
    if (expr.type !== 'call_expression') return;
    const fn = getChildByField(expr, 'function');
    if (!fn) return;

    let registryName: string | undefined;
    let isRouteMethod = false;

    if (fn.type === 'identifier') {
      // registerProvider('key', handler) — standalone function
      const name = fn.text;
      if (!REGISTER_CALL_PATTERNS.some((p) => p.test(name))) return;
      registryName = name;
    } else if (fn.type === 'member_expression') {
      // app.get('/path', handler), registry.register('key', handler)
      const obj = getChildByField(fn, 'object') ?? fn.namedChild(0);
      const prop = getChildByField(fn, 'property') ?? fn.namedChild(1);
      if (!obj || !prop) return;
      registryName = getNodeText(obj, source) + '.' + prop.text;

      // Check if it's a register/use call or HTTP method
      const methodName = prop.text;
      if (!REGISTER_CALL_PATTERNS.some((p) => p.test(methodName)) && !ROUTE_METHOD_PATTERNS.includes(methodName)) {
        return;
      }
      if (ROUTE_METHOD_PATTERNS.includes(methodName)) {
        isRouteMethod = true;
      }
    } else {
      return;
    }

    const argsNode = getChildByField(expr, 'arguments');
    if (!argsNode || argsNode.namedChildCount < 1) return;

    const keyNode = argsNode.namedChild(0);
    const handlerNode = argsNode.namedChild(1) ?? null;
    if (!keyNode) return;

    const keyText = this.extractKeyText(keyNode, source);
    const handlerText = handlerNode ? getNodeText(handlerNode, source) : undefined;

    const kindClass = isRouteMethod
      ? { kind: 'route' as RegistryKind, registryName }
      : this.classifyKind(registryName);

    if (opts.kind !== 'all' && kindClass.kind !== opts.kind) return;

    if (keyText == null) {
      candidates.push(this.makeCandidate({
        kind: kindClass.kind,
        registryName,
        keyText: getNodeText(keyNode, source),
        handlerText,
        evidence: isRouteMethod ? 'route-node' : 'register-call',
        confidence: 'low',
        range: this.rangeFor(statementNode, file.path),
        isDynamicKey: true,
        isTestOrFixture: isTest,
        routePath: isRouteMethod ? getNodeText(keyNode, source) : undefined,
        note: handlerNode
          ? 'dynamic key; static value unknown'
          : 'register call without handler argument',
      }));
      return;
    }

    if (opts.key && keyText !== opts.key) return;
    if (opts.query && !keyText.toLowerCase().includes(opts.query.toLowerCase())) return;

    candidates.push(this.makeCandidate({
      kind: kindClass.kind,
      registryName,
      keyText,
      handlerText,
      evidence: isRouteMethod ? 'route-node' : 'register-call',
      confidence: handlerNode ? 'high' : 'medium',
      range: this.rangeFor(statementNode, file.path),
      isTestOrFixture: isTest,
      routePath: isRouteMethod ? keyText : undefined,
      note: handlerNode ? undefined : 'register call without handler argument found',
    }));
  }

  // ---------------------------------------------------------------------------
  // Definition array: [{ name: 'foo', handler: handlerFn }, ...]
  // ---------------------------------------------------------------------------

  private checkDefinitionArray(
    arrNode: SyntaxNode,
    statementNode: SyntaxNode,
    file: FileRecord,
    source: string,
    opts: ResolvedOptions,
    candidates: RegistryCandidate[],
    isTest: boolean,
  ): void {
    if (arrNode.type !== 'array') return;

    // Determine kind from context (variable assignment, export, etc.)
    let registryName: string | undefined;

    // Try parent first (for expression_statement → caller context)
    const parent = statementNode.parent;
    if (parent) {
      if (parent.type === 'variable_declaration' || parent.type === 'lexical_declaration') {
        // Find name from variable_declarator
        for (let i = 0; i < parent.namedChildCount; i++) {
          const vd = parent.namedChild(i);
          if (vd && vd.type === 'variable_declarator') {
            const n = getChildByField(vd, 'name');
            if (n) { registryName = getNodeText(n, source); break; }
          }
        }
      } else if (parent.type === 'export_statement') {
        // export default [...]
        registryName = 'exported';
      }
    }

    // Fallback: try the statementNode itself (when called from variable decl handler)
    if (!registryName && (statementNode.type === 'variable_declaration' || statementNode.type === 'lexical_declaration')) {
      for (let i = 0; i < statementNode.namedChildCount; i++) {
        const vd = statementNode.namedChild(i);
        if (vd && vd.type === 'variable_declarator') {
          const n = getChildByField(vd, 'name');
          if (n) { registryName = getNodeText(n, source); break; }
        }
      }
    }

    const kindClass = registryName ? this.classifyKind(registryName) : { kind: 'handler' as RegistryKind };
    if (opts.kind !== 'all' && kindClass.kind !== opts.kind) return;

    for (let i = 0; i < arrNode.namedChildCount; i++) {
      const element = arrNode.namedChild(i);
      if (!element || element.type !== 'object') continue;

      let keyValue: string | undefined;
      let handlerValue: string | undefined;

      for (let j = 0; j < element.namedChildCount; j++) {
        const child = element.namedChild(j);
        if (!child || child.type !== 'pair') continue;

        const key = getChildByField(child, 'key');
        const val = getChildByField(child, 'value');
        if (!key || !val) continue;

        const keyName = key.text.replace(/^['"]|['"]$/g, '');
        if (KEY_FIELD_NAMES.has(keyName)) {
          keyValue = this.extractKeyText(val, source) ?? getNodeText(val, source);
        }
        if (HANDLER_FIELD_NAMES.has(keyName)) {
          handlerValue = getNodeText(val, source);
        }
      }

      if (!keyValue) continue;

      if (opts.key && keyValue !== opts.key) continue;
      if (opts.query && !keyValue.toLowerCase().includes(opts.query.toLowerCase())) continue;

      candidates.push(this.makeCandidate({
        kind: kindClass.kind,
        registryName,
        keyText: keyValue,
        handlerText: handlerValue,
        evidence: 'definition-array',
        confidence: handlerValue ? 'medium' : 'low',
        range: this.rangeFor(element, file.path),
        isTestOrFixture: isTest,
        note: handlerValue
          ? undefined
          : 'definition array entry without recognized handler field (look for execute, run, handler, etc.)',
      }));
    }
  }

  // ===========================================================================
  // Handler resolution
  // ===========================================================================

  private resolveHandlerNodes(candidates: RegistryCandidate[], nodes: Node[]): void {
    const nodesByName = new Map<string, Node[]>();
    for (const n of nodes) {
      const existing = nodesByName.get(n.name) || [];
      existing.push(n);
      nodesByName.set(n.name, existing);
    }

    for (const c of candidates) {
      if (!c.handlerText) {
        c.handlerResolutionStatus = 'not-indexed';
        continue;
      }

      // Extract function/identifier name from handler text
      // e.g., "streamAnthropic" or "() => ..." or "function() { ... }"
      const nameMatch = c.handlerText.match(/^(\w+)/);
      if (!nameMatch) {
        c.handlerResolutionStatus = 'not-indexed';
        continue;
      }

      const handlerName = nameMatch[1]!;
      const matches = nodesByName.get(handlerName);
      if (!matches || matches.length === 0) {
        c.handlerResolutionStatus = 'not-indexed';
        continue;
      }

      if (matches.length === 1) {
        const n = matches[0]!;
        c.handlerNode = toNodeHandle(n);
        c.handlerResolutionStatus = 'resolved';
      } else {
        c.handlerAlternatives = matches.map((n) => toNodeHandle(n));
        c.handlerResolutionStatus = 'ambiguous';
      }
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private extractKeyText(node: SyntaxNode | null, source: string): string | null {
    if (!node) return null;
    if (node.type === 'string') {
      return getNodeText(node, source).replace(/^['"]|['"]$/g, '');
    }
    if (node.type === 'identifier' || node.type === 'property_identifier') {
      return getNodeText(node, source);
    }
    if (node.type === 'number') {
      return getNodeText(node, source);
    }
    if (node.type === 'computed_property_name') {
      const inner = node.namedChild(0);
      if (inner && inner.type === 'string') {
        return getNodeText(inner, source).replace(/^['"]|['"]$/g, '');
      }
    }
    // Dynamic key (variable, expression, template literal)
    return null;
  }

  private classifyKind(name: string | undefined): KindClassification {
    if (!name) return { kind: 'handler' };
    for (const pattern of KIND_HINT_PATTERNS) {
      if (pattern.regex.test(name)) {
        return { kind: pattern.kind, registryName: name };
      }
    }
    return { kind: 'handler', registryName: name };
  }

  private isTestOrFixturePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
      /(^|[\\/])(__tests__|__mocks__|tests?|fixtures?|examples?|e2e|specs?|stories|generated)([\\/]|$)/.test(
        lower,
      ) ||
      /\.(test|spec|fixture|example|e2e|stories)\.(ts|tsx|js|jsx)$/.test(lower) ||
      lower.includes('.generated.')
    );
  }

  private rangeFor(node: SyntaxNode, filePath: string): SourceRange {
    return {
      path: filePath,
      startLine: node.startPosition.row + 1,
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endColumn: node.endPosition.column,
    };
  }

  private makeCandidate(params: {
    kind: RegistryKind;
    registryName?: string;
    keyText: string;
    handlerText?: string;
    evidence: RegistryEvidence;
    confidence: RegistryConfidence;
    range: SourceRange;
    isDynamicKey?: boolean;
    isTestOrFixture?: boolean;
    routePath?: string;
    note?: string;
  }): RegistryCandidate {
    return {
      kind: params.kind,
      registryName: params.registryName,
      keyText: params.keyText,
      handlerText: params.handlerText,
      evidence: params.evidence,
      confidence: params.confidence,
      range: params.range,
      isDynamicKey: params.isDynamicKey,
      isTestOrFixture: params.isTestOrFixture,
      routePath: params.routePath,
      note: params.note,
    };
  }

  private addSkipped(
    collector: CandidateCollector,
    item: { path: string; reason: string; detail?: string },
  ): void {
    collector.skippedFiles.push(item);
    collector.skippedSummary[item.reason] = (collector.skippedSummary[item.reason] ?? 0) + 1;
  }

  // ===========================================================================
  // Filter, sort, deduplicate
  // ===========================================================================

  private filterAndSortCandidates(
    collector: CandidateCollector,
    opts: ResolvedOptions,
  ): void {
    // Deduplicate by range + key + evidence
    const seen = new Set<string>();
    const deduped: RegistryCandidate[] = [];
    for (const c of collector.candidates) {
      const sig = `${c.range.path}:${c.range.startLine}:${c.range.startColumn ?? 0}:${c.keyText ?? ''}:${c.evidence}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      deduped.push(c);
    }
    collector.candidates = deduped;

    // Sort: exact key match first, then high > medium > low confidence,
    // then non-test before test, then by path/line
    collector.candidates.sort((a, b) => {
      // Exact key match priority
      if (opts.key) {
        const aExact = a.keyText === opts.key ? 0 : 1;
        const bExact = b.keyText === opts.key ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
      }

      // Confidence
      const confOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
      const aConf = confOrder[a.confidence] ?? 3;
      const bConf = confOrder[b.confidence] ?? 3;
      if (aConf !== bConf) return aConf - bConf;

      // Non-test before test
      const aTest = a.isTestOrFixture ? 1 : 0;
      const bTest = b.isTestOrFixture ? 1 : 0;
      if (aTest !== bTest) return aTest - bTest;

      // Path
      if (a.range.path !== b.range.path) return a.range.path.localeCompare(b.range.path);

      // Line
      return a.range.startLine - b.range.startLine;
    });
  }

  // ===========================================================================
  // Build result
  // ===========================================================================

  private buildResult(
    collector: CandidateCollector,
    opts: ResolvedOptions,
  ): RegistryCandidatesResult {
    const total = collector.candidates.length;
    const displayCandidates = collector.candidates.slice(0, opts.maxDisplayCandidates);
    const omitted = Math.max(0, total - displayCandidates.length);

    const status = this.determineStatus(collector, total);

    const seenFiles = new Set<string>();
    for (const c of collector.candidates) seenFiles.add(c.range.path);

    const recommendations: string[] = [];

    if (status === 'no-matches') {
      recommendations.push(
        'Try broadening the query or removing the key filter.',
        'Use `codegraph_search` to find handler/registry-related symbols.',
      );
      if (!opts.includeTests) {
        recommendations.push('Retry with includeTests: true if test/fixture examples are useful.');
      }
    }

    if (status === 'partial' && omitted > 0) {
      recommendations.push(
        `Increase maxDisplayCandidates (currently ${opts.maxDisplayCandidates}) to see all ${total} candidates.`,
      );
    }

    if (total > 0) {
      // Recommend follow-up for top resolved candidates
      let recCount = 0;
      for (const c of collector.candidates) {
        if (recCount >= 5) break;
        if (c.handlerNode) {
          const n = c.handlerNode;
          recommendations.push(`codegraph_node({ nodeId: "${n.nodeId}", detail: "structure" })`);
          recCount++;
        } else if (c.handlerText && c.handlerResolutionStatus === 'not-indexed') {
          recommendations.push(
            `codegraph_search({ query: "${c.handlerText}" }) to locate handler implementation.`,
          );
          recCount++;
          break; // Only recommend one search
        }
      }
    }

    return {
      status,
      query: opts.query,
      key: opts.key,
      kind: opts.kind,
      candidates: displayCandidates,
      totalCandidates: total,
      omittedCandidates: omitted,
      searchedFiles: collector.searchedCount,
      parsedFiles: collector.parsedCount,
      skippedSummary: { ...collector.skippedSummary },
      caveats: [CAVEAT],
      recommendations,
    };
  }

  private determineStatus(
    collector: CandidateCollector,
    totalCandidates: number,
  ): RegistryCandidateStatus {
    if (totalCandidates > 0) {
      if (collector.skippedFiles.length > 0) return 'partial';
      return 'available';
    }
    // Only parser-unavailable if there are skipped files AND they're all parser-unavailable,
    // AND there are actually some skipped files (not an empty project).
    if (collector.skippedFiles.length > 0 && collector.skippedFiles.every((s) => s.reason === 'parser-unavailable')) {
      return 'parser-unavailable';
    }
    return 'no-matches';
  }
}
