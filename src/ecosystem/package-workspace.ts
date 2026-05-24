/**
 * Workspace Package Import Candidates (P3b)
 *
 * Discovers workspace packages from package.json / pnpm-workspace.yaml,
 * resolves import specifiers to source entry candidates, and optionally
 * chases symbols through barrel re-export chains.
 */

import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';
import {
  FileRecord,
  Language,
  Node,
  NodeHandle,
  WorkspaceImportCandidate,
  WorkspaceImportCandidatesResult,
  WorkspaceImportEvidence,
  WorkspaceImportOptions,
  WorkspacePackageInfo,
} from '../types';
import { extractReExports } from '../resolution/import-resolver';
import { logDebug } from '../errors';

const REEXPORT_MAX_DEPTH = 8;
const DEFAULT_LIMIT = 20;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Parse a workspace import specifier into package name and optional subpath. */
export function parseWorkspaceSpecifier(specifier: string): { packageName: string; subpath: string | null } | null {
  // Bare: "pkg" or "pkg/subpath"
  // Scoped: "@scope/pkg" or "@scope/pkg/subpath"
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) {
    return null;
  }
  const scopedMatch = specifier.match(/^(@[^/]+\/[^/]+)(?:\/(.+))?$/);
  if (scopedMatch) {
    return { packageName: scopedMatch[1]!, subpath: scopedMatch[2] ?? null };
  }
  const bareMatch = specifier.match(/^([^@/][^/]*)(?:\/(.+))?$/);
  if (bareMatch) {
    return { packageName: bareMatch[1]!, subpath: bareMatch[2] ?? null };
  }
  return null;
}

interface DiscoveredPackage {
  name: string;
  dir: string;
  packageJsonPath: string;
  workspacePattern: string;
}

/** Discover workspace packages by reading root manifests and matching patterns. */
function discoverWorkspacePackages(projectRoot: string): DiscoveredPackage[] {
  const patterns = readWorkspacePatterns(projectRoot);
  if (patterns.length === 0) return [];

  const packages: DiscoveredPackage[] = [];
  const seenDirs = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue; // negated patterns skipped at discovery
    const matcher = picomatch(pattern, { dot: false });
    // Walk the project root to find matching directories
    try {
      collectMatchingDirs(projectRoot, '', matcher, seenDirs, (relDir) => {
        const pkgJsonPath = path.join(projectRoot, relDir, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) return;
        try {
          const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
          const pkg = JSON.parse(raw) as { name?: string };
          if (typeof pkg.name === 'string' && pkg.name.length > 0) {
            packages.push({
              name: pkg.name,
              dir: relDir,
              packageJsonPath: pkgJsonPath,
              workspacePattern: pattern,
            });
          }
        } catch {
          // ignore unreadable package.json
        }
      });
    } catch (err) {
      logDebug('workspace discovery failed for pattern', { pattern, err: String(err) });
    }
  }

  return packages;
}

/** Read workspace patterns from package.json or pnpm-workspace.yaml. */
function readWorkspacePatterns(projectRoot: string): string[] {
  // 1. package.json workspaces
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw) as { workspaces?: string[] | { packages?: string[] } };
      const ws = pkg.workspaces;
      if (Array.isArray(ws)) return ws.filter((p): p is string => typeof p === 'string');
      if (ws && Array.isArray(ws.packages)) {
        return ws.packages.filter((p): p is string => typeof p === 'string');
      }
    }
  } catch {
    // fall through
  }

  // 2. pnpm-workspace.yaml
  try {
    const yamlPath = path.join(projectRoot, 'pnpm-workspace.yaml');
    if (fs.existsSync(yamlPath)) {
      const raw = fs.readFileSync(yamlPath, 'utf-8');
      const lines = raw.split('\n');
      let inPackages = false;
      const patterns: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('packages:')) {
          inPackages = true;
          continue;
        }
        if (inPackages) {
          if (trimmed.startsWith('- ')) {
            patterns.push(trimmed.slice(2).trim());
          } else if (trimmed.length > 0 && !trimmed.startsWith('#')) {
            break;
          }
        }
      }
      if (patterns.length > 0) return patterns;
    }
  } catch {
    // fall through
  }

  return [];
}

