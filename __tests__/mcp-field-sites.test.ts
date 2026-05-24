/**
 * MCP-level tests for codegraph_field_sites tool: schema, handler, formatter.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-field-sites-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(root: string, relativePath: string, source: string): void {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, source);
}

async function initProject(root: string, options?: { include?: string[] }): Promise<CodeGraph> {
  const cg = CodeGraph.initSync(root, { config: options });
  return cg;
}

// ---------------------------------------------------------------------------
// Schema tests — no project needed
// ---------------------------------------------------------------------------
describe('codegraph_field_sites schema', () => {
  it('is registered in the tools array', () => {
    const tool = tools.find((t) => t.name === 'codegraph_field_sites');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('codegraph_field_sites');
  });

  it('has required field parameter', () => {
    const tool = tools.find((t) => t.name === 'codegraph_field_sites')!;
    expect(tool.inputSchema.required).toContain('field');
  });

  it('has optional scopePath, limit, includeTests, projectPath', () => {
    const tool = tools.find((t) => t.name === 'codegraph_field_sites')!;
    const props = tool.inputSchema.properties;
    expect(props.scopePath).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.includeTests).toBeDefined();
    expect(props.projectPath).toBeDefined();
  });

  it('does NOT expose maxSourceBytes in MCP schema', () => {
    const tool = tools.find((t) => t.name === 'codegraph_field_sites')!;
    const props = tool.inputSchema.properties;
    expect(props.maxSourceBytes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invalid-arg tests — no handler needed (test error propagation via a
// zero-file project so validation runs before any file I/O)
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_SQLITE)('codegraph_field_sites invalid args', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    writeFile(root, 'src/empty.ts', '// no symbols yet');
    cg = await initProject(root);
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    cleanup(root);
  });

  it('returns error for missing field', async () => {
    const result = await handler.execute('codegraph_field_sites', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('field must be a non-empty string');
  });

  it('returns error for empty field', async () => {
    const result = await handler.execute('codegraph_field_sites', { field: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('field must be a non-empty string');
  });

  it('returns error for whitespace-only field', async () => {
    const result = await handler.execute('codegraph_field_sites', { field: '   ' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('field must be a non-empty string');
  });

  it('returns error for field with newlines', async () => {
    const result = await handler.execute('codegraph_field_sites', { field: 'foo\nbar' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('field must not contain newlines');
  });

  it('returns error for non-string field', async () => {
    const result = await handler.execute('codegraph_field_sites', { field: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('field must be a non-empty string');
  });

  it('returns error for bad scopePath with ..', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'x',
      scopePath: '../escape',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('scopePath must not contain');
  });

  it('returns error for absolute scopePath', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'x',
      scopePath: '/absolute/path',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('relative path');
  });

  it('returns error for negative limit', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'x',
      limit: -5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('limit must be a positive number');
  });

  it('returns error for NaN limit', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'x',
      limit: NaN,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('limit must be a positive number');
  });

  it('returns error for non-boolean includeTests', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'x',
      includeTests: 'yes',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('includeTests must be a boolean');
  });
});

// ---------------------------------------------------------------------------
// Happy-path handler + formatter tests
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_SQLITE)('codegraph_field_sites handler', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    writeFile(root, 'src/session.ts', `
interface Context {
  systemPrompt: string;
}
export function build(context: Context) {
  const state: any = {};
  state.systemPrompt = context.systemPrompt;
  state.systemPrompt += " extra";
  const val = context['systemPrompt'];
  const snapshot = { systemPrompt: state.systemPrompt, tools: [] };
  const { systemPrompt } = context;
  return { systemPrompt, result: state.systemPrompt };
}
export function mapHint(context: Context) {
  const params: any = {};
  params.system = context.systemPrompt;
  return { prompt: context.systemPrompt };
}
`);
    cg = await initProject(root);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    cleanup(root);
  });

  it('returns markdown with title and caveat', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
    });
    const text = result.content[0].text;
    expect(result.isError).toBeFalsy();
    expect(text).toContain('## Field sites: `systemPrompt`');
    expect(text).toContain('Field sites are static AST navigation hints');
    expect(text.match(/Field sites are static AST navigation hints/g)?.length).toBe(1);
  });

  it('groups sites by category with correct section titles', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
    });
    const text = result.content[0].text;
    expect(text).toContain('### Writes');
    expect(text).toContain('### Mapping hints');
    expect(text).toContain('### Object construction');
    expect(text).toContain('### Reads');
  });

  it('shows stats line with searched/searchable/parsed/matched counts', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
    });
    const text = result.content[0].text;
    expect(text).toContain('Searched indexed files:');
    expect(text).toContain('Searchable TS/JS files:');
    expect(text).toContain('parsed files:');
    expect(text).toContain('matched files:');
  });

  it('shows totalSites and category breakdown', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
    });
    const text = result.content[0].text;
    expect(text).toContain('Sites:');
    // Should have writes and reads at minimum
    expect(text).toMatch(/writes \d+/);
    expect(text).toMatch(/reads \d+/);
  });

  it('shows mapping hints when applicable', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
    });
    const text = result.content[0].text;
    expect(text).toContain('Mapping hints');
    // mapping note must appear
    expect(text).toContain('syntax-only mapping hint');
  });

  it('shows Readwrite access annotation for compound assignments', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
    });
    const text = result.content[0].text;
    // The += assignment should show access=readwrite
    expect(text).toContain('access=readwrite');
  });

  it('includes enclosing node info for sites', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
    });
    const text = result.content[0].text;
    expect(text).toContain('enclosing:');
    expect(text).toContain('nodeId=');
  });

  it('does not include fenced source code blocks', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
    });
    const text = result.content[0].text;
    expect(text).not.toContain('```typescript');
    expect(text).not.toContain('```ts');
    expect(text).not.toContain('```js');
  });

  it('shows status and recommendations for no-matches', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'nonexistentFieldXYZ',
    });
    const text = result.content[0].text;
    expect(result.isError).toBeFalsy();
    // "no-matches" status should be stated
    expect(text).toContain('Status: no-matches');
    // Should still have the caveat header
    expect(text).toContain('Field sites are static AST navigation hints');
  });

  it('limit parameter is respected', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
      limit: 2,
    });
    const text = result.content[0].text;
    expect(result.isError).toBeFalsy();
    // Should not crash; sites should be capped
    expect(text).toContain('Sites:');
  });

  it('scopePath filters results', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
      scopePath: 'src/session.ts',
    });
    const text = result.content[0].text;
    expect(result.isError).toBeFalsy();
    expect(text).toContain('(scope: src/session.ts)');
  });

  it('includeTests=false does not crash on a test-free project', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
      includeTests: false,
    });
    const text = result.content[0].text;
    expect(result.isError).toBeFalsy();
    expect(text).toContain('## Field sites: `systemPrompt`');
  });
});

// ---------------------------------------------------------------------------
// Degradation path tests (no-searchable-files)
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_SQLITE)('codegraph_field_sites no-searchable-files', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    // Only Python files — no TS/JS/TSX/JSX
    writeFile(root, 'src/util.py', 'def greet():\n  return "hello"\n');
    cg = await initProject(root);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    cleanup(root);
  });

  it('returns no-searchable-files for Python-only project', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'greet',
    });
    const text = result.content[0].text;
    expect(result.isError).toBeFalsy();
    expect(text).toContain('Status: no-searchable-files');
    expect(text).toContain('Field sites are static AST navigation hints');
  });
});

// ---------------------------------------------------------------------------
// Degradation path tests (all-skipped via source-too-large)
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_SQLITE)('codegraph_field_sites source-skip', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = tmpRoot();
    // Normal file that will be searched successfully
    writeFile(root, 'src/small.ts', 'export const x = 1;\n');
    // Seed file under the indexing size limit (1 MiB) so it gets indexed,
    // then replace it with oversized content so the field-sites analyzer
    // skips it as source-too-large.
    writeFile(root, 'src/huge.ts', 'export const y = 2;\n');
    cg = await initProject(root);
    await cg.indexAll();
    // Now overwrite with content > maxSourceBytes (default 1 MiB).
    const overLimit = '// valid ts\nconst big = "' + 'a'.repeat(1100 * 1024) + '";\n';
    writeFile(root, 'src/huge.ts', overLimit);
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    cleanup(root);
  });

  it('reports source-too-large in skipped summary for oversized files', async () => {
    const result = await handler.execute('codegraph_field_sites', {
      field: 'systemPrompt',
    });
    const text = result.content[0].text;
    expect(result.isError).toBeFalsy();
    expect(text).toContain('Searched indexed files:');
    expect(text).toContain('Field sites are static AST navigation hints');
    // The huge file should be skipped as source-too-large.
    expect(text).toContain('source-too-large');
    // The small file should appear in searchable files count.
    expect(text).toContain('Searchable TS/JS files: 2');
  });
});
