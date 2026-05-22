/**
 * On-demand AST-derived structure summaries for single function/method nodes.
 *
 * This module is deliberately query-time only: it reads and parses the target
 * source file for navigation guidance, but does not persist anything in the DB.
 */

import * as fs from 'fs/promises';
import type { Parser, Node as SyntaxNode, Tree } from 'web-tree-sitter';
import {
  FileRecord,
  Language,
  Node,
  NodeStructureEnclosingContext,
  NodeStructureEnclosingKind,
  NodeStructureItem,
  NodeStructureOptions,
  NodeStructureResult,
  SourceRange,
} from '../types';
import { toNodeHandle } from '../addressability/format';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { hashContent } from '../extraction';
import { getChildByField, getNodeText } from '../extraction/tree-sitter-helpers';
import { normalizePath, validatePathWithinRoot } from '../utils';

const SUPPORTED_LANGUAGES = new Set<Language>(['typescript', 'javascript', 'tsx', 'jsx']);
const SUPPORTED_NODE_KINDS = new Set<Node['kind']>(['function', 'method']);
const DEFAULT_MAX_LABEL_CHARS = 120;
const DEFAULT_MAX_OBJECT_KEYS = 12;
const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024;
const STATIC_CAVEAT = 'Static AST structure only. This is reading-navigation guidance, not runtime proof or an LLM summary.';
const CALLBACK_NOTE = 'callback-like syntax/name hint only; binding not inferred';
const NESTED_CALLBACK_NOTE = 'inside nested function/callback; not outer sequential flow';

const FUNCTION_LIKE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'public_field_definition',
  'field_definition',
]);

const NESTED_FUNCTION_BOUNDARY_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'class_declaration',
  'abstract_class_declaration',
  'class',
]);

const LOOP_TYPES = new Set([
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
]);

interface NormalizedOptions {
  maxLabelChars: number;
  maxObjectKeys: number;
  includeNestedCallbacks: boolean;
  maxSourceBytes: number;
}

export interface NodeStructureParserHost {
  loadGrammarsForLanguages(languages: Language[]): Promise<void>;
  getParser(language: Language): Parser | null;
}

interface TargetFunction {
  candidate: SyntaxNode;
  functionNode: SyntaxNode;
  body: SyntaxNode;
  isExpressionBody: boolean;
  paramNames: Set<string>;
}

interface AnalyzeState {
  items: NodeStructureItem[];
  caveats: string[];
  enclosing: NodeStructureEnclosingContext[];
  depth: number;
  node: Node;
  source: string;
  options: NormalizedOptions;
  bodyRoot: SyntaxNode;
  paramNames: Set<string>;
  nestedCallbackDepth: number;
  suppressObjectNodes: Set<number>;
}

interface CallInfo {
  label: string;
  calleeText?: string;
  receiverText?: string;
  propertyText?: string;
  isCallbackLike: boolean;
}

const defaultParserHost: NodeStructureParserHost = {
  loadGrammarsForLanguages,
  getParser,
};

export class NodeStructureAnalyzer {
  constructor(
    private readonly projectRoot: string,
    private readonly parserHost: NodeStructureParserHost = defaultParserHost
  ) {}

