import { describe, expect, it } from '@jest/globals';

import { SPOTIFY_E1_ROUTES, SPOTIFY_E2_ROUTES } from '../src/routing/semanticRouteCatalog';
import { spotifyActionSchema } from '../src/spotify/contracts';
import { MUSIC_ROUTING_MATRIX } from '../src/spotify/musicRoutingMatrix';

describe('music routing matrix consistency', () => {
  it('covers all spotify actions from contracts', () => {
    const matrixActions = new Set(MUSIC_ROUTING_MATRIX.map((entry) => entry.action));
    const contractActions = new Set(spotifyActionSchema.options);

    expect(matrixActions).toEqual(contractActions);
  });

  it('maps semantic E2 spotify routes correctly', () => {
    const e2Keys = new Set(SPOTIFY_E2_ROUTES.map((route) => route.key));

    const matrixE2 = MUSIC_ROUTING_MATRIX.filter((entry) => entry.semanticLevel === 'E2');
    for (const entry of matrixE2) {
      expect(entry.semanticRouteKey).toBeDefined();
      expect(e2Keys.has(entry.semanticRouteKey!)).toBe(true);
      expect(entry.plannerRequiredWhenSemantic).toBe(false);
      expect(entry.routerDirect).toBe(true);
    }
  });

  it('maps semantic E1 spotify routes correctly', () => {
    const e1Keys = new Set(SPOTIFY_E1_ROUTES.map((route) => route.key));

    const matrixE1 = MUSIC_ROUTING_MATRIX.filter((entry) => entry.semanticLevel === 'E1');
    for (const entry of matrixE1) {
      expect(entry.semanticRouteKey).toBeDefined();
      expect(e1Keys.has(entry.semanticRouteKey!)).toBe(true);
      expect(entry.plannerRequiredWhenSemantic).toBe(true);
      expect(entry.musicPlanner).toBe(true);
    }
  });

  it('keeps explicit contract available for all spotify actions', () => {
    for (const entry of MUSIC_ROUTING_MATRIX) {
      expect(entry.explicitContract).toBe(true);
    }
  });

  it('declares like_track as non-semantic action', () => {
    const like = MUSIC_ROUTING_MATRIX.find((entry) => entry.action === 'like_track');

    expect(like).toBeDefined();
    expect(like?.semanticLevel).toBe('none');
    expect(like?.semanticRouteKey).toBeUndefined();
    expect(like?.musicPlanner).toBe(true);
  });
});
