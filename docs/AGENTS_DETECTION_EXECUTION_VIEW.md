# Agents - Detection, Routing, Execution, Response

Objectif: expliquer, pour chaque agent Jarvis, le cycle complet:
1. comment il est detecte,
2. comment il est route,
3. comment il est execute,
4. comment la reponse finale est construite.

## Review Status

- [ ] Reviewed with user: global multi-agent pipeline
- [ ] Reviewed with user: spotify/search/weather
- [ ] Reviewed with user: todo/mail/executors/general
- [ ] Reviewed with user: response synthesis and voice domain mapping

Companion architecture steps:
- architecture-review/03_routing_runtime_engine.md
- architecture-review/04_action_orchestration_service_and_response_build.md
- architecture-review/05_response_dispatch_to_source.md
- architecture-review/06_source_specific_rendering_text_vs_voice.md

## 1) Vue globale du pipeline multi-agents

1. Entree explicite Spotify
- Si domain=spotify et action valide: passage direct Spotify, sans routeur general.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L956)

2. Entree texte
- Jarvis active d abord le semantic router (si active), puis le routeur LLM orchestrateur.
- Semantic E2/E1 peut activer directement certaines routes.
- Sinon routeUserRequest choisit des cibles depuis HA_AGENT_MAP + agents internes (spotify, weather).
- References:
  - [src/routing/semanticRouter.ts](src/routing/semanticRouter.ts)
  - [src/routing/routeDecision.ts](src/routing/routeDecision.ts)
  - [src/conversation/orchestratorRouter.ts](src/conversation/orchestratorRouter.ts)
  - [src/routes/ingest.ts](src/routes/ingest.ts#L1040)

3. Execution specialisee
- Chaque cible est executee dans un task specialise.
- Si plusieurs cibles repondent: synthese multi-agent.
- Si aucune cible exploitable: fallback HA general.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L1951)

4. Construction de reponse
- Spotify seul: payload Spotify enrichi (status, music.routing, planner, etc.).
- Autres agents: payload general avec replyMeta kind/source/routeKey.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L2296)

## 2) Agent Spotify

Detection
- Explicite: domain spotify + action.
- Semantique E2 direct: pause, play, next, previous, now_playing, list_devices, clear_queue.
- Semantique E1 planner: search, search_and_play, queue_add, transfer, add_to_playlist, volume_set.
- Matrix: [src/spotify/musicRoutingMatrix.ts](src/spotify/musicRoutingMatrix.ts)

Routing
- Paths: explicit_contract, router_direct, music_planner.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L199)

Execution
- executeSpotifyCapability action par action.
- Reference: [src/spotify/spotifyExecutor.ts](src/spotify/spotifyExecutor.ts#L311)

Reponse
- Payload Spotify dedie avec:
  - replyMeta.kind=spotify
  - replyMeta.routeKey=spotify.action
  - music.routing.path
  - music.execution.status
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L208)

Doc detaillee deja produite
- [docs/MUSIC_ACTION_EXECUTION_VIEW.md](docs/MUSIC_ACTION_EXECUTION_VIEW.md)

## 3) Agent Search (search.news, search.web, search.deep)

