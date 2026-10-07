# Phase 3 — Données utilisateur, historique et isolation

Date : 2026-10-06.

## Décision de clôture

La phase 3 est clôturée pour le socle PC. Les données conversationnelles ne sont plus globales : chaque compte humain et chaque service technique nommé possède une partition distincte. Le chantier 4 peut construire le control plane administrateur sur ce modèle sans exposer le contenu privé des utilisateurs.

## Corrections de la revue finale

- Le backfill n'est plus limité au passage initial `pending → active` : il s'exécute aussi pour le propriétaire configuré qui était déjà actif avant la phase 3.
- Le foyer principal manquant d'un propriétaire historique est recréé de manière idempotente.
- Le backfill monolithique a été remplacé par des lots transactionnels de 250 threads, reprenables et audités séparément.
- L'ownership des services possède une migration v5 distincte ; elle met à niveau une vraie structure v4 et ne reconstruit les index que si leur définition diffère.
- Les triggers v5 refusent les doubles owners et les différences d'owner entre un thread, ses mutations et ses jeux de résultats.
- La migration refuse les objets orphelins et les violations de clés étrangères au lieu de poursuivre avec une isolation ambiguë.
- La restauration accepte de nouveau les sauvegardes pré-identité, puis laisse le runtime courant les migrer vers la v5.

## Modèle persistant

Les migrations SQLite v4 et v5 restent additives. La v4 introduit `owner_user_id` et le modèle de partage ; la v5 ajoute `owner_service_id`, répare les index v4 si nécessaire et installe les invariants SQL empêchant un double owner ou un owner différent entre un thread et ses objets enfants. Les messages héritent de l'owner de leur thread et sont lus avec une jointure autorisée sur ce thread.

Les tables suivantes préparent les ressources partagées et leur administration :

- `households` et `household_memberships` pour le foyer principal et ses membres ;
- `integration_connections` pour l'état, le provider, les scopes et une référence de credential, sans token en clair ;
- `resource_grants` pour attribuer une ressource à un utilisateur ou à un foyer ;
- `audit_events` pour un journal append-only protégé contre les mises à jour et suppressions SQL.

Le propriétaire OIDC configuré crée ou répare un foyer principal déterministe à chaque authentification. Qu'il soit nouvellement créé ou déjà actif avant la phase 3, il récupère les threads historiques encore sans owner, ainsi que leurs propositions et jeux de résultats. Le backfill avance par transactions de 250 threads, reprend après interruption et écrit un événement append-only pour chaque lot. Les nouveaux enregistrements legacy ou sans authentification restent dans une partition séparée et ne deviennent jamais visibles à un utilisateur.

## Frontières d'isolation

L'identité validée est propagée pendant toute la requête avec un contexte asynchrone. Les dépôts appliquent ensuite le filtre d'owner aux listes, lectures, créations, mises à jour et suppressions. Un identifiant exact appartenant à un autre principal se comporte comme une ressource absente.

Les contrôles couvrent :

- les listes de conversations, l'historique, les résumés, les titres et la suppression ;
- les messages et les fenêtres de conversation actives ;
- les propositions de mutation, leur confirmation, leur annulation et leur exécution ;
- les jeux de résultats et les références conversationnelles ;
- les profils, favoris et préférences Culture, dont l'identifiant provient désormais du principal serveur ;
- les services nommés, isolés entre eux par `owner_service_id`.

Le nettoyage de rétention global est une opération de maintenance explicite. Les expirations déclenchées par une requête restent limitées à la partition courante.

## Migration et récupération

Les v4 et v5 tolèrent volontairement des colonnes d'owner nulles pour la partition de compatibilité. Le passage futur à des contraintes obligatoires aura lieu après activation réelle d'OIDC, vérification des comptes et extinction des clés legacy. La v5 refuse de démarrer si elle détecte un enfant avec un owner différent de son thread, un double owner ou une violation de clé étrangère.

Avant activation sur une base PC existante :

1. créer une sauvegarde avec `npm run db:conversation -- backup --source <base> --destination <sauvegarde>` ;
2. démarrer le runtime v5 puis connecter le subject propriétaire configuré ;
3. exécuter `npm run db:conversation -- verify --source <base>` ;
4. vérifier que `unownedThreadCount` correspond uniquement aux flux legacy attendus et que `foreign_key_check` reste vide ;
5. conserver la sauvegarde pré-v4 jusqu'à validation fonctionnelle.

Le rollback binaire vers un runtime v3 n'est pas supporté car ce runtime refuse une base plus récente. Le retour arrière consiste à arrêter le runtime, restaurer la sauvegarde pré-v4 vers un nouveau chemin, puis redémarrer l'ancienne version sur cette copie. L'outil accepte également une sauvegarde pré-identité afin que le runtime courant puisse la migrer vers la v5. Les écritures faites après migration doivent sinon être conservées par un roll-forward.

## Validation

La validation couvre les deux sens d'une tentative d'accès horizontal, les identifiants devinés, les services techniques nommés, la partition legacy, le backfill propriétaire, les profils Culture, l'audit append-only et la sauvegarde-restauration.

| Surface | Résultat |
| --- | --- |
| Migrations v4 et v5 | additives, idempotentes, checksums, invariants et upgrade v4 réel contrôlés |
| Utilisateur A vers utilisateur B | threads, messages, propositions et résultats invisibles |
| Service A vers service B | partitions techniques distinctes |
| Profil Culture | identité humaine ou service dérivée côté serveur |
| Sauvegarde et restauration | comptes, ownership, audit et clés étrangères vérifiés |
| Validation Jarvis | `npm run verify` vert : 59 suites, 527 tests et 13 capacités |
| Audit dépendances | `npm audit --audit-level high` vert : 0 vulnérabilité |

## Limites avant exposition publique

- Le realm OIDC réel et le subject propriétaire doivent encore être activés sur le PC de déploiement.
- Les colonnes d'owner restent nullables pour la compatibilité locale ; les clés legacy doivent être désactivées avant l'edge public.
- Les APIs d'administration des foyers, memberships, grants, intégrations et événements d'audit appartiennent au chantier 4.
- Le port Android n'est pas inclus dans cette clôture PC.
- Jest force encore la sortie après les suites vertes à cause de handles asynchrones historiques ; cette dette d'outillage reste à traiter avant les tests d'endurance.
