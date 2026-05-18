import { describe, expect, it } from '@jest/globals';

import { estimateMultiIntentLikelihood } from '../../src/routing/multiIntentLikelihood';

describe('estimateMultiIntentLikelihood', () => {
  it('returns low likelihood for a simple single intent', () => {
    const score = estimateMultiIntentLikelihood('mets la musique');
    expect(score).toBeLessThan(0.5);
  });

  it('returns higher likelihood for combined intents with connectors', () => {
    const score = estimateMultiIntentLikelihood('lis mes mails puis ajoute une tache et mets un minuteur');
    expect(score).toBeGreaterThanOrEqual(0.5);
  });

  it('clamps score to [0, 1]', () => {
    const score = estimateMultiIntentLikelihood(
      'mets la musique et lis mes mails et ajoute une tache et ouvre la porte et ensuite baisse le volume',
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