/** Recursively collect directories matching a picomatch matcher. */
function collectMatchingDirs(
  projectRoot: string,
  relDir: string,
  matcher: ReturnType<typeof picomatch>,
  seen: Set<string>,
  onMatch: (relDir: string) => void
): void {
  const fullDir = path.join(projectRoot, relDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fullDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === 'node_modules' || name === '.git' || name === '.codegraph' || name === 'dist' || name === 'build') {
      continue;
    }
    const childRel = relDir ? `${relDir}/${name}` : name;
    if (seen.has(childRel)) continue;

    // Check if this directory itself matches
    if (matcher(childRel)) {
      seen.add(childRel);
      onMatch(childRel);
    }

    // Also recurse — patterns like "packages/**" need deep traversal
    collectMatchingDirs(projectRoot, childRel, matcher, seen, onMatch);
  }
}

/** Load workspace packages with caching. */
let workspacePackageCache: DiscoveredPackage[] | undefined;
let workspacePackageCacheRoot: string | undefined;

export function getWorkspacePackages(projectRoot: string): DiscoveredPackage[] {
  if (workspacePackageCacheRoot === projectRoot && workspacePackageCache) {
    return workspacePackageCache;
  }
  workspacePackageCacheRoot = projectRoot;
  workspacePackageCache = discoverWorkspacePackages(projectRoot);
  return workspacePackageCache;
}

export function clearWorkspacePackageCache(): void {
  workspacePackageCache = undefined;
  workspacePackageCacheRoot = undefined;
}

/** Find a workspace package by its npm name. */
function findWorkspacePackage(projectRoot: string, packageName: string): DiscoveredPackage | undefined {
  return getWorkspacePackages(projectRoot).find((p) => p.name === packageName);
}

interface RawEntryCandidate {
  sourcePath: string;
  evidence: WorkspaceImportEvidence;
  confidence: number;
  conditionPath?: string[];
  exportField?: string;
}

