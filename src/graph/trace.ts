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
  TracePathRanking,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { normalizeLocatorPath, toNodeHandle } from '../addressability/format';
import { isTestFile } from '../search/query-utils';

const DEFAULT_EDGE_KINDS: EdgeKind[] = ['calls', 'references', 'imports'];
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_PATHS = 5;
const DEFAULT_VISITED_CAP = 1000;
const DEFAULT_BOUNDARY_CAP = 5;
const CANDIDATE_PATH_OVERCOLLECT_FACTOR = 5;
const MIN_CANDIDATE_PATH_LIMIT = 10;
const MAX_CANDIDATE_PATH_LIMIT = 100;
const PER_NODE_STATE_LIMIT = 3;
const REFERENCE_SOURCE_EVIDENCE_SET: ReadonlySet<string> = new Set(REFERENCE_SOURCE_EVIDENCE_VALUES);
const OPTIONAL_BRANCH_KEYWORDS = [
  'compact',
  'compaction',
  'preflight',
  'retry',
  'cleanup',
  'fallback',
  'error',
  'recover',
  'rollback',
  'teardown',
  'dispose',
] as const;

interface InternalStep {
  node: Node;
  edge: Edge | null;
}

interface QueueItem {
  node: Node;
  steps: InternalStep[];
  depth: number;
  pathKey: string;
}

interface RankingContext {
  skipNonProductionPenalty: boolean;
  scopePath: string;
}

interface CandidateStateSummary {
  pathKey: string;
  depth: number;
  score: number;
  confidence: number;
  lowEvidenceCount: number;
  optionalKeywordCount: number;
  testOrFixtureNodeCount: number;
  generatedNodeCount: number;
  metadataMissingCount: number;
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
    const rankingContext = this.buildRankingContext(from, filteredTargets, opts);
    const candidatePathLimit = this.candidatePathLimit(opts.maxPaths);
    const initialSteps: InternalStep[] = [{ node: from, edge: null }];
    const initialState = this.summarizeCandidateState(initialSteps, rankingContext);
    const queue: QueueItem[] = [{ node: from, steps: initialSteps, depth: 0, pathKey: initialState.pathKey }];
    const statesByNode = new Map<string, CandidateStateSummary[]>([
      [from.id, [initialState]],
    ]);
    const paths: TracePath[] = [];
    const frontierBoundaries: TraceBoundary[] = [];
    let visitedCount = 0;

