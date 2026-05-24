/**
 * User-facing CodeGraph instructions stay in sync for addressability and trace.
 */
import { describe, it, expect } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';
import { INSTRUCTIONS_TEMPLATE } from '../src/installer/instructions-template';

describe('CodeGraph instructions', () => {
  it('mentions trace, precise locators, edge evidence, and boundaries in server instructions', () => {
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_trace');
    expect(SERVER_INSTRUCTIONS).toContain('nodeId');
    expect(SERVER_INSTRUCTIONS).toContain('file:line');
    expect(SERVER_INSTRUCTIONS).toContain('edge evidence');
    expect(SERVER_INSTRUCTIONS).toContain('direct-call');
    expect(SERVER_INSTRUCTIONS).toContain('property-call');
    expect(SERVER_INSTRUCTIONS).toContain('boundary');
    expect(SERVER_INSTRUCTIONS).toContain('static score');
    expect(SERVER_INSTRUCTIONS).toContain('not runtime main-path proof');
    expect(SERVER_INSTRUCTIONS).toContain('relevance reasons');
    expect(SERVER_INSTRUCTIONS).toContain('static ranking explanations');
    expect(SERVER_INSTRUCTIONS).toContain('detail: "structure"');
    expect(SERVER_INSTRUCTIONS).toContain('long TS/JS functions');
    expect(SERVER_INSTRUCTIONS).toContain('structure summary');
    expect(SERVER_INSTRUCTIONS).toContain('not runtime proof');
    expect(SERVER_INSTRUCTIONS).toContain('git status/diff');
  });

  it('mentions field sites and its caveats in server instructions', () => {
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_field_sites');
    expect(SERVER_INSTRUCTIONS).toContain('not full dataflow or runtime proof');
    expect(SERVER_INSTRUCTIONS).toContain('dynamic/computed/alias cases');
    expect(SERVER_INSTRUCTIONS).toContain('Provider payload');
  });

  it('mentions trace, precise locators, edge evidence, and boundaries in installed agent instructions', () => {
    expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph_trace');
    expect(INSTRUCTIONS_TEMPLATE).toContain('nodeId');
    expect(INSTRUCTIONS_TEMPLATE).toContain('file:line');
    expect(INSTRUCTIONS_TEMPLATE).toContain('edge evidence');
    expect(INSTRUCTIONS_TEMPLATE).toContain('direct-call');
    expect(INSTRUCTIONS_TEMPLATE).toContain('property-call');
    expect(INSTRUCTIONS_TEMPLATE).toContain('boundary');
    expect(INSTRUCTIONS_TEMPLATE).toContain('static score');
    expect(INSTRUCTIONS_TEMPLATE).toContain('not runtime main-path proof');
    expect(INSTRUCTIONS_TEMPLATE).toContain('relevance reasons');
    expect(INSTRUCTIONS_TEMPLATE).toContain('complete semantic proof');
    expect(INSTRUCTIONS_TEMPLATE).toContain('detail: "structure"');
    expect(INSTRUCTIONS_TEMPLATE).toContain('long TS/JS function');
    expect(INSTRUCTIONS_TEMPLATE).toContain('structure summary');
    expect(INSTRUCTIONS_TEMPLATE).toContain('not runtime proof');
    expect(INSTRUCTIONS_TEMPLATE).toContain('git status');
    expect(INSTRUCTIONS_TEMPLATE).toContain('git diff');
  });

  it('mentions field sites and its caveats in installed agent instructions', () => {
    expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph_field_sites');
    expect(INSTRUCTIONS_TEMPLATE).toContain('not full dataflow or runtime proof');
    expect(INSTRUCTIONS_TEMPLATE).toContain('dynamic or computed keys');
    expect(INSTRUCTIONS_TEMPLATE).toContain('Field sites are static hints, not dataflow');
  });

  // P3 ecosystem tools
  it('mentions ecosystem candidate tools and coverage caveats in server instructions', () => {
    // PR2: workspace import candidates
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_import_candidates');
    expect(SERVER_INSTRUCTIONS).toContain('not a complete Node/TypeScript resolver');
    // PR3: registry candidates
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_registry_candidates');
    expect(SERVER_INSTRUCTIONS).toContain('not runtime branch proof');
    // PR1: coverage / indexed-only boundary
    expect(SERVER_INSTRUCTIONS).toContain('indexed source coverage');
    expect(SERVER_INSTRUCTIONS).toContain('not a complete filesystem inventory');
    // Ensure coverage detail is mentioned
    expect(SERVER_INSTRUCTIONS).toContain('detail: "coverage"');
  });

  it('mentions ecosystem candidate tools and caveats in installed agent instructions', () => {
    // PR2: workspace import candidates
    expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph_import_candidates');
    expect(INSTRUCTIONS_TEMPLATE).toContain('static workspace package entry candidates');
    // PR3: registry candidates
    expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph_registry_candidates');
    expect(INSTRUCTIONS_TEMPLATE).toContain('not runtime');
    expect(INSTRUCTIONS_TEMPLATE).toContain('keys are low-confidence');
    // PR1: coverage / indexed-only boundary
    expect(INSTRUCTIONS_TEMPLATE).toContain('indexed source coverage');
    expect(INSTRUCTIONS_TEMPLATE).toContain('not a complete filesystem inventory');
    expect(INSTRUCTIONS_TEMPLATE).toContain('detail: "coverage"');
  });
});
