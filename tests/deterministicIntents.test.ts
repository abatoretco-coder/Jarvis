import { describe, expect, test } from '@jest/globals';

import { resolveDeterministicIntentReply } from '../src/conversation/deterministicIntents';

describe('deterministic intents', () => {
  test('matches compliment command with named target and returns deterministic taunt', () => {
    const first = resolveDeterministicIntentReply('Fais un compliment a Robin');
    const second = resolveDeterministicIntentReply('Fais un compliment a Robin');

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.intent).toBe('taunt_named_target');
    expect(first?.responseText).toContain('Robin n est pas');
    expect(second?.responseText).toBe(first?.responseText);
  });

  test('asks for target when no target is present', () => {
    const result = resolveDeterministicIntentReply('Fais un compliment');

    expect(result).toBeDefined();
    expect(result?.intent).toBe('taunt_missing_target');
    expect(result?.responseText).toContain('il me faut un prenom');
  });

  test('returns undefined for non-matching request', () => {
    const result = resolveDeterministicIntentReply('allume la lumiere du salon');
    expect(result).toBeUndefined();
  });
});
