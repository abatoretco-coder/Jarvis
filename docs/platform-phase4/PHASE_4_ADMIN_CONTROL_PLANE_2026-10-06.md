# Phase 4 — Control plane administrateur côté API

Date : 2026-10-06.

## Décision de clôture

La phase 4 est clôturée pour le socle PC. Jarvis expose désormais un control plane administrateur authentifié pour les comptes, les foyers, les droits fins, les intégrations, l'audit et les vues opérationnelles. Ces contrats permettent de commencer le panel Desktop sans accès direct à SQLite, Home Assistant, Docker ou au système hôte.

## Contrats disponibles

| Domaine        | Endpoints                                                                            | Garanties principales                                                                      |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Utilisateurs   | `GET /v1/admin/users`, `GET /v1/admin/users/:userId`, approbation, rôles et statut   | détail sans contenu privé, refus/suspension/réactivation, protection du dernier owner      |
| Foyers         | liste des foyers et membres, mise à jour d'un membership                             | rôle et statut contrôlés, dernier owner du foyer protégé                                   |
| Permissions    | catalogue RBAC et CRUD de `resource_grants`                                          | domaine, zone, appareil, capacité, caméra, serrure ou opération NAS                        |
| Intégrations   | liste et révocation                                                                  | scopes, état, synchronisation et code d'erreur ; aucune référence de credential en réponse |
| Services et IA | état de configuration, modèles, latence, erreurs, tokens et budgets                  | aucune clé, URL secrète ou contenu utilisateur                                             |
| Domotique      | inventaire Home Assistant, zones déduites, entités non mappées et grants applicables | attributs réduits à l'état administratif utile                                             |
| Audit          | recherche filtrée et pagination opaque                                               | acteur, cible, résultat, corrélation, IP et référence client                               |
| Opérations     | catalogue fini                                                                       | seules les opérations effectivement disponibles sont annoncées comme telles                |

## Sécurité et cohérence

Chaque route `/v1/admin/*` requiert un principal humain actif possédant le rôle `admin` ou `owner`. Une clé de service, même historiquement non bornée, ne peut pas ouvrir le control plane. Le hook global continue d'appliquer la permission `admin`, puis la route impose le principal humain.

Les mutations exigent un header `Idempotency-Key` de 8 à 128 caractères. Le couple acteur/clé, l'empreinte de la requête et la réponse sont persistés pendant une fenêtre opérationnelle de 24 heures. Un rejeu identique renvoie la réponse initiale avec `Idempotent-Replay: true` ; la réutilisation de la clé avec un autre objet échoue en `409`.

La mutation métier, l'événement d'audit de succès et l'enregistrement d'idempotence partagent une transaction SQLite. Une erreur annule l'état métier puis écrit un événement `failed` distinct. Les refus de confirmation renforcée sont également audités. Les événements restent append-only.

Une confirmation explicite est requise pour :

- attribuer ou retirer un rôle global `admin` ou `owner` ;
- attribuer, modifier ou retirer un membership privilégié dans un foyer ;
- révoquer définitivement un compte ;
- créer ou révoquer un droit sur une caméra, une serrure ou une opération NAS ;
- révoquer une connexion d'intégration.

Seul un owner peut confirmer les changements de rôle privilégié et les droits domotiques sensibles. Une révocation d'intégration efface la référence de credential dans la même transaction et ne la renvoie jamais.

## Migration v6

La migration SQLite v6 est additive. Elle ajoute les métadonnées de synchronisation et révocation aux intégrations, la révocation logique des grants, des index d'administration et `admin_idempotency_keys`. Les checksums du ledger sont vérifiés et les migrations restent idempotentes.

Avant activation sur une base PC existante :

1. créer une sauvegarde vérifiée avec `npm run db:conversation -- backup` ;
2. démarrer le runtime v6 une première fois hors trafic ;
3. vérifier `schema_migrations`, `PRAGMA foreign_key_check` et l'accès owner ;
4. exécuter un parcours approbation, suspension/réactivation et grant non sensible ;
5. conserver la sauvegarde pré-v6 jusqu'à validation du panel Desktop.

