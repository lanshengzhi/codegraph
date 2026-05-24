/**
 * Field Sites Analyzer
 *
 * Query-time AST analysis for field/key read/write/construction/mapping sites.
 * No DB schema migration; reads indexed file list and parses source on demand.
 */

import * as fs from 'fs/promises';
import type { Parser, Node as SyntaxNode, Tree } from 'web-tree-sitter';
import {
  FieldSite,
  FieldSiteCategory,
  FieldSiteCategoryCounts,
  FieldSiteEvidence,
  FieldSiteSkippedFile,
  FieldSiteSkippedSummary,
  FieldSitesOptions,
  FieldSitesResult,
  FieldSiteStatus,
  FileRecord,
  Language,
  Node,
  NodeHandle,
  SourceRange,
} from '../types';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { hashContent } from '../extraction';
import { getChildByField, getNodeText } from '../extraction/tree-sitter-helpers';
import { normalizePath, validatePathWithinRoot } from '../utils';

const SUPPORTED_LANGUAGES = new Set<Language>(['typescript', 'javascript', 'tsx', 'jsx']);
const DEFAULT_MAX_LABEL_CHARS = 120;
const DEFAULT_MAX_OBJECT_KEYS = 12;
const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES_TO_PARSE = 5000;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_MAX_SKIPPED_FILE_SAMPLES = 20;
const DEFAULT_LIMIT = 80;
const CAVEAT = 'Field sites are static AST navigation hints, not full dataflow, alias analysis, or runtime payload proof.';

// Type-only node types to skip during traversal
const TYPE_ONLY_TYPES = new Set([
  'type_annotation',
  'interface_body',
  'property_signature',
  'object_type',
  'type_arguments',
  'literal_type',
  'type_alias_declaration',
  'interface_declaration',
]);

export interface FieldSitesParserHost {
  loadGrammarsForLanguages(languages: Language[]): Promise<void>;
  getParser(language: Language): Parser | null;
}

const defaultParserHost: FieldSitesParserHost = {
  loadGrammarsForLanguages,
  getParser,
};

type NormalizedFieldSitesOptions = Required<Omit<FieldSitesOptions, 'includeTests'>>;

export class FieldSitesAnalyzer {
  constructor(
    private readonly projectRoot: string,
    private readonly parserHost: FieldSitesParserHost = defaultParserHost
  ) {}

