/**
 * Node structure summaries for long function/method navigation.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { hashContent } from '../src/extraction';
import { NodeStructureAnalyzer } from '../src/structure/node-structure';
import { ToolHandler, tools } from '../src/mcp/tools';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-node-structure-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(root: string, relativePath: string, source: string): void {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, source);
}

async function initProject(root: string): Promise<CodeGraph> {
  const cg = CodeGraph.initSync(root, {
    config: { include: ['src/**/*.{ts,tsx,js,jsx,py}'], exclude: [] },
  });
  await cg.indexAll();
  return cg;
}

function findNode(cg: CodeGraph, name: string, kind?: Node['kind'], filePath?: string): Node {
  const nodes = kind ? cg.getNodesByKind(kind) : [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')];
  const found = nodes.find((node) => node.name === name && (!filePath || node.filePath === filePath));
  if (!found) throw new Error(`Node not found: ${name} ${kind ?? ''} ${filePath ?? ''}`);
  return found;
}

function expectRangeInside(item: { range: { startLine: number; endLine: number; path: string } }, node: Node): void {
  expect(item.range.path).toBe(node.filePath);
  expect(item.range.startLine).toBeGreaterThanOrEqual(node.startLine);
  expect(item.range.endLine).toBeLessThanOrEqual(node.endLine);
}

describe.skipIf(!HAS_SQLITE)('CodeGraph.getNodeStructure', () => {
  let root: string;
  let cg: CodeGraph;

  beforeEach(() => {
    root = tmpRoot();
  });

  afterEach(() => {
    cg?.destroy();
    cleanup(root);
  });

  it('returns available structure with basic callsite, return, caveats, and recommendations', async () => {
    writeFile(root, 'src/long.ts', `
function normalize(input: string): string { return input.trim(); }
export function simple(input: string): string {
  const value = normalize(input);
  return value;
}
`);
    cg = await initProject(root);
    const node = findNode(cg, 'simple', 'function');

    const result = await cg.getNodeStructure(node.id);

    expect(result.status).toBe('available');
    expect(result.node?.nodeId).toBe(node.id);
    expect(result.node?.qualifiedName).toBe(node.qualifiedName);
    expect(result.language).toBe('typescript');
    expect(result.caveats.join('\n')).toContain('Static AST structure only');
    expect(result.recommendations).toContain(`read src/long.ts:${node.startLine}-${node.endLine}`);
    expect(result.recommendations.join('\n')).toContain(`codegraph_node({ nodeId: "${node.id}", includeCode: true })`);
    expect(result.items.some((item) => item.kind === 'callsite' && item.calleeText?.includes('normalize'))).toBe(true);
    expect(result.items.some((item) => item.kind === 'return-value' && item.label.includes('return value'))).toBe(true);
    for (const item of result.items) expectRangeInside(item, node);
  });

  it('returns not_found for an unknown node id without throwing', async () => {
    writeFile(root, 'src/long.ts', 'export function simple() { return 1; }\n');
    cg = await initProject(root);

    const result = await cg.getNodeStructure('function:missing');

    expect(result.status).toBe('not_found');
    expect(result.items).toEqual([]);
    expect(result.recommendations).toContain('codegraph sync --quiet');
  });

  it.each([
    {
      label: 'function declaration',
      file: 'src/shape.ts',
      name: 'fn',
      kind: 'function' as const,
      source: 'function normalize(input: string) { return input; }\nexport function fn(input: string) { return normalize(input); }\n',
      expected: 'normalize',
    },
    {
      label: 'block-bodied arrow',
      file: 'src/shape.ts',
      name: 'fn',
      kind: 'function' as const,
      source: 'function normalize(input: string) { return input; }\nexport const fn = (input: string) => { return normalize(input); };\n',
      expected: 'normalize',
    },
    {
      label: 'expression-bodied arrow',
      file: 'src/shape.ts',
      name: 'fn',
      kind: 'function' as const,
      source: 'function normalize(input: string) { return input; }\nexport const fn = (input: string) => normalize(input);\n',
      expected: 'implicit return',
    },
    {
      label: 'function expression',
      file: 'src/shape.ts',
      name: 'fn',
      kind: 'function' as const,
      source: 'function normalize(input: string) { return input; }\nconst fn = function (input: string) { return normalize(input); };\n',
      expected: 'normalize',
    },
    {
      label: 'class method',
      file: 'src/shape.ts',
      name: 'method',
      kind: 'method' as const,
      source: 'function normalize(input: string) { return input; }\nclass C { method(input: string) { return normalize(input); } }\n',
      expected: 'normalize',
    },
    {
      label: 'TS class field arrow',
      file: 'src/shape.ts',
      name: 'handler',
      kind: 'method' as const,
      source: 'class C { run(event: Event) { return event.type; }\n  handler = (event: Event) => { return this.run(event); }\n}\n',
      expected: 'this.run',
    },
    {
      label: 'TS HOF wrapper class field arrow',
      file: 'src/shape.ts',
      name: 'handler',
      kind: 'method' as const,
      source: 'declare function throttle<T>(fn: T): T;\nclass C { run(event: Event) { return event.type; }\n  handler = throttle((event: Event) => { return this.run(event); })\n}\n',
      expected: 'this.run',
    },
    {
      label: 'JS class field arrow',
      file: 'src/shape.js',
      name: 'handler',
      kind: 'method' as const,
      source: 'class C { run(event) { return event.type; }\n  handler = (event) => { return this.run(event); }\n}\n',
      expected: 'this.run',
    },
    {
      label: 'JS HOF wrapper class field arrow',
      file: 'src/shape.js',
      name: 'handler',
      kind: 'method' as const,
      source: 'function throttle(fn) { return fn; }\nclass C { run(event) { return event.type; }\n  handler = throttle((event) => { return this.run(event); })\n}\n',
      expected: 'this.run',
    },
    {
      label: 'TSX expression-bodied component',
      file: 'src/component.tsx',
      name: 'Component',
      kind: 'function' as const,
      source: 'const View = () => <div />;\nexport const Component = () => <View />;\n',
      expected: 'implicit return',
    },
  ])('matches AST body for $label', async ({ file, name, kind, source, expected }) => {
    writeFile(root, file, source);
    cg = await initProject(root);
    const node = findNode(cg, name, kind, file);

    const result = await cg.getNodeStructure(node.id);

    expect(result.status).toBe('available');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((item) => item.label.includes(expected) || item.calleeText?.includes(expected))).toBe(true);
    for (const item of result.items) expectRangeInside(item, node);
  });

  it('summarizes control flow and enclosing context without crossing nested function boundaries', async () => {
    writeFile(root, 'src/long.ts', `
type Input = { user?: string; kind: string; items: string[] };
declare const audit: (...args: unknown[]) => void;
declare const opts: { dryRun?: boolean };
declare const worker: { run(item: string): void };
declare function buildPreview(input: Input): unknown;
declare function recover(err: unknown): void;
declare function cleanup(): void;
export function processRequest(input: Input) {
  if (!input.user) {
    audit('missing-user');
    return { ok: false };
  }
  if (opts?.dryRun) {
    return buildPreview(input);
  }
  switch (input.kind) {
    case 'a':
      audit('a');
      break;
  }
  try {
    for (const item of input.items) {
      worker.run(item);
    }
  } catch (err) {
    recover(err);
  } finally {
    cleanup();
  }
  function innerDecl() {
    return dangerousDecl();
  }
  const innerArrow = () => dangerousArrow();
  const innerExpr = function () {
    return dangerousExpr();
  };
  safe();
  return { ok: true };
}
`);
    cg = await initProject(root);
    const node = findNode(cg, 'processRequest', 'function');

    const result = await cg.getNodeStructure(node.id);

    expect(result.status).toBe('available');
    expect(result.items.some((item) => item.kind === 'guard' && item.conditionText?.includes('!input.user'))).toBe(true);
    expect(result.items.some((item) => item.kind === 'early-return')).toBe(true);
    expect(result.items.some((item) => item.kind === 'switch')).toBe(true);
    expect(result.items.some((item) => item.kind === 'loop')).toBe(true);
    expect(result.items.some((item) => item.kind === 'try')).toBe(true);
    expect(result.items.some((item) => item.kind === 'catch')).toBe(true);
    expect(result.items.some((item) => item.kind === 'finally')).toBe(true);

    const workerRun = result.items.find((item) => item.kind === 'callsite' && item.calleeText?.includes('worker.run'));
    expect(workerRun?.enclosing?.map((ctx) => ctx.kind)).toEqual(expect.arrayContaining(['try', 'loop']));
    expect(result.items.some((item) => item.calleeText?.includes('dangerousDecl'))).toBe(false);
    expect(result.items.some((item) => item.calleeText?.includes('dangerousArrow'))).toBe(false);
    expect(result.items.some((item) => item.calleeText?.includes('dangerousExpr'))).toBe(false);
    expect(result.items.some((item) => item.calleeText?.includes('safe'))).toBe(true);
  });

  it('captures predicate callsites and gives else branches a non-guard context', async () => {
    writeFile(root, 'src/guard-else.ts', `
declare function shouldSkip(input: string): boolean;
declare function skip(input: string): void;
declare function doWork(input: string): void;
export function guardElse(input: string) {
  if (shouldSkip(input)) {
    skip(input);
    return { ok: false };
  } else {
    doWork(input);
  }
  return { ok: true };
}
`);
    cg = await initProject(root);
    const node = findNode(cg, 'guardElse', 'function');

    const result = await cg.getNodeStructure(node.id);

    const predicate = result.items.find((item) => item.kind === 'callsite' && item.calleeText?.includes('shouldSkip'));
    expect(predicate).toBeTruthy();
    expect(predicate?.enclosing?.map((ctx) => ctx.kind)).toContain('guard');

    const doWork = result.items.find((item) => item.kind === 'callsite' && item.calleeText?.includes('doWork'));
    expect(doWork).toBeTruthy();
    expect(doWork?.enclosing?.some((ctx) => ctx.kind === 'guard')).toBe(false);
    expect(doWork?.enclosing?.map((ctx) => ctx.kind)).toContain('branch');
    expect(doWork?.enclosing?.some((ctx) => ctx.label.includes('else of if'))).toBe(true);
  });

  it('marks callback-like invocations and optionally collects one level of inline callback bodies', async () => {
    writeFile(root, 'src/callbacks.ts', `
type Item = { id: string; ok: boolean };
declare const worker: { run(item: Item): void };
declare function skip(item: Item): Item;
declare function transform(item: Item): Item;
export function run(items: Item[], onProgress?: (id: string) => void, options?: { streamFn?: () => void }) {
  for (const item of items) {
    worker.run(item);
    onProgress?.(item.id);
    options?.streamFn?.();
  }
  return items.map((item) => {
    if (!item.ok) return skip(item);
    return transform(item);
  });
}
`);
    cg = await initProject(root);
    const node = findNode(cg, 'run', 'function');

    const result = await cg.getNodeStructure(node.id);

    const workerRun = result.items.find((item) => item.calleeText?.includes('worker.run'));
    expect(workerRun?.kind).toBe('callsite');
    expect(workerRun?.receiverText).toBe('worker');
    expect(workerRun?.propertyText).toBe('run');
    const onProgress = result.items.find((item) => item.calleeText?.includes('onProgress'));
    expect(onProgress?.kind).toBe('callback-invocation');
    expect(onProgress?.note).toContain('binding not inferred');
    const streamFn = result.items.find((item) => item.calleeText?.includes('streamFn'));
    expect(streamFn?.kind).toBe('callback-invocation');
    expect(streamFn?.note).toContain('binding not inferred');
    expect(result.items.find((item) => item.calleeText?.includes('skip'))?.note).toContain('inside nested function/callback');
    expect(result.items.find((item) => item.calleeText?.includes('transform'))?.note).toContain('inside nested function/callback');
    expect(result.items.filter((item) => item.kind === 'early-return' && item.note?.includes('inside nested')).length).toBe(0);

    const withoutCallbacks = await cg.getNodeStructure(node.id, { includeNestedCallbacks: false });
    expect(withoutCallbacks.items.some((item) => item.calleeText?.includes('skip'))).toBe(false);
    expect(withoutCallbacks.items.some((item) => item.calleeText?.includes('transform'))).toBe(false);
    expect(result.items.map((item) => `${item.label} ${item.note ?? ''}`).join('\n')).not.toMatch(/runtime main path|definitely/);
  });

  it('does not collect ordinary nested function bodies inside an inline callback', async () => {
    writeFile(root, 'src/callback-nested.ts', `
type Item = { id: string };
declare function dangerousDecl(item: Item): Item;
declare function dangerousArrow(item: Item): Item;
declare function dangerousExpr(item: Item): Item;
declare function dangerousMethod(item: Item): Item;
declare function transform(item: Item): Item;
export function callbackNested(items: Item[]) {
  return items.map((item) => {
    function innerDecl() {
      return dangerousDecl(item);
    }
    const innerArrow = () => dangerousArrow(item);
    const innerExpr = function () {
      return dangerousExpr(item);
    };
    class Inner {
      method() {
        return dangerousMethod(item);
      }
    }
    return transform(item);
  });
}
`);
    cg = await initProject(root);
    const node = findNode(cg, 'callbackNested', 'function');

    const result = await cg.getNodeStructure(node.id);

    expect(result.items.some((item) => item.calleeText?.includes('transform'))).toBe(true);
    expect(result.items.find((item) => item.calleeText?.includes('transform'))?.note).toContain('inside nested function/callback');
    expect(result.items.some((item) => item.calleeText?.includes('dangerousDecl'))).toBe(false);
    expect(result.items.some((item) => item.calleeText?.includes('dangerousArrow'))).toBe(false);
    expect(result.items.some((item) => item.calleeText?.includes('dangerousExpr'))).toBe(false);
    expect(result.items.some((item) => item.calleeText?.includes('dangerousMethod'))).toBe(false);
  });

  it('attaches parenthesized object return keys to return-value without duplicate object literal items', async () => {
    writeFile(root, 'src/returns-object.ts', `
export const implicitObject = () => ({ ok: true, value: 1 });
export function explicitObject() {
  return ({ ok: true, value: 1 });
}
`);
    cg = await initProject(root);

    for (const name of ['implicitObject', 'explicitObject']) {
      const node = findNode(cg, name, 'function');
      const result = await cg.getNodeStructure(node.id);
      const returnValue = result.items.find((item) => item.kind === 'return-value');

      expect(result.status).toBe('available');
      expect(returnValue?.objectKeys).toEqual(expect.arrayContaining(['ok', 'value']));
      expect(result.items.some((item) => item.kind === 'object-literal')).toBe(false);
    }
  });

  it('reports local object literal and return construction hints without dataflow claims', async () => {
    writeFile(root, 'src/payload.ts', `
type Context = { ok: boolean; systemPrompt: string; messages: string[]; tools?: string[] };
declare function convertMessages(messages: string[]): string[];
declare function send(body: unknown): void;
export function buildPayload(ctx: Context) {
  if (!ctx.ok) return { ok: false, reason: 'bad' };
  const payload = {
    system: ctx.systemPrompt,
    messages: convertMessages(ctx.messages),
    tools: ctx.tools ?? [],
  };
  send({ body: payload, stream: true });
  return { ok: true, payload };
}
`);
    cg = await initProject(root);
    const node = findNode(cg, 'buildPayload', 'function');

    const result = await cg.getNodeStructure(node.id);

    const payload = result.items.find((item) => item.kind === 'object-literal' && item.label.includes('payload'));
    expect(payload?.objectKeys).toEqual(expect.arrayContaining(['system', 'messages', 'tools']));
    const sendArg = result.items.find((item) => item.kind === 'object-literal' && item.label.includes('send'));
    expect(sendArg?.objectKeys).toEqual(expect.arrayContaining(['body', 'stream']));
    const returnObject = result.items.find((item) => item.kind === 'return-value' && item.objectKeys?.includes('payload'));
    expect(returnObject?.objectKeys).toEqual(expect.arrayContaining(['ok', 'payload']));
    const early = result.items.find((item) => item.kind === 'early-return');
    expect(early?.objectKeys).toEqual(expect.arrayContaining(['ok', 'reason']));
    expect(result.items.map((item) => item.label).join('\n')).not.toMatch(/definitely reaches|provider payload/);
  });

  it('returns unsupported and unavailable statuses safely', async () => {
    writeFile(root, 'src/plain.py', 'def py_func():\n    return 1\n');
    writeFile(root, 'src/box.ts', 'export class Box { value = 1; method() { return this.value; } }\n');
    cg = await initProject(root);

    const py = findNode(cg, 'py_func', 'function', 'src/plain.py');
    const pyResult = await cg.getNodeStructure(py.id);
    expect(pyResult.status).toBe('unsupported-language');
    expect(pyResult.caveats.join('\n')).toContain('currently supports TypeScript/JavaScript/TSX/JSX');

    const box = findNode(cg, 'Box', 'class', 'src/box.ts');
    const boxResult = await cg.getNodeStructure(box.id);
    expect(boxResult.status).toBe('unsupported-node-kind');
    expect(boxResult.caveats.join('\n')).toContain('function/method bodies');

    const method = findNode(cg, 'method', 'method', 'src/box.ts');
    fs.unlinkSync(path.join(root, 'src/box.ts'));
    const missing = await cg.getNodeStructure(method.id);
    expect(missing.status).toBe('source-unavailable');
  });

  it('handles source-too-large and source-stale with size guard precedence', async () => {
    writeFile(root, 'src/large.ts', 'export function target() { return small(); }\nfunction small() { return 1; }\n');
    cg = await initProject(root);
    const node = findNode(cg, 'target', 'function');

    const tooLarge = await cg.getNodeStructure(node.id, { maxSourceBytes: 10 });
    expect(tooLarge.status).toBe('source-too-large');
    expect(tooLarge.recommendations).toContain(`read src/large.ts:${node.startLine}-${node.endLine}`);

    fs.writeFileSync(path.join(root, 'src/large.ts'), 'export function target() { return changed(); }\nfunction changed() { return 2; }\n');
    const stale = await cg.getNodeStructure(node.id);
    expect(stale.status).toBe('source-stale');
    expect(stale.items).toEqual([]);
    expect(stale.recommendations).toContain('codegraph sync --quiet');

    fs.writeFileSync(path.join(root, 'src/large.ts'), `export function target() {\n  return changed();\n}\n${'// filler\n'.repeat(100)}`);
    const staleButLarge = await cg.getNodeStructure(node.id, { maxSourceBytes: 20 });
    expect(staleButLarge.status).toBe('source-too-large');
  });
});

