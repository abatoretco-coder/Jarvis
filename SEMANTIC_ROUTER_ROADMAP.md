# Semantic Router Implementation Roadmap

**Statut**: Planning  
**Dernière mise à jour**: Mai 2026  
**Auteur**: AI-assisted architecture

---

## 📋 Vue d'ensemble

Ce document décrit l'implémentation d'une couche de **routage hiérarchisé avec embeddings** pour Jarvis, destinée à remplacer progressivement le routeur LLM pour les cas déterministes et semi-déterministes.

### Pipeline cible

```
STT brut
  ↓
[0] Contrat structuré explicite (si fourni par client)
  ↓
[1] Règles déterministes locales (D0)
  ↓
[2] Semantic Router à embeddings
    ├─ E2 : action + executor direct (pas de planner)
    └─ E1 : domaine certain → sous-agent + planner
  ↓
[3] Router LLM existant (cas ambigus, multi-intent, contexte)
  ↓
[4] Sous-agent(s) / executor(s)
  ↓
[5] Fallback Home Assistant général
```

---

## 🎯 Niveaux de certitude

| Niveau | Description | Planner | Coût | Exemple |
|--------|---|---|---|---|
| **D0** | Déterminisme pur | ❌ | ~0ms | "pause" → `spotify.pause` |
| **E2** | Embedding + direct executor | ❌ | ~40-50ms | "quel temps ?" → `search.news.weather` |
| **E1** | Embedding → agent → planner | ✅ | ~500-1000ms | "mets du jazz" → Spotify planner |
| **LLM** | Router LLM pour ambiguïté | ✅ | ~1500-2000ms | "mets du jazz et donne-moi les actus" |

---

## 🗂️ Seuils de décision

```
acceptScore = 0.84       (80%+ de confiance minimale)
minMargin   = 0.08       (au moins 8 points d'écart avec 2ème route)
multiIntent threshold = 0.5
```

**Logique** :
- Si `top1 >= 0.84` ET `margin >= 0.08` ET pas multi-intent → **accepter route sémantique**
- Sinon → **fallback vers routeur LLM existant**

---

## 📊 Matrice par domaine

### Spotify

**E2** (7 routes — pas de planner) :
- `spotify.pause` | `play` | `next` | `previous` | `now_playing` | `list_devices` | `clear_queue`

**E1** (6 routes — avec planner Spotify) :
- `spotify.search` | `search_and_play` | `queue_add` | `transfer` | `add_to_playlist` | `volume_set`

### Search

**E2** (5 routes) :
- `search.news.weather` | `live_sport` | `current_news` | `web.definition` | `web.quick_lookup`

**E1** (3 routes) :
- `search.deep.analysis` | `history` | `comparison`

### To Do

**E2** (6 routes) :
- `todo.list_tasks` | `today` | `tomorrow` | `this_week` | `overdue` | `list_lists`

**E1** (9 routes) :
- `todo.add_task` | `complete_task` | `delete_task` | `update_task` | `create_list` | `delete_list` | `checklist_add/complete/delete`

### Mail

**E2** (2 routes) :
- `mail.list_inbox` | `list_inbox.unread`

**E1** (8 routes) :
- `mail.search_emails` | `send_email` | `reply_email` | `forward_email` | `mark_read` | `mark_unread` | `trash_email` | `flag_email`

### Home Assistant Executors

**E2** (6 routes) :
- `executor.light_on` | `light_off` | `vacuum_start` | `vacuum_stop` | `scene_simple` | `script_simple`

**E1** (6 routes) :
- `executor.timer` | `alarm` | `reminder` | `calendar` | `vacuum_zone` | `audio_zone`

---

## 🚀 Phases d'implémentation

### Phase 0 : Fondations (Semaine 1-2, 6 commits)

**Commits** :
1. `semanticRouter.types.ts` — types TypeScript
2. `semanticRouteCatalog.ts` — catalogue 20 routes E2
3. `embeddingClient.ts` — client Ollama/OpenAI
4. `routeScoring.ts` — calcul similarity + scoring
5. `routeDecision.ts` — logique d'acceptation/rejet
6. `semanticRouter.ts` — orchestration principale + conversion RouterResult

