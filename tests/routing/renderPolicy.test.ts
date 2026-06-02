import { describe, expect, it } from '@jest/globals';

import { resolveRenderPolicy } from '../../src/routing/render/policies';
import type { ActionExecutionResult } from '../../src/routing/render/types';

function makeResult(overrides: Partial<ActionExecutionResult> = {}): ActionExecutionResult {
  return {
    status: 'success',
    domain: 'general',
    actionKey: 'general.unknown',
    facts: {},
    ...overrides,
  };
}

describe('resolveRenderPolicy', () => {
  it('maps spotify.pause to deterministic_static', () => {
    const policy = resolveRenderPolicy(makeResult({
      domain: 'spotify',
      actionKey: 'spotify.pause',
    }));

    expect(policy.mode).toBe('deterministic_static');
  });

  it('maps search.deep.analysis to llm_domain_rephrase', () => {
    const policy = resolveRenderPolicy(makeResult({
      domain: 'search',
      actionKey: 'search.deep.analysis',
    }));

    expect(policy.mode).toBe('llm_domain_rephrase');
    expect(policy.promptKey).toBe('search.deep');
  });

  it('maps executor.* keys to executors domain policy', () => {
    const policy = resolveRenderPolicy(makeResult({
      domain: 'executors',
      actionKey: 'executor.timer',
    }));

    expect(policy.mode).toBe('deterministic_template');
  });

  it('returns deterministic_error when status is not success', () => {
    const policy = resolveRenderPolicy(makeResult({
      status: 'error',
      actionKey: 'spotify.pause',
      domain: 'spotify',
    }));

    expect(policy.mode).toBe('deterministic_error');
  });

  it('falls back to domain default when action key is unknown', () => {
    const policy = resolveRenderPolicy(makeResult({
      domain: 'mail',
      actionKey: 'mail.unknown_action',
    }));

    expect(policy.mode).toBe('llm_domain_rephrase');
    expect(policy.promptKey).toBe('mail.domain');
  });
});
