import { describe, expect, test } from '@jest/globals';

import { resolveDeterministicIntentReply } from '../src/conversation/deterministicIntents';

describe('deterministic intents', () => {
  test('matches compliment command with named target and returns a taunt variant', () => {
    const result = resolveDeterministicIntentReply('Fais un compliment a Robin');

    expect(result).toBeDefined();
    expect(result?.intent).toBe('taunt_named_target');
    expect(result?.responseText).toContain('Robin');
    expect(result?.responseText).toContain('pas');
    expect(result?.responseText.endsWith('.')).toBe(true);
  });

  test('returns random variants across repeated calls', () => {
    const outputs = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const result = resolveDeterministicIntentReply('Fais un compliment a Robin');
      if (result?.responseText) {
        outputs.add(result.responseText);
      }
    }

    expect(outputs.size).toBeGreaterThan(1);
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
