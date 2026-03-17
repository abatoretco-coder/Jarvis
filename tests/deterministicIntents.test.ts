import { describe, expect, test } from '@jest/globals';

import { resolveDeterministicIntentReply } from '../src/conversation/deterministicIntents';

describe('deterministic intents', () => {
  test('matches compliment command with named target and returns a taunt variant', () => {
    const result = resolveDeterministicIntentReply('Fais un compliment a Robin');

    expect(result).toBeDefined();
    expect(result?.intent).toBe('ironic_named_target');
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

  test('extracts target correctly for "pour Robin" phrasing', () => {
    const result = resolveDeterministicIntentReply('Est-ce que tu peux me faire un petit compliment pour Robin ?');

    expect(result).toBeDefined();
    expect(result?.intent).toBe('ironic_named_target');
    expect(result?.responseText).toContain('Robin');
    expect(result?.responseText).not.toContain('Pour n est pas');
  });

  test('matches insult keyword with savage style', () => {
    const result = resolveDeterministicIntentReply('Insulte Robin');

    expect(result).toBeDefined();
    expect(result?.intent).toBe('savage_named_target');
    expect(result?.responseText).toContain('Robin');
    expect(result?.responseText.endsWith('.')).toBe(true);
  });

  test('keeps Robin as target in "insulte-moi Robin ... pour voir" phrasing', () => {
    const result = resolveDeterministicIntentReply('Insulte-moi Robin pour voir ce que ca donne');

    expect(result).toBeDefined();
    expect(result?.intent).toBe('savage_named_target');
    expect(result?.responseText).toContain('Robin');
    expect(result?.responseText).not.toContain('Voir');
  });

  test('asks for target when no target is present', () => {
    const result = resolveDeterministicIntentReply('Fais un compliment');

    expect(result).toBeDefined();
    expect(result?.intent).toBe('ironic_missing_target');
    expect(result?.responseText).toContain('il me faut un prenom');
  });

  test('returns undefined for non-matching request', () => {
    const result = resolveDeterministicIntentReply('allume la lumiere du salon');
    expect(result).toBeUndefined();
  });
});
