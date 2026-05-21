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
  });

  it('returns gaps and recommendations when maxDepth prevents a complete path', () => {
    const result = cg.trace({ symbol: 'entry' }, { symbol: 'target' }, { maxDepth: 1 });
    expect(result.status).toBe('resolved');
    expect(result.paths).toHaveLength(0);
    expect(result.gaps.join('\n')).toMatch(/No complete path/);
    expect(result.recommendations.join('\n')).toMatch(/maxDepth|explore|node/i);
  });

  it('accepts fileLine for the entry locator', () => {
    const result = cg.trace({ fileLine: 'src/flow.ts:2' }, { symbol: 'target' }, { maxDepth: 4 });
    expect(result.status).toBe('resolved');
    expect(result.from?.name).toBe('entry');
    expect(result.paths[0]?.steps.map((s) => s.node.name)).toContain('target');
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

describe.skipIf(!HAS_SQLITE)('CodeGraph.trace ambiguity', () => {
  let root: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    root = tmpRoot();
    writeTraceFixture(root);
    fs.writeFileSync(path.join(root, 'src', 'other.ts'), 'export function entry(): void {}\n');
    cg = CodeGraph.initSync(root, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
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
});

describe.skipIf(!HAS_SQLITE)('MCP codegraph_trace', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    writeTraceFixture(root);
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
    expect(text).toContain('calls');
    expect(text).toMatch(/Recommended next/i);
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
});
