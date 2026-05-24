/**
 * Workspace Import Candidates Tests (P3b)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import {
  getWorkspacePackages,
  clearWorkspacePackageCache,
  parseWorkspaceSpecifier,
} from '../src/ecosystem/package-workspace';

describe('parseWorkspaceSpecifier', () => {
  it('parses bare package name', () => {
    expect(parseWorkspaceSpecifier('pkg')).toEqual({ packageName: 'pkg', subpath: null });
  });

  it('parses bare package with subpath', () => {
    expect(parseWorkspaceSpecifier('pkg/stream')).toEqual({ packageName: 'pkg', subpath: 'stream' });
  });

  it('parses scoped package name', () => {
    expect(parseWorkspaceSpecifier('@scope/pkg')).toEqual({ packageName: '@scope/pkg', subpath: null });
  });

  it('parses scoped package with subpath', () => {
    expect(parseWorkspaceSpecifier('@scope/pkg/stream')).toEqual({ packageName: '@scope/pkg', subpath: 'stream' });
  });

  it('returns null for relative path', () => {
    expect(parseWorkspaceSpecifier('./pkg')).toBeNull();
    expect(parseWorkspaceSpecifier('../pkg')).toBeNull();
  });

  it('returns null for absolute path', () => {
    expect(parseWorkspaceSpecifier('/pkg')).toBeNull();
  });
});

describe('getWorkspaceImportCandidates', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-'));
    clearWorkspacePackageCache();
  });

  afterEach(() => {
    clearWorkspacePackageCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  function writeFile(relPath: string, content: string) {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }

  it('returns no-workspaces when no workspace config', async () => {
    const cg = CodeGraph.initSync(tmpDir);
    const result = cg.getWorkspaceImportCandidates('@scope/pkg');
    expect(result.status).toBe('no-workspaces');
    cg.close();
  });

  it('returns package-not-found when workspaces exist but package is missing', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile('packages/a/package.json', JSON.stringify({ name: '@scope/a' }));

    const cg = CodeGraph.initSync(tmpDir);
    const result = cg.getWorkspaceImportCandidates('@scope/missing');
    expect(result.status).toBe('package-not-found');
    cg.close();
  });

  it('finds workspace package via package.json workspaces array', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile('packages/ai/package.json', JSON.stringify({
      name: '@scope/ai',
      exports: { '.': './src/index.ts' },
    }));
    writeFile('packages/ai/src/index.ts', 'export function streamSimple() {}');

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const result = cg.getWorkspaceImportCandidates('@scope/ai');
    expect(result.status).toBe('available');
    expect(result.package).toBeDefined();
    expect(result.package!.name).toBe('@scope/ai');
    expect(result.candidates.length).toBeGreaterThan(0);

    const exact = result.candidates.find((c) => c.evidence === 'exports-exact');
    expect(exact).toBeDefined();
    expect(exact!.sourcePath).toBe('packages/ai/src/index.ts');
    expect(exact!.confidence).toBeGreaterThan(0.9);

    cg.close();
  });

  it('finds workspace package via package.json workspaces.packages object', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: { packages: ['packages/*'] } }));
    writeFile('packages/b/package.json', JSON.stringify({ name: 'pkg-b' }));
    writeFile('packages/b/src/index.ts', 'export const x = 1;');

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const result = cg.getWorkspaceImportCandidates('pkg-b');
    expect(result.status).toBe('available');
    expect(result.candidates.length).toBeGreaterThan(0);

    cg.close();
  });

  it('finds workspace package via pnpm-workspace.yaml', async () => {
    writeFile('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    writeFile('packages/c/package.json', JSON.stringify({ name: 'pkg-c' }));
    writeFile('packages/c/src/index.ts', 'export const y = 2;');

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const result = cg.getWorkspaceImportCandidates('pkg-c');
    expect(result.status).toBe('available');
    expect(result.candidates.length).toBeGreaterThan(0);

    cg.close();
  });

  it('resolves subpath candidate', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile('packages/ai/package.json', JSON.stringify({
      name: '@scope/ai',
      exports: { './stream': './src/stream.ts' },
    }));
    writeFile('packages/ai/src/stream.ts', 'export function streamSimple() {}');

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const result = cg.getWorkspaceImportCandidates('@scope/ai/stream');
    expect(result.status).toBe('available');

    const exact = result.candidates.find((c) => c.evidence === 'exports-exact');
    expect(exact).toBeDefined();
    expect(exact!.sourcePath).toBe('packages/ai/src/stream.ts');

    cg.close();
  });

  it('follows re-export chain for symbol', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile('packages/ai/package.json', JSON.stringify({
      name: '@scope/ai',
      exports: { '.': './src/index.ts' },
    }));
    writeFile('packages/ai/src/index.ts', 'export { streamSimple } from "./stream";');
    writeFile('packages/ai/src/stream.ts', 'export function streamSimple() { return 42; }');

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const result = cg.getWorkspaceImportCandidates('@scope/ai', { symbol: 'streamSimple' });
    expect(result.status).toBe('available');

    const best = result.candidates[0];
    expect(best).toBeDefined();
    expect(best!.symbolNode).toBeDefined();
    expect(best!.symbolNode!.name).toBe('streamSimple');
    expect(best!.reExportChain).toBeDefined();
    expect(best!.reExportChain!.length).toBeGreaterThan(0);

    cg.close();
  });

  it('chases symbol through second candidate when first candidate file is missing', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile('packages/ai/package.json', JSON.stringify({
      name: '@scope/ai',
      exports: { '.': './dist/index.js' }, // points to a missing dist file
      main: './src/index.ts', // fallback to existing source
    }));
    writeFile('packages/ai/src/index.ts', 'export function streamSimple() { return 42; }');

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const result = cg.getWorkspaceImportCandidates('@scope/ai', { symbol: 'streamSimple' });
    expect(result.status).toBe('available');

    // The exports-exact candidate (dist/index.js) is highest confidence but missing,
    // so symbol chase should fall through to the main-field candidate (src/index.ts).
    const srcCandidate = result.candidates.find((c) => c.sourcePath === 'packages/ai/src/index.ts');
    expect(srcCandidate).toBeDefined();
    expect(srcCandidate!.symbolNode).toBeDefined();
    expect(srcCandidate!.symbolNode!.name).toBe('streamSimple');

    cg.close();
  });

  it('applies dist-to-src heuristic with low confidence', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile('packages/ai/package.json', JSON.stringify({
      name: '@scope/ai',
      main: 'dist/lib.js',
    }));
    writeFile('packages/ai/src/lib.ts', 'export function foo() {}');

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const result = cg.getWorkspaceImportCandidates('@scope/ai', { includeUnindexed: true });
    const heuristic = result.candidates.find((c) => c.evidence === 'dist-to-src-heuristic');
    expect(heuristic).toBeDefined();
    expect(heuristic!.sourcePath).toBe('packages/ai/src/lib.ts');
    expect(heuristic!.confidence).toBeLessThan(0.5);

    cg.close();
  });

  it('returns invalid-specifier for relative paths', async () => {
    const cg = CodeGraph.initSync(tmpDir);
    const result = cg.getWorkspaceImportCandidates('./relative');
    expect(result.status).toBe('invalid-specifier');
    cg.close();
  });

  it('does not return external npm packages as workspace candidates', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile('packages/a/package.json', JSON.stringify({ name: '@scope/a' }));

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const result = cg.getWorkspaceImportCandidates('react');
    expect(result.status).toBe('package-not-found');

    cg.close();
  });

  it('respects includeUnindexed flag', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile('packages/a/package.json', JSON.stringify({
      name: '@scope/a',
      exports: { '.': './src/index.ts' },
    }));
    writeFile('packages/a/src/index.ts', 'export function foo() {}');

    const cg = CodeGraph.initSync(tmpDir);
    // Do NOT index — so nothing is indexed

    // Default: includeUnindexed=false should exclude files that exist but are not indexed
    const resultIndexed = cg.getWorkspaceImportCandidates('@scope/a', { includeUnindexed: false });
    expect(resultIndexed.candidates.length).toBe(0);
    expect(resultIndexed.status).toBe('no-candidates');

    // includeUnindexed=true should include files that exist but are not indexed
    const resultUnindexed = cg.getWorkspaceImportCandidates('@scope/a', { includeUnindexed: true });
    expect(resultUnindexed.candidates.length).toBeGreaterThan(0);
    expect(resultUnindexed.candidates.every((c) => !c.indexed)).toBe(true);

    cg.close();
  });

  it('returns no-candidates when nothing matches', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile('packages/a/package.json', JSON.stringify({ name: '@scope/a' }));
    // No src/index.ts, no exports, no main

    const cg = CodeGraph.initSync(tmpDir);
    const result = cg.getWorkspaceImportCandidates('@scope/a');
    // With no entry files on disk, should return no-candidates or available with empty
    // Actually our buildEntryCandidates generates conventional paths even if they don't exist.
    // With includeUnindexed: false (default), those non-existing paths are filtered out.
    expect(result.status).toBe('no-candidates');

    cg.close();
  });
});

describe('Workspace resolver integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-res-'));
    clearWorkspacePackageCache();
  });

  afterEach(() => {
    clearWorkspacePackageCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function writeFile(relPath: string, content: string) {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }

  it('resolves workspace import to indexed source in resolver', async () => {
    writeFile('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    writeFile('packages/ai/package.json', JSON.stringify({
      name: '@scope/ai',
      exports: { '.': './src/index.ts' },
    }));
    writeFile('packages/ai/src/index.ts', 'export function streamSimple() { return 42; }');
    writeFile('src/app.ts', 'import { streamSimple } from "@scope/ai";\nfunction runApp() { streamSimple(); }');

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Verify the unresolved ref for streamSimple was resolved via workspace package
    const appNodes = cg.getNodesInFile('src/app.ts');
    const runNode = appNodes.find((n) => n.name === 'runApp' && n.kind === 'function');
    expect(runNode).toBeDefined();

    const edges = cg.getOutgoingEdges(runNode!.id);
    const callEdge = edges.find((e) => e.kind === 'calls');
    expect(callEdge).toBeDefined();

    const targetNode = cg['queries'].getNodeById(callEdge!.target);
    expect(targetNode).toBeDefined();
    expect(targetNode!.name).toBe('streamSimple');
    expect(targetNode!.filePath).toBe('packages/ai/src/index.ts');

    cg.close();
  });
});
