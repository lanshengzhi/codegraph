import {
  Edge,
  EdgeKind,
  Node,
  REFERENCE_SOURCE_EVIDENCE_VALUES,
  ReferenceSourceEvidence,
  TraceBoundary,
  TraceBoundaryType,
  TraceEdge,
  TraceOptions,
  TracePath,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { normalizeLocatorPath, toNodeHandle } from '../addressability/format';

const DEFAULT_EDGE_KINDS: EdgeKind[] = ['calls', 'references', 'imports'];
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_PATHS = 5;
const DEFAULT_VISITED_CAP = 1000;
const DEFAULT_BOUNDARY_CAP = 5;
const REFERENCE_SOURCE_EVIDENCE_SET: ReadonlySet<string> = new Set(REFERENCE_SOURCE_EVIDENCE_VALUES);

interface InternalStep {
  node: Node;
  edge: Edge | null;
}

interface QueueItem {
  node: Node;
  steps: InternalStep[];
  depth: number;
}

export interface TraceSearchResult {
  targetCandidates: Node[];
  paths: TracePath[];
  boundaries: TraceBoundary[];
  gaps: string[];
  recommendations: string[];
  visitedCount: number;
}

/**
 * Bounded graph path search for CodeGraph trace.
 */
export class GraphTracer {
  constructor(private queries: QueryBuilder) {}

  trace(from: Node, targetCandidates: Node[], options: TraceOptions = {}): TraceSearchResult {
    const opts = this.normalizeOptions(options);
    const filteredTargets = this.filterTargetCandidates(targetCandidates, opts);
    const gaps: string[] = [];
    const recommendations: string[] = [];

    if (filteredTargets.length === 0) {
      gaps.push('No target candidates remain after applying scope/include/exclude path filters.');
      recommendations.push('Relax scopePath/includePaths/excludePaths or inspect the target with codegraph_search.');
      return { targetCandidates: [], paths: [], boundaries: [], gaps, recommendations, visitedCount: 0 };
    }

    const targetIds = new Set(filteredTargets.map((n) => n.id));
    const queue: QueueItem[] = [{ node: from, steps: [{ node: from, edge: null }], depth: 0 }];
    const bestDepth = new Map<string, number>([[from.id, 0]]);
    const paths: TracePath[] = [];
    const frontierBoundaries: TraceBoundary[] = [];
    let visitedCount = 0;

    while (queue.length > 0 && paths.length < opts.maxPaths && visitedCount < DEFAULT_VISITED_CAP) {
      const item = queue.shift()!;
      visitedCount++;

      if (item.depth > 0 && targetIds.has(item.node.id)) {
        paths.push(this.buildPath(item.steps));
        continue;
      }

      if (item.depth >= opts.maxDepth) {
        this.addBoundary(
          frontierBoundaries,
          this.buildFrontierBoundary('max-depth', item.steps, `Traversal reached maxDepth=${opts.maxDepth} before reaching the target. Increase maxDepth or inspect this frontier node.`)
        );
        continue;
      }

      const adjacent = this.getAdjacentEdges(item.node.id, opts.direction, opts.edgeKinds);
      adjacent.sort((a, b) => this.edgePriority(a.kind) - this.edgePriority(b.kind));

      let enqueued = false;
      for (const edge of adjacent) {
        const nextId = this.nextNodeId(item.node.id, edge, opts.direction);
        if (!nextId) continue;
        if (item.steps.some((s) => s.node.id === nextId)) continue;

        const nextNode = this.queries.getNodeById(nextId);
        if (!nextNode) continue;
        if (!this.nodeAllowed(nextNode, opts)) continue;

        const nextDepth = item.depth + 1;
        const previousBest = bestDepth.get(nextId);
        if (previousBest !== undefined && previousBest < nextDepth) continue;
        bestDepth.set(nextId, nextDepth);

        queue.push({
          node: nextNode,
          steps: [...item.steps, { node: nextNode, edge }],
          depth: nextDepth,
        });
        enqueued = true;
      }

      if (!enqueued) {
        this.addBoundary(
          frontierBoundaries,
          this.buildFrontierBoundary(
            'dead-end',
            item.steps,
            'No traversable indexed edge continues from this node. This is an unclassified indexed-graph boundary; dynamic calls may exist in source, but raw call expression shape is not recorded in P0b.'
          )
        );
      }
    }

    paths.sort((a, b) => {
      if (a.steps.length !== b.steps.length) return a.steps.length - b.steps.length;
      return b.confidence - a.confidence;
    });

    const limitedPaths = paths.slice(0, opts.maxPaths);
    const boundaries = limitedPaths.length > 0
      ? this.classifyPathBoundaries(limitedPaths)
      : frontierBoundaries.slice(0, DEFAULT_BOUNDARY_CAP);

    if (paths.length === 0) {
      gaps.push(
        `No complete path found within maxDepth=${opts.maxDepth} over edgeKinds=${opts.edgeKinds.join(',')}.`
      );
      if (visitedCount >= DEFAULT_VISITED_CAP) {
        gaps.push(`Traversal stopped at visited node cap (${DEFAULT_VISITED_CAP}).`);
      }
      recommendations.push('Try increasing maxDepth, widening edgeKinds, or using codegraph_explore on the returned endpoint handles.');
    }

    return {
      targetCandidates: filteredTargets,
      paths: limitedPaths,
      boundaries,
      gaps,
      recommendations,
      visitedCount,
    };
  }

  private normalizeOptions(options: TraceOptions): Required<TraceOptions> {
    return {
      maxDepth: clampNumber(options.maxDepth ?? DEFAULT_MAX_DEPTH, 1, 20),
      maxPaths: clampNumber(options.maxPaths ?? DEFAULT_MAX_PATHS, 1, 20),
      edgeKinds: options.edgeKinds && options.edgeKinds.length > 0 ? options.edgeKinds : DEFAULT_EDGE_KINDS,
      direction: options.direction ?? 'outgoing',
      includePaths: options.includePaths ?? [],
      excludePaths: options.excludePaths ?? [],
      scopePath: options.scopePath ?? '',
    };
  }

  private filterTargetCandidates(targets: Node[], options: Required<TraceOptions>): Node[] {
    return dedupeNodes(targets).filter((node) => this.nodeAllowed(node, options));
  }

  private nodeAllowed(node: Node, options: Required<TraceOptions>): boolean {
    const filePath = normalizeLocatorPath(node.filePath);

    if (options.scopePath) {
      const scope = normalizeLocatorPath(options.scopePath);
      if (!pathMatches(filePath, scope)) return false;
    }

    if (options.includePaths.length > 0) {
      const includes = options.includePaths.map((p) => normalizeLocatorPath(p));
      if (!includes.some((p) => pathMatches(filePath, p))) return false;
    }

    if (options.excludePaths.length > 0) {
      const excludes = options.excludePaths.map((p) => normalizeLocatorPath(p));
      if (excludes.some((p) => pathMatches(filePath, p))) return false;
    }

    return true;
  }

  private getAdjacentEdges(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both',
    edgeKinds: EdgeKind[]
  ): Edge[] {
    if (direction === 'outgoing') {
      return this.queries.getOutgoingEdges(nodeId, edgeKinds);
    }
    if (direction === 'incoming') {
      return this.queries.getIncomingEdges(nodeId, edgeKinds);
    }
    return [
      ...this.queries.getOutgoingEdges(nodeId, edgeKinds),
      ...this.queries.getIncomingEdges(nodeId, edgeKinds),
    ];
  }

  private nextNodeId(currentNodeId: string, edge: Edge, direction: 'outgoing' | 'incoming' | 'both'): string | null {
    if (direction === 'outgoing') return edge.target;
    if (direction === 'incoming') return edge.source;
    if (edge.source === currentNodeId) return edge.target;
    if (edge.target === currentNodeId) return edge.source;
    return null;
  }

  private buildPath(steps: InternalStep[]): TracePath {
    const edges = steps.slice(1).map((step) => this.toTraceEdge(step.edge!));
    const directCalls = edges.filter((edge) => edge.kind === 'calls').length;
    const confidence = Math.max(0.1, Math.min(1, 0.45 + directCalls * 0.15 + (edges.length <= 3 ? 0.1 : 0)));
    const last = steps[steps.length - 1]!.node;

    return {
      steps: steps.map((step) => ({
        node: toNodeHandle(step.node),
        via: step.edge ? this.toTraceEdge(step.edge) : undefined,
      })),
      edges,
      confidence,
      reason: `Reached target ${last.name} by ${edges.length} static graph edge${edges.length === 1 ? '' : 's'}.`,
    };
  }

  private buildFrontierBoundary(type: 'max-depth' | 'dead-end', steps: InternalStep[], reason: string): TraceBoundary {
    const current = steps[steps.length - 1]!;
    const edge = current.edge ? this.toTraceEdge(current.edge) : undefined;
    const enclosingNode = this.getBoundarySourceNode(current.edge, steps);

    return {
      type,
      node: toNodeHandle(current.node),
      enclosingNode: enclosingNode ? toNodeHandle(enclosingNode) : undefined,
      edge,
      reason,
    };
  }

  private classifyPathBoundaries(paths: TracePath[]): TraceBoundary[] {
    const boundaries: TraceBoundary[] = [];

    for (const path of paths) {
      for (const edge of path.edges) {
        const type = this.classifyTraceEdgeBoundary(edge);
        if (!type) continue;

        const targetNode = this.queries.getNodeById(edge.targetNodeId);
        if (!targetNode) continue;
        const sourceNode = this.queries.getNodeById(edge.sourceNodeId);

        this.addBoundary(boundaries, {
          type,
          node: toNodeHandle(targetNode),
          enclosingNode: sourceNode ? toNodeHandle(sourceNode) : undefined,
          edge,
          reason: this.boundaryReason(type),
        });

        if (boundaries.length >= DEFAULT_BOUNDARY_CAP) return boundaries;
      }
    }

    return boundaries;
  }

  private classifyTraceEdgeBoundary(edge: TraceEdge): TraceBoundaryType | null {
    const confidence = edge.confidence;
    const resolvedBy = edge.resolvedBy;

    if (resolvedBy === 'framework') return 'framework-edge';
    if (confidence === undefined && resolvedBy === undefined) return 'metadata-not-recorded';
    if (
      (confidence !== undefined && confidence < 0.8) ||
      resolvedBy === 'fuzzy' ||
      (resolvedBy === 'instance-method' && (confidence === undefined || confidence < 0.8))
    ) {
      return 'low-evidence-edge';
    }

    return null;
  }

  private boundaryReason(type: TraceBoundaryType): string {
    switch (type) {
      case 'low-evidence-edge':
        return 'This edge was produced by low-evidence static resolution (low confidence, fuzzy, or weak instance-method matching). Inspect source before treating it as a likely runtime path.';
      case 'framework-edge':
        return 'Framework resolver produced this edge. It is a static framework pattern candidate, not lifecycle/runtime proof.';
      case 'metadata-not-recorded':
        return 'This edge exists in the graph, but resolver confidence/source and call expression evidence were not recorded.';
      case 'max-depth':
      case 'dead-end':
        return 'Trace reached an indexed-graph boundary before reaching the target.';
    }
  }

  private getBoundarySourceNode(edge: Edge | null, steps: InternalStep[]): Node | null {
    if (edge) {
      const sourceNode = this.queries.getNodeById(edge.source);
      if (sourceNode) return sourceNode;
    }
    return steps.length > 1 ? steps[steps.length - 2]!.node : null;
  }

  private addBoundary(boundaries: TraceBoundary[], boundary: TraceBoundary): void {
    if (boundaries.some((existing) => this.boundaryKey(existing) === this.boundaryKey(boundary))) return;
    if (boundaries.length >= DEFAULT_BOUNDARY_CAP) return;
    boundaries.push(boundary);
  }

  private boundaryKey(boundary: TraceBoundary): string {
    return [
      boundary.type,
      boundary.node.nodeId,
      boundary.edge?.sourceNodeId ?? '',
      boundary.edge?.targetNodeId ?? '',
      boundary.edge?.kind ?? '',
      boundary.edge?.line ?? '',
      boundary.edge?.column ?? '',
    ].join('|');
  }

  private toTraceEdge(edge: Edge): TraceEdge {
    const metadata = edge.metadata;
    const confidence = metadata && typeof metadata.confidence === 'number' && Number.isFinite(metadata.confidence)
      ? metadata.confidence
      : undefined;
    const resolvedBy = metadata && typeof metadata.resolvedBy === 'string'
      ? metadata.resolvedBy
      : undefined;

    return {
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      kind: edge.kind,
      line: edge.line,
      column: edge.column,
      provenance: edge.provenance,
      confidence,
      resolvedBy,
      sourceEvidence: readSourceEvidence(metadata),
      referenceName: readStringMetadata(metadata, 'referenceName'),
      referenceKind: readStringMetadata(metadata, 'referenceKind') as EdgeKind | undefined,
      calleeText: readStringMetadata(metadata, 'calleeText'),
      receiverText: readStringMetadata(metadata, 'receiverText'),
      propertyText: readStringMetadata(metadata, 'propertyText'),
      expressionKind: readStringMetadata(metadata, 'expressionKind'),
      isComputed: readBooleanMetadata(metadata, 'isComputed'),
      isOptional: readBooleanMetadata(metadata, 'isOptional'),
      argumentCount: readNumberMetadata(metadata, 'argumentCount'),
      framework: readStringMetadata(metadata, 'framework'),
    };
  }

  private edgePriority(kind: EdgeKind): number {
    switch (kind) {
      case 'calls': return 0;
      case 'references': return 1;
      case 'imports': return 2;
      case 'instantiates': return 3;
      case 'contains': return 4;
      default: return 5;
    }
  }
}

function readStringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBooleanMetadata(metadata: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = metadata?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumberMetadata(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readSourceEvidence(metadata: Record<string, unknown> | undefined): ReferenceSourceEvidence | undefined {
  const value = metadata?.sourceEvidence;
  return typeof value === 'string' && REFERENCE_SOURCE_EVIDENCE_SET.has(value)
    ? value as ReferenceSourceEvidence
    : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function pathMatches(filePath: string, filter: string): boolean {
  if (!filter) return true;
  const cleanFilter = filter.endsWith('/') ? filter.slice(0, -1) : filter;
  return (
    filePath === cleanFilter ||
    filePath.startsWith(cleanFilter + '/') ||
    filePath.includes(cleanFilter)
  );
}

function dedupeNodes(nodes: Node[]): Node[] {
  const seen = new Set<string>();
  const result: Node[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    result.push(node);
  }
  return result;
}
