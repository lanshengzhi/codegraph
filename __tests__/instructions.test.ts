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
  });

  it('mentions field sites and its caveats in installed agent instructions', () => {
    expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph_field_sites');
    expect(INSTRUCTIONS_TEMPLATE).toContain('not full dataflow or runtime proof');
    expect(INSTRUCTIONS_TEMPLATE).toContain('dynamic or computed keys');
    expect(INSTRUCTIONS_TEMPLATE).toContain('Field sites are static hints, not dataflow');
  });
});
