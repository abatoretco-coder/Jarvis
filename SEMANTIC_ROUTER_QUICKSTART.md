# 🚀 SEMANTIC ROUTER — QUICK START GUIDE

**Vous êtes ici** : Phase 1A (Shadow Mode) Complete ✅

---

## 📍 Où commencer ?

### Pour COMPRENDRE le vision (30 min)

**Lire dans cet ordre** :

1. **[SEMANTIC_ROUTER_ROADMAP.md](./SEMANTIC_ROUTER_ROADMAP.md)** ← **COMMENCEZ ICI**
   - Vue d'ensemble : D0 → E2 → E1 → LLM → HA
   - 4 phases d'implémentation
   - Seuils : acceptScore=0.84, minMargin=0.08
   - **Temps** : 15 min

2. **[SEMANTIC_ROUTER_SUMMARY.md](./SEMANTIC_ROUTER_SUMMARY.md)** ← Visualisation claire
   - Diagrammes ASCII
   - Stats (16 routes E2, 8 routes E1 démarrage, 32 variantes Spotify)
   - Checklist go-live
   - **Temps** : 10 min

---

### Pour IMPLÉMENTER (Phase 0 code, 2 semaines)

**Fichiers à implémenter** (dans cet ordre) :

```
1. src/routing/embeddingClient.ts        ← Ollama/OpenAI client
2. src/routing/routeScoring.ts           ← Cosine similarity
3. src/routing/routeDecision.ts          ← Accept/reject logic
4. src/routing/semanticRouter.ts         ← Main orchestration
5. src/routes/ingest.ts                  ← Integration point
6. tests/routing/semanticRouter.test.ts  ← Tests fixtures
```

**Types & Catalog** (déjà créés ✅) :
- `src/routing/semanticRouter.types.ts` ✅
- `src/routing/semanticRouteCatalog.ts` ✅
- `src/routing/deterministic/*.ts` ✅

**Doc technique** (consulter pendant implémentation) :
- [ARCHITECTURE.md](./src/routing/ARCHITECTURE.md) — Patterns & contrats
- [deterministic/DETERMINISTIC_PROMPTS.md](./src/routing/deterministic/DETERMINISTIC_PROMPTS.md) — Response patterns

---

### Pour NAVIGUER (10 min)

**Central Hub** :
- [src/routing/INDEX.md](./src/routing/INDEX.md) — Navigation + checklist

---

## 📦 Ce qui a été livré (Phase 0 + Phase 1A)

### Documentation (2500+ lignes)

| Fichier | Lignes | Contenu | Audience |
|---|---|---|---|
| [SEMANTIC_ROUTER_ROADMAP.md](./SEMANTIC_ROUTER_ROADMAP.md) | 850 | Vision complète 4 phases | Product, Managers |
| [ARCHITECTURE.md](./src/routing/ARCHITECTURE.md) | 900 | Deep dive technique | Developers |
| [INDEX.md](./src/routing/INDEX.md) | 350 | Navigation hub | Everyone |
| [deterministic/DETERMINISTIC_PROMPTS.md](./src/routing/deterministic/DETERMINISTIC_PROMPTS.md) | 400 | Patterns réponses | Developers |

### Code TypeScript Phase 0 (Types + Catalog)

| Fichier | Lignes | Status | Compilable |
|---|---|---|---|
| [semanticRouter.types.ts](./src/routing/semanticRouter.types.ts) | 280 | ✅ COMPLET | ✅ YES |
| [semanticRouteCatalog.ts](./src/routing/semanticRouteCatalog.ts) | 500+ | ✅ COMPLET (50 routes) | ✅ YES |
| [spotifyResponses.ts](./src/routing/deterministic/spotifyResponses.ts) | 180 | ✅ COMPLET | ✅ YES |
| [searchResponses.ts](./src/routing/deterministic/searchResponses.ts) | 18 | ⏳ STUBS | ✅ YES |
| [todoResponses.ts](./src/routing/deterministic/todoResponses.ts) | 16 | ⏳ STUBS | ✅ YES |
| [mailResponses.ts](./src/routing/deterministic/mailResponses.ts) | 13 | ⏳ STUBS | ✅ YES |

### Code TypeScript Phase 1A (Infrastructure)

