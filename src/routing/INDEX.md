# Semantic Router — Index & Navigation

**Dernière mise à jour** : Mai 2026  
**Version** : Phase 1A (Shadow Mode) ✅

---

## 📚 Documentation

### 1. **[ROADMAP.md](../../docs/semantic-router/ROADMAP.md)** ← COMMENCER ICI
   - Vue d'ensemble complète
   - 4 phases d'implémentation (8-10 semaines)
   - Matrice par domaine (Spotify, Search, Todo, Mail, HA)
   - Seuils de décision
   - Checklist avant Go Live

### 2. **[ARCHITECTURE.md](./ARCHITECTURE.md)** ← Deep Dive Technique
   - Types TypeScript complets
   - Flux d'exécution détaillé (5 étapes)
   - Intégration dans ingest.ts
   - Structure logging
   - Fixtures de test
   - Debugging tools

### 3. **[deterministic/DETERMINISTIC_PROMPTS.md](./deterministic/DETERMINISTIC_PROMPTS.md)** ← Réponses TTS
   - Format des réponses déterministes
   - Patterns & conventions
   - Intégration dans routes
   - Checklist de qualité

---

## 🏗️ Structure des fichiers

```
src/routing/
├── INDEX.md                           ← Ce fichier
├── ARCHITECTURE.md                    ← Doc technique détaillée
├── semanticRouter.types.ts            ← Types TS (Phase 0) ✅
├── semanticRouteCatalog.ts            ← Catalogue 50 routes (16 E2 + 34 E1) ✅
├── embeddingClient.ts                 ← Client Ollama/OpenAI (Phase 1A) ✅
├── routeScoring.ts                    ← Scoring cosine (Phase 1A) ✅
├── routeDecision.ts                   ← Logique décision (Phase 1A) ✅
├── semanticRouter.ts                  ← Orchestration (Phase 1A) ✅
├── routeDispatcher.ts                 ← Dispatch search E2 (Phase 1A) ✅
├── e1RouteDispatcher.ts               ← Dispatch E1 agents (Phase 1A) ✅
├── deterministic/
│   ├── spotifyResponses.ts            ← Spotify E2 (Phase 0 — COMPLET) ✅
│   ├── searchResponses.ts             ← Search E2 (STUBS — synthèse LLM)
│   ├── todoResponses.ts               ← Todo (STUBS — synthèse LLM)
│   ├── mailResponses.ts               ← Mail (STUBS — synthèse LLM)
│   ├── haResponses.ts                 ← HA E2 (Phase 3)
│   └── DETERMINISTIC_PROMPTS.md       ← Doc réponses

src/conversation/
└── haAgentRouter.ts                   ← Compat shim + parseAgentMap (Phase 1A) ✅

tests/
├── semanticRouter.phase1a.test.ts     ← Phase 1A tests ✅
├── routing/
│   ├── e1RouteDispatcher.test.ts      ← E1 dispatch tests ✅
│   ├── e1Catalog.test.ts              ← E1 catalog tests ✅
│   └── routeDispatcher.search.test.ts ← Search dispatch tests ✅
```

---

## 📊 Phase Breakdown

### Phase 0 : Fondations ← VOUS ÊTES ICI

**Durée** : Semaine 1-2  
**Commits** : 6  
**Sorties** :
- ✅ `semanticRouter.types.ts` — Types TypeScript
- ✅ `semanticRouteCatalog.ts` — catalogue aligné runtime (E2 + E1)
- ⏳ `embeddingClient.ts` — Client embeddings
- ⏳ `routeScoring.ts` — Calcul similarity
- ⏳ `routeDecision.ts` — Logique décision
- ⏳ `semanticRouter.ts` — Orchestration
- ✅ `deterministic/spotifyResponses.ts` — Spotify responses (COMPLET)
- ✅ `deterministic/searchResponses.ts` — Stubs Search
- ✅ `deterministic/todoResponses.ts` — Stubs Todo
- ✅ `deterministic/mailResponses.ts` — Stubs Mail
- ✅ `deterministic/DETERMINISTIC_PROMPTS.md` — Documentation

