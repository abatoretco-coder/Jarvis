# Architecture détaillée — Semantic Router

**Dernière mise à jour**: Mai 2026

---

## 🏗️ Vue d'ensemble des modules

```
src/routing/
├── semanticRouter.ts                  ← Orchestration principale
├── semanticRouter.types.ts            ← Types TypeScript
├── semanticRouteCatalog.ts            ← Catalogue aligné runtime (E2 + E1)
├── embeddingClient.ts                 ← Client Ollama/OpenAI
├── routeScoring.ts                    ← Calcul similarity + ranking
├── routeDecision.ts                   ← Logique d'acceptation/rejet
├── routeDispatcher.ts                 ← Exécution des routes (Phase 2+)
├── ARCHITECTURE.md                    ← Ce fichier
├── deterministic/
│   ├── spotifyResponses.ts            ← Réponses Spotify (D0/E2)
│   ├── searchResponses.ts             ← Réponses Search
│   ├── todoResponses.ts               ← Réponses Todo
│   ├── mailResponses.ts               ← Réponses Mail
│   ├── haResponses.ts                 ← Réponses HA Executors
│   ├── DETERMINISTIC_PROMPTS.md       ← Documentation réponses
│   └── types.ts                       ← Types partagés
└── directActions/                     ← Phase 2+
    ├── spotifyDirectActions.ts
    ├── searchDirectActions.ts
    ├── todoDirectActions.ts
    ├── mailDirectActions.ts
    └── haDirectActions.ts
```

---

## 📋 Types TypeScript

### SemanticRouteDefinition

```ts
export type SemanticRouteDefinition = {
  key: string;                    // 'spotify.pause' | 'search.news.external_weather'
  level: 'D0' | 'E2' | 'E1';
  targetAgentId?: string;         // 'spotify' | 'search' | 'todo' | 'mail' | 'ha_executor'
  directRequest?: {               // contrat runtime: domain/action/slots
    domain: string;
    action: string;
    slots?: Record<string, unknown>;
  };
  plannerRequired?: boolean;      // true = E1 (needs LLM planner)
  examples: string[];             // ['pause', 'arrête le son', 'coupe Spotify']
  highRisk?: boolean;             // true = delete/send (E1+ only)
  deterministicResponses?: () => string[];  // Zone de réponses déterministes
};
```

### SemanticRouteResult

```ts
export type SemanticRouteResult = {
  accepted: boolean;              // true = route sémantique utilisée
  decision: SemanticRouteDecision; // accepted_d0 | accepted_e2 | accepted_e1 | rejected_*
  matchedRoute?: SemanticRouteDefinition;
  top1Score: number;              // cosine similarity du 1er match (0-1)
  top2Score: number;              // cosine similarity du 2e match (0-1)
  margin: number;                 // top1 - top2
  top1Intent: string;             // clé de la route top1
  top2Intent: string;             // clé de la route top2
  confidence: number;             // 0-1, toujours = top1Score
  fallbackReason?: string;        // 'low_score' | 'low_margin' | 'multi_intent' | 'embedding_failed'
};

type SemanticRouteDecision = 
  | 'accepted_d0'
  | 'accepted_e2'
  | 'accepted_e1'
  | 'rejected_low_score'
  | 'rejected_low_margin'
  | 'rejected_multi_intent'
  | 'fallback_llm';
```

### SemanticRouterOptions

```ts
export type SemanticRouterOptions = {
  acceptScore?: number;           // default: 0.84
  minMargin?: number;             // default: 0.08
  multiIntentThreshold?: number;  // default: 0.5
  enableD0?: boolean;             // default: true
  enableE2?: boolean;             // default: true
  enableE1?: boolean;             // default: true
};
```

---

## 🔧 Flux d'exécution complet

### 1. Appel depuis ingest.ts

```ts
// src/routes/ingest.ts
const semanticResult = await trySemanticRouter({
  userText: assistantInputText,
  embeddingConfig: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    timeoutMs: 5000,
  },
  options: {
    acceptScore: 0.84,
    minMargin: 0.08,
    enableD0: true,
    enableE2: true,
    enableE1: false,  // Phase 1 : E2 seulement
  },
  multiIntentLikelihood: 0,  // sera calculé plus tard
});

// Log résultat
app.log.info({ result: semanticResult }, 'semantic_router_result');

// Décision : utiliser semantic route ou fallback LLM ?
if (semanticResult.accepted) {
  // Route sémantique acceptée
  app.log.info({ route: semanticResult.matchedRoute?.key }, 'semantic_route_accepted');
  
  // Execute la route
  const reply = await executeSemanticRoute({
    route: semanticResult.matchedRoute,
    userText: assistantInputText,
    context: { env, app, threadId, requestId },
  });
  return { reply, replyMeta: { source: 'semantic_router' } };
} else {
  // Fallback vers LLM router existant
  app.log.info({ reason: semanticResult.fallbackReason }, 'semantic_router_fallback_llm');
  
  const routerResult = await routeUserRequest(...);
  // ... reste du flux LLM normal
}
```

