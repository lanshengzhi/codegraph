/**
 * MCP-level tests for ecosystem tools: status/coverage (P3a PR1).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { NODE_KINDS } from '../src/types';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-eco-'));
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
  const cg = CodeGraph.initSync(root);
  await cg.indexAll();
  return cg;
}

// ---------------------------------------------------------------------------
// Schema tests — no project needed
// ---------------------------------------------------------------------------
describe('codegraph_search schema', () => {
  it('advertises the raw MCP name and exposes real NodeKind values', () => {
    const tool = tools.find((t) => t.name === 'search');
    expect(tool).toBeDefined();
    expect(tools.some((t) => t.name === 'codegraph_search')).toBe(false);
    expect(tool!.inputSchema.properties.kind.enum).toEqual([...NODE_KINDS]);
    expect(tool!.inputSchema.properties.kind.enum).toContain('type_alias');
    expect(tool!.inputSchema.properties.kind.enum).toContain('constant');
    expect(tool!.inputSchema.properties.kind.enum).not.toContain('type');
  });
});

describe('codegraph_status schema', () => {
  it('is registered in the tools array with the raw MCP name', () => {
    const tool = tools.find((t) => t.name === 'status');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('status');
    expect(tools.some((t) => t.name === 'codegraph_status')).toBe(false);
  });

  it('has detail, checkFilesystem, limit, and projectPath properties', () => {
    const tool = tools.find((t) => t.name === 'status')!;
    const props = tool.inputSchema.properties;
    expect(props.detail).toBeDefined();
    expect(props.checkFilesystem).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.projectPath).toBeDefined();
  });

  it('detail enum includes summary and coverage', () => {
    const tool = tools.find((t) => t.name === 'status')!;
    const detail = tool.inputSchema.properties.detail;
    expect(detail.enum).toContain('summary');
    expect(detail.enum).toContain('coverage');
  });
});

// ---------------------------------------------------------------------------
// Handler tests — require a real project
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_SQLITE)('codegraph_status handler', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(() => {
    root = tmpRoot();
  });

  afterEach(() => {
    cg?.destroy();
    cleanup(root);
  });

  it('returns compact summary by default', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_status', {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('CodeGraph Status');
    expect(text).toContain('Files indexed:');
    expect(text).toContain('Total nodes:');
    expect(text).not.toContain('Coverage boundaries');
  });

  it('accepts prefixed aliases while advertising raw MCP names for gateway prefixing', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    expect(tools.some((tool) => tool.name === 'status')).toBe(true);
    expect(tools.some((tool) => tool.name === 'codegraph_status')).toBe(false);

    const raw = await handler.execute('status', {});
    expect(raw.isError).toBeFalsy();
    expect(raw.content[0]!.text).toContain('CodeGraph Status');

    const prefixed = await handler.execute('codegraph_status', {});
    expect(prefixed.isError).toBeFalsy();
    expect(prefixed.content[0]!.text).toContain('CodeGraph Status');

    const doublePrefixed = await handler.execute('codegraph_codegraph_status', {});
    expect(doublePrefixed.isError).toBeFalsy();
    expect(doublePrefixed.content[0]!.text).toContain('CodeGraph Status');
  });

  it('rejects invalid search kind values instead of returning a misleading empty search', async () => {
    writeFile(root, 'src/a.ts', 'export type Alias = string;\n');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const invalid = await handler.execute('codegraph_search', { query: 'Alias', kind: 'type' });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]!.text).toContain('Invalid kind');
    expect(invalid.content[0]!.text).toContain('type_alias');

    const valid = await handler.execute('codegraph_search', { query: 'Alias', kind: 'type_alias' });
    expect(valid.isError).toBeFalsy();
    expect(valid.content[0]!.text).toContain('Alias (type_alias)');
  });

  it('returns coverage detail when detail=coverage', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_status', { detail: 'coverage' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('CodeGraph Coverage Status');
    expect(text).toContain('indexed source coverage');
    expect(text).toContain('Coverage boundaries');
  });

  it('returns error for invalid detail', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_status', { detail: 'invalid' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Invalid detail');
  });

  it('includes pending changes in coverage detail', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);
    writeFile(root, 'src/b.ts', 'export const y = 2;\n');
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_status', { detail: 'coverage' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Pending source changes');
  });

  it('includes workspace summary when package.json has workspaces', async () => {
    writeFile(root, 'package.json', JSON.stringify({
      name: 'root',
      workspaces: ['packages/*'],
    }));
    writeFile(root, 'packages/ai/package.json', JSON.stringify({ name: '@scope/ai' }));
    writeFile(root, 'packages/ai/src/index.ts', 'export const x = 1;\n');
    writeFile(root, 'src/app.ts', 'export const app = 1;\n');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_status', { detail: 'coverage' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Workspace packages');
  });

  it('includes alias summary when tsconfig has paths', async () => {
    writeFile(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_status', { detail: 'coverage' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Path aliases');
  });

  it('includes filesystem check when checkFilesystem=true', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_status', { detail: 'coverage', checkFilesystem: true });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Filesystem check');
  });

  it('coverage output does not include full source code', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_status', { detail: 'coverage' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).not.toContain('export const x = 1');
  });

  it('default detail stays compact even for large repos', async () => {
    for (let i = 0; i < 30; i++) {
      writeFile(root, `src/f${i}.ts`, `export const x${i} = ${i};\n`);
    }
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_status', {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).not.toContain('Pending source changes');
    expect(text).not.toContain('Coverage boundaries');
  });
});

// ---------------------------------------------------------------------------
// codegraph_import_candidates tests
// ---------------------------------------------------------------------------
describe('codegraph_import_candidates schema', () => {
  it('is registered in the tools array with the raw MCP name', () => {
    const tool = tools.find((t) => t.name === 'import_candidates');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('import_candidates');
    expect(tools.some((t) => t.name === 'codegraph_import_candidates')).toBe(false);
  });

  it('has specifier, symbol, limit, includeUnindexed, and projectPath properties', () => {
    const tool = tools.find((t) => t.name === 'import_candidates')!;
    const props = tool.inputSchema.properties;
    expect(props.specifier).toBeDefined();
    expect(props.symbol).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.includeUnindexed).toBeDefined();
    expect(props.projectPath).toBeDefined();
  });

  it('requires specifier', () => {
    const tool = tools.find((t) => t.name === 'import_candidates')!;
    expect(tool.inputSchema.required).toContain('specifier');
  });
});

describe.skipIf(!HAS_SQLITE)('codegraph_import_candidates handler', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(() => {
    root = tmpRoot();
  });

  afterEach(() => {
    cg?.destroy();
    cleanup(root);
  });

  it('returns candidates for a workspace package', async () => {
    writeFile(root, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile(root, 'packages/ai/package.json', JSON.stringify({
      name: '@scope/ai',
      exports: { '.': './src/index.ts' },
    }));
    writeFile(root, 'packages/ai/src/index.ts', 'export function streamSimple() {}');

    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_import_candidates', { specifier: '@scope/ai' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('@scope/ai');
    expect(text).toContain('packages/ai/src/index.ts');
    expect(text).toContain('evidence=exports-exact');
  });

  it('returns symbol node when symbol is provided', async () => {
    writeFile(root, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile(root, 'packages/ai/package.json', JSON.stringify({
      name: '@scope/ai',
      exports: { '.': './src/index.ts' },
    }));
    writeFile(root, 'packages/ai/src/index.ts', 'export function streamSimple() { return 42; }');

    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_import_candidates', { specifier: '@scope/ai', symbol: 'streamSimple' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('streamSimple');
    expect(text).toContain('nodeId=');
  });

  it('returns error for empty specifier', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_import_candidates', { specifier: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('specifier must be a non-empty string');
  });

  it('returns no-workspaces when no workspace config', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_import_candidates', { specifier: '@scope/ai' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('no-workspaces');
  });
});

// =============================================================================
// codegraph_registry_candidates tests (P3c PR3)
// =============================================================================
describe('codegraph_registry_candidates schema', () => {
  it('is registered in the tools array with the raw MCP name', () => {
    const tool = tools.find((t) => t.name === 'registry_candidates');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('registry_candidates');
    expect(tools.some((t) => t.name === 'codegraph_registry_candidates')).toBe(false);
  });

  it('has query, key, kind, scopePath, limit, includeTests, and projectPath properties', () => {
    const tool = tools.find((t) => t.name === 'registry_candidates')!;
    const props = tool.inputSchema.properties;
    expect(props.query).toBeDefined();
    expect(props.key).toBeDefined();
    expect(props.kind).toBeDefined();
    expect(props.scopePath).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.includeTests).toBeDefined();
    expect(props.projectPath).toBeDefined();
  });

  it('kind enum includes valid values', () => {
    const tool = tools.find((t) => t.name === 'registry_candidates')!;
    const kind = tool.inputSchema.properties.kind;
    expect(kind.enum).toContain('provider');
    expect(kind.enum).toContain('tool');
    expect(kind.enum).toContain('extension');
    expect(kind.enum).toContain('route');
    expect(kind.enum).toContain('handler');
    expect(kind.enum).toContain('all');
  });

  it('has no required parameters', () => {
    const tool = tools.find((t) => t.name === 'registry_candidates')!;
    // registry_candidates can be called with no args for broad discovery
    expect(tool.inputSchema.required ?? []).toHaveLength(0);
  });
});

describe.skipIf(!HAS_SQLITE)('codegraph_registry_candidates handler', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(() => {
    root = tmpRoot();
  });

  afterEach(() => {
    cg?.destroy();
    cleanup(root);
  });

  it('accepts prefixed aliases while advertising raw MCP names', async () => {
    writeFile(root, 'src/providers.ts', 'const providers = { anthropic: fn }; function fn() {}');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const raw = await handler.execute('registry_candidates', { key: 'anthropic' });
    expect(raw.isError).toBeFalsy();

    const prefixed = await handler.execute('codegraph_registry_candidates', { key: 'anthropic' });
    expect(prefixed.isError).toBeFalsy();
    expect(prefixed.content[0]!.text).toContain('anthropic');
  });

  it('returns registry candidates for an object literal', async () => {
    writeFile(root, 'src/providers.ts', `
const providers = {
  anthropic: streamAnthropic,
  openai: streamOpenAI,
};
function streamAnthropic() { return 42; }
function streamOpenAI() { return 43; }
`);
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', { key: 'anthropic' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Registry candidates');
    expect(text).toContain('anthropic');
    expect(text).toContain('streamAnthropic');
    expect(text).toContain('evidence=object-literal');
    expect(text).toContain('confidence=high');
  });

  it('output includes static candidate caveat', async () => {
    writeFile(root, 'src/providers.ts', 'const providers = { x: fn }; function fn() {}');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Static registry/resolver candidates only');
    expect(text).toContain('runtime');
  });

  it('returns handler node handle when resolved', async () => {
    writeFile(root, 'src/providers.ts', `
const providers = { anthropic: streamAnthropic };
function streamAnthropic() { return 42; }
`);
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', { key: 'anthropic' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('nodeId=');
    expect(text).toContain('streamAnthropic');
  });

  it('returns error for invalid kind', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', { kind: 'invalid' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Invalid kind');
  });

  it('returns error for key with newline', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', { key: 'foo\nbar' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('newlines');
  });

  it('formatter does not output full source code', async () => {
    writeFile(root, 'src/providers.ts', `
const providers = { anthropic: streamAnthropic };
function streamAnthropic() { return 42; }
`);
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', { key: 'anthropic' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).not.toContain('return 42');
  });

  it('groups candidates by registry name', async () => {
    writeFile(root, 'src/providers.ts', `
const providers = {
  anthropic: streamAnthropic,
  openai: streamOpenAI,
};
function streamAnthropic() {}
function streamOpenAI() {}
`);
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('### providers');
  });

  it('includes recommended next section', async () => {
    writeFile(root, 'src/providers.ts', `
const providers = { anthropic: streamAnthropic };
function streamAnthropic() {}
`);
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', { key: 'anthropic' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Recommended next');
    expect(text).toContain('codegraph_node');
  });

  it('accepts query parameter for broad search', async () => {
    writeFile(root, 'src/providers.ts', `
const providers = { anthropic: streamAnthropic, openai: streamOpenAI };
function streamAnthropic() {}
function streamOpenAI() {}
`);
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', { query: 'anthropic' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('anthropic');
    expect(text).not.toContain('openai');
  });

  it('scopes search to a path prefix', async () => {
    writeFile(root, 'src/providers/providers.ts', 'const providers = { x: fn }; function fn() {}');
    writeFile(root, 'src/tools/tools.ts', 'const tools = { y: fn2 }; function fn2() {}');
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', { scopePath: 'src/providers', query: 'x' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('x');
    expect(text).not.toContain('tools');
  });

  it('omitted count is shown when candidates exceed display cap', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => `  "key${i}": fn${i},`).join('\n');
    const fns = Array.from({ length: 30 }, (_, i) => `function fn${i}() { return ${i}; }`).join('\n');
    writeFile(root, 'src/many.ts', `const providers = {\n${entries}\n};\n${fns}`);
    cg = await initProject(root);
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_registry_candidates', {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('more candidate(s) omitted');
  });
});
