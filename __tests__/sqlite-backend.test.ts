/**
 * SQLite backend reporting.
 *
 * node:sqlite (Node's built-in real SQLite) is the sole backend. Pin that
 * DatabaseConnection / CodeGraph report it and come up in WAL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { CodeGraph } from '../src';
import type { Node, UnresolvedReference } from '../src/types';

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

function makeNode(id: string = 'func:src/app.ts:entry:1'): Node {
  return {
    id,
    kind: 'function',
    name: 'entry',
    qualifiedName: 'src/app.ts::entry',
    filePath: 'src/app.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 1,
    updatedAt: Date.now(),
  };
}

function makeRef(overrides: Partial<UnresolvedReference> = {}): UnresolvedReference {
  return {
    fromNodeId: 'func:src/app.ts:entry:1',
    referenceName: 'provider.streamSimple',
    referenceKind: 'calls',
    line: 2,
    column: 2,
    filePath: 'src/app.ts',
    language: 'typescript',
    metadata: {
      sourceEvidence: 'property-call',
      receiverText: 'provider',
      propertyText: 'streamSimple',
      calleeText: 'provider.streamSimple',
    },
    ...overrides,
  };
}

describe('DatabaseConnection — backend reporting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-backend-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the node-sqlite backend in WAL for an initialized DB', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    expect(conn.getBackend()).toBe('node-sqlite');
    expect(conn.getJournalMode()).toBe('wal');
    conn.close();
  });

  it('CodeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getBackend()).toBe('node-sqlite');
    } finally {
      cg.destroy();
    }
  });
});

describe('unresolved reference metadata schema', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-unresolved-metadata-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('initializes new databases with unresolved_refs.metadata', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    try {
      const columns = conn.getDb().prepare('PRAGMA table_info(unresolved_refs)').all() as Array<{ name: string }>;
      expect(columns.map((col) => col.name)).toContain('metadata');
      expect(conn.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      conn.close();
    }
  });

  it('round-trips unresolved reference metadata through all read paths', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    try {
      const queries = new QueryBuilder(conn.getDb());
      queries.insertNode(makeNode());
      queries.insertUnresolvedRef(makeRef());

      for (const refs of [
        queries.getUnresolvedReferences(),
        queries.getUnresolvedReferencesBatch(0, 10),
        queries.getUnresolvedReferencesByFiles(['src/app.ts']),
        queries.getUnresolvedByName('provider.streamSimple'),
      ]) {
        expect(refs).toHaveLength(1);
        expect(refs[0]!.metadata?.sourceEvidence).toBe('property-call');
        expect(refs[0]!.metadata?.receiverText).toBe('provider');
        expect(refs[0]!.metadata?.propertyText).toBe('streamSimple');
      }
    } finally {
      conn.close();
    }
  });

  it('treats null, malformed, and primitive metadata JSON as not recorded', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    try {
      const queries = new QueryBuilder(conn.getDb());
      const db = conn.getDb();
      queries.insertNode(makeNode());
      const stmt = db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, metadata)
        VALUES (?, ?, 'calls', 2, 0, NULL, 'src/app.ts', 'typescript', ?)
      `);
      for (const [name, metadata] of [
        ['nullish', null],
        ['malformed', '{not json'],
        ['string', '"primitive"'],
        ['number', '123'],
        ['array', '[]'],
      ] as Array<[string, string | null]>) {
        stmt.run(makeNode().id, name, metadata);
      }

      const refs = queries.getUnresolvedReferences();
      expect(refs).toHaveLength(5);
      expect(refs.every((ref) => ref.metadata === undefined)).toBe(true);
    } finally {
      conn.close();
    }
  });

  it.skipIf(!HAS_SQLITE)('migrates a real v4 database to v5 without changing old refs', () => {
    const dbPath = path.join(dir, 'v4.db');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
      INSERT INTO schema_versions (version, applied_at, description) VALUES
        (1, 1, 'Initial schema'),
        (2, 2, 'Add project metadata, provenance tracking, and unresolved ref context'),
        (3, 3, 'Add lower(name) expression index for memory-efficient case-insensitive lookups'),
        (4, 4, 'Drop redundant idx_edges_source / idx_edges_target');

      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        language TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL,
        end_column INTEGER NOT NULL,
        docstring TEXT,
        signature TEXT,
        visibility TEXT,
        is_exported INTEGER DEFAULT 0,
        is_async INTEGER DEFAULT 0,
        is_static INTEGER DEFAULT 0,
        is_abstract INTEGER DEFAULT 0,
        decorators TEXT,
        type_parameters TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_nodes_lower_name ON nodes(lower(name));

      CREATE TABLE edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata TEXT,
        line INTEGER,
        col INTEGER,
        provenance TEXT DEFAULT NULL,
        FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_edges_source_kind ON edges(source, kind);
      CREATE INDEX idx_edges_target_kind ON edges(target, kind);
      CREATE INDEX idx_edges_provenance ON edges(provenance);

      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        language TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        node_count INTEGER DEFAULT 0,
        errors TEXT
      );
      CREATE TABLE unresolved_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_node_id TEXT NOT NULL,
        reference_name TEXT NOT NULL,
        reference_kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        col INTEGER NOT NULL,
        candidates TEXT,
        file_path TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT 'unknown',
        FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_unresolved_file_path ON unresolved_refs(file_path);
      CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    const node = makeNode();
    db.prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(node.id, node.kind, node.name, node.qualifiedName, node.filePath, node.language, node.startLine, node.endLine, node.startColumn, node.endColumn, node.updatedAt);
    db.prepare(`
      INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
      VALUES (?, 'legacyCall', 'calls', 2, 0, NULL, 'src/app.ts', 'typescript')
    `).run(node.id);
    db.close();

    const conn = DatabaseConnection.open(dbPath);
    try {
      const columns = conn.getDb().prepare('PRAGMA table_info(unresolved_refs)').all() as Array<{ name: string }>;
      expect(columns.map((col) => col.name)).toContain('metadata');
      expect(conn.getSchemaVersion()?.version).toBe(5);
      const indexes = conn.getDb().prepare('PRAGMA index_list(edges)').all() as Array<{ name: string }>;
      expect(indexes.map((idx) => idx.name)).not.toContain('idx_edges_source');
      expect(indexes.map((idx) => idx.name)).not.toContain('idx_edges_target');
      const refs = new QueryBuilder(conn.getDb()).getUnresolvedReferences();
      expect(refs).toHaveLength(1);
      expect(refs[0]!.referenceName).toBe('legacyCall');
      expect(refs[0]!.metadata).toBeUndefined();
    } finally {
      conn.close();
    }
  });
});