**Fichiers créés** : 13  
**Status** : 🔴 En attente d'implémentation

---

### Phase 1 : Intégration & E2 Live

**Durée** : Semaine 3-4  
**Commits** : 5  
**Requiert** : Phase 0 complétée  
**Sorties** :
- Config env `SEMANTIC_ROUTER_*`
- Intégration dans `src/routes/ingest.ts`
- Catalogue E2 rempli
- Logging & metrics
- Phase 1 tests

---

### Phase 2 : E1 Agents & Expansion 🔴 TODO

**Durée** : Semaine 5-6  
**Commits** : 6  
**Requiert** : Phase 1 live en prod  
**Sorties** :
- 22 routes E1
- Direct actions pour Spotify/Search/Todo/Mail
- Route dispatcher
- Phase 2 tests

---

### Phase 3 : HA & Tuning

**Durée** : Semaine 7-8  
**Commits** : 3  
**Sorties** :
- HA executor routes
- Threshold adaptive
- Phase 3 tests

---

### Phase 4 : Advanced

**Durée** : Semaine 9-10  
**Commits** : 3  
**Sorties** :
- Clustering par intent
- pgvector pour scalabilité
- Personalization utilisateur

---

## 🎯 Etat réel du catalogue (Source de vérité)

- **E2 (16)**: Spotify (7), Search externe (5), Weather local (4)
- **E1 (34)**: Spotify (6), Search deep (3), Todo (15), Mail (10)
- **Total : 50 routes** (16 E2 + 34 E1)
- Shadow mode : `SEMANTIC_ROUTER_ENABLED=true` + `SEMANTIC_ROUTER_SHADOW_MODE=true`
- Activation : `SEMANTIC_ROUTER_ACTIVATION_ENABLED=false` (Phase 1B)

## 🎯 Routes : Résumé complet

### Spotify (7+6 routes)

**E2** (direct executor, ~40-50ms) :
- `spotify.pause` ✅
- `spotify.play` ✅
- `spotify.next` ✅
- `spotify.previous` ✅
- `spotify.now_playing` ✅
- `spotify.list_devices` ✅
- `spotify.clear_queue` ✅

**E1** (agent planner, ~500-1000ms) :
- `spotify.search`
- `spotify.search_and_play`
- `spotify.queue_add`
- `spotify.transfer`
- `spotify.add_to_playlist`
- `spotify.volume_set`

### Search (5+3 routes)

**E2** :
- `search.news.external_weather` ✅
- `search.news.live_sport` ✅
- `search.news.current_news` ✅
- `search.web.definition` ✅
- `search.web.quick_lookup` ✅

### Weather local (4 routes)

**E2** :
- `weather.current_temperature` ✅
- `weather.current_humidity` ✅
- `weather.current_precipitation` ✅
- `weather.current_conditions` ✅

**E1** :
- `search.deep.analysis`
- `search.deep.history`
- `search.deep.comparison`

### Todo (6+9 routes)

**E1 (démarrage)** :
- `todo.list_tasks` ✅
- `todo.list_tasks.today` ✅
- `todo.list_tasks.tomorrow` ✅
- `todo.list_tasks.this_week` ✅
- `todo.list_tasks.overdue` ✅
- `todo.list_lists` ✅

**E1** :
- `todo.add_task`
- `todo.complete_task`
- `todo.delete_task`
- `todo.update_task`
- `todo.create_list`
- `todo.delete_list`
- `todo.add_checklist_item`
- `todo.complete_checklist_item`
- `todo.delete_checklist_item`

### Mail (2+8 routes)

**E1 (démarrage)** :
- `mail.list_inbox` ✅
- `mail.list_inbox.unread` ✅

