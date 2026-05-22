# Music Routing Decision Matrix

## Review Status

- [ ] Reviewed with user: regles de decision
- [ ] Reviewed with user: matrix par action
- [ ] Reviewed with user: verification automatique

Cette matrice est la reference metier pour la musique.

## Regles de decision

1. Si payload contient domain=spotify + action valide
- Decision: execution directe
- Routing path: explicit_contract
- Routing level: hors semantic (contract API)

2. Si routeur renvoie une action Spotify directe exploitable (pause/play/next/previous/now_playing/list_devices/clear_queue)
- Decision: execution directe
- Routing path: router_direct
- Routing level: E2

3. Si routeur cible Spotify mais l action necessite interpretation (search/search_and_play/queue_add/transfer/add_to_playlist/volume_set)
- Decision: passer par planner
- Routing path: music_planner
- Routing level: E1

4. Si action non semantique (like_track)
- Decision: explicite ou planner
- Routing path: explicit_contract ou music_planner
- Routing level: none

## Matrix par action

| action | semantic_level | semantic_route | planner_required | explicit_contract | router_direct | music_planner |
|---|---|---|---:|---:|---:|---:|
| pause | E2 | spotify.pause | no | yes | yes | no |
| play | E2 | spotify.play | no | yes | yes | no |
| next | E2 | spotify.next | no | yes | yes | no |
| previous | E2 | spotify.previous | no | yes | yes | no |
| now_playing | E2 | spotify.now_playing | no | yes | yes | no |
| list_devices | E2 | spotify.list_devices | no | yes | yes | no |
| clear_queue | E2 | spotify.clear_queue | no | yes | yes | no |
| search | E1 | spotify.search | yes | yes | no | yes |
| search_and_play | E1 | spotify.search_and_play | yes | yes | no | yes |
| queue_add | E1 | spotify.queue_add | yes | yes | no | yes |
| transfer | E1 | spotify.transfer | yes | yes | no | yes |
| add_to_playlist | E1 | spotify.add_to_playlist | yes | yes | no | yes |
| volume_set | E1 | spotify.volume_set | yes | yes | no | yes |
| like_track | none | - | no | yes | no | yes |

## Verification automatique

Commande:

npm run verify:music-routing

Sorties generees:
- artifacts/music-routing-jest-results.json
- artifacts/music-routing-verification-report.json
- artifacts/music-routing-verification-report.md

Le script lance build + tests metier + tests de coherence de la matrice, puis produit un rapport horodate.
