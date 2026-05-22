# Music Routing Business Map (Jarvis)

Objectif: valider le metier musique avec un contrat simple.

Pour chaque requete, verifier 3 choses:
1. Routing: quel chemin a ete pris.
2. Execution: quelle action Spotify a ete executee.
3. Reponse: quel resultat verbal est renvoye.

## Chemins de routing musique

- explicit_contract
  - Condition: `domain=spotify` + `action` dans la payload `/v1/ingest`.
  - Comportement: execute directement l'action Spotify, sans routeur HA.

- router_direct
  - Condition: routeur semantique/agent cible Spotify avec une action directe exploitable.
  - Exemple: `spotify.transfer` avec `slots.device` fourni.
  - Comportement: execute directement l'action routee.

- music_planner
  - Condition: cible Spotify sans action exploitable complete.
  - Exemple: `search_and_play` sans query explicite.
  - Comportement: passe par le planner musique, puis execute l'action resolue.

## Contrat de reponse musique

En plus de `responseText`, la reponse musique expose:

- `status`: `success | need_clarification | error`
- `replyMeta.kind`: `spotify`
- `replyMeta.routeKey`: `spotify.<action_executee>`
- `replyMeta.fallbackReason`: `execution_error` si l'execution Spotify echoue
- `music.routing.path`: `explicit_contract | router_direct | music_planner`
- `music.routing.action`: action executee
- `music.execution.status`: statut final d'execution

## Cas metier cibles (input -> resultat attendu)

1. Input: payload explicite Spotify pause sans lecture active
- Routing attendu: `explicit_contract`
- Action attendue: `pause`
- Resultat verbal attendu: phrase indiquant qu'aucune lecture n'est active
- Statut attendu: `error`

2. Input: phrase de transfert vers un appareil avec route directe
- Routing attendu: `router_direct`
- Action attendue: `transfer`
- Resultat verbal attendu: confirmation de transfert
- Statut attendu: `success`

3. Input: phrase generique "mets de la musique" (sans query exploitable)
- Routing attendu: `music_planner`
- Action attendue: `play` (ou action resolue par planner)
- Resultat verbal attendu: confirmation de lecture
- Statut attendu: `success`

## Diagnostic metier

Si un test metier echoue:

- Cas 1: `music.routing.path` incorrect
  - Type de probleme: routing
  - Action: corriger routeur semantique / activation / direct request

- Cas 2: `music.routing.action` correcte mais `music.execution.status=error`
  - Type de probleme: execution
  - Action: corriger capability executor / API Spotify / slots

- Cas 3: action executee correcte mais reponse verbale incoherente
  - Type de probleme: formulation metier
  - Action: corriger `tts` de la capability concernee