### 2. Calcul embedding utilisateur

**embeddingClient.ts** :
```ts
const userEmbedding = await getEmbeddingCached(
  assistantInputText,           // "quel temps demain ?"
  { provider: 'ollama', ... }
);
// Résultat: [0.1, 0.34, ..., 0.45]  (384 dimensions)
```

**Cache** :
- Key: `ollama:nomic-embed-text:quel temps demain ?`
- TTL: session (in-memory Map)
- Hit rate cible: >80%

### 3. Scoring des routes

**routeScoring.ts** :
```ts
const routeEmbeddings = new Map<string, number[]>();

for (const route of SEMANTIC_ROUTES) {
  const routeText = route.examples[0];  // "quel temps ?"
  const emb = await getEmbeddingCached(routeText, config);
  routeEmbeddings.set(route.key, emb);
}

const scored = scoreRoutesAgainstEmbedding(
  userEmbedding,    // utilisateur
  routeEmbeddings   // toutes les routes
);

// Résultat (trié):
// [
//   { routeKey: 'search.news.external_weather', score: 0.91 },
//   { routeKey: 'search.web.lookup',   score: 0.61 },
//   { routeKey: 'search.deep.analysis', score: 0.58 },
//   ...
// ]
```

**Formule** :
```
cosine_similarity(A, B) = (A·B) / (||A|| × ||B||)
                        = Σ(A[i]×B[i]) / (√Σ(A[i]²) × √Σ(B[i]²))
```

### 4. Décision

**routeDecision.ts** :
```ts
const top1 = scored[0];    // search.news.external_weather, 0.91
const top2 = scored[1];    // search.web.lookup, 0.61
const margin = 0.91 - 0.61 = 0.30

if (top1.score >= 0.84 && margin >= 0.08 && !multiIntent) {
  return 'accept';  // ✓ Route sémantique acceptée
} else if (top1.score < 0.84) {
  return 'reject_low_score';
} else if (margin < 0.08) {
  return 'reject_low_margin';
} else if (multiIntent) {
  return 'reject_multi_intent';
}
```

### 5. Exécution (Phase 2+)

**routeDispatcher.ts** :
```ts
if (route.level === 'E2' && route.directRequest) {
  // Exécution directe (pas de planner)
  return executeDirectAction(route.directRequest.domain, route.directRequest.action, route.directRequest.slots);
}

if (route.level === 'E1') {
  // Envoyer vers agent + planner existant
  return executeAgentRoute(route.targetAgentId, userText);
}
```

---

## 🎯 Catalog Structure

### Exemple : Spotify

```ts
// src/routing/semanticRouteCatalog.ts

export const SPOTIFY_E2_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'spotify.pause',
    level: 'E2',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'pause' },
    plannerRequired: false,
    examples: [
      'pause',
      'pause la musique',
      'arrête le son',
      'coupe',
      'mets en pause',
    ],
    deterministicResponses: () => SPOTIFY_PAUSE_RESPONSES,
  },
  {
    key: 'spotify.play',
    level: 'E2',
    targetAgentId: 'spotify',
    directRequest: { domain: 'spotify', action: 'play' },
    plannerRequired: false,
    examples: [
      'play',
      'relance',
      'mets le son',
      'continuer',
      'reprends',
    ],
    deterministicResponses: () => SPOTIFY_PLAY_RESPONSES,
  },
  // ... 5 autres routes E2
];

export const SPOTIFY_E1_ROUTES: SemanticRouteDefinition[] = [
  {
    key: 'spotify.search_and_play',
    level: 'E1',
    targetAgentId: 'spotify',
    plannerRequired: true,  // ← planner LLM Spotify
    examples: [
      'mets du jazz',
      'lance Daft Punk',
      'joue de la musique classique',
      'mets un peu de funk',
    ],
  },
  // ... 5 autres routes E1
];

export const SEMANTIC_ROUTES = [
  ...SPOTIFY_E2_ROUTES,
  ...SPOTIFY_E1_ROUTES,
  ...SEARCH_E2_ROUTES,
  ...SEARCH_E1_ROUTES,
  // ... tous les autres domaines
];
```

---

## 💬 Réponses déterministes

### Fichier : src/routing/deterministic/spotifyResponses.ts

