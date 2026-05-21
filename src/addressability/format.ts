import * as path from 'path';
import { Node, NodeHandle } from '../types';

/**
 * Rust path roots that have no direct file-system equivalent.
 */
const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/** Last `::` / `.` / `/`-separated segment of a qualified symbol. */
export function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

export function isQualifiedSymbol(symbol: string): boolean {
  return /[.\/]|::/.test(symbol);
}

/**
 * Convert a graph node into a compact reusable handle.
 */
export function toNodeHandle(node: Node): NodeHandle {
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

/**
 * Format a node handle as a terse copyable string for MCP text output.
 */
export function formatNodeHandle(node: Node): string {
  const handle = toNodeHandle(node);
  const range = `${handle.path}:${handle.startLine}-${handle.endLine}`;
  const parts = [
    `nodeId=${handle.nodeId}`,
    `qualifiedName=${handle.qualifiedName}`,
    `range=${range}`,
  ];
  if (handle.signature) {
    parts.push(`signature=${handle.signature}`);
  }
  return parts.join(' ');
}

/**
 * Parse stack-trace/read-style file locations: `path:line` or `path:line:column`.
 */
export function parseFileLine(input: string): { path: string; line: number; column?: number } | null {
  const match = input.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!match) return null;

  const [, rawPath, rawLine, rawColumn] = match;
  if (!rawPath || !rawLine) return null;

  const line = Number(rawLine);
  if (!Number.isInteger(line) || line <= 0) return null;

  const parsed: { path: string; line: number; column?: number } = { path: rawPath, line };
  if (rawColumn !== undefined) {
    const column = Number(rawColumn);
    if (Number.isInteger(column) && column >= 0) {
      parsed.column = column;
    }
  }
  return parsed;
}

/**
 * Normalize a locator path to the index's project-relative slash format.
 */
export function normalizeLocatorPath(input: string, projectRoot?: string): string {
  let normalized = input.replace(/\\/g, '/');

  if (projectRoot && path.isAbsolute(input)) {
    normalized = path.relative(projectRoot, input).replace(/\\/g, '/');
  }

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  return normalized;
}

/**
 * Check if a node matches a symbol query.
 *
 * Accepts simple names (`run`) and qualifiers using `.`, `::`, or `/`.
 */
export function matchesSymbol(node: Node, symbol: string): boolean {
  // Simple name match.
  if (node.name === symbol) return true;

  // File basename match (e.g. "product-card" matches "product-card.liquid").
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) {
    return true;
  }

  if (!isQualifiedSymbol(symbol)) return false;
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  if (parts.length < 2) return false;

  const lastPart = parts[parts.length - 1]!;
  if (node.name !== lastPart) return false;

  // Qualified-name suffix match. Extractors commonly join semantic hierarchy with `::`.
  const colonSuffix = parts.join('::');
  if (node.qualifiedName.includes(colonSuffix)) return true;

  // File-path containment for module/file-derived qualifiers.
  const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
  if (containerHints.length === 0) return false;

  const segments = node.filePath.split('/').filter((s) => s.length > 0);
  return containerHints.every((hint) =>
    segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
  );
}
