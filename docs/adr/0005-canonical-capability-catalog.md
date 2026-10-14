# ADR 0005 — Catalogue canonique des capacités conversationnelles

## Statut

Accepté — 14 octobre 2026.

## Contexte

Jarvis maintenait plusieurs inventaires indépendants : routes sémantiques,
registre des effets et confirmations, `HA_AGENT_MAP`, fast paths et capacités
publiques. Une capacité pouvait donc être exécutable sans être proposée au
routeur. Google Calendar a révélé cette dérive : le chemin direct fonctionnait,
mais le routeur LLM ne recevait aucun agent Calendar.

## Décision

`SEMANTIC_ROUTES` est l’inventaire canonique des capacités conversationnelles
routables. `CAPABILITY_REGISTRY` en est une projection calculée ; il ne maintient
plus sa propre liste de routes. Les capacités directes non sémantiques, comme
`nas.status`, sont ajoutées explicitement avec `semanticLevel: none`.

Chaque famille de capacité déclare ensuite une stratégie d’exposition dans
`ROUTER_EXPOSURE_BY_AGENT` :

- `orchestrator` : agent proposé au routeur lorsque ses dépendances et permissions sont disponibles ;
- `runtime_special` : entrée construite à partir d’un état runtime spécialisé ;
- `pre_router` : capacité volontairement traitée avant le routeur.

La disponibilité OAuth, les feature flags et les permissions restent une
projection runtime. Ils ne modifient jamais l’existence statique d’une capacité.
`HA_AGENT_MAP` reste autorisé pour les agents Home Assistant externes ou legacy,
mais ne peut ni activer ni masquer un agent direct canonique.

## Automatisation

`npm run check:capabilities` échoue si :

- une route sémantique n’a pas exactement une projection métier ;
- action ou politique planner divergent ;
- une route à risque est classée en lecture seule ;
- une famille n’a pas de stratégie d’exposition ;
- la matrice Spotify référence une route absente.

Le workflow GitHub `Capability architecture` exécute ce contrôle, le build et
les tests de contrat sur chaque pull request ou push touchant au routage.

## Mise en production

Avant tout déploiement, exécuter `npm run check:capabilities`, le lint, le build,
le typecheck des tests et la suite Jest complète. Après redémarrage, contrôler
`/ready` puis valider au minimum une lecture d'agenda et une continuation
contextuelle. Une capacité ne doit jamais être ajoutée directement au prompt du
routeur : elle doit partir de `SEMANTIC_ROUTES`, déclarer sa stratégie
d'exposition et satisfaire le contrôle d'architecture.

En cas de régression, revenir au commit applicatif précédent sans restaurer la
base tant qu'aucune migration incompatible n'a été appliquée. Le catalogue est
construit au démarrage ; un rollback du runtime restaure donc aussi l'ancien
ensemble de capacités exposées.

## Conséquences

Ajouter une capacité exige désormais une modification du catalogue canonique et
une stratégie d’exposition explicite. Les projections et la CI empêchent les
inventaires secondaires de dériver silencieusement. Les capacités dynamiques des
appareils Home Assistant restent sous la responsabilité de `HomeCatalog` ; ce
catalogue décrit leur famille conversationnelle, pas chaque appareil du foyer.