| Fichier | Lignes | Status | Notes |
|---|---|---|---|
| [embeddingClient.ts](./src/routing/embeddingClient.ts) | ~150 | ✅ COMPLET | Ollama + OpenAI, LRU 512 |
| [routeScoring.ts](./src/routing/routeScoring.ts) | ~120 | ✅ COMPLET | Cosine similarity, centroid |
| [routeDecision.ts](./src/routing/routeDecision.ts) | ~100 | ✅ COMPLET | Accept/reject, multi-intent |
| [semanticRouter.ts](./src/routing/semanticRouter.ts) | ~95 | ✅ COMPLET | Orchestration 5-step |
| [routeDispatcher.ts](./src/routing/routeDispatcher.ts) | ~60 | ✅ COMPLET | Search E2 live dispatch |
| [e1RouteDispatcher.ts](./src/routing/e1RouteDispatcher.ts) | ~50 | ✅ COMPLET | E1 dispatch vers agents |
| [haAgentRouter.ts](./src/conversation/haAgentRouter.ts) | ~50 | ✅ COMPLET | Compat shim + parseAgentMap |

### Tests Phase 1A

| Fichier | Tests | Status |
|---|---|---|
| [semanticRouter.phase1a.test.ts](./tests/semanticRouter.phase1a.test.ts) | ~90 | ✅ PASS |
| [routing/e1RouteDispatcher.test.ts](./tests/routing/e1RouteDispatcher.test.ts) | ~20 | ✅ PASS |
| [routing/e1Catalog.test.ts](./tests/routing/e1Catalog.test.ts) | ~15 | ✅ PASS |
| [routing/routeDispatcher.search.test.ts](./tests/routing/routeDispatcher.search.test.ts) | ~20 | ✅ PASS |
| **Total (13 suites)** | **158** | **✅ ALL PASS** |

---

## 🎯 Etat actuel des routes

```
┌─ SPOTIFY (7 E2 + 6 E1)
│  E2 (direct executor) :
│  ├─ pause              → 4 variantes
│  ├─ play               → 4 variantes
│  ├─ next               → 4 variantes
│  ├─ previous           → 4 variantes
│  ├─ now_playing        → template
│  ├─ list_devices       → template
│  └─ clear_queue        → 3 variantes
│  E1 (agent planner) : search, search_and_play, queue_add, transfer, add_to_playlist, volume_set
│
├─ WEATHER LOCAL (4 E2)
│  ├─ current_temperature  → "quelle température à la maison ?"
│  ├─ current_humidity     → "humidité actuelle maison"
│  ├─ current_precipitation → "il pleut chez moi ?"
│  └─ current_conditions   → "météo locale du moment"
│
├─ SEARCH EXTERNE (5 E2 + 3 E1 deep)
│  E2 : external_weather, live_sport, current_news, definition, quick_lookup
│  E1 deep : analysis, history, comparison
│
├─ TODO (15 E1)
│  ├─ list_tasks, list_tasks.today, list_tasks.tomorrow
│  ├─ list_tasks.this_week, list_tasks.overdue, list_lists
│  └─ add_task, complete_task, delete_task, update_task
│     create_list, delete_list
│     add_checklist_item, complete_checklist_item, delete_checklist_item
│
└─ MAIL (10 E1)
   ├─ list_inbox, list_inbox.unread
   ├─ search_emails, send_email, reply_email, forward_email
   └─ mark_read, mark_unread, trash_email, flag_email
```

**Total** : 16 routes E2 + 34 routes E1 = **50 routes** + 32 Spotify variantes

---

## ⚙️ Configuration (Phase 1)

```bash
# .env
SEMANTIC_ROUTER_ENABLED=true                         # Activation
SEMANTIC_ROUTER_PROVIDER=ollama                      # or openai
SEMANTIC_ROUTER_BASE_URL=http://localhost:11434
SEMANTIC_ROUTER_MODEL=nomic-embed-text               # or text-embedding-3-small
SEMANTIC_ROUTER_ACCEPT_SCORE=0.84                    # 84% confiance min
SEMANTIC_ROUTER_MIN_MARGIN=0.08                      # écart top1-top2
SEMANTIC_ROUTER_TIMEOUT_MS=5000                      # 5s per embedding
```

---

## 📊 Seuils & Décision

```
Top1 Score = 0.91
Top2 Score = 0.61
Margin = 0.30

Check 1: top1 >= 0.84 ✓
Check 2: margin >= 0.08 ✓
Check 3: !multiIntent ✓

RESULT: ACCEPT E2 route 🟢
Execute directly, ~50ms latency
```

Si échoue une check → **Fallback vers LLM Router existant**

---

