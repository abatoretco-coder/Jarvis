# Etape 3 - Fonctionnement du routing

## But
Expliquer l ordre de decision du routing et ses garde-fous.

## Ordre runtime
1. Semantic router (si active) — peut court-circuiter le LLM si une route est activee.
2. Sinon routeur orchestrateur LLM (targets + confidence).
3. Dispatch des cibles specialisees retenues.
4. Fallback HA general uniquement si aucun resultat exploitable.

Note: il n y a pas de priorite Spotify pre-routeur. Spotify passe par le routeur comme n importe quel autre intent.

## Semantic router
1. Pipeline
- Embedding texte utilisateur
- Scoring catalogue routes (similarite cosinus)
- Decision selon score accepte, marge top1/top2, multi-intent

2. Modes
- Shadow mode (SEMANTIC_ROUTER_SHADOW_MODE=true): tourne en fond, logge seulement, n influence jamais le routage.
- Live mode: peut activer une cible et bypasser le LLM si la route est dans l allowlist.

3. Niveaux d activation live
- E2 (SEMANTIC_ROUTER_ACTIVATION_ENABLED + SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES): active RouterTarget directement (spotify action, weather...).
- E1 (SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED + SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES): active RouterTarget avec planner eventuel.
- E1 high-risk (SEMANTIC_ROUTER_E1_HIGH_RISK_ACTIVATION_ENABLED + SEMANTIC_ROUTER_ACTIVATED_E1_HIGH_RISK_ROUTES): idem, flag separe.

Important:
- Les routes search E2 ne passent pas par RouterTarget. Elles sont executees directement via dispatchAcceptedSearchE2Route() et produisent assistantText.
- Les routes Spotify/Weather E2 passent par toSemanticActivationTarget() puis le pipeline d execution standard.

4. Resultat semantic
- assistantText deja produit (live response) -> routerPromise = targets vides, LLM non appele.
- semanticActivatedTarget defini -> routerPromise wrappe la cible directement, LLM non appele.
- Sinon -> routerPromise appelle le LLM orchestrateur.

## Orchestrateur LLM
1. Sortie structuree JSON (jamais free text).
2. Liste targets[] avec agentId + confidence + action/slots (spotify).
3. Filtrage par seuil ROUTER_CONFIDENCE_THRESHOLD.
4. Contexte fourni: summary thread + 3 messages recents.

## Dispatch apres routing
1. spotifyTarget separe des haSpecTargets.
2. spotifyTarget -> music planner (ou action directe si router l a fournie) -> executor Spotify.
3. haSpecTargets -> taches specialisees en parallele: search agents, executors HA, weather, todo, mail, calendar.
4. Si validTargets vide -> HA general fallback.
5. Si router failed (rejected) -> HA general fallback.

Details importants:
- Runtime multi-intent guard: si la phrase semble multi-intent (score > SEMANTIC_ROUTER_MULTI_INTENT_THRESHOLD), le semantic router live est saute et le flux retombe sur le routeur LLM.
- D0 est present dans les types/decision, mais aucune route D0 active dans le catalogue actuellement.
- Reponses deterministes Spotify E2: pour les actions aveugles (pause, play, next, previous, clear_queue), la phrase retour est prise du catalogue deterministicResponses (courte, locale, sans LLM).
- now_playing et list_devices restent dynamiques (texte provenant de l executor) car ils dependent de donnees live.

## References code
- src/routing/semanticRouter.ts
- src/routing/routeDecision.ts
- src/conversation/orchestratorRouter.ts
- src/routes/ingest.ts (routerPromise, dispatch bloc)
