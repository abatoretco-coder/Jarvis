# Phase 6 — Intégrations personnelles et partagées

Statut : **clôturée pour le socle PC après revue corrective** le 2026-10-06.

## Périmètre livré

- Registre serveur des fournisseurs et scopes nécessaires.
- OAuth complet pour Google Calendar, Gmail, Microsoft To Do et Spotify : démarrage authentifié, navigateur système, callback commun, `state` à usage unique, expiration dix minutes et PKCE S256.
- Refresh tokens chiffrés par AES-256-GCM avec AAD, clé hors base et version de clé. Les rotations Gmail, Microsoft et Spotify sont ré-enregistrées dans le coffre.
- Connexions `personal` et `household_shared`. Une connexion partagée exige un nom, un foyer administré par le créateur et un grant explicite.
- Sélection du credential depuis le principal OIDC actif. Une requête humaine ne retombe jamais sur les refresh tokens ou stores globaux historiques.
- Sélection d’une connexion partagée uniquement avec un `integrationConnectionId` fourni par le client et autorisé par le dépôt ; sans identifiant, seule la connexion personnelle est éligible.
- Cache proactif global mail, tâches et Spotify neutralisé pour les requêtes humaines authentifiées.
- Renouvellement non destructif : le credential actif reste utilisable jusqu’à l’activation du nouveau token, y compris après un refus de consentement.
- Desktop : connexion personnelle, création partagée avec foyer et libellé, états, diagnostic, renouvellement et révocation via une boîte de dialogue accessible.
- Panel administrateur limité aux métadonnées ; aucun secret n’est exposé.

## Fournisseurs

| Fournisseur | OAuth personnel | Utilisation runtime |
|---|---:|---:|
| Google Calendar | oui | API, Dashboard et conversation |
| Gmail | oui | agent mail |
| Microsoft To Do | oui | agent tâches |
| Spotify | oui | planification et exécution musicale |

Un fournisseur est affiché comme connectable uniquement si son client système et le coffre sont configurés.

## Sécurité et données

- La base stocke seulement ciphertext, IV, tag GCM et version de clé.
- `OAUTH_TOKEN_ENCRYPTION_KEY` contient exactement 32 octets encodés en base64 et reste hors Git et hors sauvegarde SQLite.
- Les query strings OAuth sont retirées des logs de requête.
- Le callback revérifie le compte actif et la permission avant l’échange du code.
- Un compte suspendu ne peut ni déchiffrer ni utiliser son token.
- La révocation supprime le secret local dans la transaction. Google reçoit aussi une demande de révocation distante ; Microsoft et Spotify nécessitent le retrait global depuis le compte fournisseur lorsqu’il est souhaité.
- Les sauvegardes v7 vérifient tables et colonnes ; les credentials restent chiffrés.

## Configuration PC

Variables principales :

- `OAUTH_TOKEN_ENCRYPTION_KEY`
- `OAUTH_TOKEN_KEY_VERSION=1`
- `INTEGRATION_OAUTH_REDIRECT_URI`
- clients/secrets système Google, Microsoft et Spotify

Le callback générique recommandé est `/v1/integrations/oauth/callback`. HTTP est accepté uniquement sur loopback en développement ; le déploiement doit utiliser HTTPS et enregistrer exactement la même URI chez chaque fournisseur.

## Validation

- Backend : lint, build, typecheck tests, 62 suites Jest / 550 tests et registre de 13 capacités.
- Desktop : build Vite/TypeScript et 22 fichiers Vitest / 91 tests.
- Cas dédiés : altération du coffre, anti-rejeu, PKCE pour les trois familles OAuth, deux utilisateurs/deux agendas, suspension, foyer `home:*`, partage explicite, renouvellement non destructif et absence de fallback global.

## Conditions restantes avant ouverture publique

- Exécuter un consentement réel par fournisseur avec les credentials de staging.
- Finaliser les listes de test, vérifications d’application et politiques de publication propres à Google, Microsoft et Spotify.
- Le warning Vite sur le chunk principal supérieur à 500 kB est non bloquant pour cette phase et reste à suivre dans le chantier performance UI.