  async analyze(
    field: string,
    files: FileRecord[],
    loadNodesForFile: (path: string) => Node[],
    options: FieldSitesOptions = {}
  ): Promise<FieldSitesResult> {
    const normalized = this.normalizeOptions(options);
    const limit = normalized.limit;

    const scopePath = normalized.scopePath;

    const resultBase = (status: FieldSiteStatus): FieldSitesResult => ({
      status,
      field,
      scopePath,
      includeTests: options?.includeTests !== false,
      limit,
      sites: [],
      searchedFiles: 0,
      searchableFiles: 0,
      parsedFiles: 0,
      matchedFiles: 0,
      skippedFileCount: 0,
      skippedFilesOmitted: 0,
      skippedSummary: {},
      skippedFiles: [],
      totalSites: 0,
      totalSitesByCategory: {},
      omittedSites: 0,
      omittedSitesByCategory: {},
      caveats: [CAVEAT],
      recommendations: [],
    });

    // Validate field
    const trimmed = field.trim();
    if (!trimmed || trimmed.includes('\n') || trimmed.length > 120) {
      return {
        ...resultBase('invalid-field'),
        recommendations: ['Provide a non-empty field name without newlines, up to 120 characters.'],
      };
    }

    const fieldQuery = trimmed;

    const searchedFiles = files.length;

    // Separate supported vs unsupported
    const supportedFiles: FileRecord[] = [];
    const skippedFiles: FieldSiteSkippedFile[] = [];
    const skippedSummary: FieldSiteSkippedSummary = {};

    for (const file of files) {
      if (SUPPORTED_LANGUAGES.has(file.language)) {
        supportedFiles.push(file);
      } else {
        this.addSkipped(skippedFiles, skippedSummary, {
          path: file.path,
          language: file.language,
          reason: 'unsupported-language',
        });
      }
    }

    const searchableFiles = supportedFiles.length;

    if (searchableFiles === 0) {
      const result = resultBase('no-searchable-files');
      result.searchedFiles = searchedFiles;
      result.searchableFiles = 0;
      result.skippedFileCount = skippedFiles.length;
      result.skippedSummary = skippedSummary;
      result.skippedFiles = this.capSkippedFiles(skippedFiles, normalized.maxSkippedFileSamples);
      result.skippedFilesOmitted = Math.max(0, skippedFiles.length - result.skippedFiles.length);
      result.caveats.push('No TypeScript/JavaScript/TSX/JSX files found in scope. Field sites currently supports only these languages.');
      return result;
    }

    // Distinct languages for parser loading
    const distinctLanguages = [...new Set(supportedFiles.map((f) => f.language))].filter((l): l is Language =>
      SUPPORTED_LANGUAGES.has(l)
    );

    try {
      await this.parserHost.loadGrammarsForLanguages(distinctLanguages);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = resultBase('parser-unavailable');
      result.searchedFiles = searchedFiles;
      result.searchableFiles = searchableFiles;
      for (const file of supportedFiles) {
        this.addSkipped(skippedFiles, skippedSummary, {
          path: file.path,
          language: file.language,
          reason: 'parser-unavailable',
          detail: message,
        });
      }
      result.skippedFileCount = skippedFiles.length;
      result.skippedSummary = skippedSummary;
      result.skippedFiles = this.capSkippedFiles(skippedFiles, normalized.maxSkippedFileSamples);
      result.skippedFilesOmitted = Math.max(0, skippedFiles.length - result.skippedFiles.length);
      return result;
    }

    const parsers = new Map<Language, Parser | null>();
    for (const lang of distinctLanguages) {
      parsers.set(lang, this.parserHost.getParser(lang));
    }

    // Collect sites
    const allSites: FieldSite[] = [];
    let parsedFiles = 0;
    let matchedFiles = 0;
    let hasPartial = false;

    const parseBudget = { remaining: normalized.maxFilesToParse };

    // Process in batches for I/O concurrency.
    // Budget is only consumed by files that actually reach parser.parse;
    // prefilter-negative files don't count. When the real parse budget is
    // exhausted, remaining files in this and future batches are skipped.
    for (let i = 0; i < supportedFiles.length; i += DEFAULT_BATCH_SIZE) {
      const batch = supportedFiles.slice(i, i + DEFAULT_BATCH_SIZE);

      // Process the full batch — budget check is based on actual parsedFiles,
      // not a pre-emptive slice. Some files in the batch may be cheap-prefilter
      // negatives and won't consume budget.
      const batchResults = await Promise.all(
        batch.map((file) =>
          this.processFile(file, fieldQuery, parsers, normalized, loadNodesForFile, parseBudget)
        )
      );

      for (const res of batchResults) {
        if (res.parsed) {
          parsedFiles++;
        }
        if (res.skipped) {
          this.addSkipped(skippedFiles, skippedSummary, res.skipped);
          if (res.skipped.reason !== 'unsupported-language') {
            hasPartial = true;
          }
        }
        if (res.sites.length > 0) {
          matchedFiles++;
          allSites.push(...res.sites);
        }
      }

      // After the batch: check real parse budget.
      if (parsedFiles >= normalized.maxFilesToParse) {
        // Budget exhausted — mark all remaining files as too-many-files.
        for (let j = i + DEFAULT_BATCH_SIZE; j < supportedFiles.length; j++) {
          const f = supportedFiles[j];
          if (!f) continue;
          this.addSkipped(skippedFiles, skippedSummary, {
            path: f.path,
            language: f.language,
            reason: 'too-many-files',
          });
        }
        hasPartial = true;
        break;
      }
    }

    // Sort: production before test, then category priority, then path/order
    allSites.sort((a, b) => {
      const aTest = a.isTestOrFixture ? 1 : 0;
      const bTest = b.isTestOrFixture ? 1 : 0;
      if (aTest !== bTest) return aTest - bTest;
      const catPriority = (c: FieldSiteCategory): number => {
        switch (c) {
          case 'write': return 0;
          case 'mapping': return 1;
          case 'construction': return 2;
          case 'read': return 3;
          default: return 4;
        }
      };
      const pa = catPriority(a.category);
      const pb = catPriority(b.category);
      if (pa !== pb) return pa - pb;
      if (a.range.path !== b.range.path) return a.range.path.localeCompare(b.range.path);
      if (a.range.startLine !== b.range.startLine) return a.range.startLine - b.range.startLine;
      return (a.range.startColumn ?? 0) - (b.range.startColumn ?? 0);
    });

    const totalSites = allSites.length;
    const totalSitesByCategory = this.countByCategory(allSites);

    const sites = allSites.slice(0, limit);
    const omittedSites = allSites.length - sites.length;
    const omittedSitesByCategory = this.countByCategory(allSites.slice(limit));

    // Determine if all skipped supported files are parser-unavailable.
    // Exclude unsupported-language from the check — Python files in scope
    // should not prevent the parser-unavailable status for TS/JS files.
    const supportedSkipped = skippedFiles.filter((s) => s.reason !== 'unsupported-language');
    const supportedSkippedCount = supportedSkipped.length;
    const allSupportedSkipped = supportedSkippedCount > 0 && supportedSkippedCount === supportedFiles.length;
    const allParserUnavailable = allSupportedSkipped && supportedSkipped.every((s) => s.reason === 'parser-unavailable');
    const someSupportedSkipped = supportedSkippedCount > 0 && supportedSkippedCount < supportedFiles.length;

    let status: FieldSiteStatus;
    if (allParserUnavailable) {
      status = 'parser-unavailable';
    } else if (allSupportedSkipped) {
      status = 'all-skipped';
    } else if (totalSites > 0 && !hasPartial && omittedSites === 0) {
      status = 'available';
    } else if (totalSites > 0 || hasPartial || omittedSites > 0) {
      status = 'partial';
    } else if (someSupportedSkipped) {
      status = 'partial';
    } else {
      status = 'no-matches';
    }

    const result: FieldSitesResult = {
      status,
      field,
      scopePath,
      includeTests: options?.includeTests !== false,
      limit,
      sites,
      searchedFiles,
      searchableFiles,
      parsedFiles,
      matchedFiles,
      skippedFileCount: skippedFiles.length,
      skippedFilesOmitted: 0,
      skippedSummary,
      skippedFiles: this.capSkippedFiles(skippedFiles, normalized.maxSkippedFileSamples),
      totalSites,
      totalSitesByCategory,
      omittedSites,
      omittedSitesByCategory,
      caveats: [CAVEAT],
      recommendations: [],
    };

    result.skippedFilesOmitted = Math.max(0, skippedFiles.length - result.skippedFiles.length);

    if (status === 'no-matches') {
      if (parsedFiles === 0) {
        result.caveats.push('No source text contained the exact field string; dynamic/computed/alias cases are not covered.');
      } else {
        result.caveats.push('No value-level AST field sites matched (parsed files may contain the field only in type declarations, dynamic keys, or unsupported syntax).');
      }
      result.recommendations.push('Try a targeted read or grep for dynamic/alias usage.');
      if (options.includeTests === false) {
        result.recommendations.push('Retry with includeTests: true if test/fixture examples are useful.');
      }
    }

    if (status === 'all-skipped') {
      result.recommendations.push('codegraph sync --quiet');
    }

    if (status === 'partial') {
      const parts: string[] = [];
      if (omittedSites > 0) {
        parts.push(`${omittedSites} site(s) omitted (limit ${limit})`);
      }
      const skippedReasons = new Set(skippedFiles.map(s => s.reason));
      if (skippedReasons.size > 0) {
        parts.push(`${skippedFiles.length} file(s) skipped (${[...skippedReasons].join(', ')})`);
      }
      if (hasPartial) {
        parts.push('some matched files had partial AST coverage');
      }
      if (parts.length > 0) {
        result.caveats.push(`Incomplete: ${parts.join('; ')}.`);
      }
    }

    // Generate recommendations from top enclosing nodes (available or partial)
    if ((status === 'available' || status === 'partial') && sites.length > 0) {
      const seen = new Set<string>();
      const topNodes: Array<{ nodeId: string; path: string; line: number }> = [];
      for (const site of sites) {
        const enc = site.enclosingNode;
        if (!enc?.nodeId || seen.has(enc.nodeId)) continue;
        seen.add(enc.nodeId);
        topNodes.push({ nodeId: enc.nodeId, path: site.range.path, line: site.range.startLine });
        if (topNodes.length >= 5) break;
      }

      for (const n of topNodes) {
        result.recommendations.push(`codegraph_node({ nodeId: "${n.nodeId}", detail: "structure" })`);
      }
    }

    return result;
  }