  async analyze(
    node: Node,
    fileRecord: FileRecord | null,
    options: NodeStructureOptions = {}
  ): Promise<NodeStructureResult> {
    const normalized = this.normalizeOptions(options);
    const safePath = validatePathWithinRoot(this.projectRoot, node.filePath);
    const nodeHandle = toNodeHandle(node);

    const base = (status: NodeStructureResult['status'], caveats: string[], recommendations?: string[]): NodeStructureResult => ({
      status,
      node: nodeHandle,
      language: node.language,
      items: [],
      caveats,
      recommendations: recommendations ?? this.safeRecommendations(node, safePath, false),
    });

    if (!safePath) {
      return base('source-unavailable', [
        STATIC_CAVEAT,
        `Source path "${node.filePath}" is invalid or outside the project root.`,
      ], [`codegraph_node({ nodeId: "${node.id}", includeCode: true })`]);
    }

    if (!SUPPORTED_NODE_KINDS.has(node.kind)) {
      return base('unsupported-node-kind', [
        STATIC_CAVEAT,
        'structure detail supports function/method bodies. For container symbols, use includeCode=true to get a member outline or choose a specific method node.',
      ]);
    }

    if (!SUPPORTED_LANGUAGES.has(node.language)) {
      return base('unsupported-language', [
        STATIC_CAVEAT,
        'structure detail currently supports TypeScript/JavaScript/TSX/JSX function and method bodies.',
      ]);
    }

    let stat;
    try {
      stat = await fs.stat(safePath);
    } catch {
      return base('source-unavailable', [
        STATIC_CAVEAT,
        `Source file "${node.filePath}" is unavailable. The index may be stale.`,
      ], this.safeRecommendations(node, safePath, true));
    }

    if (!stat.isFile()) {
      return base('source-unavailable', [
        STATIC_CAVEAT,
        `Source path "${node.filePath}" is not a regular file.`,
      ], this.safeRecommendations(node, safePath, true));
    }

    if (stat.size > normalized.maxSourceBytes) {
      return base('source-too-large', [
        STATIC_CAVEAT,
        `Source file is ${stat.size} bytes, above the query-time structure parse guard (${normalized.maxSourceBytes} bytes).`,
      ], this.safeRecommendations(node, safePath, false));
    }

    let source: string;
    try {
      source = await fs.readFile(safePath, 'utf8');
    } catch {
      return base('source-unavailable', [
        STATIC_CAVEAT,
        `Source file "${node.filePath}" could not be read.`,
      ], this.safeRecommendations(node, safePath, true));
    }

    if (fileRecord && hashContent(source) !== fileRecord.contentHash) {
      return base('source-stale', [
        STATIC_CAVEAT,
        'Current source differs from the indexed file record; structure is not computed from stale coordinates.',
      ], this.safeRecommendations(node, safePath, true));
    }

    let parser: Parser | null = null;
    try {
      await this.parserHost.loadGrammarsForLanguages([node.language]);
      parser = this.parserHost.getParser(node.language);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return base('parser-unavailable', [
        STATIC_CAVEAT,
        `Parser for ${node.language} is unavailable: ${message}`,
      ]);
    }

    if (!parser) {
      return base('parser-unavailable', [
        STATIC_CAVEAT,
        `Parser for ${node.language} is unavailable.`,
      ]);
    }

    let tree: Tree | null = null;
    try {
      tree = parser.parse(source);
      if (!tree) {
        return base('parse-error', [
          STATIC_CAVEAT,
          'Parser returned no tree for the source file.',
        ], this.safeRecommendations(node, safePath, true));
      }

      const target = this.findTargetFunction(tree.rootNode, node, source, normalized);
      if (!target) {
        return base(tree.rootNode.hasError ? 'parse-error' : 'no-body', [
          STATIC_CAVEAT,
          tree.rootNode.hasError
            ? 'Parse tree contains ERROR nodes and the target function body could not be reliably located.'
            : 'Target function body could not be reliably located in the current source.',
        ], this.safeRecommendations(node, safePath, true));
      }

      const state: AnalyzeState = {
        items: [],
        caveats: [STATIC_CAVEAT],
        enclosing: [],
        depth: 0,
        node,
        source,
        options: normalized,
        bodyRoot: target.body,
        paramNames: target.paramNames,
        nestedCallbackDepth: 0,
        suppressObjectNodes: new Set(),
      };

      if (tree.rootNode.hasError) {
        state.caveats.push('Parse tree contains ERROR nodes; structure was produced from the matched target body only.');
      }

      this.analyzeTargetBody(target, state);

      return {
        status: 'available',
        node: nodeHandle,
        language: node.language,
        items: state.items.sort((a, b) => a.range.startLine - b.range.startLine || (a.range.startColumn ?? 0) - (b.range.startColumn ?? 0)),
        caveats: state.caveats,
        recommendations: this.safeRecommendations(node, safePath, false),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return base('parse-error', [
        STATIC_CAVEAT,
        `Structure parse failed: ${message}`,
      ], this.safeRecommendations(node, safePath, true));
    } finally {
      tree?.delete();
    }
  }

  private normalizeOptions(options: NodeStructureOptions): NormalizedOptions {
    return {
      maxLabelChars: options.maxLabelChars ?? DEFAULT_MAX_LABEL_CHARS,
      maxObjectKeys: options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
      includeNestedCallbacks: options.includeNestedCallbacks !== false,
      maxSourceBytes: options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    };
  }

  private safeRecommendations(node: Node, safePath: string | null, includeSync: boolean): string[] {
    const recommendations: string[] = [];
    if (includeSync) recommendations.push('codegraph sync --quiet');
    if (safePath) recommendations.push(`read ${node.filePath}:${node.startLine}-${node.endLine}`);
    recommendations.push(`codegraph_node({ nodeId: "${node.id}", includeCode: true })`);
    return recommendations;
  }

  private findTargetFunction(root: SyntaxNode, node: Node, source: string, options: NormalizedOptions): TargetFunction | null {
    const candidates: Array<{ candidate: SyntaxNode; target: TargetFunction; score: number }> = [];

    const visit = (syntax: SyntaxNode): void => {
      if (FUNCTION_LIKE_TYPES.has(syntax.type)) {
        const target = this.resolveTargetFunction(syntax, source, options);
        if (target) {
          const score = this.scoreCandidate(target.candidate, target.functionNode, node, source, options);
          if (score > 0) candidates.push({ candidate: syntax, target, score });
        }
      }

      for (let i = 0; i < syntax.namedChildCount; i++) {
        const child = syntax.namedChild(i);
        if (child) visit(child);
      }
    };

    visit(root);
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.target ?? null;
  }

  private scoreCandidate(candidate: SyntaxNode, functionNode: SyntaxNode, node: Node, source: string, options: NormalizedOptions): number {
    const startLine = candidate.startPosition.row + 1;
    const endLine = candidate.endPosition.row + 1;
    const overlapStart = Math.max(startLine, node.startLine);
    const overlapEnd = Math.min(endLine, node.endLine);
    const overlap = Math.max(0, overlapEnd - overlapStart + 1);
    if (overlap === 0 && Math.abs(startLine - node.startLine) > 2) return 0;

    const candidateName = this.extractFunctionName(candidate, functionNode, source, options);
    const nameMatches = candidateName === node.name || node.qualifiedName.endsWith(`.${candidateName}`) || node.qualifiedName.endsWith(`::${candidateName}`);
    const kindMatches = this.candidateKindMatches(candidate, node);
    const startDistance = Math.abs(startLine - node.startLine);
    const containment = startLine >= node.startLine && endLine <= node.endLine ? 20 : 0;
    return overlap * 10 + (nameMatches ? 100 : 0) + (kindMatches ? 40 : 0) + containment - startDistance;
  }

  private candidateKindMatches(candidate: SyntaxNode, node: Node): boolean {
    if (node.kind === 'method') {
      return candidate.type === 'method_definition' || candidate.type === 'public_field_definition' || candidate.type === 'field_definition';
    }
    return candidate.type === 'function_declaration' || candidate.type === 'arrow_function' || candidate.type === 'function_expression' || candidate.type === 'method_definition';
  }

  private resolveTargetFunction(candidate: SyntaxNode, source: string, options: NormalizedOptions): TargetFunction | null {
    if (candidate.type === 'public_field_definition' || candidate.type === 'field_definition') {
      const inner = this.findFirstNestedFunction(candidate);
      if (!inner) return null;
      const body = this.resolveFunctionBodyNode(inner);
      if (!body) return null;
      return {
        candidate,
        functionNode: inner,
        body,
        isExpressionBody: body.type !== 'statement_block',
        paramNames: this.extractParamNames(inner, source, options),
      };
    }

    const body = this.resolveFunctionBodyNode(candidate);
    if (!body) return null;
    return {
      candidate,
      functionNode: candidate,
      body,
      isExpressionBody: candidate.type === 'arrow_function' && body.type !== 'statement_block',
      paramNames: this.extractParamNames(candidate, source, options),
    };
  }

  private findFirstNestedFunction(node: SyntaxNode): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'arrow_function' || child.type === 'function_expression') return child;
      if (child.type === 'call_expression') {
        const args = getChildByField(child, 'arguments');
        if (args) {
          for (let j = 0; j < args.namedChildCount; j++) {
            const arg = args.namedChild(j);
            if (arg && (arg.type === 'arrow_function' || arg.type === 'function_expression')) return arg;
          }
        }
      }
    }
    return null;
  }

  private resolveFunctionBodyNode(node: SyntaxNode): SyntaxNode | null {
    return getChildByField(node, 'body');
  }

  private extractFunctionName(candidate: SyntaxNode, functionNode: SyntaxNode, source: string, options: NormalizedOptions): string {
    const ownName = getChildByField(candidate, 'name');
    if (ownName) return this.nodeText(ownName, source, options);

    const functionName = getChildByField(functionNode, 'name');
    if (functionName) return this.nodeText(functionName, source, options);

    const parent = functionNode.parent;
    if (parent?.type === 'variable_declarator') {
      const variableName = getChildByField(parent, 'name');
      if (variableName) return this.nodeText(variableName, source, options);
    }

    return '<anonymous>';
  }

  private extractParamNames(functionNode: SyntaxNode, source: string, options: NormalizedOptions): Set<string> {
    const params = getChildByField(functionNode, 'parameters');
    const names = new Set<string>();
    if (!params) return names;

    for (let i = 0; i < params.namedChildCount; i++) {
      const param = params.namedChild(i);
      if (!param) continue;
      const name = this.firstIdentifierOutsideTypes(param, source, options);
      if (name) names.add(name);
    }
    return names;
  }

  private firstIdentifierOutsideTypes(node: SyntaxNode, source: string, options: NormalizedOptions): string | null {
    if (node.type === 'type_annotation' || node.type === 'return_type') return null;
    if (node.type === 'identifier') return this.nodeText(node, source, options);
    const nameField = getChildByField(node, 'name');
    if (nameField && nameField.type === 'identifier') return this.nodeText(nameField, source, options);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const name = this.firstIdentifierOutsideTypes(child, source, options);
      if (name) return name;
    }
    return null;
  }

  private analyzeTargetBody(target: TargetFunction, state: AnalyzeState): void {
    if (target.isExpressionBody) {
      this.addReturnValue(target.body, `implicit return ${this.nodeText(target.body, state.source, state.options)}`, state, true);
      this.visitExpression(target.body, state);
      return;
    }

    this.visitChildren(target.body, state);
  }

  private visitChildren(node: SyntaxNode, state: AnalyzeState): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.visitNode(child, state);
    }
  }

  private visitNode(node: SyntaxNode, state: AnalyzeState): void {
    if (this.isOrdinaryNestedBoundary(node, state)) {
      this.addCaveatOnce(state, 'Ordinary nested function/class bodies are not treated as outer sequential flow.');
      return;
    }

    if (!this.isInsideNestedCallback(state)) {
      if (node.type === 'if_statement') {
        this.visitIfStatement(node, state);
        return;
      }
      if (node.type === 'switch_statement') {
        this.visitControlFlow(node, 'switch', `switch (${this.controlFieldText(node, 'value', state)})`, state);
        return;
      }
      if (LOOP_TYPES.has(node.type)) {
        this.visitControlFlow(node, 'loop', this.loopLabel(node, state), state);
        return;
      }
      if (node.type === 'try_statement') {
        this.visitTryStatement(node, state);
        return;
      }
    }

    if (node.type === 'return_statement') {
      this.visitReturnStatement(node, state);
      return;
    }

    if (node.type === 'call_expression' || node.type === 'new_expression') {
      this.visitCallExpression(node, state);
      return;
    }

    if (this.isObjectLiteral(node)) {
      this.visitObjectLiteral(node, state);
      return;
    }

    this.visitChildren(node, state);
  }

  private visitExpression(node: SyntaxNode, state: AnalyzeState): void {
    this.visitNode(node, state);
  }

  private isOrdinaryNestedBoundary(node: SyntaxNode, state: AnalyzeState): boolean {
    if (!NESTED_FUNCTION_BOUNDARY_TYPES.has(node.type)) return false;
    if (node.id === state.bodyRoot.id) return false;
    return true;
  }

  private isInsideNestedCallback(state: AnalyzeState): boolean {
    return state.nestedCallbackDepth > 0;
  }

  private visitIfStatement(node: SyntaxNode, state: AnalyzeState): void {
    const conditionNode = getChildByField(node, 'condition');
    const condition = conditionNode ? this.nodeText(conditionNode, state.source, state.options) : '...';
    const consequence = getChildByField(node, 'consequence') ?? node.namedChildren.find((child) => child.type === 'statement_block') ?? null;
    const exits = consequence ? this.containsShallowExit(consequence) : false;
    const kind: NodeStructureEnclosingKind = exits ? 'guard' : 'branch';
    const exitText = exits ? ` exits via ${this.exitKind(consequence)}` : '';
    const label = this.cap(`if (${condition})${exitText}`, state.options.maxLabelChars);
    this.addItem(state, {
      kind,
      range: this.rangeFor(node, state.node.filePath),
      depth: state.depth,
      label,
      conditionText: condition,
    });

    const context = this.enclosingContext(kind, node, label, state);
    this.withContext(state, context, () => {
      if (conditionNode) this.visitNode(conditionNode, state);
      if (consequence) this.visitNodeOrChildren(consequence, state);
    });

    const alternative = getChildByField(node, 'alternative');
    if (alternative) {
      const alternativeLabel = this.cap(`else of if (${condition})`, state.options.maxLabelChars);
      const alternativeContext = this.enclosingContext('branch', alternative, alternativeLabel, state);
      this.withContext(state, alternativeContext, () => this.visitNodeOrChildren(alternative, state));
    }
  }

  private visitControlFlow(node: SyntaxNode, kind: NodeStructureEnclosingKind, label: string, state: AnalyzeState): void {
    const cappedLabel = this.cap(label, state.options.maxLabelChars);
    this.addItem(state, {
      kind,
      range: this.rangeFor(node, state.node.filePath),
      depth: state.depth,
      label: cappedLabel,
      conditionText: kind === 'switch' ? this.controlFieldText(node, 'value', state) : undefined,
    });
    const context = this.enclosingContext(kind, node, cappedLabel, state);
    this.withContext(state, context, () => this.visitChildren(node, state));
  }

  private visitTryStatement(node: SyntaxNode, state: AnalyzeState): void {
    const label = 'try';
    this.addItem(state, {
      kind: 'try',
      range: this.rangeFor(node, state.node.filePath),
      depth: state.depth,
      label,
    });
    const tryContext = this.enclosingContext('try', node, label, state);

    this.withContext(state, tryContext, () => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'catch_clause' || child.type === 'finally_clause') continue;
        this.visitNode(child, state);
      }
    });

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'catch_clause') {
        this.visitClause(child, 'catch', state);
      } else if (child.type === 'finally_clause') {
        this.visitClause(child, 'finally', state);
      }
    }
  }

  private visitClause(node: SyntaxNode, kind: 'catch' | 'finally', state: AnalyzeState): void {
    const label = kind === 'catch' ? this.cap(`catch ${this.nodeText(node, state.source, state.options).replace(/\{[\s\S]*$/, '').trim()}`, state.options.maxLabelChars) : 'finally';
    this.addItem(state, {
      kind,
      range: this.rangeFor(node, state.node.filePath),
      depth: state.depth,
      label,
    });
    const context = this.enclosingContext(kind, node, label, state);
    this.withContext(state, context, () => this.visitChildren(node, state));
  }

  private visitReturnStatement(node: SyntaxNode, state: AnalyzeState): void {
    const argument = this.returnArgument(node);
    const returnTarget = argument ? this.unwrapParenthesizedExpression(argument) : null;
    const expressionText = argument ? this.nodeText(argument, state.source, state.options) : '';
    const label = this.cap(expressionText ? `return ${expressionText}` : 'return', state.options.maxLabelChars);
    const note = this.isInsideNestedCallback(state) ? NESTED_CALLBACK_NOTE : undefined;

    if (argument) this.suppressReturnTarget(state, argument);

    if (this.isInsideNestedCallback(state)) {
      this.addReturnValue(node, label, state, false, note, argument ?? undefined);
    } else {
      const early = this.isEarlyReturn(node, state);
      this.addItem(state, {
        kind: early ? 'early-return' : 'return-value',
        range: this.rangeFor(node, state.node.filePath),
        depth: state.depth,
        label,
        enclosing: this.copyEnclosing(state),
        objectKeys: returnTarget && this.isObjectLiteral(returnTarget) ? this.objectKeys(returnTarget, state) : undefined,
      });
    }

    if (argument) this.visitExpression(argument, state);
  }

  private addReturnValue(node: SyntaxNode, label: string, state: AnalyzeState, implicit: boolean, note?: string, argument?: SyntaxNode): void {
    const rawTarget = argument ?? node;
    const target = this.unwrapParenthesizedExpression(rawTarget);
    this.addItem(state, {
      kind: 'return-value',
      range: this.rangeFor(node, state.node.filePath),
      depth: state.depth,
      label: this.cap(label, state.options.maxLabelChars),
      enclosing: this.copyEnclosing(state),
      objectKeys: this.isObjectLiteral(target) ? this.objectKeys(target, state) : undefined,
      note,
    });
    if (implicit) this.suppressReturnTarget(state, rawTarget);
  }

  private suppressReturnTarget(state: AnalyzeState, node: SyntaxNode): void {
    state.suppressObjectNodes.add(node.id);
    const unwrapped = this.unwrapParenthesizedExpression(node);
    if (unwrapped.id !== node.id) state.suppressObjectNodes.add(unwrapped.id);
  }

  private unwrapParenthesizedExpression(node: SyntaxNode): SyntaxNode {
    let current = node;
    while (current.type === 'parenthesized_expression') {
      const child = current.namedChild(0);
      if (!child) return current;
      current = child;
    }
    return current;
  }

  private visitCallExpression(node: SyntaxNode, state: AnalyzeState): void {
    const info = this.callInfo(node, state);
    this.addItem(state, {
      kind: info.isCallbackLike ? 'callback-invocation' : 'callsite',
      range: this.rangeFor(node, state.node.filePath),
      depth: state.depth,
      label: info.label,
      calleeText: info.calleeText,
      receiverText: info.receiverText,
      propertyText: info.propertyText,
      enclosing: this.copyEnclosing(state),
      note: this.callNote(info, state),
    });

    const args = getChildByField(node, 'arguments');
    if (args) {
      for (let i = 0; i < args.namedChildCount; i++) {
        const arg = args.namedChild(i);
        if (!arg) continue;
        if (this.isInlineCallback(arg)) {
          if (state.options.includeNestedCallbacks && state.nestedCallbackDepth === 0) {
            this.visitInlineCallback(arg, state);
          }
        } else {
          this.visitNode(arg, state);
        }
      }
      return;
    }

    this.visitChildren(node, state);
  }

  private visitInlineCallback(callback: SyntaxNode, state: AnalyzeState): void {
    const body = this.resolveFunctionBodyNode(callback);
    if (!body) return;
    state.nestedCallbackDepth += 1;
    state.depth += 1;
    try {
      if (body.type === 'statement_block') {
        this.visitChildren(body, state);
      } else {
        this.addReturnValue(body, `implicit return ${this.nodeText(body, state.source, state.options)}`, state, true, NESTED_CALLBACK_NOTE);
        this.visitExpression(body, state);
      }
    } finally {
      state.depth -= 1;
      state.nestedCallbackDepth -= 1;
    }
  }

  private visitObjectLiteral(node: SyntaxNode, state: AnalyzeState): void {
    if (!state.suppressObjectNodes.has(node.id)) {
      const item = this.objectLiteralItem(node, state);
      if (item) this.addItem(state, item);
    }
    this.visitChildren(node, state);
  }

  private objectLiteralItem(node: SyntaxNode, state: AnalyzeState): NodeStructureItem | null {
    const parent = node.parent;
    if (parent?.type === 'return_statement') return null;

    const keys = this.objectKeys(node, state);
    const range = this.rangeFor(node, state.node.filePath);
    const note = this.isInsideNestedCallback(state) ? NESTED_CALLBACK_NOTE : undefined;
    const base = {
      kind: 'object-literal' as const,
      range,
      depth: state.depth,
      objectKeys: keys,
      enclosing: this.copyEnclosing(state),
      note,
    };

    if (parent?.type === 'variable_declarator' && getChildByField(parent, 'value')?.id === node.id) {
      const name = getChildByField(parent, 'name');
      const declaration = parent.parent;
      const declarationText = declaration ? getNodeText(declaration, state.source).trim() : '';
      const keyword = declarationText.startsWith('let ') ? 'let' : declarationText.startsWith('var ') ? 'var' : 'const';
      const nameText = name ? this.nodeText(name, state.source, state.options) : 'value';
      return { ...base, label: this.cap(`${keyword} ${nameText} = { ... }`, state.options.maxLabelChars) };
    }

    if (parent?.type === 'assignment_expression' && getChildByField(parent, 'right')?.id === node.id) {
      const left = getChildByField(parent, 'left') ?? parent.namedChild(0);
      const leftText = left ? this.nodeText(left, state.source, state.options) : 'value';
      return { ...base, label: this.cap(`assignment to ${leftText} = { ... }`, state.options.maxLabelChars) };
    }

    if (parent?.type === 'arguments') {
      const call = parent.parent;
      if (call && call.type === 'call_expression') {
        const info = this.callInfo(call, state);
        return { ...base, label: this.cap(`${info.calleeText ?? 'call'}({ ... }) argument`, state.options.maxLabelChars) };
      }
    }

    return { ...base, label: this.cap('object literal { ... }', state.options.maxLabelChars) };
  }

  private visitNodeOrChildren(node: SyntaxNode, state: AnalyzeState): void {
    if (node.type === 'statement_block') {
      this.visitChildren(node, state);
    } else {
      this.visitNode(node, state);
    }
  }

  private withContext(state: AnalyzeState, context: NodeStructureEnclosingContext, fn: () => void): void {
    state.enclosing.push(context);
    state.depth += 1;
    try {
      fn();
    } finally {
      state.depth -= 1;
      state.enclosing.pop();
    }
  }

  private enclosingContext(kind: NodeStructureEnclosingKind, node: SyntaxNode, label: string, state: AnalyzeState): NodeStructureEnclosingContext {
    return {
      kind,
      range: this.rangeFor(node, state.node.filePath),
      label,
    };
  }

  private addItem(state: AnalyzeState, item: NodeStructureItem): void {
    state.items.push(item);
  }

  private addCaveatOnce(state: AnalyzeState, caveat: string): void {
    if (!state.caveats.includes(caveat)) state.caveats.push(caveat);
  }

  private copyEnclosing(state: AnalyzeState): NodeStructureEnclosingContext[] | undefined {
    return state.enclosing.length > 0 ? state.enclosing.map((ctx) => ({ ...ctx, range: { ...ctx.range } })) : undefined;
  }

  private isEarlyReturn(node: SyntaxNode, state: AnalyzeState): boolean {
    if (state.enclosing.length > 0) return true;
    const parent = node.parent;
    if (!parent || parent.id !== state.bodyRoot.id) return true;
    const named = parent.namedChildren.filter((child) => child.type !== 'comment');
    const last = named[named.length - 1];
    return last?.id !== node.id;
  }

  private returnArgument(node: SyntaxNode): SyntaxNode | null {
    const argument = getChildByField(node, 'argument');
    if (argument) return argument;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) return child;
    }
    return null;
  }

  private containsShallowExit(node: SyntaxNode): boolean {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (this.isExitStatement(child)) return true;
      if (NESTED_FUNCTION_BOUNDARY_TYPES.has(child.type)) continue;
      if (child.type === 'statement_block' || child.type === 'parenthesized_expression') {
        if (this.containsShallowExit(child)) return true;
      }
    }
    return false;
  }

  private exitKind(node: SyntaxNode | null): string {
    if (!node) return 'exit';
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'return_statement') return 'return';
      if (child.type === 'throw_statement') return 'throw';
      if (child.type === 'break_statement') return 'break';
      if (child.type === 'continue_statement') return 'continue';
      const nested = this.exitKind(child);
      if (nested !== 'exit') return nested;
    }
    return 'exit';
  }

  private isExitStatement(node: SyntaxNode): boolean {
    return node.type === 'return_statement' || node.type === 'throw_statement' || node.type === 'break_statement' || node.type === 'continue_statement';
  }

  private loopLabel(node: SyntaxNode, state: AnalyzeState): string {
    const text = this.nodeText(node, state.source, state.options);
    const header = text.split('{')[0]?.trim() ?? node.type;
    return header.length > 0 ? header : node.type;
  }

  private controlFieldText(node: SyntaxNode, field: string, state: AnalyzeState): string {
    const fieldNode = getChildByField(node, field);
    return fieldNode ? this.nodeText(fieldNode, state.source, state.options) : '...';
  }

  private callInfo(node: SyntaxNode, state: AnalyzeState): CallInfo {
    if (node.type === 'new_expression') {
      const constructorNode = getChildByField(node, 'constructor') ?? node.namedChild(0);
      const constructorText = constructorNode ? this.nodeText(constructorNode, state.source, state.options) : this.nodeText(node, state.source, state.options);
      const calleeText = this.cap(constructorText.replace(/^new\s+/, ''), state.options.maxLabelChars);
      return {
        label: this.cap(`new ${calleeText}(...)`, state.options.maxLabelChars),
        calleeText: `new ${calleeText}`,
        isCallbackLike: false,
      };
    }

    const functionNode = getChildByField(node, 'function') ?? node.namedChild(0);
    const callText = this.nodeText(node, state.source, state.options);
    const calleeText = functionNode ? this.nodeText(functionNode, state.source, state.options) : callText.replace(/\([\s\S]*$/, '');
    const property = functionNode ? this.propertyNode(functionNode) : null;
    const receiver = functionNode ? this.receiverNode(functionNode) : null;
    const propertyText = property ? this.nodeText(property, state.source, state.options) : undefined;
    const receiverText = receiver ? this.nodeText(receiver, state.source, state.options) : undefined;
    const directName = this.directCalleeName(functionNode, state);
    const callbackByParam = directName ? state.paramNames.has(directName) : false;
    const callbackByProperty = propertyText ? this.isCallbackLikeName(propertyText) : false;
    const isCallbackLike = callbackByParam || callbackByProperty;

    return {
      label: this.cap(`${calleeText}(...)`, state.options.maxLabelChars),
      calleeText,
      receiverText,
      propertyText,
      isCallbackLike,
    };
  }

  private callNote(info: CallInfo, state: AnalyzeState): string | undefined {
    const notes: string[] = [];
    if (info.isCallbackLike) notes.push(CALLBACK_NOTE);
    if (this.isInsideNestedCallback(state)) notes.push(NESTED_CALLBACK_NOTE);
    return notes.length > 0 ? notes.join('; ') : undefined;
  }

  private directCalleeName(functionNode: SyntaxNode | null, state: AnalyzeState): string | null {
    if (!functionNode) return null;
    if (functionNode.type === 'identifier') return this.nodeText(functionNode, state.source, state.options);
    return null;
  }

  private propertyNode(functionNode: SyntaxNode): SyntaxNode | null {
    if (functionNode.type !== 'member_expression' && functionNode.type !== 'subscript_expression') return null;
    return getChildByField(functionNode, 'property') ?? functionNode.namedChild(1);
  }

  private receiverNode(functionNode: SyntaxNode): SyntaxNode | null {
    if (functionNode.type !== 'member_expression' && functionNode.type !== 'subscript_expression') return null;
    return getChildByField(functionNode, 'object') ?? functionNode.namedChild(0);
  }

  private isCallbackLikeName(name: string): boolean {
    return /(?:callback|handler|listener|on[A-Z].*|.*Fn$|.*Callback$|.*Handler$)/.test(name);
  }

  private isInlineCallback(node: SyntaxNode): boolean {
    return node.type === 'arrow_function' || node.type === 'function_expression';
  }

  private isObjectLiteral(node: SyntaxNode): boolean {
    return node.type === 'object' || node.type === 'object_expression';
  }

  private objectKeys(node: SyntaxNode, state: AnalyzeState): string[] {
    const keys: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const key = this.objectKey(child, state);
      if (key) keys.push(key);
      if (keys.length >= state.options.maxObjectKeys) break;
    }
    return keys;
  }

  private objectKey(node: SyntaxNode, state: AnalyzeState): string | null {
    if (node.type === 'spread_element') return '...spread';
    if (node.type === 'shorthand_property_identifier' || node.type === 'property_identifier' || node.type === 'identifier') {
      return this.nodeText(node, state.source, state.options);
    }
    const key = getChildByField(node, 'key');
    if (!key) return null;
    if (key.type === 'computed_property_name') return '[computed]';
    return this.nodeText(key, state.source, state.options).replace(/^['"]|['"]$/g, '');
  }

  private rangeFor(node: SyntaxNode, filePath: string): SourceRange {
    return {
      path: normalizePath(filePath),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
    };
  }

  private nodeText(node: SyntaxNode, source: string, options: NormalizedOptions): string {
    return this.cap(getNodeText(node, source), options.maxLabelChars);
  }

  private cap(value: string, max: number): string {
    const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= max) return cleaned;
    return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
  }
}
