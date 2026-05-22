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
import type { Edge, Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function hasSqliteBindings(): boolean {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
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

function makeTraceNode(id: string, name: string, startLine: number): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'src/direct.ts',
    language: 'typescript',
    startLine,
    endLine: startLine + 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: Date.now(),
  };
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
