# Matrice des contrats API Jarvis

Date de l'audit : 2026-10-15.

Cette matrice rapproche les routes réellement enregistrées par Jarvis des
consommateurs Desktop, Android et Home Assistant. Les familles non consommées
par un client restent des API serveur valides ; l'absence de consommateur n'est
donc pas une preuve de code mort.

## Matrice par famille

| Contrat Jarvis exposé                                                   | Desktop                        | Android                        | Home Assistant                        | Tests / documentation                                                            |
| ----------------------------------------------------------------------- | ------------------------------ | ------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /health`, `/live`, `/ready`                                        | santé                          | santé                          | healthchecks Docker                   | `health.test.ts`, documentation de déploiement                                   |
| `POST /v1/ingest`, `GET/DELETE /v1/threads/**`                          | conversation SSE et historique | conversation SSE et historique | broker vocal via `/v1/ingest`         | `ingest*.test.ts`, tests voix clients, `INTERCONNECTIVITY_AUDIT.md`              |
| `POST /v1/stt/:engineId`, `POST /v1/tts[/…]`                            | voix                           | voix                           | compte technique autorisé sur STT/TTS | `ingest.integration.test.ts`, tests audio clients                                |
| `GET /v1/mutation-results/:idempotencyKey`                              | récupération après coupure     | récupération après coupure     | —                                     | `mutationIdempotency.test.ts`, tests repository Android                          |
| `GET /v1/home`, `GET /v1/home/configuration`                            | maison et aménagement          | maison et aménagement          | —                                     | `homeRoutes.test.ts`, tests `homeApi`/repository                                 |
| `POST /v1/home/actions`                                                 | oui                            | oui                            | —                                     | tests routes, exécuteur et clients                                               |
| Création, exécution et suppression `/v1/home/quick-actions/**`          | oui                            | oui                            | —                                     | `homeRoutes.test.ts`, contrats Android                                           |
| CRUD `/v1/home/scenes/**`, `POST …/run`                                 | oui                            | oui                            | scènes compilées côté serveur         | `homeRoutes.test.ts`, `homeActionVerification.test.ts`, tests Desktop            |
| CRUD `/v1/home/automations/**`, `PATCH …/state`, `POST …/run`           | oui                            | oui                            | autorité et stockage réels            | `homeRoutes.test.ts`, `homeAssistantAutomationService.test.ts`, contrats Android |
| `POST /v1/home/routines`                                                | aucun                          | aucun                          | —                                     | **retiré : HTTP 410**, test contractuel serveur                                  |
| `DELETE /v1/home/routines/:routineId`                                   | non exposé                     | migration uniquement           | —                                     | test route/repository ; à conserver jusqu'à migration des données                |
| `/v1/home/lighting/**`, `/v1/home/heating-plan`                         | oui                            | oui                            | exécution indirecte                   | tests routes et clients                                                          |
| `/v1/home/devices/:deviceId/robot/**`                                   | oui                            | oui                            | exécution indirecte                   | tests routes et clients                                                          |
| `/v1/music/**`                                                          | oui                            | oui                            | —                                     | tests musique serveur et clients                                                 |
| `/v1/daily-life/**`                                                     | oui                            | oui                            | —                                     | tests service/routes et ViewModels                                               |
| `/v1/dashboard`, `/v1/mail/**`, `/v1/todo/**`, `/v1/calendar/google/**` | oui                            | partiel via écrans dédiés      | —                                     | tests dashboard/hooks/routes                                                     |
| `/v1/integrations/**`, `/v1/auth/**`                                    | oui                            | session OIDC                   | —                                     | tests identité/intégrations                                                      |
| `/v1/admin/**`                                                          | administration                 | —                              | —                                     | tests admin et permissions                                                       |
| `/v1/culture/**`                                                        | préférences                    | —                              | évaluation et accusé proactifs        | tests culture, `verify-culture-proactive-package.ps1`                            |
| `/v1/news/**`, `/v1/nas/status`, `/v1/ha/index`                         | oui                            | —                              | —                                     | tests hooks/routes                                                               |
| `/v1/pc-agent/**`                                                       | agent local                    | —                              | —                                     | tests agent et permissions machine                                               |

## Contrat détaillé des automatisations

| Opération         | Route                                  | Lecture résident | Mutation propriétaire | Invité | Android / Desktop                    |
| ----------------- | -------------------------------------- | ---------------- | --------------------- | ------ | ------------------------------------ |
| Lister            | `GET /v1/home/automations`             | oui              | oui                   | non    | oui / oui                            |
| Créer             | `POST /v1/home/automations`            | non              | oui                   | non    | oui / oui                            |
| Modifier          | `PUT /v1/home/automations/:id`         | non              | oui                   | non    | oui / oui                            |
| Activer/suspendre | `PATCH /v1/home/automations/:id/state` | non              | oui                   | non    | oui / oui                            |
| Exécuter          | `POST /v1/home/automations/:id/run`    | non              | oui                   | non    | non exposé dans l'écran / disponible |
| Supprimer         | `DELETE /v1/home/automations/:id`      | non              | oui                   | non    | oui / oui                            |

## Résultats confirmés

1. Android appelait encore `POST /v1/home/routines`, alors que Jarvis répond 410.
   Le parcours utilise désormais le CRUD Home Assistant ci-dessus, en réel
   comme en mode DEMO.
2. Une scène pouvait contenir deux actions opposées pour le même équipement et
   les lancer en concurrence. La création, l'exécution et la compilation Home
   Assistant rejettent désormais `home_scene_device_conflict`. Les équipements
   indépendants restent parallélisés.
3. Le widget rapide Desktop ignorait le résultat métier d'une scène. Il partage
   désormais l'interprétation de `HomeView` pour `confirmed`, `accepted`,
   `partial`, `uncertain` et `failed`, puis actualise l'état sans rejouer une
   mutation après une perte réseau.
4. La documentation Home Assistant décrivait Android comme client direct de
   Home Assistant. Le flux réel et documenté passe par Jarvis afin de ne jamais
   exposer le jeton Home Assistant au téléphone.

## Code mort prouvé et supprimé

- `HomeCatalog.upsertRoutine` et son type d'entrée : aucun appel après le retrait
  de la route de création, y compris dans les usages dynamiques recherchés.
- styles Desktop `.home-automation-item--routine` et `.home-routine-state` :
  aucun rendu ne les référence plus.
- DTO, méthode Retrofit, use case et dialogue Android dédiés à la création de
  routines : aucun appel restant ; le modèle de lecture/suppression legacy est
  volontairement conservé.

## Éléments suspects, non supprimés

- Les structures `HomeRoutine` restent dans le catalogue et les clients tant
  que des données historiques peuvent exister. Leur suppression nécessitera
  une preuve de migration complète des installations.
- Certaines routes serveur d'administration, de culture ou d'agent PC n'ont
  qu'un consommateur spécialisé. Elles ne sont pas mortes pour autant et n'ont
  pas été modifiées.
- Les documents de phase datés restent des archives ; ils sont marqués comme
  historiques plutôt que réécrits rétroactivement.