**Fichiers déterministes** :
- `src/routing/deterministic/spotifyResponses.ts`
- `src/routing/deterministic/searchResponses.ts`
- `src/routing/deterministic/todoResponses.ts`
- `src/routing/deterministic/mailResponses.ts`
- `src/routing/deterministic/haResponses.ts`

**Sorties** :
- Infrastructure de routage sémantique fonctionnelle
- 20 routes E2 testables

---

### Phase 1 : Intégration & E2 (Semaine 3-4, 5 commits)

**Commits** :
7. Config env + `src/env.ts` → `SEMANTIC_ROUTER_*` vars
8. Integration `src/routes/ingest.ts` → appel semantic router avant LLM router
9. E2 Catalog complete (20 routes remplies)
10. Logging & metrics
11. Phase 1 test fixtures + tests

**Sorties** :
- Semantic router actif en production
- E2 routes live → 20 actions ultra-rapides
- Logs détaillés pour tuning

---

### Phase 2 : E1 Agents & Expansion (Semaine 5-6, 6 commits)

**Commits** :
12. E1 Catalog (22 routes)
13. `routeDispatcher.ts` → acheminer vers agents
14. Direct actions Spotify E2
15. Direct actions Search/Todo/Mail E2
16. E1 Catalog complet + wiring agents
17. Phase 2 test fixtures

**Sorties** :
- 22 routes E1 disponibles
- Direct executors E2 fonctionnels
- E1 routes routées vers planners existants

---

### Phase 3 : HA Executors & Tuning (Semaine 7-8, 3 commits)

**Commits** :
18. HA Executor routes (E2 + E1)
19. Threshold adaptive tuning (analyse logs Phase 1-2)
20. Phase 3 tests

**Sorties** :
- HA executors intégrés
- Seuils optimisés via data réelle

---

### Phase 4 : Advanced & Personalization (Semaine 9-10, 3 commits)

**Commits** :
21. Centroid learning (clustering par intent)
22. pgvector migration (si catalogue > 200)
23. User personalization (preferences mémorisées)

**Sorties** :
- Système auto-adaptatif
- Scalabilité garantie

---

## 📂 Architecture de fichiers déterministes

```
src/routing/
  deterministic/
    ├── DETERMINISTIC_PROMPTS.md          ← Documentation
    ├── spotifyResponses.ts               ← Phrases Spotify
    ├── searchResponses.ts                ← Phrases Search
    ├── todoResponses.ts                  ← Phrases Todo
    ├── mailResponses.ts                  ← Phrases Mail
    ├── haResponses.ts                    ← Phrases HA
    └── types.ts                          ← Types partagés
```

Chaque fichier contient :
- Responses texte brutes (FR, oral-friendly)
- Fonction de sélection (variantes aléatoires)
- Template pour slots dynamiques (device, task name, etc.)

Exemple :

```ts
// spotifyResponses.ts
export const SPOTIFY_PAUSE_RESPONSES = [
  'Musique en pause.',
  'J\'ai mis en pause.',
  'Pause.',
];

export function getSpotifyPauseResponse(): string {
  return SPOTIFY_PAUSE_RESPONSES[Math.floor(Math.random() * SPOTIFY_PAUSE_RESPONSES.length)];
}
```

---

## 🔌 Points d'intégration

### src/routes/ingest.ts

**Avant** : routeur LLM directement
```ts
const routerResult = await routeUserRequest(...)
```

**Après** : semantic router en premier, puis fallback
```ts
const semanticRoute = await trySemanticRouter({...});
const routerResult = semanticRoute?.accepted 
  ? semanticRouteToRouterResult(semanticRoute.matchedRoute)
  : await routeUserRequest(...);
```

### Logging indispensable

```
semantic_router_start
semantic_router_accepted              → decision: 'accepted_e2|e1'
semantic_router_rejected_*            → decision: 'rejected_low_score|margin|multi_intent'
semantic_router_fallback_llm          → fallback vers LLM router
semantic_router_result                → complet (top1, top2, margin, confidence)
```

---

## 🎓 Comment fonctionne chaque composant

### 1. **embeddingClient.ts**

```
Input: "quel temps demain ?"
  ↓ Ollama/OpenAI API
Output: [0.1, 0.34, -0.02, ..., 0.45]  (384 ou 1536 dims)
  ↓ cached
```

