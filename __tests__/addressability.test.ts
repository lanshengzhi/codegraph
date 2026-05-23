/**
 * Addressability tests for reusable node handles and exact locators.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { ToolHandler } from '../src/mcp/tools';
import { formatNodeHandle, parseFileLine, toNodeHandle } from '../src/addressability/format';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-addressability-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function sampleNode(overrides: Partial<Node> = {}): Node {
  return {
    id: 'node-1',
    kind: 'function',
    name: 'run',
    qualifiedName: 'src/service.ts::run',
    filePath: 'src/service.ts',
    language: 'typescript',
    startLine: 7,
    endLine: 9,
    startColumn: 0,
    endColumn: 1,
    signature: '(): string',
    updatedAt: 1,
    ...overrides,
  };
}

function writeAddressabilityFixture(root: string): void {
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'service.ts'),
    [
      'export class Service {',
      '  run(): string {',
      '    return helper();',
      '  }',
      '}',
      '',
      'export function run(): string {',
      "  return 'top';",
      '}',
      '',
      'function helper(): string {',
      "  return 'ok';",
      '}',
      '',
    ].join('\n')
  );
}

describe('node handle formatting', () => {
  it('converts nodes into compact reusable handles', () => {
    const handle = toNodeHandle(sampleNode());
    expect(handle).toEqual({
      nodeId: 'node-1',
      name: 'run',
      kind: 'function',
      qualifiedName: 'src/service.ts::run',
      path: 'src/service.ts',
      startLine: 7,
      endLine: 9,
      signature: '(): string',
    });
  });

  it('formats handles with copyable nodeId, qualifiedName, and range fields', () => {
    const formatted = formatNodeHandle(sampleNode());
    expect(formatted).toContain('nodeId=node-1');
    expect(formatted).toContain('qualifiedName=src/service.ts::run');
    expect(formatted).toContain('range=src/service.ts:7-9');
    expect(formatted).toContain('signature=(): string');
  });

  it('parses file:line strings and ignores an optional column', () => {
    expect(parseFileLine('src/a.ts:42')).toEqual({ path: 'src/a.ts', line: 42 });
    expect(parseFileLine('src/a.ts:42:9')).toEqual({ path: 'src/a.ts', line: 42, column: 9 });
    expect(parseFileLine('src/a.ts:not-a-line')).toBeNull();
  });
});

describe.skipIf(!HAS_SQLITE)('CodeGraph.resolveNodeLocator', () => {
  let root: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    root = tmpRoot();
    writeAddressabilityFixture(root);
    cg = CodeGraph.initSync(root, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    cg?.destroy();
    cleanup(root);
  });

  it('resolves nodeId and qualifiedName exactly', () => {
    const method = cg.getNodesByKind('method').find((n) => n.name === 'run')!;

    const byId = cg.resolveNodeLocator({ nodeId: method.id });
    expect(byId.status).toBe('resolved');
    expect(byId.node?.id).toBe(method.id);

    const byQualifiedName = cg.resolveNodeLocator({ qualifiedName: method.qualifiedName });
    expect(byQualifiedName.status).toBe('resolved');
    expect(byQualifiedName.node?.id).toBe(method.id);
  });

  it('resolves path + line and fileLine to the innermost containing symbol', () => {
    const byPathLine = cg.resolveNodeLocator({ path: 'src/service.ts', line: 3 });
    expect(byPathLine.status).toBe('resolved');
    expect(byPathLine.node?.kind).toBe('method');
    expect(byPathLine.node?.qualifiedName).toContain('Service');

    const byFileLine = cg.resolveNodeLocator({ fileLine: 'src/service.ts:3:12' });
    expect(byFileLine.status).toBe('resolved');
    expect(byFileLine.node?.id).toBe(byPathLine.node?.id);
  });

  it('reports ambiguity for same-name symbols and includes alternatives', () => {
    const symbolOnly = cg.resolveNodeLocator({ symbol: 'run' });
    expect(symbolOnly.status).toBe('ambiguous');
    expect(symbolOnly.alternatives?.map((n) => n.kind).sort()).toEqual(['function', 'method']);

    const symbolWithPath = cg.resolveNodeLocator({ symbol: 'run', path: 'src/service.ts' });
    expect(symbolWithPath.status).toBe('ambiguous');
    expect(symbolWithPath.alternatives?.length).toBeGreaterThanOrEqual(2);
  });

  it('returns not_found with nearby alternatives when a line is outside any symbol', () => {
    const result = cg.resolveNodeLocator({ path: 'src/service.ts', line: 6 });
    expect(result.status).toBe('not_found');
    expect(result.alternatives?.some((n) => n.name === 'run')).toBe(true);
    expect(result.message).toMatch(/No symbol covers/);
  });
});

describe.skipIf(!HAS_SQLITE)('MCP addressability', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    writeAddressabilityFixture(root);
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

  it('includes exact handles in search and node detail output', async () => {
    const search = await handler.execute('codegraph_search', { query: 'run' });
    const searchText = search.content[0].text;
    expect(searchText).toContain('nodeId=');
    expect(searchText).toContain('qualifiedName=');
    expect(searchText).toContain('range=src/service.ts:');

    const node = await handler.execute('codegraph_node', { symbol: 'run' });
    const nodeText = node.content[0].text;
    expect(nodeText).toContain('nodeId=');
    expect(nodeText).toContain('qualifiedName=');
    expect(nodeText).toContain('Range: src/service.ts:');
    expect(nodeText).toMatch(/Ambiguous|symbols named "run"/);
  });

  it('accepts nodeId and fileLine locators for codegraph_node', async () => {
    const method = cg.getNodesByKind('method').find((n) => n.name === 'run')!;

    const byId = await handler.execute('codegraph_node', { nodeId: method.id });
    expect(byId.isError).toBeFalsy();
    expect(byId.content[0].text).toContain('## run (method)');
    expect(byId.content[0].text).toContain(`nodeId=${method.id}`);

    const byFileLine = await handler.execute('codegraph_node', { fileLine: 'src/service.ts:3' });
    expect(byFileLine.isError).toBeFalsy();
    expect(byFileLine.content[0].text).toContain('## run (method)');
  });

  it('accepts exact locators for callers/callees/impact without symbol-only aggregation', async () => {
    const helper = cg.getNodesByKind('function').find((n) => n.name === 'helper')!;
    const method = cg.getNodesByKind('method').find((n) => n.name === 'run')!;

    const callers = await handler.execute('codegraph_callers', { nodeId: helper.id });
    expect(callers.isError).toBeFalsy();
    expect(callers.content[0].text).toContain('run (method)');
    expect(callers.content[0].text).toContain(`nodeId=${method.id}`);
    expect(callers.content[0].text).toContain('edgeKind=calls');
    expect(callers.content[0].text).toContain('callsite=src/service.ts:');
    expect(callers.content[0].text).toContain('provenance=unknown');
    expect(callers.content[0].text).toContain('confidence=');
    expect(callers.content[0].text).toContain('resolvedBy=');

    const callees = await handler.execute('codegraph_callees', { path: 'src/service.ts', line: 3 });
    expect(callees.isError).toBeFalsy();
    expect(callees.content[0].text).toContain('helper (function)');
    expect(callees.content[0].text).toContain('edgeKind=calls');
    expect(callees.content[0].text).toContain('callsite=src/service.ts:');

    const impact = await handler.execute('codegraph_impact', { qualifiedName: helper.qualifiedName });
    expect(impact.isError).toBeFalsy();
    expect(impact.content[0].text).toContain('helper');
    expect(impact.content[0].text).toContain('range=src/service.ts:');
  });

  it('explains that codegraph_files no-match results are indexed-only', async () => {
    const result = await handler.execute('codegraph_files', { path: 'src/missing.ts' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('No indexed files matched the criteria.');
    expect(text).toContain('indexed files only');
    expect(text).toContain('new, ignored, unsupported, non-code, or not synced');
    expect(text).toContain('git status');
    expect(text).toContain('read src/missing.ts');
    expect(text).toContain('codegraph sync --quiet');
  });

  it('returns an MCP error when no locator fields are provided', async () => {
    const result = await handler.execute('codegraph_node', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('locator');
  });
});