```ts
// Variantes pour chaque action, pour un peu de naturel
export const SPOTIFY_PAUSE_RESPONSES = [
  'Musique en pause.',
  'J\'ai mis en pause.',
  'Pause.',
];

export const SPOTIFY_PLAY_RESPONSES = [
  'Musique relancée.',
  'C\'est parti.',
  'Relancé.',
];

export const SPOTIFY_NEXT_RESPONSES = [
  'Passage au morceau suivant.',
  'Suivant.',
  'Morceau suivant.',
];

// Réponses avec slots dynamiques
export const SPOTIFY_NOW_PLAYING_TEMPLATE = (artist: string, track: string): string => {
  return `Actuellement : ${track} de ${artist}.`;
};

export const SPOTIFY_VOLUME_TEMPLATE = (level: number): string => {
  return `Volume réglé à ${level}%.`;
};

// Fonction de sélection (varie les réponses)
export function getSpotifyPauseResponse(): string {
  return SPOTIFY_PAUSE_RESPONSES[
    Math.floor(Math.random() * SPOTIFY_PAUSE_RESPONSES.length)
  ];
}

// Export helper général
export function getSpotifyResponse(action: string, params?: Record<string, any>): string {
  switch (action) {
    case 'pause':
      return getSpotifyPauseResponse();
    case 'play':
      return SPOTIFY_PLAY_RESPONSES[Math.floor(Math.random() * SPOTIFY_PLAY_RESPONSES.length)];
    case 'next':
      return SPOTIFY_NEXT_RESPONSES[Math.floor(Math.random() * SPOTIFY_NEXT_RESPONSES.length)];
    case 'now_playing':
      return SPOTIFY_NOW_PLAYING_TEMPLATE(params?.artist || 'Artiste', params?.track || 'Morceau');
    case 'volume_set':
      return SPOTIFY_VOLUME_TEMPLATE(params?.level || 50);
    default:
      return 'Action effectuée.';
  }
}
```

Fichiers complémentaires :
- `searchResponses.ts` → search.news, search.web, search.deep
- `todoResponses.ts` → todo.list, todo.add, etc.
- `mailResponses.ts` → mail.list, mail.send, etc.
- `haResponses.ts` → executor actions

---

## 🔌 Intégration dans ingest.ts

### Structure actuelle

```ts
// avant semantic router
const routerResult = await routeUserRequest(assistantInputText, ...)
```

### Structure nouvelle (Phase 1)

```ts
import { trySemanticRouter, semanticRouteToRouterResult } from '../routing/semanticRouter';

// Appel semantic router AVANT LLM router
const semanticRoute = await trySemanticRouter({
  userText: assistantInputText,
  embeddingConfig: deps.semanticRouterConfig,
  options: { acceptScore: 0.84, minMargin: 0.08, enableE2: true, enableE1: false },
});

let routerResult: RouterResult | null = null;

if (semanticRoute?.accepted) {
  // ✓ Route sémantique acceptée
  app.log.info({
    threadId, requestId,
    route: semanticRoute.matchedRoute?.key,
    level: semanticRoute.matchedRoute?.level,
    score: semanticRoute.top1Score,
    margin: semanticRoute.margin,
  }, 'semantic_route_accepted');

  routerResult = semanticRouteToRouterResult(semanticRoute.matchedRoute!);
} else {
  // Fallback LLM router
  app.log.info({
    threadId, requestId,
    fallbackReason: semanticRoute?.fallbackReason,
  }, 'semantic_router_fallback_llm');

  routerResult = await routeUserRequest(assistantInputText, ...);
}

// Reste du flux ingest inchangé
```

---

## 📊 Logging structure

Tous les logs sémantiques doivent inclure :

```json
{
  "timestamp": "ISO-8601",
  "threadId": "uuid",
  "requestId": "uuid",
  "semanticRouter": {
    "userText": "quel temps demain",
    "top1_intent": "search.news.external_weather",
    "top1_score": 0.91,
    "top2_intent": "search.web.lookup",
    "top2_score": 0.61,
    "margin": 0.30,
    "decision": "accepted_e2",
    "enabled_levels": ["E2"],
    "elapsed_ms": 45,
    "cache_hit_embedding": true,
    "cache_hit_routes": true
  },
  "outcome": "semantic_route_executed" | "fallback_llm"
}
```

Événements clés :

| Événement | Quand |
|---|---|
| `semantic_router_start` | Avant embedding utilisateur |
| `semantic_router_embedding_failed` | Erreur client embedding |
| `semantic_router_scored` | Après scoring (debug only) |
| `semantic_router_accepted` | Decision = accept |
| `semantic_router_rejected_low_score` | top1 < 0.84 |
| `semantic_router_rejected_low_margin` | margin < 0.08 |
| `semantic_router_rejected_multi_intent` | Multi-intent détecté |
| `semantic_router_fallback_llm` | Fallback vers LLM router |
| `semantic_router_result` | Résumé complet |