Detection
- HA_AGENT_MAP key search ou prefix search.
- Helper de detection: isSearchAgentKey.
- Reference: [src/search/agents.ts](src/search/agents.ts#L132)

Routing
- E2 live routes search.news.external_weather, live_sport, current_news, search.web.definition, quick_lookup.
- Dispatcher E2: dispatchAcceptedSearchE2Route.
- Reference:
  - [src/routing/routeDispatcher.ts](src/routing/routeDispatcher.ts)
  - [src/routing/semanticRouteCatalog.ts](src/routing/semanticRouteCatalog.ts#L128)

Execution
- callSearchAgent avec config par agent (model, temperature, recency filter).
- Search agents bypass HA completement.
- Reference:
  - [src/search/agents.ts](src/search/agents.ts)
  - [src/routes/ingest.ts](src/routes/ingest.ts#L2079)

Reponse
- Texte direct du search agent.
- En cas multi-agent, texte fusionne par synthese.
- Response domain final: search.
- References:
  - [src/conversation/orchestratorRouter.ts](src/conversation/orchestratorRouter.ts#L193)
  - [src/routes/ingest.ts](src/routes/ingest.ts#L2270)

## 4) Agent Weather (local Home Assistant)

Detection
- 3 entrees possibles:
  1) Semantic E2 weather.current_temperature/humidity/precipitation/current_conditions
  2) Injection locale heuristique (isLikelyLocalWeatherQuery)
  3) Routeur LLM cible weather
- References:
  - [src/routing/semanticRouteCatalog.ts](src/routing/semanticRouteCatalog.ts#L186)
  - [src/routes/ingest.ts](src/routes/ingest.ts#L555)
  - [src/routes/ingest.ts](src/routes/ingest.ts#L1896)

Routing
- En cas requete meteo externe, Jarvis privilegie search.news.external_weather.
- En cas meteo locale mono-intent, Jarvis retire les cibles search pour verrouiller local.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L1877)

Execution
- Lecture etats HA, build snapshot meteo.
- Deterministe d abord pour requetes simples (temperature, humidite, pluie, condition actuelle).
- Sinon synthese OpenAI a partir du snapshot.
- References:
  - [src/weather/weatherSnapshot.ts](src/weather/weatherSnapshot.ts)
  - [src/weather/deterministicWeatherReply.ts](src/weather/deterministicWeatherReply.ts)
  - [src/routes/ingest.ts](src/routes/ingest.ts#L2148)

Reponse
- Texte meteo local concis.
- Response domain final: weather.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L2270)

## 5) Agent Todo

Detection
- Key todo ou prefix todo dans HA_AGENT_MAP.
- Helper: isTodoAgentKey.
- Reference: [src/todo/todoAgent.ts](src/todo/todoAgent.ts#L996)

Routing
- Peut venir du routeur LLM specialise.
- Peut venir de semantic E1 via dispatcher (route todo.*).
- Reference:
  - [src/routing/e1RouteDispatcher.ts](src/routing/e1RouteDispatcher.ts)
  - [src/routes/ingest.ts](src/routes/ingest.ts#L2072)

Execution
- callTodoAgent:
  - planner OpenAI vers action todo,
  - execution Microsoft Graph Tasks.
- Bypass HA complet.
- Reference: [src/todo/todoAgent.ts](src/todo/todoAgent.ts#L1004)

Reponse
- Texte operationnel (cree, liste, coche, supprime, etc.).
- Response domain final: todo.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L2270)

## 6) Agent Mail

Detection
- Key mail ou prefix mail dans HA_AGENT_MAP.
- Helper: isMailAgentKey.
- Reference: [src/mail/mailAgent.ts](src/mail/mailAgent.ts#L811)

Routing
- Routeur LLM specialise ou semantic E1 route mail.*
- Dispatcher E1: mail_text.
- Reference: [src/routing/e1RouteDispatcher.ts](src/routing/e1RouteDispatcher.ts)

Execution
- callMailAgent:
  - preclassification sur certains cas,
  - planner OpenAI action mail,
  - execution Gmail/Outlook.
- Bypass HA complet.
- Reference: [src/mail/mailAgent.ts](src/mail/mailAgent.ts#L822)

Reponse
- Texte metier mail (liste, lecture, envoi, flag, etc.).
- Etat voix mail memorise pour follow-up vocal.
- Response domain final: mail.
- References:
  - [src/routes/ingest.ts](src/routes/ingest.ts#L2329)
  - [src/routes/ingest.ts](src/routes/ingest.ts#L2338)

## 7) Agent Executors (home automation)

Detection
- Cible executors depuis:
  - routeur LLM (action domotique),
  - semantic E1 routes executor.*
- Reference: [src/routing/semanticRouteCatalog.ts](src/routing/semanticRouteCatalog.ts#L567)

Routing
- Semantic E1 executor est mappe vers une cible HA executors.
- Cas particulier timer: tentative de traitement direct local avant HA conversation.
- References:
  - [src/routes/ingest.ts](src/routes/ingest.ts#L1513)
  - [src/routes/ingest.ts](src/routes/ingest.ts#L633)

Execution
- Timer direct:
  - parse duree,
  - trouve entite timer.*,
  - callService timer.start.
- Sinon executors passe par conversationService.callHomeAssistantConversation sur agent executors.
- References:
  - [src/routes/ingest.ts](src/routes/ingest.ts#L2190)
  - [src/routes/ingest.ts](src/routes/ingest.ts#L2223)

Reponse
- Texte d action domotique (confirmation ou erreur claire).
- Response domain final: executor.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L2271)

## 8) Agent General HA (fallback)

Detection
- Ce nest pas un agent cible primaire.
- Il est appele uniquement si:
  - routeur indisponible,
  - aucune cible valide,
  - toutes cibles specialisees echouent ou retournent null.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L2296)

Routing
- Fallback unique vers HA_AGENT_GENERAL.
- Reference: [src/env.ts](src/env.ts#L167)

Execution
- conversationService.callHomeAssistantConversation avec generalAgentId.
- OUT_OF_SCOPE force un message deterministe de secours.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L2300)

Reponse
- Payload standard replyMeta.kind=general.
- source: ha_general si fallback, sinon semantic_router ou router_or_specialized selon chemin.
- Reference: [src/routes/ingest.ts](src/routes/ingest.ts#L2343)

## 9) Regles de construction de reponse (tous agents)

Single agent
- Spotify seul: payload Spotify enrichi.
- Non Spotify seul: texte direct en payload general.

Multi-agent
- Les sorties sont fusionnees par synthese LLM.
- Fallback deterministic join si synthese indisponible.
- Reference: [src/conversation/orchestratorRouter.ts](src/conversation/orchestratorRouter.ts#L193)

Voix
- Formatage final depend du domaine: mail, todo, search, executor, weather, spotify, general.
- Reference: [src/conversation/voiceUx.ts](src/conversation/voiceUx.ts)

## 10) Ce que tu peux decider maintenant facilement

1. Pour chaque agent, tu peux choisir si on veut:
- plus de determinisme,
- plus de planner,
- plus de fallback HA.

2. Tu peux separer strategie de reponse:
- agents execution (executor, spotify actions de controle)
- agents information (search, weather info, now_playing, list_devices)
- agents transactionnels (mail, todo)

3. Tu peux prioriser les prochains travaux par agent, sans toucher les autres.
