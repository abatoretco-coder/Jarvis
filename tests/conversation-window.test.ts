import { describe, expect, it } from '@jest/globals';

import { detectEffectiveThreadId } from '../src/conversation/conversationWindow';
import { enrichWithContextNote, getPersistableUserText } from '../src/conversation/contextNote';

describe('conversation window helpers', () => {
  it('reuses active thread id when available', () => {
    const effective = detectEffectiveThreadId('client-thread', { threadId: 'active-thread' });
    expect(effective).toBe('active-thread');
  });

  it('falls back to client thread id when no active thread exists', () => {
    const effective = detectEffectiveThreadId('client-thread', null);
    expect(effective).toBe('client-thread');
  });
});

describe('context note helpers', () => {
  it('enriches input text with runtime context format', () => {
    const enriched = enrichWithContextNote('Quelle température ?', '[Time: 15:45]');
    expect(enriched).toContain('Contexte d actualite: [Time: 15:45].');
    expect(enriched).toContain('Question utilisateur: Quelle température ?');
  });

  it('keeps original text when context note is empty', () => {
    expect(enrichWithContextNote('Allume la lumière', '   ')).toBe('Allume la lumière');
  });

  it('keeps persisted text clean', () => {
    expect(getPersistableUserText('Mets le thermostat à 22°C')).toBe('Mets le thermostat à 22°C');
  });
});