---

## ⚙️ Configuration environment

```bash
# .env.local

# Semantic Router activation
SEMANTIC_ROUTER_ENABLED=true
SEMANTIC_ROUTER_PROVIDER=ollama                    # ollama | openai
SEMANTIC_ROUTER_BASE_URL=http://localhost:11434
SEMANTIC_ROUTER_MODEL=nomic-embed-text             # ou text-embedding-3-small pour OpenAI
SEMANTIC_ROUTER_TIMEOUT_MS=5000
SEMANTIC_ROUTER_ACCEPT_SCORE=0.84                  # 0-1
SEMANTIC_ROUTER_MIN_MARGIN=0.08                    # 0-1
SEMANTIC_ROUTER_CACHE_SIZE=1000                    # Max embeddings en cache
SEMANTIC_ROUTER_LOG_LEVEL=info                     # debug | info | warn
```

---

## 🧪 Testing Fixtures

### Format

```json
{
  "text": "quel temps demain",
  "expectedRoute": "search.news.external_weather",
  "expectedLevel": "E2",
  "shouldAccept": true,
  "expectedScore": 0.85,  // approx
  "fallbackReason": null
}
```

### Phase 1 Fixtures (20 tests)

```json
[
  // E2 Spotify
  {"text": "pause", "expectedRoute": "spotify.pause", "expectedLevel": "E2", "shouldAccept": true},
  {"text": "play", "expectedRoute": "spotify.play", "expectedLevel": "E2", "shouldAccept": true},

  // E2 Search
  {"text": "quel temps à Paris demain ?", "expectedRoute": "search.news.external_weather", "expectedLevel": "E2", "shouldAccept": true},
  {"text": "qui a gagné le match ?", "expectedRoute": "search.news.live_sport", "expectedLevel": "E2", "shouldAccept": true},

  // E1 Todo/Mail (démarrage)
  {"text": "mes tâches", "expectedRoute": "todo.list_tasks", "expectedLevel": "E1", "shouldAccept": true},
  {"text": "lis mes mails", "expectedRoute": "mail.list_inbox", "expectedLevel": "E1", "shouldAccept": true},

  // Fallback LLM
  {"text": "mets du jazz et donne-moi les actus", "shouldAccept": false, "fallbackReason": "multi_intent"},
  {"text": "mets le son au salon", "shouldAccept": false, "fallbackReason": "ambiguous_domain"}
]
```

---

## 🔍 Debugging

### Commandes utiles

```bash
# Build & type check
npm run build

# Tests Phase 1
npm run test -- tests/routing/semanticRouter.phase1.test.ts

# Logs actifs (grep)
tail -f logs/app.log | grep 'semantic_router'

# Trace embedding cache
tail -f logs/app.log | grep 'embedding'
```

### Outils de diagnosis

```ts
// Dans ingest.ts, ajouter endpoint debug
app.get('/debug/semantic-route', async (req, reply) => {
  const userText = req.query.text;
  const result = await trySemanticRouter({ userText, ... });
  reply.send({
    input: userText,
    result,
    cached: false,  // simuler
  });
});

// Usage:
// curl 'http://localhost:8090/debug/semantic-route?text=pause'
```

---

## 📈 Métriques importantes

À tracker via logs :

- **Latency E2** : p50/p95/p99 (<50ms target)
- **Accuracy E2** : % routes correctes
- **Fallback rate** : % qui fallback à LLM (target <5%)
- **Cache hit** : % embedding queries cached (target >80%)
- **Score distribution** : histogramme top1 scores
- **Multi-intent detection** : fréquence détection
- **Route popularity** : routes les plus utilisées

Dashboard Grafana recommandé avec ces métriques.

---

## 🚀 Checklist Phase 0

- [ ] `semanticRouter.types.ts` créé et typé
- [ ] `embeddingClient.ts` supporte Ollama + OpenAI
- [ ] `routeScoring.ts` implémente cosine similarity
- [ ] `routeDecision.ts` logique d'acceptation correcte
- [ ] `semanticRouter.ts` orchestre tout et retourne `SemanticRouteResult`
- [ ] Deterministic responses fichiers créés (spotifyResponses, etc.)
- [ ] Tests unitaires pour chaque module
- [ ] Documentation ARCHITECTURE.md complète

---

## 🔄 Évolutions futures

### Phase 2
- routeDispatcher + directRequest executors
- E1 catalog complet
- Agent wiring

### Phase 3
- HA executors
- Threshold tuning auto

### Phase 4
- Centroid clustering
- pgvector pour scalabilité
- User personalization

---

**Status** : En attente Phase 0 implementation  
**Prochaine étape** : [ROADMAP.md](../../docs/semantic-router/ROADMAP.md)
