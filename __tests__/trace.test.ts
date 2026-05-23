/**
 * Trace tests for candidate graph paths between exact locators.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { ToolHandler } from '../src/mcp/tools';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { GraphTracer } from '../src/graph/trace';
import type { Edge, EdgeKind, Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function hasSqliteBindings(): boolean {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const HAS_SQLITE = hasSqliteBindings();

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-trace-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeTraceFixture(root: string): void {
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'flow.ts'),
    [
      'export function entry(): void {',
      '  service();',
      '}',
      '',
      'function service(): void {',
      '  repository();',
      '}',
      '',
      'function repository(): void {',
      '  target();',
      '}',
      '',
      'export function target(): string {',
      "  return 'done';",
      '}',
      '',
    ].join('\n')
  );
}

function writeIncomingTraceFixture(root: string): void {
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'incoming-caller.ts'),
    [
      "import { incomingTarget } from './incoming-target';",
      '',
      'export function incomingEntry(): void {',
      '  incomingTarget();',
      '}',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(src, 'incoming-target.ts'),
    [
      'export function incomingTarget(): void {',
      '}',
      '',
      'export function incomingOtherTarget(): void {',
      '}',
      '',
    ].join('\n')
  );
}

function writeDeadEndTraceFixture(root: string): void {
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'dead-end.ts'),
    [
      'export function entry(): void {',
      '  service();',
      '}',
      '',
      'function service(): void {',
      '  // no indexed call to target',
      '}',
      '',
      'export function target(): void {}',
      '',
    ].join('\n')
  );
}

function writePropertyBoundaryFixture(root: string): void {
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'property-boundary.ts'),
    [
      'export function entry(config: { streamFn: () => void }): void {',
      '  config.streamFn();',
      '}',
      '',
      'export function target(): void {}',
      '',
    ].join('\n')
  );
}

function writeResolvedPropertyTraceFixture(root: string): void {
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'provider.ts'),
    [
      'export class Provider {',
      '  streamSimple(): void {}',
      '}',
      '',
      'export function propertyEntry(provider: Provider): void {',
      '  provider.streamSimple();',
      '}',
      '',
    ].join('\n')
  );
}

function makeTraceNode(id: string, name: string, startLine: number, filePath = 'src/direct.ts'): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine,
    endLine: startLine + 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: Date.now(),
  };
}

function insertTraceNodes(queries: QueryBuilder, nodes: Node[]): void {
  for (const node of nodes) queries.insertNode(node);
}

function insertTraceEdge(
  queries: QueryBuilder,
  source: Node,
  target: Node,
  metadata: Record<string, unknown>,
  kind: EdgeKind = 'calls'
): void {
  queries.insertEdge({
    source: source.id,
    target: target.id,
    kind,
    line: source.startLine + 1,
    metadata,
  });
}

function traceNames(pathResult: { steps: Array<{ node: { name: string } }> }): string[] {
  return pathResult.steps.map((step) => step.node.name);
}

describe.skipIf(!HAS_SQLITE)('CodeGraph.trace', () => {
  let root: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    root = tmpRoot();
    writeTraceFixture(root);
    cg = CodeGraph.initSync(root, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    cg?.destroy();
    cleanup(root);
  });

  it('returns a candidate path from entry to target', () => {
    const result = cg.trace({ symbol: 'entry' }, { symbol: 'target' }, { maxDepth: 4 });
    expect(result.status).toBe('resolved');
    expect(result.paths.length).toBeGreaterThanOrEqual(1);

    const names = result.paths[0]!.steps.map((s) => s.node.name);
    expect(names).toEqual(['entry', 'service', 'repository', 'target']);
    expect(result.paths[0]!.steps.every((s) => s.node.nodeId && s.node.path)).toBe(true);
    expect(result.paths[0]!.edges.every((e) => e.kind === 'calls')).toBe(true);
    expect(result.paths[0]!.edges.some((e) => typeof e.line === 'number')).toBe(true);
    expect(result.paths[0]!.edges[0]!.confidence).toEqual(expect.any(Number));
    expect(result.paths[0]!.edges[0]!.resolvedBy).toEqual(expect.any(String));
    expect(result.paths[0]!.edges[0]!.sourceEvidence).toBe('direct-call');
    expect(result.paths[0]!.edges[0]!.referenceName).toBe('service');
    expect(result.boundaries).toEqual([]);
  });

  it('returns gaps and recommendations when maxDepth prevents a complete path', () => {
    const result = cg.trace({ symbol: 'entry' }, { symbol: 'target' }, { maxDepth: 1 });
    expect(result.status).toBe('resolved');
    expect(result.paths).toHaveLength(0);
    expect(result.gaps.join('\n')).toMatch(/No complete path/);
    expect(result.recommendations.join('\n')).toMatch(/maxDepth|explore|node/i);
    expect(result.boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'max-depth',
        node: expect.objectContaining({ name: 'service' }),
        enclosingNode: expect.objectContaining({ name: 'entry' }),
        edge: expect.objectContaining({ kind: 'calls', line: 2 }),
        reason: expect.stringMatching(/maxDepth=1|maximum depth/i),
      }),
    ]));
  });

  it('accepts fileLine for the entry locator', () => {
    const result = cg.trace({ fileLine: 'src/flow.ts:2' }, { symbol: 'target' }, { maxDepth: 4 });
    expect(result.status).toBe('resolved');
    expect(result.from?.name).toBe('entry');
    expect(result.paths[0]?.steps.map((s) => s.node.name)).toContain('target');
  });

  it('returns empty boundaries when the entry locator cannot be resolved', () => {
    const result = cg.trace({ symbol: 'missingEntry' }, { symbol: 'target' }, { maxDepth: 4 });
    expect(result.status).toBe('not_found');
    expect(result.paths).toHaveLength(0);
    expect(result.boundaries).toEqual([]);
  });

  it('returns empty boundaries when no target candidates are found', () => {
    const result = cg.trace({ symbol: 'entry' }, { symbol: 'missingTarget' }, { maxDepth: 4 });
    expect(result.status).toBe('resolved');
    expect(result.targetCandidates).toEqual([]);
    expect(result.paths).toHaveLength(0);
    expect(result.boundaries).toEqual([]);
  });

  it('applies include/exclude path filters', () => {
    const included = cg.trace(
      { symbol: 'entry' },
      { symbol: 'target' },
      { maxDepth: 4, includePaths: ['src'] }
    );
    expect(included.paths.length).toBeGreaterThan(0);

    const excluded = cg.trace(
      { symbol: 'entry' },
      { symbol: 'target' },
      { maxDepth: 4, excludePaths: ['src/flow.ts'] }
    );
    expect(excluded.paths).toHaveLength(0);
    expect(excluded.gaps.join('\n')).toMatch(/No target candidates|No complete path/);
  });
});

describe.skipIf(!HAS_SQLITE)('CodeGraph.trace boundaries', () => {
  let root: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    root = tmpRoot();
    writeDeadEndTraceFixture(root);
    cg = CodeGraph.initSync(root, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    cg?.destroy();
    cleanup(root);
  });

  it('returns dead-end boundaries when no indexed edge continues toward the target', () => {
    const result = cg.trace({ symbol: 'entry' }, { symbol: 'target' }, { maxDepth: 4 });
    expect(result.status).toBe('resolved');
    expect(result.paths).toHaveLength(0);
    expect(result.boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'dead-end',
        node: expect.objectContaining({ name: 'service' }),
        enclosingNode: expect.objectContaining({ name: 'entry' }),
        reason: expect.stringMatching(/No traversable indexed edge|dead.?end|not recorded/i),
      }),
    ]));
  });
});

describe.skipIf(!HAS_SQLITE)('GraphTracer edge evidence boundaries', () => {
  function traceSingleEdge(metadata?: Record<string, unknown>) {
    const root = tmpRoot();
    const db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    const queries = new QueryBuilder(db.getDb());
    const entry = makeTraceNode('entry', 'entry', 1);
    const target = makeTraceNode('target', 'target', 5);
    queries.insertNode(entry);
    queries.insertNode(target);
    queries.insertEdge({
      source: entry.id,
      target: target.id,
      kind: 'calls',
      line: 3,
      metadata,
    });

    const result = new GraphTracer(queries).trace(entry, [target], { maxDepth: 1, edgeKinds: ['calls'] });
    db.close();
    cleanup(root);
    return result;
  }

  it('classifies low-confidence path edges as low evidence', () => {
    const result = traceSingleEdge({ confidence: 0.7, resolvedBy: 'exact-match' });
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'low-evidence-edge',
        node: expect.objectContaining({ name: 'target' }),
        enclosingNode: expect.objectContaining({ name: 'entry' }),
        edge: expect.objectContaining({ confidence: 0.7 }),
      }),
    ]));
  });

  it('classifies fuzzy path edges as low evidence without requiring low confidence', () => {
    const result = traceSingleEdge({ confidence: 0.95, resolvedBy: 'fuzzy' });
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'low-evidence-edge',
        edge: expect.objectContaining({ confidence: 0.95, resolvedBy: 'fuzzy' }),
        reason: expect.stringMatching(/low-evidence static resolution.*fuzzy/i),
      }),
    ]));
  });

  it('classifies framework resolver path edges as framework boundaries', () => {
    const result = traceSingleEdge({ confidence: 0.85, resolvedBy: 'framework' });
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'framework-edge',
        reason: expect.stringMatching(/framework/i),
      }),
    ]));
  });

  it('classifies path edges without resolver metadata as metadata-not-recorded', () => {
    const result = traceSingleEdge();
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'metadata-not-recorded',
        reason: expect.stringMatching(/not recorded|metadata/i),
      }),
    ]));
  });

  it('does not mix side-branch frontier boundaries into a complete trace result', () => {
    const root = tmpRoot();
    const db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    const queries = new QueryBuilder(db.getDb());
    const entry = makeTraceNode('entry', 'entry', 1);
    const service = makeTraceNode('service', 'service', 5);
    const target = makeTraceNode('target', 'target', 9);
    queries.insertNode(entry);
    queries.insertNode(service);
    queries.insertNode(target);
    queries.insertEdge({
      source: entry.id,
      target: target.id,
      kind: 'calls',
      line: 2,
      metadata: { confidence: 0.95, resolvedBy: 'exact-match' },
    });
    queries.insertEdge({
      source: entry.id,
      target: service.id,
      kind: 'calls',
      line: 3,
      metadata: { confidence: 0.95, resolvedBy: 'exact-match' },
    });

    const result = new GraphTracer(queries).trace(entry, [target], { maxDepth: 2, edgeKinds: ['calls'] });
    db.close();
    cleanup(root);

    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.boundaries).toEqual([]);
  });
});

describe.skipIf(!HAS_SQLITE)('GraphTracer P1b ranking', () => {
  function withManualTrace<T>(run: (queries: QueryBuilder) => T): T {
    const root = tmpRoot();
    const db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    const queries = new QueryBuilder(db.getDb());
    try {
      return run(queries);
    } finally {
      db.close();
      cleanup(root);
    }
  }

  it('ranks high-confidence direct paths above fuzzy low-confidence paths', () => withManualTrace((queries) => {
    const entry = makeTraceNode('entry', 'entry', 1);
    const normal = makeTraceNode('normal', 'normal', 5);
    const fuzzy = makeTraceNode('fuzzy', 'fuzzy', 9);
    const target = makeTraceNode('target', 'target', 13);
    insertTraceNodes(queries, [entry, normal, fuzzy, target]);
    insertTraceEdge(queries, entry, fuzzy, { sourceEvidence: 'direct-call', confidence: 0.5, resolvedBy: 'fuzzy' });
    insertTraceEdge(queries, fuzzy, target, { sourceEvidence: 'direct-call', confidence: 0.5, resolvedBy: 'fuzzy' });
    insertTraceEdge(queries, entry, normal, { sourceEvidence: 'direct-call', confidence: 0.9, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, normal, target, { sourceEvidence: 'direct-call', confidence: 0.9, resolvedBy: 'exact-match' });

    const result = new GraphTracer(queries).trace(entry, [target], { maxDepth: 2, maxPaths: 2, edgeKinds: ['calls'] });

    expect(traceNames(result.paths[0]!)).toEqual(['entry', 'normal', 'target']);
    expect(result.paths[0]!.ranking.signals.averageConfidence).toBeGreaterThan(result.paths[1]!.ranking.signals.averageConfidence!);
    expect(result.paths[1]!.ranking.penalties.join(' ')).toMatch(/low evidence|fuzzy/i);
    expect(result.paths[0]!.confidence).not.toBe(result.paths[0]!.ranking.score);
  }));

  it('labels optional keyword paths and ranks the normal path first', () => withManualTrace((queries) => {
    const entry = makeTraceNode('entry', 'entry', 1);
    const check = makeTraceNode('check', '_checkCompaction', 5);
    const compact = makeTraceNode('compact', 'compact', 9);
    const normal = makeTraceNode('normal', 'runAgentLoop', 13);
    const target = makeTraceNode('target', 'target', 17);
    insertTraceNodes(queries, [entry, check, compact, normal, target]);
    insertTraceEdge(queries, entry, check, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, check, compact, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, compact, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, entry, normal, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, normal, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });

    const result = new GraphTracer(queries).trace(entry, [target], { maxDepth: 3, maxPaths: 2, edgeKinds: ['calls'] });

    expect(traceNames(result.paths[0]!)).toEqual(['entry', 'runAgentLoop', 'target']);
    const optionalPath = result.paths.find((pathResult) => traceNames(pathResult).includes('compact'))!;
    expect(optionalPath.ranking.label).toBe('optional-branch');
    expect(optionalPath.ranking.penalties.join(' ')).toMatch(/optional-branch keyword penalty.*compact/i);
    expect(optionalPath.ranking.reasons.join(' ')).toMatch(/_checkCompaction|compact/);
  }));

  it('applies test fixture penalties only when trace locators are production paths', () => withManualTrace((queries) => {
    const entry = makeTraceNode('entry', 'entry', 1, 'src/entry.ts');
    const prod = makeTraceNode('prod', 'prodHelper', 5, 'src/flow.ts');
    const test = makeTraceNode('test', 'testHelper', 9, 'src/__tests__/flow.test.ts');
    const target = makeTraceNode('target', 'target', 13, 'src/target.ts');
    insertTraceNodes(queries, [entry, prod, test, target]);
    insertTraceEdge(queries, entry, test, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, test, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, entry, prod, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, prod, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });

    const productionTrace = new GraphTracer(queries).trace(entry, [target], { maxDepth: 2, maxPaths: 2, edgeKinds: ['calls'] });
    expect(traceNames(productionTrace.paths[0]!)).toEqual(['entry', 'prodHelper', 'target']);
    const testPath = productionTrace.paths.find((pathResult) => traceNames(pathResult).includes('testHelper'))!;
    expect(testPath.ranking.penalties.join(' ')).toMatch(/test\/fixture\/example path penalty/);

    const testEntry = makeTraceNode('test-entry', 'testEntry', 21, 'src/__tests__/entry.test.ts');
    const testTarget = makeTraceNode('test-target', 'testTarget', 25, 'src/__tests__/target.test.ts');
    const testHelper = makeTraceNode('test-helper', 'testOnlyHelper', 29, 'src/__tests__/helper.test.ts');
    insertTraceNodes(queries, [testEntry, testTarget, testHelper]);
    insertTraceEdge(queries, testEntry, testHelper, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, testHelper, testTarget, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });

    const testTrace = new GraphTracer(queries).trace(testEntry, [testTarget], { maxDepth: 2, maxPaths: 1, edgeKinds: ['calls'] });
    expect(testTrace.paths[0]!.ranking.signals.testOrFixtureNodeCount).toBeGreaterThan(0);
    expect(testTrace.paths[0]!.ranking.penalties.join(' ')).not.toMatch(/test\/fixture\/example path penalty/);
    expect(testTrace.paths[0]!.ranking.reasons.join(' ')).toMatch(/allowed by trace locator/);
  }));

  it('over-collects paths so maxPaths=1 still returns the better later candidate', () => withManualTrace((queries) => {
    const entry = makeTraceNode('entry', 'entry', 1);
    const fallback = makeTraceNode('fallback', 'fallbackHandler', 5);
    const normal = makeTraceNode('normal', 'normalHandler', 9);
    const target = makeTraceNode('target', 'target', 13);
    insertTraceNodes(queries, [entry, fallback, normal, target]);
    insertTraceEdge(queries, entry, fallback, { sourceEvidence: 'direct-call', confidence: 0.4, resolvedBy: 'fuzzy' });
    insertTraceEdge(queries, fallback, target, { sourceEvidence: 'direct-call', confidence: 0.4, resolvedBy: 'fuzzy' });
    insertTraceEdge(queries, entry, normal, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, normal, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });

    const result = new GraphTracer(queries).trace(entry, [target], { maxDepth: 2, maxPaths: 1, edgeKinds: ['calls'] });

    expect(result.paths).toHaveLength(1);
    expect(traceNames(result.paths[0]!)).toEqual(['entry', 'normalHandler', 'target']);
    expect(result.paths[0]!.ranking.label).toBe('higher-ranked-static-candidate');
  }));

  it('continues past a low-quality target flood and keeps the best complete path', () => withManualTrace((queries) => {
    const entry = makeTraceNode('entry', 'entry', 1);
    const low = makeTraceNode('low', 'lowFloodPath', 5);
    const high = makeTraceNode('high', 'highConfidencePath', 9);
    const shared = makeTraceNode('shared', 'shared', 13);
    const targets = Array.from({ length: 12 }, (_, index) => makeTraceNode(`target${index}`, `target${index}`, 20 + index));
    insertTraceNodes(queries, [entry, low, high, shared, ...targets]);
    insertTraceEdge(queries, entry, low, { sourceEvidence: 'direct-call', confidence: 0.4, resolvedBy: 'fuzzy' });
    insertTraceEdge(queries, low, shared, { sourceEvidence: 'direct-call', confidence: 0.4, resolvedBy: 'fuzzy' });
    insertTraceEdge(queries, entry, high, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, high, shared, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    for (const target of targets) {
      insertTraceEdge(queries, shared, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    }

    const result = new GraphTracer(queries).trace(entry, targets, { maxDepth: 3, maxPaths: 1, edgeKinds: ['calls'] });

    expect(result.paths).toHaveLength(1);
    expect(traceNames(result.paths[0]!)).toContain('highConfidencePath');
    expect(traceNames(result.paths[0]!)).not.toContain('lowFloodPath');
    expect(result.paths[0]!.ranking.signals.averageConfidence).toBeGreaterThan(0.9);
  }));

  it('does not expand queued states after per-node top-K retention evicts them', () => withManualTrace((queries) => {
    const entry = makeTraceNode('entry', 'entry', 1);
    const low1 = makeTraceNode('low1', 'low1', 5);
    const low2 = makeTraceNode('low2', 'low2', 9);
    const low3 = makeTraceNode('low3', 'low3', 13);
    const high = makeTraceNode('high', 'highConfidenceDetour', 17);
    const shared = makeTraceNode('shared', 'shared', 21);
    const target = makeTraceNode('target', 'target', 25);
    insertTraceNodes(queries, [entry, low1, low2, low3, high, shared, target]);
    for (const low of [low1, low2, low3]) {
      insertTraceEdge(queries, entry, low, { sourceEvidence: 'direct-call', confidence: 0.4, resolvedBy: 'fuzzy' });
      insertTraceEdge(queries, low, shared, { sourceEvidence: 'direct-call', confidence: 0.4, resolvedBy: 'fuzzy' });
    }
    insertTraceEdge(queries, entry, high, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, high, shared, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, shared, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });

    const result = new GraphTracer(queries).trace(entry, [target], { maxDepth: 3, maxPaths: 10, edgeKinds: ['calls'] });
    const namesByPath = result.paths.map(traceNames);

    expect(namesByPath.some((names) => names.includes('highConfidenceDetour'))).toBe(true);
    expect(namesByPath.some((names) => names.includes('low3'))).toBe(false);
  }));

  it('keeps stronger longer states to the same node instead of pruning by best depth', () => withManualTrace((queries) => {
    const entry = makeTraceNode('entry', 'entry', 1);
    const detour = makeTraceNode('detour', 'highConfidenceDetour', 5);
    const shared = makeTraceNode('shared', 'shared', 9);
    const target = makeTraceNode('target', 'target', 13);
    insertTraceNodes(queries, [entry, detour, shared, target]);
    insertTraceEdge(queries, entry, shared, { sourceEvidence: 'direct-call', confidence: 0.3, resolvedBy: 'fuzzy' });
    insertTraceEdge(queries, entry, detour, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, detour, shared, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, shared, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });

    const result = new GraphTracer(queries).trace(entry, [target], { maxDepth: 3, maxPaths: 1, edgeKinds: ['calls'] });

    expect(result.paths).toHaveLength(1);
    expect(traceNames(result.paths[0]!)).toEqual(['entry', 'highConfidenceDetour', 'shared', 'target']);
    expect(result.paths[0]!.ranking.signals.averageConfidence).toBeGreaterThan(0.9);
  }));

  it('keeps distinct edge evidence for the same node path and ranks the stronger edge', () => withManualTrace((queries) => {
    const entry = makeTraceNode('entry', 'entry', 1);
    const shared = makeTraceNode('shared', 'shared', 5);
    const target = makeTraceNode('target', 'target', 9);
    insertTraceNodes(queries, [entry, shared, target]);
    insertTraceEdge(queries, entry, shared, { sourceEvidence: 'direct-call', confidence: 0.3, resolvedBy: 'fuzzy', referenceName: 'shared' });
    insertTraceEdge(queries, entry, shared, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match', referenceName: 'shared' });
    insertTraceEdge(queries, shared, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match', referenceName: 'target' });

    const result = new GraphTracer(queries).trace(entry, [target], { maxDepth: 2, maxPaths: 1, edgeKinds: ['calls'] });

    expect(result.paths).toHaveLength(1);
    expect(traceNames(result.paths[0]!)).toEqual(['entry', 'shared', 'target']);
    expect(result.paths[0]!.edges[0]!.confidence).toBe(0.95);
    expect(result.paths[0]!.edges[0]!.resolvedBy).toBe('exact-match');
    expect(result.paths[0]!.ranking.signals.averageConfidence).toBeGreaterThan(0.9);
  }));

  it('reports visited-cap caveats even when ranked paths were found', () => withManualTrace((queries) => {
    const entry = makeTraceNode('entry', 'entry', 1);
    const target = makeTraceNode('target', 'target', 5);
    const branches = Array.from({ length: 1050 }, (_, index) => makeTraceNode(`branch${index}`, `branch${index}`, 10 + index));
    insertTraceNodes(queries, [entry, target, ...branches]);
    insertTraceEdge(queries, entry, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    for (const branch of branches) {
      insertTraceEdge(queries, entry, branch, { sourceEvidence: 'direct-call', confidence: 0.9, resolvedBy: 'exact-match' });
    }

    const result = new GraphTracer(queries).trace(entry, [target], { maxDepth: 1, maxPaths: 1, edgeKinds: ['calls'] });

    expect(result.paths).toHaveLength(1);
    expect(result.gaps.join('\n')).toMatch(/visited node cap.*not exhaustive/i);
  }));

  it('computes direct-call ratio from sourceEvidence rather than edge kind', () => withManualTrace((queries) => {
    const entry = makeTraceNode('entry', 'entry', 1);
    const direct = makeTraceNode('direct', 'directHelper', 5);
    const property = makeTraceNode('property', 'propertyHelper', 9);
    const target = makeTraceNode('target', 'target', 13);
    insertTraceNodes(queries, [entry, direct, property, target]);
    insertTraceEdge(queries, entry, property, { sourceEvidence: 'property-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, property, target, { sourceEvidence: 'property-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, entry, direct, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });
    insertTraceEdge(queries, direct, target, { sourceEvidence: 'direct-call', confidence: 0.95, resolvedBy: 'exact-match' });

    const result = new GraphTracer(queries).trace(entry, [target], { maxDepth: 2, maxPaths: 2, edgeKinds: ['calls'] });

    expect(traceNames(result.paths[0]!)).toEqual(['entry', 'directHelper', 'target']);
    const propertyPath = result.paths.find((pathResult) => traceNames(pathResult).includes('propertyHelper'))!;
    expect(result.paths[0]!.ranking.signals.directCallRatio).toBe(1);
    expect(propertyPath.ranking.signals.directCallCount).toBe(0);
    expect(propertyPath.ranking.signals.propertyCallCount).toBe(2);
  }));
});

describe.skipIf(!HAS_SQLITE)('CodeGraph.trace ambiguity', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    writeTraceFixture(root);
    fs.writeFileSync(path.join(root, 'src', 'other.ts'), 'export function entry(): void {}\n');
    cg = CodeGraph.initSync(root, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    cleanup(root);
  });

  it('does not silently choose an ambiguous from symbol', () => {
    const result = cg.trace({ symbol: 'entry' }, { symbol: 'target' }, { maxDepth: 4 });
    expect(result.status).toBe('ambiguous');
    expect(result.paths).toHaveLength(0);
    expect(result.fromResolution.alternatives?.length).toBeGreaterThanOrEqual(2);
    expect(result.recommendations.join('\n')).toContain('nodeId=');
  });

  it('groups ambiguous symbol handles by file in MCP output', async () => {
    const result = await handler.execute('codegraph_node', { symbol: 'entry' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/symbols named "entry"/);
    expect(text).toContain('> src/flow.ts:');
    expect(text).toContain('> src/other.ts:');
    expect(text).toContain('nodeId=');
    expect(text).toContain('qualifiedName=');
    expect(text).toContain('range=');
  });
});

describe.skipIf(!HAS_SQLITE)('MCP codegraph_trace', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    writeTraceFixture(root);
    writeIncomingTraceFixture(root);
    cg = CodeGraph.initSync(root, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    cleanup(root);
  });

  it('formats path-shaped trace results with handles and recommendations', async () => {
    const result = await handler.execute('codegraph_trace', {
      from: 'entry',
      to: 'target',
      maxDepth: 4,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('## Trace');
    expect(text).toContain('Path 1');
    expect(text).toContain('static score');
    expect(text).toContain('Reason:');
    expect(text).toContain('Caveat: Static ranking only, not runtime main-path proof.');
    expect(text).toContain('entry');
    expect(text).toContain('service');
    expect(text).toContain('repository');
    expect(text).toContain('target');
    expect(text).toContain('nodeId=');
    expect(text).toContain('range=src/flow.ts:');
    expect(text).toContain('edgeKind=calls');
    expect(text).toContain('callsite=src/flow.ts:');
    expect(text).toContain('provenance=unknown');
    expect(text).toContain('confidence=');
    expect(text).not.toContain('confidence=not-recorded');
    expect(text).toContain('resolvedBy=exact-match');
    expect(text).toContain('evidence=direct-call');
    expect(text).toContain('reference=service');
    expect(text).not.toContain('edgeKind=calls evidence=not-recorded');
    expect(text).toContain('Static graph candidate only');
    expect(text).toMatch(/Recommended next/i);
    expect(text).toContain('codegraph_node({ nodeId:');
    expect(text).toContain('read src/flow.ts:');
    expect(text).toContain('codegraph_explore query "entry service repository target"');
  });

  it('formats incomplete traces with boundary handles and exact next checks', async () => {
    const result = await handler.execute('codegraph_trace', {
      from: 'entry',
      to: 'target',
      maxDepth: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('No complete path found.');
    expect(text).toMatch(/Boundaries|low-evidence/i);
    expect(text).toContain('type=max-depth');
    expect(text).toContain('service');
    expect(text).toContain('enclosing=entry');
    expect(text).toContain('callsite=src/flow.ts:2');
    expect(text).toContain('codegraph_node({ nodeId:');
    expect(text).toContain('codegraph_callees({ nodeId:');
    expect(text).toContain('codegraph_callers({ nodeId:');
    expect(text).toContain('read src/flow.ts:');
  });

  it('formats callers and callees with the same recorded edge evidence', async () => {
    const callees = await handler.execute('codegraph_callees', { symbol: 'entry' });
    expect(callees.isError).toBeFalsy();
    expect(callees.content[0].text).toContain('evidence=direct-call');
    expect(callees.content[0].text).toContain('reference=service');

    const callers = await handler.execute('codegraph_callers', { symbol: 'service' });
    expect(callers.isError).toBeFalsy();
    expect(callers.content[0].text).toContain('evidence=direct-call');
    expect(callers.content[0].text).toContain('reference=service');
  });

  it('formats incoming and bidirectional trace callsites with the edge source file', async () => {
    for (const direction of ['incoming', 'both'] as const) {
      const result = await handler.execute('codegraph_trace', {
        from: 'incomingTarget',
        to: 'incomingEntry',
        direction,
        maxDepth: 2,
      });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain('Path 1');
      expect(text).toContain('callsite=src/incoming-caller.ts:4');
      expect(text).not.toContain('callsite=src/incoming-target.ts:4');
    }
  });

  it('formats incoming and bidirectional boundary callsites with the edge source file', async () => {
    for (const direction of ['incoming', 'both'] as const) {
      const result = await handler.execute('codegraph_trace', {
        from: 'incomingTarget',
        to: 'incomingOtherTarget',
        direction,
        maxDepth: 1,
      });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain('No complete path found.');
      expect(text).toContain('type=max-depth');
      expect(text).toContain('enclosing=incomingEntry');
      expect(text).toContain('callsite=src/incoming-caller.ts:4');
      expect(text).not.toContain('callsite=src/incoming-target.ts:4');
    }
  });

  it('accepts fromNodeId and scopePath inputs', async () => {
    const entry = cg.getNodesByKind('function').find((n) => n.name === 'entry')!;
    const result = await handler.execute('codegraph_trace', {
      fromNodeId: entry.id,
      to: 'target',
      scopePath: 'src',
      maxDepth: 4,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Path 1');
  });

  it('formats metadata-missing path edges without guessing dynamic binding types', async () => {
    const result = await handler.execute('codegraph_trace', {
      fromNodeId: 'file:src/flow.ts',
      to: 'entry',
      edgeKinds: ['contains'],
      maxDepth: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Path 1');
    expect(text).toContain('confidence=not-recorded');
    expect(text).toContain('resolvedBy=not-recorded');
    expect(text).toContain('evidence=not-recorded');
    expect(text).toContain('type=metadata-not-recorded');
    expect(text).not.toContain('callback-property-call');
    expect(text).not.toContain('type=registry');
    expect(text).not.toContain('registry-candidate');
    expect(text).not.toContain('Possible binding sites');
  });
});

describe.skipIf(!HAS_SQLITE)('MCP edge evidence output', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    writeResolvedPropertyTraceFixture(root);
    cg = CodeGraph.initSync(root, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    cleanup(root);
  });

  it('formats recorded property-call evidence with receiver and property text', async () => {
    const result = await handler.execute('codegraph_trace', {
      from: 'propertyEntry',
      to: 'streamSimple',
      maxDepth: 2,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('evidence=property-call');
    expect(text).toContain('reference=provider.streamSimple');
    expect(text).toContain('receiver=provider');
    expect(text).toContain('property=streamSimple');
    expect(text).not.toContain('edgeKind=calls evidence=not-recorded');
  });
});

describe('MCP edge evidence fallbacks', () => {
  type EdgeFormatter = { formatEdgeEvidence(edge: Edge): string };

  function format(edge: Edge): string {
    const handler = new ToolHandler(null) as unknown as EdgeFormatter;
    return handler.formatEdgeEvidence(edge);
  }

  it('falls back to name-match when source evidence is missing but resolver metadata exists', () => {
    const text = format({
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { resolvedBy: 'exact-match', referenceName: 'service' },
    });
    expect(text).toContain('evidence=name-match');
    expect(text).toContain('reference=service');
  });

  it('treats explicit not-recorded or invalid source evidence as missing for resolver fallback', () => {
    const explicit = format({
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { sourceEvidence: 'not-recorded', resolvedBy: 'exact-match' },
    });
    expect(explicit).toContain('evidence=name-match');

    const invalid = format({
      source: 'a',
      target: 'b',
      kind: 'calls',
      metadata: { sourceEvidence: 'made-up', resolvedBy: 'exact-match' },
    });
    expect(invalid).toContain('evidence=name-match');
  });

  it('uses fuzzy and framework resolver evidence when source shape is absent', () => {
    expect(format({ source: 'a', target: 'b', kind: 'calls', metadata: { resolvedBy: 'fuzzy' } })).toContain('evidence=fuzzy');
    expect(format({ source: 'a', target: 'b', kind: 'calls', metadata: { resolvedBy: 'framework' } })).toContain('evidence=framework');
  });

  it('keeps metadata-missing edges at not-recorded', () => {
    const text = format({ source: 'a', target: 'b', kind: 'contains' });
    expect(text).toContain('evidence=not-recorded');
    expect(text).toContain('confidence=not-recorded');
    expect(text).toContain('resolvedBy=not-recorded');
  });
});

describe.skipIf(!HAS_SQLITE)('MCP codegraph_trace conservative dynamic boundary output', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    writePropertyBoundaryFixture(root);
    cg = CodeGraph.initSync(root, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    cleanup(root);
  });

  it('does not guess callback/property/registry binding for unresolved property calls', async () => {
    const result = await handler.execute('codegraph_trace', {
      from: 'entry',
      to: 'target',
      maxDepth: 4,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('No complete path found.');
    expect(text).toMatch(/dead-end|not recorded|unclassified/i);
    expect(text).toContain('read src/property-boundary.ts:');
    expect(text).not.toContain('callback-property-call');
    expect(text).not.toContain('property-call');
    expect(text).not.toContain('type=registry');
    expect(text).not.toContain('registry-candidate');
    expect(text).not.toContain('Possible binding sites');
  });
});
