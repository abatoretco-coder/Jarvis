/**
 * Semantic Router — Types Fondamentaux
 *
 * Contrats TypeScript pour le routage sémantique par embeddings.
 * Phase 0 : Définitions communes à tous les modules.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Route Levels & Decisions
// ─────────────────────────────────────────────────────────────────────────────

export type RouteLevel = 'D0' | 'E2' | 'E1';

export type SemanticRouteDecision =
  | 'accepted_d0'              // Déterminisme pur
  | 'accepted_e2'              // Embedding → direct executor
  | 'accepted_e1'              // Embedding → agent + planner
  | 'rejected_low_score'       // top1 < acceptScore
  | 'rejected_low_margin'      // margin < minMargin
  | 'rejected_multi_intent'    // Multi-intent détecté
  | 'fallback_llm';            // Fallback vers LLM router existant

// ─────────────────────────────────────────────────────────────────────────────
// Semantic Route Definition
// ─────────────────────────────────────────────────────────────────────────────

export type SemanticRouteDefinition = {
  /**
   * Identifiant unique de la route.
   * Format: "domain.action" ou "domain.subdomain.action"
  * Exemples: "spotify.pause", "search.news.external_weather", "todo.list_tasks"
   */
  key: string;

  /**
   * Niveau de certitude requis.
   * - D0  : Règles déterministes pures (futur)
   * - E2  : Embedding + exécution directe (pas de planner)
   * - E1  : Embedding + agent spécialisé (avec planner LLM)
   */
  level: RouteLevel;

  /**
   * Agent cible ou executor.
   * Exemples: "spotify", "search", "todo", "mail", "ha_executor"
   */
  targetAgentId?: string;

  /**
   * Requête directe alignée avec le runtime (domain/action/slots).
   * Exemples:
   *  - { domain: "spotify", action: "pause" }
   *  - { domain: "mail", action: "list_inbox", slots: { unread_only: true } }
   */
  directRequest?: {
    domain: string;
    action: string;
    slots?: Record<string, unknown>;
  };

  /**
   * Si true, cette route nécessite un planner LLM dans l'agent.
   * Toutes les E1 routes auront plannerRequired = true.
   * Les E2 routes auront plannerRequired = false.
   */
  plannerRequired?: boolean;

  /**
   * Exemples de phrasing utilisateur pour cette action.
   * Le premier exemple est la "phrase canonique" pour les embeddings.
   * Minimum 3 exemples pour couvrir variations.
   */
  examples: string[];

  /**
   * Si true, action destructive ou sensible (delete, send, etc.).
   * Les D0/E2 ne doivent JAMAIS avoir highRisk = true.
   * Les E1 actions sensibles auront highRisk = true.
   */
  highRisk?: boolean;

  /**
   * Fonction retournant les réponses déterministes pour cette action.
   * Utilisée en E2 pour l'exécution directe.
   * Retourne une liste de variantes (aléatoire, pas d'IA).
   */
  deterministicResponses?: () => string[];

  /**
   * Métadonnées optionnelles.
   * Pour logging, analytics, future features.
   */
  metadata?: {
    category?: string;          // "music" | "productivity" | "communication" | "smart_home"
    latencyTarget?: number;     // ms, pour monitoring
    version?: string;           // "1.0" pour migrations futures
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Semantic Route Result (retourné par trySemanticRouter)
// ─────────────────────────────────────────────────────────────────────────────

export type SemanticRouteResult = {
  /**
   * La route a-t-elle été acceptée ?
   * true = utiliser la route sémantique
   * false = fallback vers LLM router
   */
  accepted: boolean;

  /**
   * Décision détaillée (reason if rejected).
   */
  decision: SemanticRouteDecision;

  /**
   * Route matchée (undefined si rejected).
   */
  matchedRoute?: SemanticRouteDefinition;

  /**
   * Score de similarité cosinus du 1er match (0-1).
   * Toujours présent, même si rejected.
   */
  top1Score: number;

  /**
   * Score du 2e match (0-1).
   * 0 si aucun 2e match.
   */
  top2Score: number;

  /**
   * Marge entre top1 et top2 : top1Score - top2Score.
   * Utilisée pour rejeter si trop faible (ambiguïté).
   */
  margin: number;

  /**
   * Clé de la route top1 match.
  * Ex: "search.news.external_weather"
   */
  top1Intent: string;

  /**
   * Clé de la route top2 match (empty string si aucune).
   */
  top2Intent: string;

  /**
   * Confiance générale : toujours = top1Score.
   */
  confidence: number;

  /**
   * Raison du rejet (si decision = 'rejected_*').
   * Valeurs: 'low_score', 'low_margin', 'multi_intent', 'embedding_failed'
   */
  fallbackReason?: string;

  /**
   * Temps écoulé en ms pour le calcul (pour monitoring).
   */
  elapsedMs?: number;

  /**
   * Métadonnées de debug.
   */
  debug?: {
    cachedEmbedding?: boolean;
    cachedRoutes?: boolean;
    embeddingProvider?: string;
    routesScored?: number;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Embedding Client Config
// ─────────────────────────────────────────────────────────────────────────────

export type EmbeddingProvider = 'ollama' | 'openai';

export type EmbeddingClientConfig = {
  /**
   * Provider d'embeddings.
   * 'ollama' : local, ~40-50ms latency
   * 'openai' : cloud, ~100-150ms latency
   */
  provider: EmbeddingProvider;

  /**
   * URL de base du serveur.
   * Ollama: "http://localhost:11434"
   * OpenAI: "https://api.openai.com/v1"
   */
  baseUrl: string;

  /**
   * Modèle d'embedding.
   * Ollama:  "nomic-embed-text" (384 dims)
   * OpenAI:  "text-embedding-3-small" (1536 dims)
   */
  model: string;

  /**
   * Timeout en ms pour les appels d'embedding.
   * Default: 5000
   */
  timeoutMs?: number;

  /**
   * Clé API (pour OpenAI).
   * Ignorée pour Ollama.
   */
  apiKey?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Semantic Router Options
// ─────────────────────────────────────────────────────────────────────────────

export type SemanticRouterOptions = {
  /**
   * Score minimum pour accepter une route.
   * Default: 0.84 (84% de confiance)
   * Plage: 0.5-0.95 (ajuster selon domaine)
   */
  acceptScore?: number;

  /**
   * Marge minimum entre top1 et top2.
   * Default: 0.08 (au moins 8 points d'écart)
   * Plage: 0.02-0.15
   */
  minMargin?: number;

  /**
   * Seuil pour détecter multi-intent.
   * Default: 0.5
   * Si deux routes ont des scores proches > 0.5, rejecter → LLM router
   */
  multiIntentThreshold?: number;

  /**
   * Activer routes D0 (déterministes pures).
   * Default: true
   * Phase 0 : pas utilisé (pas de D0 routes)
   */
  enableD0?: boolean;

  /**
   * Activer routes E2 (embedding + direct executor).
   * Default: true
   */
  enableE2?: boolean;

  /**
   * Activer routes E1 (embedding + agent planner).
   * Default: true (mais Phase 1 = false)
   */
  enableE1?: boolean;

  /**
   * Logging verbosity.
   * 'silent' | 'error' | 'warn' | 'info' | 'debug'
   */
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
};

// ─────────────────────────────────────────────────────────────────────────────
// Semantic Router Input
// ─────────────────────────────────────────────────────────────────────────────

export type SemanticRouterInput = {
  /**
   * Texte utilisateur brut (après STT).
   */
  userText: string;

  /**
   * Configuration du client d'embedding.
   */
  embeddingConfig: EmbeddingClientConfig;

  /**
   * Options de décision.
   */
  options?: SemanticRouterOptions;

  /**
   * Indice heuristique de multi-intent (0-1).
   * Calculé par le routeur LLM ou détecteur local.
   * Default: 0 (assume single-intent)
   */
  multiIntentLikelihood?: number;

  /**
   * Contexte optionnel pour logging/metrics.
   */
  context?: {
    threadId?: string;
    requestId?: string;
  };

  /**
   * Niveaux de routes autorisés pour ce request.
   * Default: ['D0', 'E2', 'E1']
   * Phase 1 : ['D0', 'E2']
   */
  enabledLevels?: RouteLevel[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Scored Route (interne)
// ─────────────────────────────────────────────────────────────────────────────

export type ScoredRoute = {
  routeKey: string;
  score: number;
  level?: RouteLevel;
  definition?: SemanticRouteDefinition;
};

// ─────────────────────────────────────────────────────────────────────────────
// Direct Action Execution (Phase 2+)
// ─────────────────────────────────────────────────────────────────────────────

export type ExecuteSemanticRouteInput = {
  /**
   * Route à exécuter.
   */
  route: SemanticRouteDefinition;

  /**
   * Texte utilisateur original.
   */
  userText: string;

  /**
   * Contexte d'exécution (env, deps, loggers, etc.).
   */
  context: any;

  /**
   * Logger minimaliste.
   */
  logger?: MinimalLogger;
};

export type ExecuteSemanticRouteOutput = {
  /**
   * Réponse TTS-friendly en français.
   */
  reply: string;

  /**
   * Métadonnées sur l'exécution.
   */
  metadata?: {
    source?: 'direct_executor' | 'agent_planner';
    executionTime?: number;
    route?: string;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Minimal Logger (pour DI)
// ─────────────────────────────────────────────────────────────────────────────

export type MinimalLogger = {
  debug: (obj: Record<string, any>, msg: string) => void;
  info: (obj: Record<string, any>, msg: string) => void;
  warn: (obj: Record<string, any>, msg: string) => void;
  error: (obj: Record<string, any>, msg: string) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Metadata & Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const SEMANTIC_ROUTER_VERSION = '0.1.0-phase0';

export const DEFAULT_SEMANTIC_ROUTER_OPTIONS: Required<SemanticRouterOptions> = {
  acceptScore: 0.84,
  minMargin: 0.08,
  multiIntentThreshold: 0.5,
  enableD0: true,
  enableE2: true,
  enableE1: true,
  logLevel: 'info',
};