/** Build entry candidates from a package's package.json fields. */
function buildEntryCandidates(pkgDir: string, pkgJson: unknown, subpath: string | null): RawEntryCandidate[] {
  const pkg = pkgJson as Record<string, unknown>;
  const candidates: RawEntryCandidate[] = [];
  const seenPaths = new Set<string>();

  const add = (c: RawEntryCandidate) => {
    const normalized = c.sourcePath.replace(/\\/g, '/');
    if (seenPaths.has(normalized)) return;
    seenPaths.add(normalized);
    candidates.push({ ...c, sourcePath: normalized });
  };

  // 1. exports field
  if (pkg.exports && typeof pkg.exports === 'object' && pkg.exports !== null) {
    const exportKey = subpath ? `./${subpath}` : '.';
    const exportValue = (pkg.exports as Record<string, unknown>)[exportKey];

    if (typeof exportValue === 'string') {
      add({
        sourcePath: path.join(pkgDir, exportValue),
        evidence: 'exports-exact',
        confidence: 0.95,
        conditionPath: [exportKey],
        exportField: `exports["${exportKey}"]`,
      });
    } else if (typeof exportValue === 'object' && exportValue !== null) {
      const conditions = ['source', 'types', 'import', 'module', 'require', 'default'];
      for (const condition of conditions) {
        const value = (exportValue as Record<string, unknown>)[condition];
        if (typeof value === 'string') {
          const confidence = condition === 'source' ? 0.92 : condition === 'types' ? 0.85 : 0.88;
          add({
            sourcePath: path.join(pkgDir, value),
            evidence: 'exports-condition',
            confidence,
            conditionPath: [exportKey, condition],
            exportField: `exports["${exportKey}"].${condition}`,
          });
        }
      }
    }

    // For subpath, also try wildcard patterns like "./subpath": "./src/subpath.ts"
    // The exact key match above already handles this.
  }

  // 2. main / module / types / typings (root only)
  if (!subpath) {
    const fields: Array<{ key: string; evidence: WorkspaceImportEvidence; confidence: number }> = [
      { key: 'main', evidence: 'main-field', confidence: 0.8 },
      { key: 'module', evidence: 'module-field', confidence: 0.82 },
      { key: 'types', evidence: 'types-field', confidence: 0.78 },
      { key: 'typings', evidence: 'types-field', confidence: 0.78 },
    ];
    for (const { key, evidence, confidence } of fields) {
      const value = pkg[key];
      if (typeof value === 'string') {
        add({ sourcePath: path.join(pkgDir, value), evidence, confidence });
      }
    }
  }

  // 3. Conventional paths
  if (subpath) {
    const conventions = [
      `src/${subpath}.ts`,
      `src/${subpath}.tsx`,
      `${subpath}.ts`,
      `${subpath}.tsx`,
      `src/${subpath}.js`,
      `${subpath}.js`,
    ];
    for (const conv of conventions) {
      add({ sourcePath: path.join(pkgDir, conv), evidence: 'subpath-convention', confidence: 0.6 });
    }
  } else {
    const conventions = [
      'src/index.ts',
      'src/index.tsx',
      'index.ts',
      'index.tsx',
      'src/index.js',
      'index.js',
    ];
    for (const conv of conventions) {
      add({ sourcePath: path.join(pkgDir, conv), evidence: 'src-index-convention', confidence: 0.6 });
    }
  }

  // 4. dist-to-src heuristic (low confidence)
  for (const c of [...candidates]) {
    if (c.sourcePath.includes('/dist/') || c.sourcePath.includes('\\dist\\')) {
      const counterpart = c.sourcePath
        .replace(/\/dist\//g, '/src/')
        .replace(/\\dist\\/g, '/src/')
        .replace(/\.js$/, '.ts')
        .replace(/\.jsx$/, '.tsx');
      if (counterpart !== c.sourcePath) {
        add({ sourcePath: counterpart, evidence: 'dist-to-src-heuristic', confidence: 0.35 });
      }
    }
  }

  return candidates;
}

/** Read and parse a package.json safely. */
function readPackageJson(packageJsonPath: string): unknown | undefined {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Detect language from file path. */
function detectLangFromPath(filePath: string): Language | undefined {
  if (filePath.endsWith('.ts')) return 'typescript';
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.js')) return 'javascript';
  if (filePath.endsWith('.jsx')) return 'jsx';
  return undefined;
}

/** Build a NodeHandle from a Node. */
function toNodeHandle(node: Node): NodeHandle {
  return {
    nodeId: node.id,
    name: node.name,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    path: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    signature: node.signature,
  };
}

/** Chase a symbol through a re-export chain starting from entryPath. */
function chaseSymbol(
  projectRoot: string,
  entryPath: string,
  symbol: string,
  loadNodesForFile: (path: string) => Node[],
  language: Language,
  visited: Set<string>,
  depth: number
): {
  node?: NodeHandle;
  alternatives?: NodeHandle[];
  chain?: Array<{ from: string; to: string; exportedName?: string; originalName?: string }>;
} {
  if (depth > REEXPORT_MAX_DEPTH) return {};
  if (visited.has(entryPath)) return {};
  visited.add(entryPath);

  const fullPath = path.join(projectRoot, entryPath);
  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return {};
  }

  // 1. Look for direct export in this file
  const nodes = loadNodesForFile(entryPath);
  const exported = nodes.filter((n) => n.isExported && n.name === symbol);
  if (exported.length === 1) {
    return { node: toNodeHandle(exported[0]!) };
  }
  if (exported.length > 1) {
    return { alternatives: exported.map(toNodeHandle) };
  }

  // 2. Look for re-export forwarding this symbol
  const reExports = extractReExports(content, language);
  for (const rex of reExports) {
    if (rex.kind === 'named' && rex.exportedName === symbol) {
      const nextPath = resolveRelativeWithinPackage(projectRoot, entryPath, rex.source);
      if (!nextPath) continue;
      const result = chaseSymbol(projectRoot, nextPath, rex.originalName, loadNodesForFile, language, visited, depth + 1);
      const chainEntry = { from: entryPath, to: nextPath, exportedName: symbol, originalName: rex.originalName };
      return {
        node: result.node,
        alternatives: result.alternatives,
        chain: result.chain ? [chainEntry, ...result.chain] : [chainEntry],
      };
    }
    if (rex.kind === 'wildcard') {
      const nextPath = resolveRelativeWithinPackage(projectRoot, entryPath, rex.source);
      if (!nextPath) continue;
      const result = chaseSymbol(projectRoot, nextPath, symbol, loadNodesForFile, language, visited, depth + 1);
      if (result.node || (result.alternatives && result.alternatives.length > 0)) {
        const chainEntry = { from: entryPath, to: nextPath };
        return {
          node: result.node,
          alternatives: result.alternatives,
          chain: result.chain ? [chainEntry, ...result.chain] : [chainEntry],
        };
      }
    }
  }

  return {};
}

/** Resolve a relative import path from within a file to a project-relative path. */
function resolveRelativeWithinPackage(projectRoot: string, fromFile: string, importPath: string): string | null {
  if (!importPath.startsWith('.')) return null;
  const fromDir = path.dirname(path.join(projectRoot, fromFile));
  const resolved = path.resolve(fromDir, importPath);
  const rel = path.relative(projectRoot, resolved).replace(/\\/g, '/');
  // Try extension inference
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx']) {
    const candidate = rel + ext;
    if (fs.existsSync(path.join(projectRoot, candidate))) {
      return candidate;
    }
  }
  // Try index files
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = `${rel}/index${ext}`;
    if (fs.existsSync(path.join(projectRoot, candidate))) {
      return candidate;
    }
  }
  return null;
}

