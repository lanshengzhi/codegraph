/**
 * Coverage / Status Report Builder (P3a)
 *
 * Generates an indexed-source coverage explanation from existing DB records.
 * No DB schema changes; query-time only.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CoverageReport,
  CoverageReportOptions,
  CoverageStatus,
  FileRecord,
  GraphStats,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { scanDirectory } from '../extraction';
import { loadProjectAliases } from '../resolution/path-aliases';
import { logDebug } from '../errors';

const DEFAULT_LIMIT = 20;
const DEFAULT_FS_TIMEOUT_MS = 5000;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function topRoots(files: FileRecord[], limit: number): Array<{ path: string; files: number }> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.path.split('/');
    // Drop the filename; aggregate by first 1-2 directory segments for useful granularity.
    const dirParts = parts.slice(0, -1);
    const depth = Math.min(2, Math.max(1, dirParts.length));
    const root = dirParts.slice(0, depth).join('/');
    if (root) {
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([path, files]) => ({ path, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, limit);
}

function readWorkspaceSummary(projectRoot: string): { packageCount: number; source: string } | undefined {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return undefined;
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { workspaces?: string[] | { packages?: string[] } };
    const ws = pkg.workspaces;
    if (!ws) return undefined;
    if (Array.isArray(ws)) {
      return { packageCount: ws.length, source: 'package.json workspaces' };
    }
    if (ws.packages && Array.isArray(ws.packages)) {
      return { packageCount: ws.packages.length, source: 'package.json workspaces.packages' };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readPnpmWorkspace(projectRoot: string): { packageCount: number; source: string } | undefined {
  try {
    const yamlPath = path.join(projectRoot, 'pnpm-workspace.yaml');
    if (!fs.existsSync(yamlPath)) return undefined;
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    // Very simple YAML line parser for `packages:` list
    const lines = raw.split('\n');
    let inPackages = false;
    let count = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('packages:')) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        if (trimmed.startsWith('- ')) {
          count++;
        } else if (trimmed.length > 0 && !trimmed.startsWith('#')) {
          // End of list
          break;
        }
      }
    }
    if (count > 0) {
      return { packageCount: count, source: 'pnpm-workspace.yaml' };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readAliasSummary(projectRoot: string): { source: 'tsconfig' | 'jsconfig'; patternCount: number; patterns: string[] } | undefined {
  const aliases = loadProjectAliases(projectRoot);
  if (!aliases || aliases.patterns.length === 0) return undefined;
  const source = fs.existsSync(path.join(projectRoot, 'tsconfig.json')) ? ('tsconfig' as const) : ('jsconfig' as const);
  return {
    source,
    patternCount: aliases.patterns.length,
    patterns: aliases.patterns.map((p) => `${p.prefix}*${p.suffix}`),
  };
}

export function buildCoverageReport(
  projectRoot: string,
  stats: GraphStats,
  files: FileRecord[],
  queries: QueryBuilder,
  getChangedFiles: () => { added: string[]; modified: string[]; removed: string[] },
  options?: CoverageReportOptions
): CoverageReport {
  const limit = clamp(options?.limit ?? DEFAULT_LIMIT, 1, 200);
  const detail = options?.detail ?? 'summary';

  const status: CoverageStatus = stats.fileCount > 0 ? 'available' : 'no-index';

  const pending = getChangedFiles();
  const pendingSamples = [...pending.added, ...pending.modified, ...pending.removed].slice(0, limit);

  // Extraction errors from FileRecord.errors
  let totalErrorFiles = 0;
  const errorSamples: Array<{ path: string; errors: string[] }> = [];
  for (const f of files) {
    if (f.errors && f.errors.length > 0) {
      totalErrorFiles++;
      if (errorSamples.length < limit) {
        errorSamples.push({ path: f.path, errors: f.errors.map((e) => e.message) });
      }
    }
  }

  // Unresolved refs summary (bounded)
  const unresolvedSummary = queries.getUnresolvedReferencesSummary(limit);

  // Workspace summary
  const workspaceSummary = readWorkspaceSummary(projectRoot) ?? readPnpmWorkspace(projectRoot);

  // Alias summary
  const aliasSummary = readAliasSummary(projectRoot);

  const caveats: string[] = [
    'CodeGraph reports indexed source coverage, not a complete filesystem inventory.',
    'New, ignored, unsupported, non-source, or unsynced files may not appear.',
  ];

  const recommendations: string[] = [
    'Use `git status`, `read <path>`, or `codegraph sync --quiet` to verify filesystem state.',
  ];

  // Warn if pnpm-workspace.yaml exists but couldn't be parsed
  if (!workspaceSummary && fs.existsSync(path.join(projectRoot, 'pnpm-workspace.yaml'))) {
    caveats.push('pnpm-workspace.yaml found but could not be parsed; workspace summary unavailable.');
  }

  if (detail === 'summary') {
    return {
      status,
      indexedOnly: true,
      fileCount: stats.fileCount,
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      filesByLanguage: stats.filesByLanguage,
      topIndexedRoots: topRoots(files, 5),
      pendingChanges: { added: pending.added.length, modified: pending.modified.length, removed: pending.removed.length, samples: pendingSamples },
      extractionErrors: { count: totalErrorFiles, samples: errorSamples },
      unresolvedRefs: unresolvedSummary,
      workspaceSummary,
      aliasSummary,
      filesystemCheck: { enabled: false, missingFromIndex: { count: 0, samples: [] }, indexedButMissing: { count: 0, samples: [] } },
      caveats,
      recommendations,
    };
  }

  // detail === 'coverage'
  let filesystemCheck: CoverageReport['filesystemCheck'] = {
    enabled: false,
    missingFromIndex: { count: 0, samples: [] },
    indexedButMissing: { count: 0, samples: [] },
  };

  if (options?.checkFilesystem) {
    const timeoutMs = options.filesystemScanTimeoutMs ?? DEFAULT_FS_TIMEOUT_MS;
    const start = Date.now();
    try {
      const fsFiles = scanDirectory(projectRoot);
      if (Date.now() - start > timeoutMs) {
        return {
          status: 'filesystem-scan-skipped' as CoverageStatus,
          indexedOnly: true,
          fileCount: stats.fileCount,
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
          filesByLanguage: stats.filesByLanguage,
          topIndexedRoots: topRoots(files, limit),
          pendingChanges: { added: pending.added.length, modified: pending.modified.length, removed: pending.removed.length, samples: pendingSamples },
          extractionErrors: { count: totalErrorFiles, samples: errorSamples },
          unresolvedRefs: unresolvedSummary,
          workspaceSummary,
          aliasSummary,
          filesystemCheck: {
            enabled: true,
            supportedSourceFiles: fsFiles.length,
            missingFromIndex: { count: 0, samples: [] },
            indexedButMissing: { count: 0, samples: [] },
          },
          caveats: [
            ...caveats,
            `Filesystem scan exceeded ${timeoutMs}ms timeout.`,
            'Results are partial; try again with a narrower scope or increase timeout.',
          ],
          recommendations: [
            ...recommendations,
            'Reduce the project scope or increase filesystemScanTimeoutMs.',
          ],
        };
      }

      const indexedPaths = new Set(files.map((f) => f.path));
      const fsPaths = new Set(fsFiles);

      let totalMissingFromIndex = 0;
      const missingFromIndexSamples: string[] = [];
      for (const p of fsPaths) {
        if (!indexedPaths.has(p)) {
          totalMissingFromIndex++;
          if (missingFromIndexSamples.length < limit) {
            missingFromIndexSamples.push(p);
          }
        }
      }

      let totalIndexedButMissing = 0;
      const indexedButMissingSamples: string[] = [];
      for (const p of indexedPaths) {
        if (!fsPaths.has(p)) {
          totalIndexedButMissing++;
          if (indexedButMissingSamples.length < limit) {
            indexedButMissingSamples.push(p);
          }
        }
      }

      filesystemCheck = {
        enabled: true,
        supportedSourceFiles: fsFiles.length,
        missingFromIndex: { count: totalMissingFromIndex, samples: missingFromIndexSamples },
        indexedButMissing: { count: totalIndexedButMissing, samples: indexedButMissingSamples },
      };
    } catch (err) {
      logDebug('coverage filesystem scan failed', { err: String(err) });
      caveats.push('Filesystem scan failed; coverage reflects indexed files only.');
      filesystemCheck = {
        enabled: true,
        missingFromIndex: { count: 0, samples: [] },
        indexedButMissing: { count: 0, samples: [] },
      };
    }
  }

  // Build more detailed top roots
  const topRootsDetailed = topRoots(files, limit);

  // Build recommendations based on findings
  if (pendingSamples.length > 0) {
    recommendations.unshift('Run `codegraph sync --quiet` to incorporate pending changes.');
  }
  if (errorSamples.length > 0) {
    recommendations.push(`Check ${errorSamples.length} file(s) with extraction errors for unsupported syntax or parser issues.`);
  }
  if (unresolvedSummary.count > 0) {
    recommendations.push('Run `codegraph sync --quiet` or re-index to resolve ' + unresolvedSummary.count + ' unresolved references.');
  }

  return {
    status,
    indexedOnly: true,
    fileCount: stats.fileCount,
    nodeCount: stats.nodeCount,
    edgeCount: stats.edgeCount,
    filesByLanguage: stats.filesByLanguage,
    topIndexedRoots: topRootsDetailed,
    pendingChanges: { added: pending.added.length, modified: pending.modified.length, removed: pending.removed.length, samples: pendingSamples },
    extractionErrors: { count: totalErrorFiles, samples: errorSamples },
    unresolvedRefs: unresolvedSummary,
    workspaceSummary,
    aliasSummary,
    filesystemCheck,
    caveats,
    recommendations,
  };
}
