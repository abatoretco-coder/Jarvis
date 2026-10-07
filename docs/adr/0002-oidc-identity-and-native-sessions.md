# ADR 0002 — Identité OIDC et sessions natives

- Statut : accepté
- Date : 2026-10-06

## Décision

Keycloak est retenu comme fournisseur OIDC auto-hébergé. Jarvis reste la source d'autorité pour les statuts `pending`, `active`, `suspended`, `rejected`, `revoked`, les rôles et les permissions métier.

Desktop et Android seront des clients publics distincts utilisant Authorization Code + PKCE S256 dans le navigateur système. Aucun secret client ne sera embarqué. Les redirect URIs seront enregistrées exactement et séparément :

- Desktop : `com.jarvis.desktop:/oauth/callback`
- Android : `com.jarvisremote.app:/oauth/callback`

Chaque requête protégée utilisera un access token court. Le serveur vérifiera signature, issuer, audience, expiration et subject, puis relira le statut et les droits Jarvis. Les refresh tokens seront conservés dans un stockage natif chiffré : Stronghold côté Tauri, mécanisme adossé à Android Keystore côté Android.

Les clés API resteront réservées aux principaux de service et au développement local borné. Elles ne représenteront pas des sessions utilisateur et n'ouvriront pas l'edge public.

## Spike validé

- Desktop : génération PKCE S256 conforme au vecteur RFC 7636, requête sans secret client, validation exacte du callback et du `state`.
- Android : la politique HTTPS/PKCE est testée sans ajouter de bibliothèque OAuth au binaire. Le choix du composant Android sera fait au chantier 2 avec un HTTPS App Link vérifié et une revue de maintenance/sécurité.
- L'intégration Tauri utilisera `deep-link` avec `single-instance`; le callback sera traité comme une entrée non fiable.

Références : [Keycloak Server Administration Guide](https://www.keycloak.org/docs/26.8.0/server_admin/), [OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252), [Tauri deep linking](https://v2.tauri.app/es/plugin/deep-linking/), [Tauri Stronghold](https://v2.tauri.app/fr/plugin/stronghold/).

## Conséquences

- Une première authentification crée un profil Jarvis `pending`; elle ne donne aucun accès métier.
- La suspension ou révocation côté Jarvis prend effet sans redistribuer les secrets système.
- Une éventuelle interface web devra conserver le modèle de session par jetons.
- Le code du spike n'échange pas encore de jeton : l'intégration complète appartient au chantier 2.
- Le callback Android en schéma privé est réservé au développement; la cible publique est un HTTPS App Link vérifié dès que le domaine définitif existe.
