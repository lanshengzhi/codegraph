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
describe('codegraph_status schema', () => {
  it('is registered in the tools array', () => {
    const tool = tools.find((t) => t.name === 'codegraph_status');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('codegraph_status');
  });

  it('has detail, checkFilesystem, limit, and projectPath properties', () => {
    const tool = tools.find((t) => t.name === 'codegraph_status')!;
    const props = tool.inputSchema.properties;
    expect(props.detail).toBeDefined();
    expect(props.checkFilesystem).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.projectPath).toBeDefined();
  });

  it('detail enum includes summary and coverage', () => {
    const tool = tools.find((t) => t.name === 'codegraph_status')!;
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