  private normalizeOptions(options: FieldSitesOptions): NormalizedFieldSitesOptions {
    return {
      scopePath: options.scopePath ?? '',
      limit: Math.max(1, Math.min(300, options.limit ?? DEFAULT_LIMIT)),
      maxSourceBytes: options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
      maxLabelChars: options.maxLabelChars ?? DEFAULT_MAX_LABEL_CHARS,
      maxObjectKeys: options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
      maxSkippedFileSamples: options.maxSkippedFileSamples ?? DEFAULT_MAX_SKIPPED_FILE_SAMPLES,
      maxFilesToParse: Math.max(1, options.maxFilesToParse ?? DEFAULT_MAX_FILES_TO_PARSE),
    };
  }

  private isTestOrFixturePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return /(^|[\\/])(__tests__|__mocks__|tests?|fixtures?|examples?|e2e|specs?|stories|generated)([\\/]|$)/.test(lower)
      || /\.(test|spec|fixture|example|e2e|stories)\.(ts|tsx|js|jsx)$/.test(lower)
      || lower.includes('.generated.');
  }

  private addSkipped(
    list: FieldSiteSkippedFile[],
    summary: FieldSiteSkippedSummary,
    item: FieldSiteSkippedFile
  ): void {
    list.push(item);
    summary[item.reason] = (summary[item.reason] ?? 0) + 1;
  }

  private capSkippedFiles(files: FieldSiteSkippedFile[], max: number): FieldSiteSkippedFile[] {
    return files.slice(0, max);
  }

  private countByCategory(sites: FieldSite[]): FieldSiteCategoryCounts {
    const counts: FieldSiteCategoryCounts = {};
    for (const site of sites) {
      counts[site.category] = (counts[site.category] ?? 0) + 1;
    }
    return counts;
  }

  private async processFile(
    file: FileRecord,
    field: string,
    parsers: Map<Language, Parser | null>,
    options: NormalizedFieldSitesOptions,
    loadNodesForFile: (path: string) => Node[],
    parseBudget: { remaining: number },
  ): Promise<{
    parsed: boolean;
    sites: FieldSite[];
    skipped?: FieldSiteSkippedFile;
  }> {
    const safePath = validatePathWithinRoot(this.projectRoot, file.path);
    if (!safePath) {
      return {
        parsed: false,
        sites: [],
        skipped: { path: file.path, language: file.language, reason: 'outside-root' },
      };
    }

    let stat;
    try {
      stat = await fs.stat(safePath);
    } catch {
      return {
        parsed: false,
        sites: [],
        skipped: { path: file.path, language: file.language, reason: 'source-unavailable' },
      };
    }

    if (!stat.isFile()) {
      return {
        parsed: false,
        sites: [],
        skipped: { path: file.path, language: file.language, reason: 'source-unavailable' },
      };
    }

    if (stat.size > options.maxSourceBytes) {
      return {
        parsed: false,
        sites: [],
        skipped: { path: file.path, language: file.language, reason: 'source-too-large' },
      };
    }

    let source: string;
    try {
      source = await fs.readFile(safePath, 'utf8');
    } catch {
      return {
        parsed: false,
        sites: [],
        skipped: { path: file.path, language: file.language, reason: 'source-unavailable' },
      };
    }

    if (hashContent(source) !== file.contentHash) {
      return {
        parsed: false,
        sites: [],
        skipped: { path: file.path, language: file.language, reason: 'source-stale' },
      };
    }

    // Cheap prefilter
    if (!this.sourceMightContainField(source, field)) {
      return { parsed: false, sites: [] };
    }

    const parser = parsers.get(file.language) ?? null;
    if (!parser) {
      return {
        parsed: false,
        sites: [],
        skipped: { path: file.path, language: file.language, reason: 'parser-unavailable' },
      };
    }

    if (parseBudget.remaining <= 0) {
      return {
        parsed: false,
        sites: [],
        skipped: { path: file.path, language: file.language, reason: 'too-many-files' },
      };
    }
    parseBudget.remaining--;

    let tree: Tree | null = null;
    let didParse = false;
    try {
      didParse = true;
      tree = parser.parse(source);
      if (!tree) {
        return {
          parsed: true,
          sites: [],
          skipped: { path: file.path, language: file.language, reason: 'parse-error' },
        };
      }

      if (tree.rootNode.hasError) {
        // File reached parser.parse but produced errors — count toward
        // parsedFiles budget per plan spec, even though sites are
        // conservatively skipped.
        return {
          parsed: true,
          sites: [],
          skipped: { path: file.path, language: file.language, reason: 'parse-error' },
        };
      }

      const sites = this.collectSites(tree.rootNode, field, file, source, options);

      // Lazy enclosing node resolution
      if (sites.length > 0) {
        const nodes = loadNodesForFile(file.path);
        for (const site of sites) {
          site.enclosingNode = this.findEnclosingNode(nodes, site.range.startLine);
        }
      }

      return { parsed: true, sites };
    } catch {
      return {
        parsed: didParse,
        sites: [],
        skipped: { path: file.path, language: file.language, reason: 'parse-error' },
      };
    } finally {
      tree?.delete();
    }
  }

  private sourceMightContainField(source: string, field: string): boolean {
    if (source.includes(field)) return true;
    // Defensive: quoted key names like obj['field'] or { "field": value }
    // are usually already matched by the bare text check above (the quoted
    // string contains the field as a substring), but we also check the
    // quoted forms explicitly to avoid false-negative skips in edge cases.
    if (source.includes(`"${field}"`)) return true;
    if (source.includes(`'${field}'`)) return true;
    return false;
  }

  private collectSites(
    root: SyntaxNode,
    field: string,
    file: FileRecord,
    source: string,
    options: NormalizedFieldSitesOptions
  ): FieldSite[] {
    const sites: FieldSite[] = [];
    const isTest = this.isTestOrFixturePath(file.path);

    const visit = (node: SyntaxNode): void => {
      // Skip type-only subtrees
      if (TYPE_ONLY_TYPES.has(node.type)) return;

      // Assignment / compound assignment / update expression
      if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
        const left = getChildByField(node, 'left');
        const right = getChildByField(node, 'right');
        if (left) {
          const match = this.matchFieldNode(left, field);
          if (match.matched) {
            const isCompound = node.type === 'augmented_assignment_expression';
            sites.push({
              field,
              kind: 'assignment',
              category: 'write',
              access: isCompound ? 'readwrite' : 'write',
              evidence: match.evidence,
              range: this.rangeFor(node, file.path),
              label: this.cap(`${this.nodeText(left, source, options)} ${isCompound ? this.extractOperator(source, left.endIndex, right?.startIndex ?? left.endIndex) : '='} ...`, options.maxLabelChars),
              receiverText: match.receiverText,
              propertyText: match.propertyText,
              isTestOrFixture: isTest,
              note: isCompound ? 'compound assignment also reads previous value; not separately emitted as read' : undefined,
            });
            // Visit right side for reads/mappings
            if (right) visit(right);
            return;
          }
        }
      }

      // Update expression (++ / --)
      if (node.type === 'update_expression') {
        const arg = getChildByField(node, 'argument') ?? node.namedChild(0);
        if (arg) {
          const match = this.matchFieldNode(arg, field);
          if (match.matched) {
            sites.push({
              field,
              kind: 'assignment',
              category: 'write',
              access: 'readwrite',
              evidence: match.evidence,
              range: this.rangeFor(node, file.path),
              label: this.cap(this.nodeText(node, source, options), options.maxLabelChars),
              receiverText: match.receiverText,
              propertyText: match.propertyText,
              isTestOrFixture: isTest,
              note: 'update expression also reads previous value; not separately emitted as read',
            });
            return;
          }
        }
      }

      // Mapping hint: assignment where RHS contains field read and LHS is different key
      if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
        const left = getChildByField(node, 'left');
        const right = getChildByField(node, 'right');
        if (left && right) {
          const mapping = this.findMappingInExpression(right, left, field, source, options, file.path, isTest, undefined, node);
          if (mapping) {
            sites.push(mapping);
          }
        }
      }

      // Property read (member expression or subscript)
      if (node.type === 'member_expression' || node.type === 'subscript_expression' || node.type === 'optional_member_expression') {
        const match = this.matchFieldNode(node, field);
        if (match.matched) {
          // Don't report reads that are assignment LHS (handled above)
          // P2b 首版不处理 delete expression
          const parent = node.parent;
          if (parent?.type === 'unary_expression' && parent.text.startsWith('delete ')) {
            // Skip delete sites; not property-read or write in P2b
          } else if (parent && (parent.type === 'assignment_expression' || parent.type === 'augmented_assignment_expression')) {
            const parentLeft = getChildByField(parent, 'left');
            if (parentLeft?.id === node.id) {
              // Skip, already handled as assignment
            } else {
              sites.push(this.createPropertyReadSite(node, field, match, file.path, source, options, isTest));
            }
          } else {
            sites.push(this.createPropertyReadSite(node, field, match, file.path, source, options, isTest));
          }
        }
      }

      // Object literal key / shorthand
      if (node.type === 'object' || node.type === 'object_expression') {
        const parent = node.parent;
        const isReturnObject = parent?.type === 'return_statement';

        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child) continue;

          // Skip spread elements for key listing
          if (child.type === 'spread_element') continue;

          const keyMatch = this.matchFieldNode(child, field);
          if (keyMatch.matched) {
            const objectKeys = this.extractObjectKeys(node, source, options);
            const site: FieldSite = {
              field,
              kind: isReturnObject ? 'return-object-field' : 'object-literal-key',
              category: 'construction',
              access: 'read',
              evidence: keyMatch.evidence,
              range: this.rangeFor(child, file.path),
              label: this.cap(`${isReturnObject ? 'return object' : 'object'} key ${keyMatch.propertyText ?? field}${isReturnObject ? '' : ' in { ... }'}`, options.maxLabelChars),
              propertyText: keyMatch.propertyText,
              objectKeys,
              isTestOrFixture: isTest,
              note: keyMatch.evidence === 'shorthand-key' ? 'shorthand key; local value read not traced' : undefined,
            };
            sites.push(site);
          }

          // Mapping hint inside object literal
          const value = getChildByField(child, 'value');
          if (value) {
            const propKey = this.getObjectPropertyKey(child, source, options);
            if (propKey && propKey !== field) {
              const mapping = this.findMappingInExpression(value, null, field, source, options, file.path, isTest, propKey, child);
              if (mapping) sites.push(mapping);
            }
          }
        }

        // If this is a return object, don't also visit children as generic object literal keys
        if (isReturnObject) {
          // Still visit value expressions for reads/mappings
          for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (!child) continue;
            const value = getChildByField(child, 'value');
            if (value) visit(value);
          }
          return;
        }
      }

      // Destructuring
      if (node.type === 'object_pattern') {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child) continue;

          const match = this.matchFieldNode(child, field);
          if (match.matched) {
            const alias = this.getDestructureAlias(child, source, options);
            sites.push({
              field,
              kind: 'destructuring',
              category: 'read',
              access: 'read',
              evidence: 'destructuring-pattern',
              range: this.rangeFor(child, file.path),
              label: this.cap(`destructure ${field}${alias ? ` as ${alias}` : ''}`, options.maxLabelChars),
              propertyText: match.propertyText,
              isTestOrFixture: isTest,
              note: node.parent?.type === 'formal_parameters' || node.parent?.parent?.type === 'formal_parameters'
                ? 'parameter destructuring site; caller value not inferred'
                : undefined,
            });
          }
        }
      }

      // Class field definition — only emit write when there is a value
      // initializer (systemPrompt = 'x'). Type-only declarations
      // (systemPrompt: string), definite assignment (!), and declare
      // fields must NOT produce write sites.
      if (node.type === 'field_definition' || node.type === 'public_field_definition') {
        const valueNode = getChildByField(node, 'value');
        if (!valueNode) {
          // No initializer — pure type annotation or declare, skip.
          return;
        }
        const name = getChildByField(node, 'name') ?? node.namedChild(0);
        if (name) {
          const match = this.matchFieldNode(name, field);
          if (match.matched) {
            sites.push({
              field,
              kind: 'assignment',
              category: 'write',
              access: 'write',
              evidence: match.evidence,
              range: this.rangeFor(node, file.path),
              label: this.cap(this.nodeText(node, source, options), options.maxLabelChars),
              propertyText: match.propertyText,
              isTestOrFixture: isTest,
            });
          }
        }
      }

      // Visit children (except type-only already filtered)
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && !TYPE_ONLY_TYPES.has(child.type)) visit(child);
      }
    };

    visit(root);

    // Deduplicate same syntax node + kind + category
    const seen = new Set<string>();
    const deduped: FieldSite[] = [];
    for (const site of sites) {
      const key = `${site.range.path}:${site.range.startLine}:${site.range.startColumn ?? 0}:${site.kind}:${site.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(site);
    }

    return deduped;
  }

  private createPropertyReadSite(
    node: SyntaxNode,
    field: string,
    match: { matched: boolean; evidence: FieldSiteEvidence; receiverText?: string; propertyText?: string },
    filePath: string,
    source: string,
    options: NormalizedFieldSitesOptions,
    isTest: boolean
  ): FieldSite {
    return {
      field,
      kind: 'property-read',
      category: 'read',
      access: 'read',
      evidence: match.evidence,
      range: this.rangeFor(node, filePath),
      label: this.cap(this.nodeText(node, source, options), options.maxLabelChars),
      receiverText: match.receiverText,
      propertyText: match.propertyText,
      isTestOrFixture: isTest,
    };
  }

  private findMappingInExpression(
    expr: SyntaxNode,
    targetNode: SyntaxNode | null,
    field: string,
    source: string,
    options: NormalizedFieldSitesOptions,
    filePath: string,
    isTest: boolean,
    explicitTargetKey?: string,
    rangeNode?: SyntaxNode
  ): FieldSite | null {
    // Find any member expression or subscript in expr that matches field
    const findFieldRead = (node: SyntaxNode): { node: SyntaxNode; match: { receiverText?: string; propertyText?: string } } | null => {
      if (node.type === 'member_expression' || node.type === 'subscript_expression' || node.type === 'optional_member_expression') {
        const m = this.matchFieldNode(node, field);
        if (m.matched) {
          return { node, match: { receiverText: m.receiverText, propertyText: m.propertyText } };
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        const found = findFieldRead(child);
        if (found) return found;
      }
      return null;
    };

    const fieldRead = findFieldRead(expr);
    if (!fieldRead) return null;

    let targetKey = explicitTargetKey;
    if (!targetKey && targetNode) {
      if (targetNode.type === 'member_expression' || targetNode.type === 'subscript_expression' || targetNode.type === 'optional_member_expression') {
        const prop = getChildByField(targetNode, 'property') ?? targetNode.namedChild(1);
        if (prop) {
          targetKey = this.nodeText(prop, source, options).replace(/^['"]|['"]$/g, '');
        } else {
          targetKey = this.nodeText(targetNode, source, options);
        }
      } else {
        targetKey = this.nodeText(targetNode, source, options);
      }
    }
    if (!targetKey) return null;

    // Avoid mapping when target key equals source field (not a rename)
    if (targetKey === field) return null;

    return {
      field,
      kind: 'field-mapping',
      category: 'mapping',
      access: 'read',
      evidence: 'mapping-heuristic',
      range: this.rangeFor(rangeNode ?? expr, filePath),
      label: this.cap(`${targetKey} <- ${fieldRead.match.receiverText ? fieldRead.match.receiverText + '.' : ''}${field}`, options.maxLabelChars),
      targetKey,
      sourceField: field,
      receiverText: fieldRead.match.receiverText,
      propertyText: fieldRead.match.propertyText,
      isTestOrFixture: isTest,
      note: 'syntax-only mapping hint; not dataflow or runtime payload proof',
    };
  }

  private matchFieldNode(
    node: SyntaxNode,
    field: string
  ): { matched: boolean; evidence: FieldSiteEvidence; receiverText?: string; propertyText?: string } {
    // Shorthand property identifier
    if (node.type === 'shorthand_property_identifier') {
      const text = node.text;
      if (text === field) {
        return { matched: true, evidence: 'shorthand-key', propertyText: text };
      }
      return { matched: false, evidence: 'shorthand-key' };
    }

    // Direct identifier match
    if (
      node.type === 'identifier' ||
      node.type === 'property_identifier' ||
      node.type === 'shorthand_property_identifier_pattern'
    ) {
      const text = node.text;
      if (text === field) {
        return { matched: true, evidence: 'exact-identifier', propertyText: text };
      }
      return { matched: false, evidence: 'exact-identifier' };
    }

    // Private property identifier
    if (node.type === 'private_property_identifier') {
      const text = node.text;
      if (text === field) {
        return { matched: true, evidence: 'exact-identifier', propertyText: text };
      }
      return { matched: false, evidence: 'exact-identifier' };
    }

    // Pair pattern (destructuring alias)
    if (node.type === 'pair_pattern') {
      const key = getChildByField(node, 'key');
      if (key) {
        const keyText = key.text;
        if (keyText === field) {
          return { matched: true, evidence: 'destructuring-pattern', propertyText: keyText };
        }
      }
      return { matched: false, evidence: 'destructuring-pattern' };
    }

    // String literal key
    if (node.type === 'string') {
      const text = node.text.replace(/^['"]|['"]$/g, '');
      if (text === field) {
        return { matched: true, evidence: 'string-literal-key', propertyText: text };
      }
      return { matched: false, evidence: 'string-literal-key' };
    }

    // Computed property name with string literal
    if (node.type === 'computed_property_name') {
      const inner = node.namedChild(0);
      if (inner && inner.type === 'string') {
        const text = inner.text.replace(/^['"]|['"]$/g, '');
        if (text === field) {
          return { matched: true, evidence: 'computed-string-literal-key', propertyText: text };
        }
      }
      return { matched: false, evidence: 'computed-string-literal-key' };
    }

    // Member expression / optional member expression
    if (node.type === 'member_expression' || node.type === 'optional_member_expression') {
      const prop = getChildByField(node, 'property') ?? node.namedChild(1);
      if (prop) {
        const propMatch = this.matchFieldNode(prop, field);
        if (propMatch.matched) {
          const obj = getChildByField(node, 'object') ?? node.namedChild(0);
          return {
            matched: true,
            evidence: propMatch.evidence,
            receiverText: obj?.text,
            propertyText: propMatch.propertyText,
          };
        }
      }
      return { matched: false, evidence: 'exact-identifier' };
    }

    // Subscript expression with string literal
    if (node.type === 'subscript_expression') {
      const index = getChildByField(node, 'index') ?? node.namedChild(1);
      if (index && index.type === 'string') {
        const text = index.text.replace(/^['"]|['"]$/g, '');
        if (text === field) {
          const obj = getChildByField(node, 'object') ?? node.namedChild(0);
          return { matched: true, evidence: 'string-literal-key', receiverText: obj?.text, propertyText: text };
        }
      }
      // Computed property name with string literal
      if (index && index.type === 'computed_property_name') {
        const inner = index.namedChild(0);
        if (inner && inner.type === 'string') {
          const text = inner.text.replace(/^['"]|['"]$/g, '');
          if (text === field) {
            const obj = getChildByField(node, 'object') ?? node.namedChild(0);
            return { matched: true, evidence: 'computed-string-literal-key', receiverText: obj?.text, propertyText: text };
          }
        }
      }
      return { matched: false, evidence: 'string-literal-key' };
    }

    // Object property pair (key side)
    if (node.type === 'pair') {
      const key = getChildByField(node, 'key');
      if (key) {
        const keyMatch = this.matchFieldNode(key, field);
        if (keyMatch.matched) {
          return { matched: true, evidence: keyMatch.evidence, propertyText: keyMatch.propertyText };
        }
      }
      return { matched: false, evidence: 'exact-identifier' };
    }

    return { matched: false, evidence: 'exact-identifier' };
  }

  private getObjectPropertyKey(node: SyntaxNode, source: string, options: NormalizedFieldSitesOptions): string | null {
    if (node.type === 'shorthand_property_identifier') return node.text;
    const key = getChildByField(node, 'key');
    if (!key) return null;
    return this.nodeText(key, source, options).replace(/^['"]|['"]$/g, '');
  }

  private getDestructureAlias(node: SyntaxNode, source: string, options: NormalizedFieldSitesOptions): string | null {
    if (node.type === 'pair_pattern') {
      const value = getChildByField(node, 'value');
      if (value) return this.nodeText(value, source, options);
    }
    return null;
  }

  private extractObjectKeys(node: SyntaxNode, source: string, options: NormalizedFieldSitesOptions): string[] {
    const keys: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'spread_element') {
        keys.push('...spread');
        continue;
      }
      const key = this.getObjectPropertyKey(child, source, options);
      if (key) keys.push(key);
      if (keys.length >= options.maxObjectKeys) break;
    }
    return keys;
  }

  private findEnclosingNode(nodes: Node[], line: number): NodeHandle | undefined {
    const containing = nodes
      .filter((n) => n.kind !== 'file' && line >= n.startLine && line <= n.endLine)
      .sort((a, b) => {
        const rangeA = a.endLine - a.startLine;
        const rangeB = b.endLine - b.startLine;
        return rangeA - rangeB;
      });

    const best = containing[0];
    if (!best) return undefined;

    return {
      nodeId: best.id,
      name: best.name,
      kind: best.kind,
      qualifiedName: best.qualifiedName,
      path: best.filePath,
      startLine: best.startLine,
      endLine: best.endLine,
      signature: best.signature,
    };
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

  private extractOperator(source: string, startIndex: number, endIndex: number): string {
    const text = source.substring(startIndex, endIndex).trim();
    // Extract assignment operator from text like " += " or " |= "
    const m = text.match(/^(\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<=|>>=|>>>=|=)/);
    return m ? m[1]! : '=';
  }

  private nodeText(node: SyntaxNode, source: string, options: NormalizedFieldSitesOptions): string {
    return this.cap(getNodeText(node, source), options.maxLabelChars);
  }

  private cap(value: string, max: number): string {
    const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= max) return cleaned;
    return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
  }
}