    while (queue.length > 0 && visitedCount < DEFAULT_VISITED_CAP) {
      const item = queue.shift()!;
      if (!this.isRetainedCandidateState(statesByNode, item.node.id, item.pathKey)) continue;
      visitedCount++;

      if (item.depth > 0 && targetIds.has(item.node.id)) {
        this.recordCompletePath(paths, this.buildPath(item.steps, rankingContext), candidatePathLimit);
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
      let traversableEdgeSeen = false;
      for (const edge of adjacent) {
        const nextId = this.nextNodeId(item.node.id, edge, opts.direction);
        if (!nextId) continue;
        if (item.steps.some((s) => s.node.id === nextId)) continue;

        const nextNode = this.queries.getNodeById(nextId);
        if (!nextNode) continue;
        if (!this.nodeAllowed(nextNode, opts)) continue;
        traversableEdgeSeen = true;

        const nextDepth = item.depth + 1;
        const nextSteps = [...item.steps, { node: nextNode, edge }];
        const state = this.summarizeCandidateState(nextSteps, rankingContext);
        if (!this.recordCandidateState(statesByNode, nextId, state)) continue;

        queue.push({
          node: nextNode,
          steps: nextSteps,
          depth: nextDepth,
          pathKey: state.pathKey,
        });
        enqueued = true;
      }

      if (!enqueued && !traversableEdgeSeen) {
        this.addBoundary(
          frontierBoundaries,
          this.buildFrontierBoundary(
            'dead-end',
            item.steps,
            'No traversable indexed edge continues from this node. This is an unclassified indexed-graph boundary; dynamic calls may exist in source, but raw call expression shape may be missing from older edge metadata.'
          )
        );
      }
    }

    paths.sort((a, b) => this.compareRankedPaths(a, b));

    const limitedPaths = paths.slice(0, opts.maxPaths);
    this.assignPathLabels(limitedPaths);
    const boundaries = limitedPaths.length > 0
      ? this.classifyPathBoundaries(limitedPaths)
      : frontierBoundaries.slice(0, DEFAULT_BOUNDARY_CAP);

    if (visitedCount >= DEFAULT_VISITED_CAP) {
      gaps.push(paths.length > 0
        ? `Traversal stopped at visited node cap (${DEFAULT_VISITED_CAP}); ranked paths are best candidates found before the cap, not exhaustive.`
        : `Traversal stopped at visited node cap (${DEFAULT_VISITED_CAP}).`);
    }

    if (paths.length === 0) {
      gaps.push(
        `No complete path found within maxDepth=${opts.maxDepth} over edgeKinds=${opts.edgeKinds.join(',')}.`
      );
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

  private buildPath(
    steps: InternalStep[],
    rankingContext: RankingContext
  ): TracePath {
    const edges = steps.slice(1).map((step) => this.toTraceEdge(step.edge!));
    const ranking = this.rankTracePath(steps, edges, rankingContext);
    const confidence = ranking.signals.averageConfidence ?? fallbackPathConfidence(edges);
    const last = steps[steps.length - 1]!.node;
    const reason = ranking.reasons.length > 0
      ? ranking.reasons.join('; ')
      : `Reached target ${last.name} by ${edges.length} static graph edge${edges.length === 1 ? '' : 's'}.`;

    return {
      steps: steps.map((step) => ({
        node: toNodeHandle(step.node),
        via: step.edge ? this.toTraceEdge(step.edge) : undefined,
      })),
      edges,
      confidence,
      reason,
      ranking,
    };
  }

  private buildRankingContext(
    from: Node,
    targets: Node[],
    options: Required<TraceOptions>
  ): RankingContext {
    const locatorPaths = [from.filePath, ...targets.map((target) => target.filePath)];
    if (options.scopePath) locatorPaths.push(options.scopePath);
    return {
      skipNonProductionPenalty: locatorPaths.some(isTraceNonProductionOrGeneratedPath),
      scopePath: normalizeLocatorPath(options.scopePath),
    };
  }

  private candidatePathLimit(maxPaths: number): number {
    return clampNumber(
      Math.max(maxPaths * CANDIDATE_PATH_OVERCOLLECT_FACTOR, MIN_CANDIDATE_PATH_LIMIT),
      maxPaths,
      MAX_CANDIDATE_PATH_LIMIT
    );
  }

  private summarizeCandidateState(
    steps: InternalStep[],
    rankingContext: RankingContext
  ): CandidateStateSummary {
    const edges = steps.slice(1).map((step) => this.toTraceEdge(step.edge!));
    const ranking = this.rankTracePath(steps, edges, rankingContext);
    return {
      pathKey: traceStateKey(steps, edges),
      depth: steps.length - 1,
      score: ranking.score,
      confidence: ranking.signals.averageConfidence ?? fallbackPathConfidence(edges),
      lowEvidenceCount: ranking.signals.lowEvidenceCount,
      optionalKeywordCount: ranking.signals.optionalKeywordCount,
      testOrFixtureNodeCount: ranking.signals.testOrFixtureNodeCount,
      generatedNodeCount: ranking.signals.generatedNodeCount,
      metadataMissingCount: ranking.signals.metadataMissingCount,
    };
  }

  private recordCandidateState(
    statesByNode: Map<string, CandidateStateSummary[]>,
    nodeId: string,
    state: CandidateStateSummary
  ): boolean {
    const existing = statesByNode.get(nodeId) ?? [];
    if (existing.some((candidate) => candidate.pathKey === state.pathKey)) return false;

    if (existing.length < PER_NODE_STATE_LIMIT) {
      existing.push(state);
      existing.sort((a, b) => this.compareCandidateStates(a, b));
      statesByNode.set(nodeId, existing);
      return true;
    }

    const worst = existing[existing.length - 1]!;
    if (this.compareCandidateStates(state, worst) < 0) {
      existing[existing.length - 1] = state;
      existing.sort((a, b) => this.compareCandidateStates(a, b));
      statesByNode.set(nodeId, existing);
      return true;
    }

    return false;
  }

  private isRetainedCandidateState(
    statesByNode: Map<string, CandidateStateSummary[]>,
    nodeId: string,
    pathKey: string
  ): boolean {
    return (statesByNode.get(nodeId) ?? []).some((state) => state.pathKey === pathKey);
  }

  private recordCompletePath(paths: TracePath[], path: TracePath, limit: number): void {
    const key = tracePathEvidenceKey(path);
    const existingIndex = paths.findIndex((candidate) => tracePathEvidenceKey(candidate) === key);
    if (existingIndex >= 0) {
      if (this.compareRankedPaths(path, paths[existingIndex]!) < 0) {
        paths[existingIndex] = path;
        paths.sort((a, b) => this.compareRankedPaths(a, b));
      }
      return;
    }

    if (paths.length < limit) {
      paths.push(path);
      paths.sort((a, b) => this.compareRankedPaths(a, b));
      return;
    }

    const worst = paths[paths.length - 1];
    if (worst && this.compareRankedPaths(path, worst) < 0) {
      paths[paths.length - 1] = path;
      paths.sort((a, b) => this.compareRankedPaths(a, b));
    }
  }

  private compareCandidateStates(a: CandidateStateSummary, b: CandidateStateSummary): number {
    if (Math.abs(a.score - b.score) > 0.000001) return b.score - a.score;
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (Math.abs(a.confidence - b.confidence) > 0.000001) return b.confidence - a.confidence;
    if (a.lowEvidenceCount !== b.lowEvidenceCount) return a.lowEvidenceCount - b.lowEvidenceCount;
    if (a.optionalKeywordCount !== b.optionalKeywordCount) return a.optionalKeywordCount - b.optionalKeywordCount;
    if (a.testOrFixtureNodeCount !== b.testOrFixtureNodeCount) return a.testOrFixtureNodeCount - b.testOrFixtureNodeCount;
    if (a.generatedNodeCount !== b.generatedNodeCount) return a.generatedNodeCount - b.generatedNodeCount;
    if (a.metadataMissingCount !== b.metadataMissingCount) return a.metadataMissingCount - b.metadataMissingCount;
    return a.pathKey.localeCompare(b.pathKey);
  }

  private rankTracePath(
    steps: InternalStep[],
    edges: TraceEdge[],
    rankingContext: RankingContext
  ): TracePathRanking {
    const nodes = steps.map((step) => step.node);
    const edgeCount = edges.length;
    const directCallCount = edges.filter((edge) => edge.sourceEvidence === 'direct-call').length;
    const propertyCallCount = edges.filter((edge) => edge.sourceEvidence === 'property-call').length;
    const directCallRatio = edgeCount > 0 ? directCallCount / edgeCount : 0;
    const confidenceValues = edges
      .map((edge) => edge.confidence)
      .filter((confidence): confidence is number => typeof confidence === 'number' && Number.isFinite(confidence));
    const averageConfidence = confidenceValues.length > 0
      ? confidenceValues.reduce((sum, confidence) => sum + confidence, 0) / confidenceValues.length
      : undefined;
    const lowEvidenceCount = edges.filter((edge) => isLowEvidenceEdge(edge)).length;
    const frameworkEdgeCount = edges.filter((edge) => edge.resolvedBy === 'framework' || Boolean(edge.framework)).length;
    const metadataMissingCount = edges.filter((edge) => !hasRecordedSourceEvidence(edge)).length;
    const scopeMatchCount = rankingContext.scopePath
      ? nodes.filter((node) => pathMatches(normalizeLocatorPath(node.filePath), rankingContext.scopePath)).length
      : 0;
    const testOrFixtureNodeCount = nodes.filter((node) => isTraceTestOrFixturePath(node.filePath)).length;
    const generatedNodeCount = nodes.filter((node) => isGeneratedFilePath(node.filePath)).length;
    const optionalKeywordMatches = this.optionalKeywordMatches(nodes, edges);
    const optionalKeywordCount = optionalKeywordMatches.length;
    const scopeMatchRatio = rankingContext.scopePath && nodes.length > 0 ? scopeMatchCount / nodes.length : 0;
    const testPenaltyCount = rankingContext.skipNonProductionPenalty ? 0 : testOrFixtureNodeCount;
    const generatedPenaltyCount = rankingContext.skipNonProductionPenalty ? 0 : generatedNodeCount;

    const score = Number((
      1.0 +
      directCallRatio * 0.4 +
      (averageConfidence ?? 0) * 0.3 +
      scopeMatchRatio * 0.15 -
      edgeCount * 0.03 -
      propertyCallCount * 0.04 -
      lowEvidenceCount * 0.15 -
      metadataMissingCount * 0.08 -
      frameworkEdgeCount * 0.05 -
      testPenaltyCount * 0.2 -
      generatedPenaltyCount * 0.2 -
      optionalKeywordCount * 0.15
    ).toFixed(4));

    const reasons: string[] = [
      `direct-call ratio ${directCallRatio.toFixed(2)}`,
    ];
    if (averageConfidence !== undefined) {
      reasons.push(`average edge confidence ${averageConfidence.toFixed(2)}`);
    } else {
      reasons.push('edge confidence not recorded');
    }
    if (rankingContext.scopePath && scopeMatchCount === nodes.length) {
      reasons.push('stays in requested scope');
    } else if (rankingContext.scopePath && scopeMatchCount > 0) {
      reasons.push(`partially matches requested scope (${scopeMatchCount}/${nodes.length} nodes)`);
    }
    if (optionalKeywordMatches.length > 0) {
      reasons.push(`includes optional/preflight keywords: ${optionalKeywordMatches.slice(0, 5).join(', ')}`);
    }
    if (lowEvidenceCount > 0) {
      reasons.push(`${lowEvidenceCount} low-evidence edge${lowEvidenceCount === 1 ? '' : 's'}`);
    }
    if (metadataMissingCount > 0) {
      reasons.push(`${metadataMissingCount} edge${metadataMissingCount === 1 ? '' : 's'} missing source evidence`);
    }
    if (rankingContext.skipNonProductionPenalty && (testOrFixtureNodeCount > 0 || generatedNodeCount > 0)) {
      reasons.push('test/fixture/generated path allowed by trace locator');
    }
    if (optionalKeywordMatches.length === 0 && testPenaltyCount === 0 && generatedPenaltyCount === 0) {
      reasons.push('no optional/test/generated penalties');
    }

    const penalties: string[] = [];
    if (propertyCallCount > 0) penalties.push('property-call receiver binding penalty');
    if (lowEvidenceCount > 0) {
      penalties.push(edges.some((edge) => edge.resolvedBy === 'fuzzy')
        ? 'low evidence / fuzzy resolver penalty'
        : 'low evidence resolver penalty');
    }
    if (metadataMissingCount > 0) penalties.push('metadata missing penalty');
    if (frameworkEdgeCount > 0) penalties.push('framework edge penalty');
    if (optionalKeywordMatches.length > 0) {
      penalties.push(`optional-branch keyword penalty: ${optionalKeywordMatches.slice(0, 5).join(', ')}`);
    }
    if (testPenaltyCount > 0) penalties.push('test/fixture/example path penalty');
    if (generatedPenaltyCount > 0) penalties.push('generated path penalty');
    if (edgeCount > 2) penalties.push('longer path penalty');

    const allEdgesLackResolverMetadata = edgeCount > 0 && edges.every((edge) =>
      !hasRecordedSourceEvidence(edge) && edge.confidence === undefined && edge.resolvedBy === undefined
    );
    const label = optionalKeywordCount > 0
      ? 'optional-branch'
      : (lowEvidenceCount > 0 || allEdgesLackResolverMetadata ? 'low-evidence' : 'alternate-static-candidate');

    return {
      score,
      label,
      signals: {
        edgeCount,
        directCallCount,
        propertyCallCount,
        directCallRatio,
        averageConfidence,
        lowEvidenceCount,
        frameworkEdgeCount,
        metadataMissingCount,
        scopeMatchCount,
        testOrFixtureNodeCount,
        generatedNodeCount,
        optionalKeywordCount,
      },
      reasons,
      penalties,
    };
  }

  private optionalKeywordMatches(nodes: Node[], edges: TraceEdge[]): string[] {
    const matches = new Set<string>();
    const candidates: string[] = [];

    for (const node of nodes) {
      candidates.push(node.name);
    }
    for (const edge of edges) {
      if (edge.referenceName) candidates.push(edge.referenceName);
      if (edge.calleeText) candidates.push(edge.calleeText);
      if (edge.propertyText) candidates.push(edge.propertyText);
    }

    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      if (OPTIONAL_BRANCH_KEYWORDS.some((keyword) => lower.includes(keyword))) {
        matches.add(shortSignalText(candidate));
      }
    }

    return [...matches];
  }

  private compareRankedPaths(a: TracePath, b: TracePath): number {
    if (Math.abs(a.ranking.score - b.ranking.score) > 0.000001) {
      return b.ranking.score - a.ranking.score;
    }
    if (a.edges.length !== b.edges.length) return a.edges.length - b.edges.length;
    const aConfidence = a.ranking.signals.averageConfidence ?? a.confidence;
    const bConfidence = b.ranking.signals.averageConfidence ?? b.confidence;
    if (Math.abs(aConfidence - bConfidence) > 0.000001) return bConfidence - aConfidence;
    return tracePathSortKey(a).localeCompare(tracePathSortKey(b));
  }

  private assignPathLabels(paths: TracePath[]): void {
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i]!;
      if (path.ranking.label === 'optional-branch' || path.ranking.label === 'low-evidence') continue;
      path.ranking = {
        ...path.ranking,
        label: i === 0 ? 'higher-ranked-static-candidate' : 'alternate-static-candidate',
      };
    }
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

function fallbackPathConfidence(edges: TraceEdge[]): number {
  const recorded = edges
    .map((edge) => edge.confidence)
    .filter((confidence): confidence is number => typeof confidence === 'number' && Number.isFinite(confidence));
  if (recorded.length > 0) {
    return Math.max(0.1, Math.min(1, recorded.reduce((sum, confidence) => sum + confidence, 0) / recorded.length));
  }

  const directCalls = edges.filter((edge) => edge.sourceEvidence === 'direct-call').length;
  return Math.max(0.1, Math.min(1, 0.45 + directCalls * 0.15 + (edges.length <= 3 ? 0.1 : 0)));
}

function hasRecordedSourceEvidence(edge: TraceEdge): boolean {
  return edge.sourceEvidence !== undefined && edge.sourceEvidence !== 'not-recorded';
}

function isLowEvidenceEdge(edge: TraceEdge): boolean {
  if (edge.resolvedBy === 'framework' || edge.resolvedBy === 'fuzzy') return true;
  if (edge.confidence !== undefined && edge.confidence < 0.8) return true;
  if (edge.resolvedBy === 'instance-method' && (edge.confidence === undefined || edge.confidence < 0.8)) return true;
  return false;
}

function isTraceNonProductionOrGeneratedPath(filePath: string): boolean {
  return isTraceTestOrFixturePath(filePath) || isGeneratedFilePath(filePath);
}

function isTraceTestOrFixturePath(filePath: string): boolean {
  const normalizedPath = normalizeLocatorPath(filePath);
  const normalized = normalizedPath.toLowerCase();
  if (!normalized) return false;
  if (isTestFile(normalizedPath)) return true;
  return /(^|\/)(__tests__|tests?|specs?|fixtures?|examples?|samples?|demos?|benchmarks?|integration)(\/|$)/.test(normalized);
}

function isGeneratedFilePath(filePath: string): boolean {
  const normalized = normalizeLocatorPath(filePath).toLowerCase();
  if (!normalized) return false;
  return (
    /(^|\/)(__generated__|generated|gen)(\/|$)/.test(normalized) ||
    /(^|[._-])(generated|autogenerated)\.[a-z0-9]+$/.test(normalized)
  );
}

function shortSignalText(value: string): string {
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

function tracePathSortKey(path: TracePath): string {
  const last = path.steps[path.steps.length - 1]?.node;
  return last ? `${last.path}:${last.startLine}:${last.name}` : '';
}

function traceStateKey(steps: InternalStep[], edges: TraceEdge[]): string {
  const parts: unknown[] = [steps[0]?.node.id ?? ''];
  for (let i = 1; i < steps.length; i++) {
    parts.push(traceEdgeEvidenceKey(edges[i - 1]!), steps[i]!.node.id);
  }
  return JSON.stringify(parts);
}

function tracePathEvidenceKey(path: TracePath): string {
  const parts: unknown[] = [path.steps[0]?.node.nodeId ?? ''];
  for (let i = 1; i < path.steps.length; i++) {
    parts.push(traceEdgeEvidenceKey(path.edges[i - 1]!), path.steps[i]!.node.nodeId);
  }
  return JSON.stringify(parts);
}

function traceEdgeEvidenceKey(edge: TraceEdge): unknown[] {
  return [
    edge.sourceNodeId,
    edge.targetNodeId,
    edge.kind,
    edge.line ?? null,
    edge.column ?? null,
    edge.provenance ?? null,
    edge.referenceName ?? null,
    edge.referenceKind ?? null,
    edge.sourceEvidence ?? null,
    edge.resolvedBy ?? null,
    edge.confidence ?? null,
    edge.calleeText ?? null,
    edge.receiverText ?? null,
    edge.propertyText ?? null,
    edge.framework ?? null,
  ];
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
