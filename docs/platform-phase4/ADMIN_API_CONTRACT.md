# Contrat API du control plane administrateur

Ce contrat est l'interface de référence du panel Jarvis Desktop pour la phase 5. Toutes les routes utilisent JSON, restent sous `/v1/admin` et exigent un access token OIDC appartenant à un utilisateur actif ayant le rôle `admin` ou `owner`. Une clé de service reçoit `403 human_admin_required`.

## Règles communes

Les mutations exigent `Idempotency-Key: <8 à 128 caractères ASCII sûrs>`. Un rejeu identique conserve le même résultat et ajoute `Idempotent-Replay: true`. La réutilisation de la clé avec une requête différente renvoie `409 idempotency_conflict`. Les enregistrements d'idempotence expirent après 24 heures.

Les réponses utilisent `Cache-Control: no-store`. Elles ne contiennent jamais de token, de référence de credential, de secret fournisseur ni d'attribut Home Assistant arbitraire.

Les confirmations explicites sont :

- `confirm_privileged_change` pour les rôles `admin` et `owner`, les memberships privilégiés et la révocation globale d'un compte ;
- `confirm_sensitive_grant` pour les caméras, serrures et opérations NAS ;
- `confirm_integration_revoke` pour une connexion d'intégration.

Une confirmation sensible ne remplace pas le contrôle du rôle : les rôles privilégiés et les grants sensibles exigent également un acteur `owner`.

## Utilisateurs

| Méthode et route              | Corps                               | Résultat                                                     |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `GET /users`                  | —                                   | `{ users: User[] }`                                          |
| `GET /users/:userId`          | —                                   | `User` avec dates, nombre de sessions actives et memberships |
| `POST /users/:userId/approve` | `{ role, confirmation? }`           | utilisateur actif avec son rôle initial                      |
| `PUT /users/:userId/roles`    | `{ roles, confirmation? }`          | utilisateur avec ses rôles remplacés                         |
| `PATCH /users/:userId/status` | `{ expected, next, confirmation? }` | utilisateur après transition compare-and-set                 |

Les statuts sont `pending`, `active`, `suspended`, `rejected` et `revoked`. L'approbation `pending → active` passe uniquement par `/approve`, car elle exige un rôle. Les transitions usuelles du endpoint de statut sont `pending → rejected`, `active → suspended`, `suspended → active` et `active|suspended → revoked`.

La révocation globale invalide les sessions et révoque dans la même transaction les memberships, grants et connexions d'intégration appartenant à l'utilisateur. Elle échoue avec `409 last_owner` ou `409 last_household_owner` si elle supprimerait le dernier propriétaire actif.

## Foyers et memberships

| Méthode et route                               | Corps                             | Résultat                           |
| ---------------------------------------------- | --------------------------------- | ---------------------------------- |
| `GET /households`                              | —                                 | foyers et nombre de membres actifs |
| `GET /households/:householdId/members`         | —                                 | membres, rôle et statut            |
| `PUT /households/:householdId/members/:userId` | `{ role, status, confirmation? }` | membership créé ou remplacé        |

Un membership actif exige un utilisateur globalement actif. Le dernier owner actif d'un foyer ne peut pas être retiré ou rétrogradé.

## Grants

`GET /grants` renvoie les grants actifs, expirés et révoqués avec leurs dates. `POST /grants` accepte :

```json
{
  "resourceType": "device",
  "resourceId": "light.living_room",
  "granteeUserId": "uuid",
  "permissions": ["view", "control"],
  "expiresAtMs": 1791234567890
}
```

Un seul de `granteeUserId` ou `granteeHouseholdId` est autorisé. Les types sont `domain`, `area`, `device`, `capability`, `camera`, `lock` et `nas.operation`. Les permissions sont `view`, `control`, `manage` et, uniquement pour une caméra, `stream`. Une expiration doit être future.

`DELETE /grants/:grantId` effectue une révocation logique. Pour une ressource sensible, le corps doit contenir `{ "confirmation": "confirm_sensitive_grant" }`.

## Intégrations

`GET /integrations` renvoie l'owner, le foyer éventuel, le provider, les scopes, le statut, la dernière synchronisation, un code d'erreur borné et les dates. `POST /integrations/:connectionId/revoke` exige :

```json
{ "confirmation": "confirm_integration_revoke" }
```

La révocation locale passe la connexion à `revoked` et efface sa référence de credential. La révocation distante auprès du fournisseur sera implémentée avec les connecteurs OAuth de la phase 6.

## Supervision

| Méthode et route      | Contenu                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `GET /permissions`    | matrice RBAC et catalogue des grants                                      |
| `GET /services`       | version, configuration et état des dépendances sans secrets               |
| `GET /ai`             | provider, modèles, latence, erreurs, tokens et budgets agrégés            |
| `GET /home/inventory` | entités, domaine, nom, disponibilité, zone, mapping et grants applicables |
| `GET /operations`     | catalogue fini avec disponibilité et confirmation requise                 |

L'inventaire ne renvoie pas la valeur brute des états Home Assistant. Une absence de configuration ou une indisponibilité Home Assistant renvoie `503`.

## Audit

`GET /audit` accepte `limit` de 1 à 200, `cursor`, `afterMs`, `beforeMs`, `actorId`, `targetType`, `action` et `outcome`. `afterMs` doit être strictement antérieur à `beforeMs` lorsque les deux bornes sont fournies. Le curseur opaque doit être réutilisé sans modification. La réponse contient `events` et éventuellement `nextCursor`.

Chaque événement expose l'acteur, l'action, la cible, le résultat, la corrélation, la date et des métadonnées bornées. Les clés évoquant token, secret, mot de passe, cookie, credential, autorisation ou clé API sont remplacées par `[redacted]`.

## Erreurs stables

|  HTTP | Exemples                                                                                                        |
| ----: | --------------------------------------------------------------------------------------------------------------- |
| `400` | objet ou identifiant invalide, clé d'idempotence absente, confirmation absente, permission de grant incohérente |
| `401` | access token absent, invalide ou session révoquée                                                               |
| `403` | rôle insuffisant, principal technique, confirmation owner requise                                               |
| `404` | utilisateur, foyer, grant ou intégration absent                                                                 |
| `409` | conflit d'état, dernier owner, clé d'idempotence réutilisée différemment                                        |
| `429` | rate limit sensible atteint                                                                                     |
| `503` | dépendance opérationnelle indisponible                                                                          |
