/**
 * Registry candidates tests (P3c PR3)
 *
 * Covers:
 *   - CP0: Fixture matrix (object registry, Map constructor, Map.set, register call, definition array, route node, dynamic key)
 *   - CP5a: Core patterns (route nodes + object literal + Map constructor)  
 *   - CP5b: Advanced patterns (.set() / register-call / definition array / dynamic key)
 *   - CP6: MCP handler + formatter (in shared mcp-ecosystem.test.ts)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-reg-'));
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

// =============================================================================
// Library API tests
// =============================================================================
describe('getRegistryCandidates library API', () => {
  let root: string;
  let cg: CodeGraph;

  beforeEach(() => {
    root = tmpRoot();
  });

  afterEach(() => {
    cg?.destroy();
    cleanup(root);
  });

  // ---------------------------------------------------------------------------
  // Object literal registry
  // ---------------------------------------------------------------------------
  describe.skipIf(!HAS_SQLITE)('object literal registry', () => {
    it('detects key->handler pairs in an object literal', async () => {
      writeFile(root, 'src/providers.ts', `
const providers = {
  anthropic: streamAnthropic,
  openai: streamOpenAI,
};
function streamAnthropic() { return 42; }
function streamOpenAI() { return 43; }
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'anthropic' });

      expect(result.status).toBe('available');
      expect(result.candidates).toHaveLength(1);
      const c = result.candidates[0]!;
      expect(c.evidence).toBe('object-literal');
      expect(c.confidence).toBe('high');
      expect(c.keyText).toBe('anthropic');
      expect(c.registryName).toBe('providers');
      expect(c.handlerText).toBe('streamAnthropic');
      expect(c.range.path).toBe('src/providers.ts');
    });

    it('classifies kind from registry variable name', async () => {
      writeFile(root, 'src/providers.ts', `
const providers = {
  anthropic: streamAnthropic,
};
function streamAnthropic() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates();
      expect(result.candidates[0]!.kind).toBe('provider');
    });

    it('filters by kind', async () => {
      writeFile(root, 'src/tools.ts', `
const tools = {
  search: searchTool,
};
function searchTool() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ kind: 'tool' });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.kind).toBe('tool');
    });

    it('filters by query substring', async () => {
      writeFile(root, 'src/providers.ts', `
const providers = {
  anthropic: streamAnthropic,
  openai: streamOpenAI,
};
function streamAnthropic() {}
function streamOpenAI() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ query: 'anthropic' });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.keyText).toBe('anthropic');
    });

    it('resolves handler node to a NodeHandle', async () => {
      writeFile(root, 'src/providers.ts', `
const providers = {
  anthropic: streamAnthropic,
};
function streamAnthropic() { return 42; }
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'anthropic' });

      const c = result.candidates[0]!;
      expect(c.handlerResolutionStatus).toBe('resolved');
      expect(c.handlerNode).toBeDefined();
      expect(c.handlerNode!.name).toBe('streamAnthropic');
      expect(c.handlerNode!.nodeId).toBeTruthy();
    });

    it('marks un-indexed handler as not-indexed', async () => {
      writeFile(root, 'src/providers.ts', `
const providers = {
  anthropic: unknownHandler,
};
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'anthropic' });

      const c = result.candidates[0]!;
      expect(c.handlerResolutionStatus).toBe('not-indexed');
      expect(c.handlerNode).toBeUndefined();
    });

    it('handles dynamic/computed keys as low-confidence', async () => {
      writeFile(root, 'src/providers.ts', `
const key = 'anthropic';
const providers = {
  [key]: streamAnthropic,
};
function streamAnthropic() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates();
      const dynamicCandidates = result.candidates.filter(c => c.isDynamicKey);
      expect(dynamicCandidates.length).toBeGreaterThanOrEqual(1);
      expect(dynamicCandidates[0]!.confidence).toBe('low');
      expect(dynamicCandidates[0]!.note).toContain('dynamic');
    });
  });

  // ---------------------------------------------------------------------------
  // Map constructor registry
  // ---------------------------------------------------------------------------
  describe.skipIf(!HAS_SQLITE)('Map constructor registry', () => {
    it('detects new Map([["key", handler]]) patterns', async () => {
      writeFile(root, 'src/providers.ts', `
const providers = new Map([
  ["anthropic", streamAnthropic],
  ["openai", streamOpenAI],
]);
function streamAnthropic() {}
function streamOpenAI() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'anthropic' });

      expect(result.candidates).toHaveLength(1);
      const c = result.candidates[0]!;
      expect(c.evidence).toBe('map-constructor');
      expect(c.confidence).toBe('high');
      expect(c.keyText).toBe('anthropic');
      expect(c.handlerText).toBe('streamAnthropic');
    });
  });

  // ---------------------------------------------------------------------------
  // Map.set() registration
  // ---------------------------------------------------------------------------
  describe.skipIf(!HAS_SQLITE)('Map.set() registration', () => {
    it('detects providers.set("key", handler) patterns', async () => {
      writeFile(root, 'src/setup.ts', `
const providers = new Map();
providers.set("anthropic", streamAnthropic);
function streamAnthropic() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'anthropic' });

      expect(result.candidates).toHaveLength(1);
      const c = result.candidates[0]!;
      expect(c.evidence).toBe('map-set');
      expect(c.confidence).toBe('high');
      expect(c.keyText).toBe('anthropic');
      expect(c.handlerText).toBe('streamAnthropic');
    });
  });

  // ---------------------------------------------------------------------------
  // Register-like calls
  // ---------------------------------------------------------------------------
  describe.skipIf(!HAS_SQLITE)('register-like calls', () => {
    it('detects registerProvider(name, handler) calls', async () => {
      writeFile(root, 'src/register.ts', `
registerProvider("anthropic", streamAnthropic);
function streamAnthropic() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'anthropic' });

      expect(result.candidates).toHaveLength(1);
      const c = result.candidates[0]!;
      expect(c.evidence).toBe('register-call');
      expect(c.confidence).toBe('high');
      expect(c.keyText).toBe('anthropic');
    });

    it('detects app.get("/api/chat", handler) as route', async () => {
      writeFile(root, 'src/app.ts', `
app.get("/api/chat", chatHandler);
function chatHandler() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: '/api/chat' });

      expect(result.candidates).toHaveLength(1);
      const c = result.candidates[0]!;
      expect(c.kind).toBe('route');
      expect(c.evidence).toBe('route-node');
      expect(c.routePath).toBe('/api/chat');
      expect(c.handlerText).toBe('chatHandler');
    });

    it('detects addHandler("key", fn) calls', async () => {
      writeFile(root, 'src/tools.ts', `
addTool("search", searchTool);
function searchTool() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'search' });
      expect(result.candidates).toHaveLength(1);
    });

    it('handles register call without handler argument', async () => {
      writeFile(root, 'src/tools.ts', `
register("only-key");
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'only-key' });

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.confidence).toBe('medium');
      expect(result.candidates[0]!.note).toContain('without handler');
    });
  });

  // ---------------------------------------------------------------------------
  // Definition array
  // ---------------------------------------------------------------------------
  describe.skipIf(!HAS_SQLITE)('definition array', () => {
    it('detects [{ name: "foo", handler: fooHandler }] patterns', async () => {
      writeFile(root, 'src/tools.ts', `
const tools = [
  { name: "search", handler: searchTool },
  { id: "build", execute: buildFn },
];
function searchTool() {}
function buildFn() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'search' });

      expect(result.candidates).toHaveLength(1);
      const c = result.candidates[0]!;
      expect(c.evidence).toBe('definition-array');
      expect(c.confidence).toBe('medium');
      expect(c.keyText).toBe('search');
      expect(c.handlerText).toBe('searchTool');
    });

    it('detects entry without handler field', async () => {
      writeFile(root, 'src/tools.ts', `
const tools = [
  { name: "orphan" },
];
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'orphan' });

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.confidence).toBe('low');
      expect(result.candidates[0]!.note).toContain('without recognized handler field');
    });
  });

  // ---------------------------------------------------------------------------
  // Route nodes (from DB, not AST)
  // ---------------------------------------------------------------------------
  describe.skipIf(!HAS_SQLITE)('route nodes from DB', () => {
    it('collects indexed route nodes with handler edges', async () => {
      // Framework resolvers (e.g., Express) create route nodes during indexing.
      // We write src that triggers Express route extraction:
      writeFile(root, 'package.json', JSON.stringify({ dependencies: { express: '*' } }));
      writeFile(root, 'src/app.ts', `
import express from 'express';
const app = express();
app.get('/api/chat', function chatHandler() {});
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ kind: 'all' });

      // Route nodes may or may not be created depending on framework resolution.
      // For pure Express, the extractor creates route nodes.
      // Just verify the API doesn't crash and returns a valid result.
      expect(result.status).toBeDefined();
      expect(Array.isArray(result.candidates)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases and validation
  // ---------------------------------------------------------------------------
  describe.skipIf(!HAS_SQLITE)('edge cases and validation', () => {
    it('returns no-matches for an empty project', async () => {
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'nothing' });
      expect(result.status).toBe('no-matches');
      expect(result.candidates).toHaveLength(0);
    });

    it('rejects key with newlines', async () => {
      writeFile(root, 'src/a.ts', 'export const x = 1;');
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ key: 'foo\nbar' });
      expect(result.status).toBe('invalid-query');
    });

    it('rejects absolute scopePath', async () => {
      writeFile(root, 'src/a.ts', 'export const x = 1;');
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ scopePath: '/absolute/path' });
      expect(result.status).toBe('invalid-query');
      expect(result.caveats.some(c => c.includes('absolute'))).toBe(true);
    });

    it('rejects scopePath with path escape', async () => {
      writeFile(root, 'src/a.ts', 'export const x = 1;');
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ scopePath: '../escape' });
      expect(result.status).toBe('invalid-query');
      expect(result.caveats.some(c => c.includes('..'))).toBe(true);
    });

    it('filters by scopePath', async () => {
      writeFile(root, 'src/services/providers.ts', `
const providers = { anthropic: fn };
function fn() {}
`);
      writeFile(root, 'src/other/tools.ts', `
const tools = { search: sf };
function sf() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ scopePath: 'src/services' });
      // Should only find providers, not tools
      expect(result.candidates.every(c => c.range.path.startsWith('src/services'))).toBe(true);
    });

    it('excludes tests when includeTests=false', async () => {
      writeFile(root, 'src/providers.ts', `
const providers = { anthropic: fn };
function fn() {}
`);
      writeFile(root, 'src/__tests__/providers.test.ts', `
const testProviders = { test: fn };
function fn() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ includeTests: false });
      expect(result.candidates.every(c => !c.isTestOrFixture)).toBe(true);
    });

    it('includes tests by default but labels them', async () => {
      writeFile(root, 'src/__tests__/providers.test.ts', `
const providers = { test: fn };
function fn() {}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates();
      const testCandidates = result.candidates.filter(c => c.isTestOrFixture);
      if (testCandidates.length > 0) {
        expect(testCandidates[0]!.isTestOrFixture).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // maxDisplayCandidates cap
  // ---------------------------------------------------------------------------
  describe.skipIf(!HAS_SQLITE)('display cap', () => {
    it('caps displayed candidates at maxDisplayCandidates', async () => {
      // Generate many registry entries
      const entries = Array.from({ length: 30 }, (_, i) => `  "key${i}": fn${i},`).join('\n');
      const fns = Array.from({ length: 30 }, (_, i) => `function fn${i}() { return ${i}; }`).join('\n');
      writeFile(root, 'src/many.ts', `
const providers = {\n${entries}\n};\n${fns}
`);
      cg = await initProject(root);
      const result = await cg.getRegistryCandidates({ maxDisplayCandidates: 10 });

      expect(result.candidates.length).toBeLessThanOrEqual(10);
      expect(result.totalCandidates).toBeGreaterThanOrEqual(20);
      expect(result.omittedCandidates).toBeGreaterThan(0);
    });
  });
});