describe('NodeStructureAnalyzer degradation seams', () => {
  let root: string;

  beforeEach(() => {
    root = tmpRoot();
  });

  afterEach(() => cleanup(root));

  function fakeNode(overrides: Partial<Node> = {}): Node {
    return {
      id: 'function:fake',
      kind: 'function',
      name: 'target',
      qualifiedName: 'src/fake.ts::target',
      filePath: 'src/fake.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 3,
      startColumn: 0,
      endColumn: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  it('does not read or recommend unsafe paths outside the project root', async () => {
    const analyzer = new NodeStructureAnalyzer(root);
    const result = await analyzer.analyze(fakeNode({ filePath: '../escape.ts' }), null);

    expect(result.status).toBe('source-unavailable');
    expect(result.recommendations.join('\n')).not.toContain('read ../escape.ts');
  });

  it('returns no-body when the indexed node has no matching function body in current source', async () => {
    writeFile(root, 'src/fake.ts', 'export const other = 1;\n');
    const source = fs.readFileSync(path.join(root, 'src/fake.ts'), 'utf8');
    const analyzer = new NodeStructureAnalyzer(root);

    const result = await analyzer.analyze(fakeNode(), {
      path: 'src/fake.ts',
      contentHash: hashContent(source),
      language: 'typescript',
      size: source.length,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 1,
    });

    expect(result.status).toBe('no-body');
    expect(result.recommendations).toContain('codegraph sync --quiet');
  });

  it('returns parser-unavailable through the parserHost seam', async () => {
    writeFile(root, 'src/fake.ts', 'export function target() { return 1; }\n');
    const source = fs.readFileSync(path.join(root, 'src/fake.ts'), 'utf8');
    const analyzer = new NodeStructureAnalyzer(root, {
      loadGrammarsForLanguages: async () => {},
      getParser: () => null,
    });

    const result = await analyzer.analyze(fakeNode(), {
      path: 'src/fake.ts',
      contentHash: hashContent(source),
      language: 'typescript',
      size: source.length,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 1,
    });

    expect(result.status).toBe('parser-unavailable');
  });

  it('returns parser-unavailable instead of rejecting when grammar loading throws', async () => {
    writeFile(root, 'src/fake.ts', 'export function target() { return 1; }\n');
    const source = fs.readFileSync(path.join(root, 'src/fake.ts'), 'utf8');
    const analyzer = new NodeStructureAnalyzer(root, {
      loadGrammarsForLanguages: async () => {
        throw new Error('grammar boom');
      },
      getParser: () => null,
    });

    const result = await analyzer.analyze(fakeNode(), {
      path: 'src/fake.ts',
      contentHash: hashContent(source),
      language: 'typescript',
      size: source.length,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 1,
    });

    expect(result.status).toBe('parser-unavailable');
    expect(result.caveats.join('\n')).toContain('grammar boom');
  });

  it('returns available with a parse-error caveat when ERROR nodes exist but the target body is located', async () => {
    writeFile(root, 'src/fake.ts', `
declare function ok(): number;
export function target() {
  const broken = ;
  return ok();
}
`);
    const source = fs.readFileSync(path.join(root, 'src/fake.ts'), 'utf8');
    const analyzer = new NodeStructureAnalyzer(root);

    const result = await analyzer.analyze(fakeNode({ startLine: 3, endLine: 6 }), {
      path: 'src/fake.ts',
      contentHash: hashContent(source),
      language: 'typescript',
      size: source.length,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 1,
    });

    expect(result.status).toBe('available');
    expect(result.caveats.join('\n')).toContain('Parse tree contains ERROR nodes');
    expect(result.items.some((item) => item.kind === 'callsite' && item.calleeText?.includes('ok'))).toBe(true);
  });
});

describe.skipIf(!HAS_SQLITE)('MCP codegraph_node detail=structure', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    writeFile(root, 'src/long.ts', `
function audit(value: string) { return value; }
export function run(input?: string) {
  if (!input) {
    return { ok: false };
  }
  audit(input);
  return { ok: true, input };
}
export class Runner {
  run(input: string) { return audit(input); }
}
`);
    writeFile(root, 'src/many.ts', `
declare function step(value: number): void;
export function many() {
${Array.from({ length: 45 }, (_, index) => `  step(${index});`).join('\n')}
  return true;
}
`);
    cg = await initProject(root);
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    cleanup(root);
  });

  it('exposes schema, formats structure, and does not include a source code block', async () => {
    const tool = tools.find((item) => item.name === 'codegraph_node');
    expect(tool?.inputSchema.properties.detail).toMatchObject({ type: 'string', enum: ['structure'] });

    const node = findNode(cg, 'run', 'function');
    const result = await handler.execute('codegraph_node', { nodeId: node.id, detail: 'structure' });
    const text = result.content[0].text;

    expect(result.isError).toBeFalsy();
    expect(text).toContain('## run (function) — structure');
    expect(text).toContain('Static AST structure only');
    expect(text).toContain('### Control flow');
    expect(text).toContain('### Key callsites');
    expect(text).toContain('### Construction / returns');
    expect(text).toContain(`src/long.ts:${node.startLine}`);
    expect(text).toContain(`codegraph_node({ nodeId: "${node.id}", includeCode: true })`);
    expect(text).not.toContain('```typescript');
  });

  it('prefers structure when includeCode is also true', async () => {
    const node = findNode(cg, 'run', 'function');
    const result = await handler.execute('codegraph_node', { nodeId: node.id, detail: 'structure', includeCode: true });
    const text = result.content[0].text;

    expect(text).toContain('includeCode ignored because detail=structure');
    expect(text).toContain('### Control flow');
    expect(text).not.toContain('```typescript');
  });

  it('caps formatter sections and reports omitted counts from the full item list', async () => {
    const node = findNode(cg, 'many', 'function', 'src/many.ts');
    const analyzerResult = await cg.getNodeStructure(node.id);
    expect(analyzerResult.items.filter((item) => item.kind === 'callsite')).toHaveLength(45);

    const result = await handler.execute('codegraph_node', { nodeId: node.id, detail: 'structure' });
    const text = result.content[0].text;

    expect(text).toContain('... 5 more items omitted; use includeCode/read for full source');
  });

  it('returns errors for invalid detail values and preserves strict ambiguity', async () => {
    const invalid = await handler.execute('codegraph_node', { symbol: 'run', detail: 'full' });
    expect(invalid.isError).toBe(true);
    const invalidType = await handler.execute('codegraph_node', { symbol: 'run', detail: true });
    expect(invalidType.isError).toBe(true);

    const ambiguous = await handler.execute('codegraph_node', { symbol: 'run', detail: 'structure' });
    const text = ambiguous.content[0].text;
    expect(text).toContain('Ambiguous locator');
    expect(text).toContain('Alternatives');
    expect(text).toContain('nodeId=');
    expect(text).not.toContain('— structure');
  });

  it('keeps default and includeCode behavior unchanged', async () => {
    const node = findNode(cg, 'run', 'function');

    const details = await handler.execute('codegraph_node', { nodeId: node.id });
    expect(details.content[0].text).toContain('## run (function)');
    expect(details.content[0].text).not.toContain('### Control flow');

    const full = await handler.execute('codegraph_node', { nodeId: node.id, includeCode: true });
    expect(full.content[0].text).toContain('```typescript');
    expect(full.content[0].text).toContain('return { ok: true, input }');

    const cls = findNode(cg, 'Runner', 'class');
    const outline = await handler.execute('codegraph_node', { nodeId: cls.id, includeCode: true });
    expect(outline.content[0].text).toContain('Structural outline only');
  });
});
