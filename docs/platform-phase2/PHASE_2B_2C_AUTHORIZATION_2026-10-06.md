# Phase 2B–2C — OIDC, sessions et autorisation

## Statut

Phase terminée et testée sur le socle PC. Jarvis accepte désormais deux catégories de principal clairement séparées :

- utilisateurs humains authentifiés par Keycloak/OIDC ;
- services techniques nommés, dotés de clés distinctes et de permissions bornées.

L'activation réelle reste opt-in (`OIDC_ENABLED=false` par défaut) jusqu'à la configuration du realm Keycloak et du premier propriétaire.

## Chaîne de confiance

1. Le client natif effectue Authorization Code + PKCE S256 sans secret embarqué.
2. Le serveur vérifie la signature avec le JWKS configuré, puis `iss`, `aud`, `exp`, `iat`, `sub`, `email_verified` et `sid`.
3. Le couple issuer/subject provisionne ou retrouve l'utilisateur local.
4. Le `sid` est lié à une session Jarvis révocable ; aucun jeton OIDC n'est persisté.
5. Le statut, le rôle et les permissions sont relus dans SQLite avant chaque requête protégée.

Une identité valide mais `pending`, suspendue, rejetée ou révoquée ne reçoit aucun accès métier. La route `/v1/auth/me` reste disponible au compte `pending` afin que le client puisse afficher son état.

## Politique initiale

- `owner` : toutes les permissions, y compris `nas.operations` ;
- `admin` : administration fonctionnelle, sans opération NAS ;
- `resident` : chat, historique, mail, calendrier, tâches, musique et maison ;
- `guest` : chat, musique et maison.

Le dernier propriétaire actif ne peut être rétrogradé, suspendu ou révoqué. Seul un propriétaire peut créer ou modifier un autre rôle `owner`.

## API ajoutée

- `GET /v1/auth/me`
- `GET /v1/auth/sessions`
- `POST /v1/auth/logout`
- `DELETE /v1/auth/sessions/:sessionId`
- `GET /v1/admin/users`
- `POST /v1/admin/users/:userId/approve`
- `PUT /v1/admin/users/:userId/roles`
- `PATCH /v1/admin/users/:userId/status`

Les réponses ne contiennent ni access token, ni refresh token, ni clé technique.

## Configuration

Variables principales :

- `OIDC_ENABLED`
- `OIDC_ISSUER_URL`
- `OIDC_AUDIENCE`
- `OIDC_JWKS_URL` (facultatif pour Keycloak)
- `OIDC_ALLOWED_ALGORITHMS`
- `OIDC_BOOTSTRAP_OWNER_SUBJECT`
- `SERVICE_API_KEYS_JSON`

HTTP n'est autorisé que sur loopback pour le développement. La production exige HTTPS. Les limites de débit sont séparées pour authentification, IA, audio et opérations sensibles.

## Client Desktop

Le Desktop génère une transaction PKCE aléatoire, valide la discovery, ouvre le navigateur système et reçoit le callback `com.jarvis.desktop:/oauth/callback` par le plugin deep-link et l'instance unique Tauri. L'access token reste uniquement en mémoire. Le refresh token est stocké dans Stronghold ; le secret du coffre, généré aléatoirement, reste dans le trousseau natif du système et n'est ni codé en dur ni placé dans `localStorage`.

Au démarrage, le Desktop tente un renouvellement silencieux, relit `/v1/auth/me`, programme le prochain renouvellement et expose les états `signed_out`, `authenticating`, `pending`, `active`, `unavailable` et `error`. L'écran Connexion permet de configurer l'issuer et l'identifiant du client public, de se connecter et de se déconnecter. La clé API historique est explicitement présentée comme une option technique de développement.

Android reste hors du périmètre PC demandé. Son port natif réutilisera le même contrat OIDC avant toute distribution mobile.

## Autorisation conversationnelle

Les routes métier directes appliquent les permissions par domaine. `/v1/ingest` diffère désormais l'autorisation jusqu'à ce que la capacité soit connue, puis contrôle `chat`, `mail`, `calendar`, `todo`, `music`, `home` ou `nas.operations` avant exécution. Cela couvre les contrats explicites, fast paths, confirmations de mutations, routes sémantiques E1/E2, cibles du routeur et fallback Home Assistant. Une requête multi-cible est refusée en entier si une permission manque.

## Déploiement et retour arrière

La migration SQLite v3 est additive et ne modifie aucune conversation. Désactiver `OIDC_ENABLED` revient au mode de compatibilité par clés de service. Les attributions de rôles et sessions restent stockées afin de pouvoir réactiver OIDC sans perte.

Avant exposition publique : configurer Keycloak, mapper l'audience `jarvis-api`, vérifier la présence des claims requis, définir exactement le subject propriétaire, utiliser `SERVICE_API_KEYS_JSON`, définir `ALLOW_LEGACY_API_KEYS=false`, puis refuser les anciennes clés au niveau de l'edge.
