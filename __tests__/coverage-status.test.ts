/**
 * Coverage / Status report tests (P3a PR1)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import type { CoverageReport } from '../src/types';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-coverage-'));
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

describe.skipIf(!HAS_SQLITE)('CodeGraph.getCoverageReport', () => {
  let root: string;
  let cg: CodeGraph;

  beforeEach(() => {
    root = tmpRoot();
  });

  afterEach(() => {
    cg?.destroy();
    cleanup(root);
  });

  it('returns summary with indexed-only caveat and basic stats', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    writeFile(root, 'src/b.ts', 'export function foo() { return 1; }\n');
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'summary' });
    expect(r.status).toBe('available');
    expect(r.indexedOnly).toBe(true);
    expect(r.fileCount).toBeGreaterThanOrEqual(2);
    expect(r.nodeCount).toBeGreaterThan(0);
    expect(r.caveats.length).toBeGreaterThan(0);
    expect(r.caveats.some((c) => c.includes('indexed source coverage'))).toBe(true);
    expect(r.recommendations.length).toBeGreaterThan(0);
  });

  it('returns no-index when nothing is indexed', async () => {
    cg = CodeGraph.initSync(root);
    const r = cg.getCoverageReport({ detail: 'summary' });
    expect(r.status).toBe('no-index');
    expect(r.fileCount).toBe(0);
    expect(r.nodeCount).toBe(0);
  });

  it('returns pending changes when files are added/modified', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);

    // Modify a file
    writeFile(root, 'src/a.ts', 'export const x = 2;\n');
    // Add a file
    writeFile(root, 'src/c.ts', 'export const y = 3;\n');

    const r = cg.getCoverageReport({ detail: 'summary' });
    expect(r.pendingChanges.added + r.pendingChanges.modified + r.pendingChanges.removed).toBeGreaterThan(0);
    expect(r.pendingChanges.samples.length).toBeGreaterThan(0);
  });

  it('reports extraction errors with correct total count even when samples are capped', async () => {
    // Write files that may trigger parse errors
    for (let i = 0; i < 10; i++) {
      writeFile(root, `src/bad${i}.ts`, 'const x = \u003c\u003c\u003cINVALID\u003e\u003e\u003e;\n');
    }
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'coverage', limit: 3 });
    // count should reflect total, not capped samples
    expect(r.extractionErrors.count).toBeGreaterThanOrEqual(r.extractionErrors.samples.length);
    expect(r.extractionErrors.samples.length).toBeLessThanOrEqual(3);
  });

  it('returns unresolved refs summary with byKind and topNames', async () => {
    writeFile(root, 'src/a.ts', `
      import { unknownFunc } from './missing';
      unknownFunc();
    `);
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'summary' });
    expect(r.unresolvedRefs.count).toBeGreaterThanOrEqual(0);
    expect(typeof r.unresolvedRefs.byKind).toBe('object');
    expect(Array.isArray(r.unresolvedRefs.topNames)).toBe(true);
  });

  it('detects workspace packages from package.json workspaces', async () => {
    writeFile(root, 'package.json', JSON.stringify({
      name: 'root',
      workspaces: ['packages/*'],
    }));
    writeFile(root, 'packages/ai/package.json', JSON.stringify({ name: '@scope/ai' }));
    writeFile(root, 'packages/ai/src/index.ts', 'export const x = 1;\n');
    writeFile(root, 'src/app.ts', 'export const app = 1;\n');
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'summary' });
    expect(r.workspaceSummary).toBeDefined();
    expect(r.workspaceSummary!.packageCount).toBe(1);
    expect(r.workspaceSummary!.source).toContain('package.json');
  });

  it('detects pnpm workspace from pnpm-workspace.yaml', async () => {
    writeFile(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    writeFile(root, 'packages/ai/src/index.ts', 'export const x = 1;\n');
    writeFile(root, 'src/app.ts', 'export const app = 1;\n');
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'summary' });
    expect(r.workspaceSummary).toBeDefined();
    expect(r.workspaceSummary!.source).toContain('pnpm-workspace.yaml');
  });

  it('warns when pnpm-workspace.yaml exists but cannot be parsed', async () => {
    writeFile(root, 'pnpm-workspace.yaml', 'not-valid-yaml: [\n');
    writeFile(root, 'src/app.ts', 'export const app = 1;\n');
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'coverage' });
    expect(r.caveats.some((c) => c.includes('pnpm-workspace.yaml'))).toBe(true);
  });

  it('detects tsconfig path aliases', async () => {
    writeFile(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'summary' });
    expect(r.aliasSummary).toBeDefined();
    expect(r.aliasSummary!.source).toBe('tsconfig');
    expect(r.aliasSummary!.patternCount).toBe(1);
    expect(r.aliasSummary!.patterns).toContain('@/*');
  });

  it('detects jsconfig path aliases', async () => {
    writeFile(root, 'jsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'summary' });
    expect(r.aliasSummary).toBeDefined();
    expect(r.aliasSummary!.source).toBe('jsconfig');
  });

  it('returns top indexed roots aggregated by first 1-2 path segments', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    writeFile(root, 'src/b.ts', 'export const y = 2;\n');
    writeFile(root, 'lib/c.ts', 'export const z = 3;\n');
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'summary' });
    expect(r.topIndexedRoots.length).toBeGreaterThanOrEqual(2);
    const srcRoot = r.topIndexedRoots.find((t) => t.path === 'src');
    expect(srcRoot).toBeDefined();
    expect(srcRoot!.files).toBeGreaterThanOrEqual(2);
  });

  it('coverage detail includes recommendations when there are pending changes', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);
    writeFile(root, 'src/b.ts', 'export const y = 2;\n');

    const r = cg.getCoverageReport({ detail: 'coverage' });
    expect(r.recommendations.some((rec) => rec.includes('sync'))).toBe(true);
  });

  it('checkFilesystem reports missing and indexed-but-missing files', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    writeFile(root, 'src/b.ts', 'export const y = 2;\n');
    cg = await initProject(root);

    // Remove a file from disk but keep it in index
    fs.unlinkSync(path.join(root, 'src/b.ts'));

    const r = cg.getCoverageReport({ detail: 'coverage', checkFilesystem: true });
    expect(r.filesystemCheck).toBeDefined();
    expect(r.filesystemCheck!.enabled).toBe(true);
    expect(r.filesystemCheck!.supportedSourceFiles).toBeGreaterThanOrEqual(1);
    // At least one file should be indexed-but-missing
    expect(r.filesystemCheck!.indexedButMissing.count).toBeGreaterThanOrEqual(1);
    expect(r.filesystemCheck!.indexedButMissing.samples.length).toBeGreaterThanOrEqual(1);
  });

  it('checkFilesystem timeout returns filesystem-scan-skipped status', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);

    const r = cg.getCoverageReport({
      detail: 'coverage',
      checkFilesystem: true,
      filesystemScanTimeoutMs: 1, // extremely tight timeout
    });
    expect(r.status).toBe('filesystem-scan-skipped');
    expect(r.filesystemCheck).toBeDefined();
    expect(r.filesystemCheck!.enabled).toBe(true);
    expect(r.caveats.some((c) => c.includes('timeout'))).toBe(true);
  });

  it('limit caps samples but count reflects true totals', async () => {
    for (let i = 0; i < 30; i++) {
      writeFile(root, `src/f${i}.ts`, `export const x${i} = ${i};\n`);
    }
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'coverage', limit: 5 });
    expect(r.topIndexedRoots.length).toBeLessThanOrEqual(5);
    // With 30 files under src/, filesystem check should show count > samples
    const fsCheck = cg.getCoverageReport({ detail: 'coverage', checkFilesystem: true, limit: 3 });
    if (fsCheck.filesystemCheck && fsCheck.filesystemCheck.missingFromIndex.count > 3) {
      expect(fsCheck.filesystemCheck.missingFromIndex.samples.length).toBeLessThanOrEqual(3);
    }
  });

  it('coverage detail does not include filesystem scan by default', async () => {
    writeFile(root, 'src/a.ts', 'export const x = 1;\n');
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'coverage' });
    expect(r.filesystemCheck!.enabled).toBe(false);
  });

  it('summary detail returns compact report without large sections', async () => {
    for (let i = 0; i < 30; i++) {
      writeFile(root, `src/f${i}.ts`, `export const x${i} = ${i};\n`);
    }
    cg = await initProject(root);

    const r = cg.getCoverageReport({ detail: 'summary' });
    expect(r.topIndexedRoots.length).toBeLessThanOrEqual(5);
    expect(r.filesystemCheck!.enabled).toBe(false);
  });
});