/** Build workspace info from a discovered package. */
function toWorkspacePackageInfo(pkg: DiscoveredPackage, pkgJson: unknown): WorkspacePackageInfo {
  const p = pkgJson as Record<string, unknown>;
  return {
    name: pkg.name,
    packageDir: pkg.dir,
    packageJsonPath: pkg.packageJsonPath,
    workspacePattern: pkg.workspacePattern,
    exports: p.exports,
    main: typeof p.main === 'string' ? p.main : undefined,
    module: typeof p.module === 'string' ? p.module : undefined,
    types: typeof p.types === 'string' ? p.types : undefined,
    typings: typeof p.typings === 'string' ? p.typings : undefined,
  };
}

/** Main API: get workspace import candidates for a specifier. */
export function getWorkspaceImportCandidates(
  projectRoot: string,
  files: FileRecord[],
  loadNodesForFile: (path: string) => Node[],
  specifier: string,
  options?: WorkspaceImportOptions
): WorkspaceImportCandidatesResult {
  const limit = clamp(options?.limit ?? DEFAULT_LIMIT, 1, 100);
  const includeUnindexed = options?.includeUnindexed ?? false;
  const symbol = options?.symbol;

  const parsed = parseWorkspaceSpecifier(specifier);
  if (!parsed) {
    return {
      status: 'invalid-specifier',
      specifier,
      symbol,
      candidates: [],
      totalCandidates: 0,
      omittedCandidates: 0,
      caveats: ['Specifier must be a bare or scoped package name (e.g., "@scope/pkg" or "pkg"), not a relative or absolute path.'],
      recommendations: ['Use a package name from your workspace.'],
    };
  }

  const { packageName, subpath } = parsed;

  const workspacePackages = getWorkspacePackages(projectRoot);
  if (workspacePackages.length === 0) {
    return {
      status: 'no-workspaces',
      specifier,
      symbol,
      candidates: [],
      totalCandidates: 0,
      omittedCandidates: 0,
      caveats: [
        'No workspace configuration found (package.json workspaces or pnpm-workspace.yaml).',
        'This tool resolves imports within monorepo workspace packages only. For packages installed from npm, check node_modules or use "npm ls <pkg>" / grep instead.',
      ],
      recommendations: [
        'If this IS a monorepo, add "workspaces" to your root package.json or create a pnpm-workspace.yaml.',
        'If this is NOT a monorepo, use "npm ls <pkg>" or grep node_modules to locate the package.',
      ],
    };
  }

  const pkg = findWorkspacePackage(projectRoot, packageName);
  if (!pkg) {
    return {
      status: 'package-not-found',
      specifier,
      symbol,
      candidates: [],
      totalCandidates: 0,
      omittedCandidates: 0,
      caveats: [`Workspace package "${packageName}" not found among ${workspacePackages.length} discovered workspace package(s).`],
      recommendations: [
        'Verify the package name in its package.json matches the specifier.',
        'Run `codegraph sync --quiet` if workspace packages were recently added.',
      ],
    };
  }

  const pkgJson = readPackageJson(pkg.packageJsonPath);
  if (!pkgJson) {
    return {
      status: 'partial',
      specifier,
      symbol,
      package: toWorkspacePackageInfo(pkg, {}),
      candidates: [],
      totalCandidates: 0,
      omittedCandidates: 0,
      caveats: [`Could not read package.json for workspace package "${packageName}".`],
      recommendations: [`Check ${pkg.packageJsonPath} is valid JSON.`],
    };
  }

  const rawCandidates = buildEntryCandidates(pkg.dir, pkgJson, subpath);
  const indexedPaths = new Set(files.map((f) => f.path));

  const candidates: WorkspaceImportCandidate[] = [];
  for (const raw of rawCandidates) {
    const exists = fs.existsSync(path.join(projectRoot, raw.sourcePath));
    const indexed = indexedPaths.has(raw.sourcePath);
    if (!exists && !indexed) continue;
    if (!indexed && !includeUnindexed) continue;

    const lang = detectLangFromPath(raw.sourcePath);
    const nodes = indexed ? loadNodesForFile(raw.sourcePath) : [];

    const candidate: WorkspaceImportCandidate = {
      packageName,
      subpath,
      packageDir: pkg.dir,
      sourcePath: raw.sourcePath,
      exists,
      indexed,
      language: lang,
      nodeCount: nodes.length,
      evidence: raw.evidence,
      confidence: raw.confidence,
      conditionPath: raw.conditionPath,
      exportField: raw.exportField,
      symbol,
    };

    candidates.push(candidate);
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  // If symbol is requested, chase it through the best existing candidate
  if (symbol && candidates.length > 0) {
    for (const candidate of candidates) {
      if (!candidate.exists) continue;
      const lang = candidate.language;
      if (!lang || !(lang === 'typescript' || lang === 'javascript' || lang === 'tsx' || lang === 'jsx')) {
        continue;
      }
      const chase = chaseSymbol(projectRoot, candidate.sourcePath, symbol, loadNodesForFile, lang, new Set(), 0);
      if (chase.node) {
        candidate.symbolNode = chase.node;
      }
      if (chase.alternatives && chase.alternatives.length > 0) {
        candidate.symbolAlternatives = chase.alternatives;
      }
      if (chase.chain && chase.chain.length > 0) {
        candidate.reExportChain = chase.chain;
      }
      break;
    }
  }

  const totalCandidates = candidates.length;
  const shown = candidates.slice(0, limit);
  const omitted = totalCandidates - shown.length;

  if (shown.length === 0) {
    return {
      status: 'no-candidates',
      specifier,
      symbol,
      package: toWorkspacePackageInfo(pkg, pkgJson),
      candidates: [],
      totalCandidates: 0,
      omittedCandidates: 0,
      caveats: [
        `No source candidates found for "${specifier}".`,
        includeUnindexed ? 'All possible entry paths were checked; none exist on disk.' : 'No indexed candidates found; try includeUnindexed: true to see non-indexed paths.',
      ],
      recommendations: [
        'Check the package exports, main, module, or types fields.',
        'Verify conventional entry files exist (src/index.ts, index.ts, etc.).',
      ],
    };
  }

  const caveats: string[] = [
    'Static workspace package candidates only. This is not a complete Node/TypeScript resolver and not runtime proof.',
    'Export condition precedence (source > types > import > module > require > default) is a static heuristic, not a runtime environment match.',
  ];

  if (symbol && !shown.some((c) => c.symbolNode)) {
    caveats.push(`Symbol "${symbol}" was not found in the entry candidates through a re-export chain.`);
  }

  const recommendations: string[] = [];
  const best = shown[0];
  if (best?.symbolNode) {
    recommendations.push(`codegraph_node({ nodeId: "${best.symbolNode.nodeId}" })`);
  }
  if (best) {
    recommendations.push(`read ${best.sourcePath}:1-40`);
  }
  if (shown.some((c) => c.indexed && c.nodeCount && c.nodeCount > 0)) {
    recommendations.push(`codegraph_search({ query: "${packageName}" })`);
  }

  return {
    status: 'available',
    specifier,
    symbol,
    package: toWorkspacePackageInfo(pkg, pkgJson),
    candidates: shown,
    totalCandidates,
    omittedCandidates: omitted,
    caveats,
    recommendations,
  };
}