**Fournisseurs** :
- Ollama (local, fast) : `nomic-embed-text` ~40ms
- OpenAI : `text-embedding-3-small` ~100ms

### 2. **routeScoring.ts**

```
User embedding:    [0.1, 0.34, ..., 0.45]
Route embedding:   [0.15, 0.30, ..., 0.48]
  ↓ cosine similarity
Score: 0.91
```

Répeté pour tous les 20+ routes, trié par score.

### 3. **routeDecision.ts**

```
top1_score = 0.91
top2_score = 0.61
margin = 0.30

if top1 >= 0.84 ✓ AND margin >= 0.08 ✓ AND !multiIntent ✓
  → ACCEPT
else
  → FALLBACK LLM
```

### 4. **semanticRouteCatalog.ts**

```ts
{
  key: 'spotify.pause',
  level: 'E2',
  targetAgentId: 'spotify',
  directAction: 'pause',
  plannerRequired: false,
  examples: ['pause', 'arrête le son', 'coupe Spotify'],
  deterministicResponses: () => SPOTIFY_PAUSE_RESPONSES
}
```

Chaque route pointe vers des réponses déterministes (zero-shot).

### 5. **directActions/** (Phase 2)

```ts
async function executeSpotifyDirectAction(action, text, env) {
  const token = await getSpotifyToken(env);
  switch (action) {
    case 'pause':
      await spotify.pause(token);
      return getSpotifyPauseResponse();  // ← déterministe
  }
}
```

---

## ✅ Validation & Métriques

### KPIs Phase 1

- **Latency réduction** : E2 `<50ms` vs LLM `~1500ms`
- **Accuracy** : E2 routes doivent >95% correct
- **Fallback rate** : <5% multi-intent/ambiguous
- **Cache hit** : >80% embedding queries cachées

### Tests

```bash
npm run test:semantic-router

# Fixtures pour chaque phase
tests/routing/semanticRouter.phase1.fixtures.json
tests/routing/semanticRouter.phase2.fixtures.json
tests/routing/semanticRouter.phase3.fixtures.json
```

---

## 🔍 Debugging & Logs

### Exemple log complet

```json
{
  "timestamp": "2026-05-17T14:32:15Z",
  "threadId": "abc123",
  "text": "quel temps demain",
  "semanticRouter": {
    "top1_intent": "search.news.weather",
    "top1_score": 0.91,
    "top2_intent": "search.web.lookup",
    "top2_score": 0.61,
    "margin": 0.30,
    "decision": "accepted_e2",
    "elapsed_ms": 45,
    "cachedEmbedding": true
  },
  "route": "search.news.weather",
  "levelExecuted": "E2",
  "response": "Demain il fera beau avec 18°C."
}
```

### Dashboard recommandé

- Graph : distribution acceptScore et margin par domaine
- Heatmap : routes les plus souvent accédées (E2) vs fallback LLM
- Latency : p50/p95/p99 semantic router vs LLM router

---

## 🛑 Cas d'exclusion (toujours fallback LLM)

1. **Multi-intent** : "mets du jazz et donne-moi les actus"
2. **Ambiguïté domaine** : "mets le son au salon" (Spotify vs HA audio?)
3. **Frontière Search** : "pourquoi Florence est devenue bancaire ?"
4. **Contexte conversationnel** : "et baisse un peu" (contexte du message précédent)
5. **Actions destructives sensibles** : "supprime cet email" (E1+, jamais E2)

---

## 📖 Docs complémentaires

- `src/routing/ARCHITECTURE.md` — Deep dive technique
- `src/routing/deterministic/DETERMINISTIC_PROMPTS.md` — Catalogue réponses
- `tests/routing/README.md` — Guide testing

---

## 🎯 Checklist avant Go Live

- [ ] Phase 0 : types + infra testée
- [ ] Phase 1 : 20 routes E2 live + <50ms latency
- [ ] Logging : semantic_router_* events capturées
- [ ] Fallback LLM : toujours fonctionnel
- [ ] Tests : >90% pass rate
- [ ] Deterministic responses : à jour et variées
- [ ] Docs : ARCHITECTURE.md complet

---

**Prêt pour Phase 0 ?** → [ARCHITECTURE.md](./ARCHITECTURE.md)
