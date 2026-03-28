/**
 * Search agent registry — each entry defines a Perplexity/OpenAI search strategy.
 * The agent key matches HA_AGENT_MAP entries (key.startsWith('search')).
 *
 * Agents:
 *   search.news  — recent events, sport, weather, live results  (sonar)
 *   search.web   — factual quick lookups, definitions, prices   (sonar)
 *   search.deep  — in-depth analysis, history, comparisons       (sonar-pro)
 *   search       — backward-compat alias for search.web
 */

export interface SearchAgentConfig {
  key: string;
  /** Perplexity model id — used when PERPLEXITY_API_KEY is set */
  model: string;
  /** OpenAI fallback model used when no Perplexity key */
  openAiModel: string;
  temperature: number;
  buildSystemPrompt: (dateStr: string) => string;
  buildUserQuery: (text: string, dayStr: string) => string;
  /** Restrict index to results after this many days ago (Perplexity only) */
  searchAfterDays?: number;
  searchLanguageFilter?: string[];
  languagePreference?: string;
}

const FORMAT_SHORT =
  'Reponds en une ou deux phrases naturelles. Pas de tirets, pas de listes, pas de liens, pas de noms de sites.';
const FORMAT_LONG =
  'Reponds de facon detaillee mais concise. Pas de tirets, pas de listes, pas de liens, pas de noms de sites.';

const SEARCH_AGENTS_MAP: Record<string, SearchAgentConfig> = {
  /**
   * search.news — actualités, sport, météo, résultats en direct
   * Uses a 7-day date filter so only fresh content is indexed.
   */
  'search.news': {
    key: 'search.news',
    model: 'sonar',
    openAiModel: 'gpt-4o-search-preview',
    temperature: 0.1,
    buildSystemPrompt: (dateStr) =>
      `Tu es un assistant avec acces au web en temps reel. Nous sommes le ${dateStr}. ` +
      `Effectue une recherche web et rapporte l'evenement LE PLUS RECENT disponible. ` +
      FORMAT_SHORT,
    buildUserQuery: (text, dayStr) =>
      `${text} (actualite recente, en date du ${dayStr})`,
    searchAfterDays: 7,
    searchLanguageFilter: ['fr', 'en'],
    languagePreference: 'fr',
  },

  /**
   * search.web — recherche factuelle générale, pas de contrainte temporelle
   */
  'search.web': {
    key: 'search.web',
    model: 'sonar',
    openAiModel: 'gpt-4o-search-preview',
    temperature: 0.2,
    buildSystemPrompt: (dateStr) =>
      `Tu es un assistant avec acces au web. Nous sommes le ${dateStr}. ` +
      `Reponds de facon precise et factuelle. ` +
      FORMAT_SHORT,
    buildUserQuery: (text) => text,
    searchLanguageFilter: ['fr', 'en'],
    languagePreference: 'fr',
  },

  /**
   * search.deep — analyse approfondie, historique, comparaisons, biographies
   * Uses sonar-pro for multi-source synthesis.
   */
  'search.deep': {
    key: 'search.deep',
    model: 'sonar-pro',
    openAiModel: 'gpt-4o-search-preview',
    temperature: 0.3,
    buildSystemPrompt: (dateStr) =>
      `Tu es un assistant expert avec acces au web. Nous sommes le ${dateStr}. ` +
      `Analyse en profondeur et synthetise les informations disponibles sur plusieurs sources. ` +
      FORMAT_LONG,
    buildUserQuery: (text) => text,
    searchLanguageFilter: ['fr', 'en'],
    languagePreference: 'fr',
  },
};

// Backward-compat: bare 'search' key → same behaviour as search.web
SEARCH_AGENTS_MAP['search'] = { ...SEARCH_AGENTS_MAP['search.web']!, key: 'search' };

export const SEARCH_AGENTS: Readonly<Record<string, SearchAgentConfig>> = SEARCH_AGENTS_MAP;

/** Returns config for a given agent key; falls back to search.web if unknown. */
export function getSearchAgentConfig(key: string): SearchAgentConfig {
  return SEARCH_AGENTS[key] ?? SEARCH_AGENTS['search.web']!;
}

/** Returns true for any key that should be handled as a direct search agent (bypasses HA). */
export function isSearchAgentKey(key: string | undefined): key is string {
  if (!key) return false;
  return key === 'search' || key.startsWith('search.');
}
