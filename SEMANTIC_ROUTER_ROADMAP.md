# Semantic Router Implementation Roadmap

**Statut**: ✅ Phase 1C (E2 live Search) Complète — Pré-Phase 2 consolidée  
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
| **E2** | Embedding + direct executor | ❌ | ~40-50ms | "quelle température à la maison ?" → `weather.current_temperature` |
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
- `search.news.external_weather` | `live_sport` | `current_news` | `web.definition` | `web.quick_lookup`

### Weather local

**E2** (4 routes) :
- `weather.current_temperature` | `current_humidity` | `current_precipitation` | `current_conditions`

**E1** (3 routes) :
- `search.deep.analysis` | `history` | `comparison`

### Todo (6+9 routes — 15 total E1)

**E1** :
- `todo.list_tasks` | `today` | `tomorrow` | `this_week` | `overdue` | `list_lists`
- `todo.add_task` | `complete_task` | `delete_task` | `update_task`
- `todo.create_list` | `delete_list`
- `todo.add_checklist_item` | `complete_checklist_item` | `delete_checklist_item`

### Mail (2+8 routes — 10 total E1)

**E1** :
- `mail.list_inbox` | `list_inbox.unread`
- `mail.search_emails` | `send_email` | `reply_email` | `forward_email`
- `mail.mark_read` | `mark_unread` | `trash_email` | `flag_email`

### Home Assistant Executors

**E2** (6 routes) :
- `executor.light_on` | `light_off` | `vacuum_start` | `vacuum_stop` | `scene_simple` | `script_simple`

**E1** (6 routes) :
- `executor.timer` | `alarm` | `reminder` | `calendar` | `vacuum_zone` | `audio_zone`

---

## 🚀 Phases d'implémentation

### Phase 0 : Fondations (Semaine 1-2) ✅ COMPLET

**Commits** :
1. `semanticRouter.types.ts` — types TypeScript
2. `semanticRouteCatalog.ts` — catalogue aligné runtime (`directRequest`, Weather E2, Todo/Mail E1, 50 routes)
3. `embeddingClient.ts` — client OpenAI uniquement (LRU cache 512)
4. `routeScoring.ts` — calcul similarity + scoring (centroid par route)
5. `routeDecision.ts` — logique d'acceptation/rejet + multi-intent check
6. `semanticRouter.ts` — orchestration principale + conversion RouterResult

**Fichiers déterministes** :
- `src/routing/deterministic/spotifyResponses.ts` ✅ COMPLET (32 variantes)
- `src/routing/deterministic/searchResponses.ts` ⏳ STUBS
- `src/routing/deterministic/todoResponses.ts` ⏳ STUBS
- `src/routing/deterministic/mailResponses.ts` ⏳ STUBS

**Sorties** :
- Infrastructure de routage sémantique fonctionnelle
- 50 routes catalogées (16 E2 + 34 E1)
- 158 tests passing

---

### Phase 1A : Integration Shadow Mode (Semaine 3-4) ✅ COMPLET

**Commits** :
7. Config env + `src/env.ts` → `SEMANTIC_ROUTER_*` vars
8. Integration `src/routes/ingest.ts` → appel `trySemanticRouter` avant LLM router (shadow mode)
9. `routeDispatcher.ts` → dispatch search E2 live routes
10. `e1RouteDispatcher.ts` → dispatch E1 vers agents/planners
11. `haAgentRouter.ts` → compat shim + `parseAgentMap()`
12. Phase 1A test suites (semanticRouter.phase1a, e1RouteDispatcher, e1Catalog, routeDispatcher.search)

