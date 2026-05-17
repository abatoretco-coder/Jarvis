/**
 * Deterministic Responses — Search
 *
 * Phrases TTS-friendly pour les actions Search E2.
 * Stubs Phase 0 — à remplir selon implémentation Search agent.
 */

export const SEARCH_WEATHER_RESPONSES = ['Je n\'arrive pas à dire la météo pour le moment.'];
export const SEARCH_LIVE_SPORT_RESPONSES = ['Je ne trouve pas les résultats sportifs maintenant.'];
export const SEARCH_CURRENT_NEWS_RESPONSES = ['Pas d\'actualités disponibles.'];
export const SEARCH_DEFINITION_RESPONSES = ['Je n\'arrive pas à définir ça.'];
export const SEARCH_QUICK_LOOKUP_RESPONSES = ['Je cherche...'];

export function getSearchResponse(action: string, params?: Record<string, any>): string {
  return 'Recherche en cours...';
}
