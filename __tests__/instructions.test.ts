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
  });
});