**Sorties** :
- Shadow mode actif (evaluation seulement, pas d'override LLM)
- Logs `semantic_router_*` disponibles pour tuning
- 158 tests passing (13 suites)

---

### Phase 1B : Activation Spotify+Weather E2 live ✅ COMPLET

**Commits** :
13. `SEMANTIC_ROUTER_ACTIVATION_ENABLED=true` + `SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES` Spotify+Weather
14. Spotify E2 direct executor via `toSemanticActivationTarget` + `HA_AGENT_MAP`
15. Weather E2 direct executor (local HA states)

---

### Phase 1C : E2 live Search ✅ COMPLET

**Commits** :
16. Search E2 live routes (`search.news.*`, `search.web.*`) via `dispatchAcceptedSearchE2Route`
17. SSE ack avant dispatch Search E2 live
18. Semantic router classifie sur `text` brut (pas `assistantInputText` enrichi)

---

### Pré-Phase 2 : Consolidation ✅ COMPLET

**Commits** :
19. OpenAI-only embeddings (suppression Ollama, `SEMANTIC_ROUTER_EMBEDDING_MODEL`)
20. Doc alignée sur stade réel (Phase 1C, 50 routes E2+E1)

---

### Phase 2A : E1 live progressif ✅ COMPLET

**Activations live E1 (allowlistées)** :
- `search.deep.analysis`
- `search.deep.history`
- `search.deep.comparison`
- `spotify.search`
- `spotify.search_and_play`
- `spotify.transfer`

**Comportement** :
- Bypass du routeur LLM quand une route E1 est acceptée ET allowlistée.
- `search.deep.*` dispatch direct vers Search Agent Deep.
- `spotify.search|search_and_play|transfer` dispatch vers planner Spotify puis executor existant.
- Fallback systématique vers routeur LLM si route non allowlistée / non supportée / erreur dispatcher.

**Non activé en Phase 2A** :
- `todo.*`
- `mail.*`
- `spotify.queue_add`
- `spotify.add_to_playlist`
- `spotify.volume_set`

### Phase 2B : E1 lecture productivité ✅ COMPLET

**Activations live E1 (allowlistées)** :
- `todo.list_tasks`
- `todo.list_tasks.today`
- `todo.list_tasks.tomorrow`
- `todo.list_tasks.this_week`
- `todo.list_tasks.overdue`
- `todo.list_lists`
- `mail.list_inbox`
- `mail.list_inbox.unread`
- `mail.search_emails`

**Comportement** :
- Bypass du routeur LLM quand une route Todo/Mail de lecture est acceptée ET allowlistée.
- Dispatch direct vers les agents spécialisés Todo/Mail existants (pas de nouveau planner).
- Ack SSE avant réponse pour les routes lentes Todo/Mail.
- Fallback systématique vers routeur LLM si route non allowlistée / non supportée / erreur agent.
- Les routes de mutation restent non activées en live.

### Phase 2C : E1 actions sûres de mutation limitées ✅ COMPLET

**Activations live E1 (allowlistées)** :
- `todo.add_task`
- `todo.complete_task`
- `mail.mark_read`
- `mail.mark_unread`

**Comportement** :
- Bypass du routeur LLM quand la route est acceptée et allowlistée.
- Dispatch direct vers les agents spécialisés Todo/Mail (extraction/planning inchangés).
- Ack SSE avant réponse pour les routes Todo/Mail lentes.
- Fallback systématique vers routeur LLM sur route non allowlistée/non supportée ou erreur agent.

### Phase 2D : E1 mutations sensibles 🔜 NEXT

**Scope prévu** :
- `todo.update_task`
- `todo.delete_task`
- `todo.create_list`
- `todo.delete_list`
- `todo.add_checklist_item`
- `todo.complete_checklist_item`
- `todo.delete_checklist_item`
- `mail.flag_email`

**Toujours hors scope à ce palier** :
- `mail.send_email`
- `mail.reply_email`
- `mail.forward_email`
- `mail.trash_email`

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

Répété pour tous les 50 routes, trié par score.

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
  directRequest: { domain: 'spotify', action: 'pause' },
  plannerRequired: false,
  examples: ['pause', 'arrête le son', 'coupe la musique'],
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
npm test -- --runInBand

# Suites Phase 1A
tests/semanticRouter.phase1a.test.ts
tests/routing/e1RouteDispatcher.test.ts
tests/routing/e1Catalog.test.ts
tests/routing/routeDispatcher.search.test.ts
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
    "top1_intent": "search.news.external_weather",
    "top1_score": 0.91,
    "top2_intent": "search.web.lookup",
    "top2_score": 0.61,
    "margin": 0.30,
    "decision": "accepted_e2",
    "elapsed_ms": 45,
    "cachedEmbedding": true
  },
  "route": "search.news.external_weather",
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

- [x] Phase 0 : types + catalog + Spotify responses
- [x] Phase 1A : embeddingClient, routeScoring, routeDecision, semanticRouter
- [x] Phase 1A : routeDispatcher (search E2), e1RouteDispatcher (E1)
- [x] Phase 1A : integration ingest.ts (shadow mode)
- [x] Logging : semantic_router_* events capturées
- [x] Fallback LLM : toujours fonctionnel
- [x] Tests : 158 passing (13 suites)
- [ ] Phase 1B : analyser shadow logs pour calibrer seuils
- [ ] Phase 1B : activer SEMANTIC_ROUTER_ACTIVATION_ENABLED=true
- [ ] Phase 1B : valider latency p50 < 50ms en production
- [ ] Phase 1B : valider accuracy > 95% sur routes allowlistées
- [ ] Phase 2 : wiring E1 agents (Todo/Mail/Spotify)

---

**Suite** → Analyser shadow mode logs, puis activer [Phase 1B](./src/routing/INDEX.md)