Un runtime v5 refuse volontairement une base v6. Le rollback binaire passe donc par la restauration de la sauvegarde pré-v6 sur un nouveau chemin. Les écritures postérieures doivent sinon être conservées par roll-forward.

## Revue finale

La revue adversariale initiale a corrigé quatre risques avant clôture :

- une pagination fondée uniquement sur la milliseconde pouvait sauter des événements ; le curseur combine maintenant date et identifiant ;
- un administrateur pouvait modifier un membership owner existant sans que le nouveau rôle soit owner ; le rôle actuel participe désormais au contrôle renforcé ;
- la révocation d'un grant caméra ou serrure ne vérifiait pas initialement la sensibilité de la ressource ; elle exige maintenant owner et confirmation ;
- l'inventaire Home Assistant ne reliait pas les droits configurés ; il expose désormais uniquement les identifiants des grants actifs applicables.

La revue de contrôle finale a ensuite fermé les points suivants :

- un test passe désormais par `buildApp` et prouve que toutes les surfaces sont réellement enregistrées lorsque l'OIDC est actif, absentes lorsqu'il est désactivé et adossées à une base migrée en v6 ;
- les refus d'accès d'un résident ou d'un principal de service sont audités sans enregistrer leurs credentials ;
- la révocation globale d'un compte révoque atomiquement sessions, memberships, grants et connexions, tout en protégeant le dernier owner d'un foyer ;
- les permissions de grants sont validées selon le type de ressource et une expiration passée est refusée ;
- l'inventaire Home Assistant n'expose plus la valeur brute des states et l'audit masque défensivement les clés sensibles historiques ;
- la vérification de sauvegarde v6 exige les tables et colonnes du control plane et compte les intégrations, grants et clés d'idempotence ;
- le contrat HTTP consommable par Desktop est figé dans `ADMIN_API_CONTRACT.md` ;
- une instabilité Culture détectée par la suite complète a été corrigée : les raffinements réutilisent maintenant la fenêtre temporelle déjà validée au lieu de la décaler de quelques millisecondes.

## Validation

| Vérification           | Résultat                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Câblage serveur        | toutes les routes contrôlées via `buildApp`, activation OIDC et migration v6 comprises               |
| Matrice allowed/denied | surfaces testées avec owner, admin, resident et principal de service                                 |
| Mutations              | approbation, rôles, suspension, réactivation, memberships, grants et révocation d'intégration testés |
| Validation négative    | principal technique, identifiants, objets, confirmations, curseurs et conflits d'idempotence testés  |
| Confidentialité        | credential references, states Home Assistant bruts, métadonnées sensibles et clé OpenAI non exposés  |
| Migration              | upgrade v5 → v6, ledger, colonnes, sauvegarde et restauration contrôlés                              |
| Validation Jarvis      | `npm run verify` vert : 61 suites, 546 tests et 13 capacités                                         |
| Audit dépendances      | `npm audit --audit-level=high` vert : 0 vulnérabilité                                                |

## Limites transférées aux phases suivantes

- Le panel visuel Desktop appartient à la phase 5 ; la phase 4 stabilise ses contrats backend.
- La création et le renouvellement OAuth des intégrations personnelles appartiennent à la phase 6 ; le control plane n'expose ici que leurs métadonnées et leur révocation.
- Les `resource_grants` sont configurables, auditables et visibles dans l'inventaire. Leur application au niveau de chaque action domotique déterministe sera branchée avec le modèle de logement de la phase 7.
- Les zones Home Assistant sont déduites des métadonnées disponibles dans les states REST ; les entités sans `area_id` restent explicitement non mappées jusqu'à la phase 7.
- Aucune opération destructive NAS n'est exécutable. Le catalogue la déclare indisponible tant que la réauthentification et l'implémentation bornée ne sont pas livrées.
- L'activation du realm OIDC réel reste un geste privé de déploiement PC. Jest signale encore des handles asynchrones historiques après les suites vertes.