**E1** :
- `mail.search_emails`
- `mail.send_email`
- `mail.reply_email`
- `mail.forward_email`
- `mail.mark_read`
- `mail.mark_unread`
- `mail.trash_email`
- `mail.flag_email`

### HA Executors (6+6 routes — Phase 3)

**E2** (Phase 3) :
- `executor.light_on`
- `executor.light_off`
- `executor.vacuum_start`
- `executor.vacuum_stop`
- `executor.scene_simple`
- `executor.script_simple`

**E1** (Phase 3) :
- `executor.timer`
- `executor.alarm`
- `executor.reminder`
- `executor.calendar`
- `executor.vacuum_zone`
- `executor.audio_zone`

---

## 🔧 Configuration (Phase 1A actuelle)

```bash
# .env — Phase 1A (Shadow Mode)
SEMANTIC_ROUTER_ENABLED=true
SEMANTIC_ROUTER_SHADOW_MODE=true               # évaluation seulement
SEMANTIC_ROUTER_PROVIDER=ollama
SEMANTIC_ROUTER_BASE_URL=http://localhost:11434
SEMANTIC_ROUTER_MODEL=nomic-embed-text
SEMANTIC_ROUTER_ACCEPT_SCORE=0.84
SEMANTIC_ROUTER_MIN_MARGIN=0.08
SEMANTIC_ROUTER_TIMEOUT_MS=5000

# Phase 1B : activation
# SEMANTIC_ROUTER_ACTIVATION_ENABLED=true
# SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES=spotify.pause,spotify.play,spotify.next,spotify.previous
```

---

## 📈 KPIs & Monitoring

### Phase 1 Targets

| Métrique | Target | Notes |
|---|---|---|
| E2 Latency p50 | <50ms | vs LLM ~1500ms |
| E2 Accuracy | >95% | correct routes |
| Fallback rate | <5% | ambig/multi-intent |
| Cache hit | >80% | embedding queries |

### Logging Events

```
semantic_router_start
semantic_router_accepted
semantic_router_rejected_low_score
semantic_router_rejected_low_margin
semantic_router_rejected_multi_intent
semantic_router_fallback_llm
semantic_router_result
```

---

## ✅ Checklist Before Go Live (Phase 1B)

- [x] Phase 0 : Tous fichiers créés & types OK
- [x] Phase 0 : Spotify responses COMPLET
- [x] Phase 0 : Catalog 50 routes validé (16 E2 + 34 E1)
- [x] Phase 0 : Documentation à jour
- [x] Phase 1A : embeddingClient, routeScoring, routeDecision, semanticRouter
- [x] Phase 1A : routeDispatcher (search E2), e1RouteDispatcher (E1)
- [x] Phase 1A : Integration ingest.ts (shadow mode)
- [x] Phase 1A : Config env SEMANTIC_ROUTER_*
- [x] Phase 1A : 158 tests passing
- [ ] Phase 1B : Analyser shadow logs (>100 requêtes production)
- [ ] Phase 1B : Activer SEMANTIC_ROUTER_ACTIVATION_ENABLED=true
- [ ] Phase 1B : Valider latency p50 < 50ms en production
- [ ] Phase 1B : Valider accuracy > 95% routes allowlistées
- [ ] Phase 2 : E1 wiring agents (Todo/Mail/Spotify)
- [ ] Fallback LLM router : always works
- [ ] Docs : tous README actualisés

---

## 🚀 Next Steps

1. **Lire** [ROADMAP.md](../../docs/semantic-router/ROADMAP.md)
2. **Comprendre** [ARCHITECTURE.md](./ARCHITECTURE.md)
3. **Implémenter** Phase 0 (6 commits TypeScript)
4. **Tester** avec fixtures Phase 1
5. **Déployer** Phase 1 (5 commits + intégration ingest)

---

**Current Status** : 📋 Planning complete → 🔴 Awaiting Phase 0 implementation

Contact: User / Copilot for next steps
