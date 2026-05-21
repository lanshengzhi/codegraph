/**
 * User-facing CodeGraph instructions stay in sync for addressability and trace.
 */
import { describe, it, expect } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';
import { INSTRUCTIONS_TEMPLATE } from '../src/installer/instructions-template';

describe('CodeGraph instructions', () => {
  it('mentions trace and precise locators in server instructions', () => {
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_trace');
    expect(SERVER_INSTRUCTIONS).toContain('nodeId');
    expect(SERVER_INSTRUCTIONS).toContain('file:line');
  });

  it('mentions trace and precise locators in installed agent instructions', () => {
    expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph_trace');
    expect(INSTRUCTIONS_TEMPLATE).toContain('nodeId');
    expect(INSTRUCTIONS_TEMPLATE).toContain('file:line');
  });
});