## 🚀 Timeline

| Phase | Semaines | Routes | Status |
|---|---|---|---|
| **0** | S1-2 | Types + Catalog | ✅ DONE |
| **1A** | S3-4 | Shadow Mode (50 routes catalogées, infra live) | ✅ DONE |
| **1B** | S5 | Activation (allowlist E2, tuning seuils) | 🔴 TODO |
| **2** | S6-7 | E1 Wiring (Todo/Mail/Spotify agents) | 🔴 TODO |
| **3** | S8-9 | HA Executors (12 routes) | 🔴 TODO |
| **4** | S10 | Advanced (clustering, personalization) | 🔴 TODO |

**Total** : 10 semaines pour la v1 complète

---

## 🎓 3 Concepts clés

### 1️⃣ E2 = Ultra-rapide (40-50ms)

- Embedding utilisateur → scoring
- Top 1 match ≥ 0.84 ET margin ≥ 0.08 → **ACCEPT**
- Direct executor (pas de LLM)
- Réponse déterministe (variante aléatoire)

### 2️⃣ E1 = Rapide + Planner (500-1000ms)

- Embedding utilisateur → scoring
- Match ≥ 0.84 ET margin ≥ 0.08 → **ACCEPT**
- Envoyer vers agent (Spotify planner, etc.)
- Agent retourne action structurée
- Executor + LLM synthesis

### 3️⃣ LLM Router = Fallback

- Multi-intent : "mets du jazz et donne-moi les actus"
- Ambiguïté : "mets le son" (Spotify ou HA audio?)
- Contexte : "et baisse un peu"
- Routeur existant, inchangé

---

## ✅ Checklist Lecture (30 min)

- [ ] Lire SEMANTIC_ROUTER_ROADMAP.md (15 min)
- [ ] Lire SEMANTIC_ROUTER_SUMMARY.md (10 min)
- [ ] Scroller INDEX.md (5 min)
- [ ] Parcourir ARCHITECTURE.md (skim, 5 min)

---

## ✅ Checklist Avant Implementation (Phase 0)

- [ ] Tous les docs lus ✓
- [ ] Types TypeScript compris (semanticRouter.types.ts)
- [ ] Catalog aligné runtime OK (semanticRouteCatalog.ts)
- [ ] Spotify responses OK (32 variantes)
- [ ] Ollama installé (local) OU clé OpenAI réservée
- [ ] Reserve 2 semaines Phase 0 implementation
- [ ] Slack/team notifié du début implémentation

---

## 🎯 Commande pour démarrer Phase 0

```bash
cd d:\NAS\All VM\Jarvis

# 1. Lire les docs
cat SEMANTIC_ROUTER_ROADMAP.md | head -100

# 2. Vérifier les fichiers existent
ls src/routing/semanticRouter.types.ts        ✓
ls src/routing/semanticRouteCatalog.ts        ✓
ls src/routing/deterministic/spotifyResponses.ts ✓

# 3. Build pour vérifier (Phase 1)
# npm run build  (une fois les 4 fichiers implémentés)
```

---

## 📞 Support

### Questions ?

1. **Lisez d'abord** : [SEMANTIC_ROUTER_ROADMAP.md](./SEMANTIC_ROUTER_ROADMAP.md)
2. **Puis** : [ARCHITECTURE.md](./src/routing/ARCHITECTURE.md)
3. **Puis** : [INDEX.md](./src/routing/INDEX.md)
4. **Créez un QUESTIONS.md** si besoin

### Erreurs ?

- Types ? → [semanticRouter.types.ts](./src/routing/semanticRouter.types.ts)
- Routes ? → [semanticRouteCatalog.ts](./src/routing/semanticRouteCatalog.ts)
- Responses ? → [deterministic/DETERMINISTIC_PROMPTS.md](./src/routing/deterministic/DETERMINISTIC_PROMPTS.md)

---

## 🎉 Status Final

✅ **Phase 0 : PLANNING + DOCUMENTATION + TYPES = 100% COMPLETE**

- 4 docs (2500+ lines)
- 6 fichiers TS (types + catalog + responses)
- Catalogue aligné runtime défini (E2 + E1)
- 32 variantes Spotify
- Ready for Phase 1 implementation

🟢 **Next : Implement Phase 0 code (embeddingClient, routeScoring, routeDecision, semanticRouter)**

---

**Time to first working semantic route** : ~2-3 weeks (Phase 0 + Phase 1 integration)

**Let's go! 🚀**
