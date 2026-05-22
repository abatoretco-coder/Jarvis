# Etape 4 - Orchestration par action et construction de reponse

## But
Pour chaque action/agent: niveau utilise, service appele, execution, puis construction de reponse.

## Vue runtime (code reel)
1. Le routeur fournit `validTargets` (filtrees par confidence).
2. Separation en 2 groupes:
- `spotifyTarget` (au plus un)
- `haSpecTargets` (tout le reste sauf `general`)
3. Construction d une liste `tasks` executees en parallele (`Promise.all`).
4. Si au moins un resultat exploitable:
- Spotify seul -> payload Spotify riche (`buildSpotifyIngestPayload`)
- 1 resultat non-Spotify -> texte direct
- plusieurs resultats -> synthese LLM (`synthesizeAgentResponses`)
5. Si aucun resultat exploitable -> fallback HA general.

## Format de lecture par action
1. Niveau et chemin de routing
- explicit_contract, router_direct, music_planner, E2 direct, E1 dispatch, fallback.

2. Service cible
- Spotify Web API, HA Conversation, HA Services, Perplexity/OpenAI Search, Graph Todo, Gmail/Outlook.

3. Execution
- Appel concret et logique metier (no-op, retry, clarifications, erreurs deterministes).

4. Construction de reponse
- Texte metier
- Statut (success, need_clarification, error)
- Metadata replyMeta/musique selon domaine

## Cartographie rapide par famille
1. Spotify
- Service: spotifyWebApi via spotifyExecutor.
- Execution:
	- `router_direct` si action+slots valides deja presents
	- sinon planner OpenAI (`planSpotifyActionFromTextWithOpenAi`)
	- exception: `search_and_play` sans `query` -> planner obligatoire
- Reponse:
	- cas Spotify seul -> `buildSpotifyIngestPayload` (metadata complete)
	- actions E2 aveugles (`pause`, `play`, `next`, `previous`, `clear_queue`) activees semantic -> phrase deterministe courte issue du catalogue
	- `now_playing` et `list_devices` restent dynamiques (texte executor)

2. Search
- Service: callSearchAgent (bypass HA).
- Execution: Perplexity/OpenAI selon cle agent (`search.news.*`, `search.web.*`, `search.deep`).
- Reponse: texte direct, sans HA.

3. Weather local
- Service: HA states + synthese deterministe/OpenAI.
- Execution: `ha.getStates()` -> snapshot meteo ->
	- d abord synthese deterministe (temperature/humidite/condition/precipitation)
	- sinon synthese OpenAI pour requetes complexes
- Reponse: texte weather direct.

4. Todo
- Service: Microsoft Graph via callTodoAgent.
- Reponse: texte operationnel todo.

5. Mail
- Service: Gmail/Outlook via callMailAgent.
- Reponse: texte operationnel mail + etat voix.

6. Executors
- Service: HA conversation ciblee (agent executors).
- Reponse: texte d execution domotique.

7. Agents HA specialises (hors bypass)
- Service: `conversationService.callHomeAssistantConversation(..., agentId)`
- Regle: si reponse `OUT_OF_SCOPE` -> resultat ignore (retombe sur autres resultats ou fallback general)

## Detail action par action
Le detail fin action par action est conserve dans:
- MUSIC_ACTION_EXECUTION_VIEW.md
- AGENTS_DETECTION_EXECUTION_VIEW.md
- docs/agents/*.md

## Construction de reponse (priorites)
1. Spotify seul:
- Persist messages
- Formattage voix si active (`formatVoiceResponse`)
- Payload Spotify riche (status/data/options/error_code + planner metadata)
2. Un seul resultat non-Spotify:
- texte direct sans synthese
3. Multi-target:
- agregation des `parts` puis synthese LLM unique
4. Aucun resultat:
- fallback HA general
- en erreur ou OUT_OF_SCOPE -> message deterministe de secours

## References code
- src/routes/ingest.ts
- src/spotify/spotifyExecutor.ts
- src/routing/e1RouteDispatcher.ts
- src/routing/routeDispatcher.ts
- src/todo/todoAgent.ts
- src/mail/mailAgent.ts
