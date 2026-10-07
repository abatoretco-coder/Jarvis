# Google OAuth multi-utilisateur

Jarvis conserve les identifiants d’application Google au niveau système, mais chaque consentement et chaque refresh token appartiennent à un utilisateur Jarvis précis.

## Configuration serveur

1. Créer un client OAuth Google de type **Web application**.
2. Enregistrer exactement `INTEGRATION_OAUTH_REDIRECT_URI` dans Google Cloud. Le callback générique est aussi enregistré dans les consoles Microsoft et Spotify.
3. Définir `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` et une clé `OAUTH_TOKEN_ENCRYPTION_KEY` de 32 octets encodée en base64.
4. Activer uniquement les API réellement utilisées. Google Calendar demande `openid`, `email` et `https://www.googleapis.com/auth/calendar`.

Le Desktop appelle l’API authentifiée `/v1/integrations`, ouvre la page de consentement dans le navigateur puis actualise l’état. Le callback public vérifie une transaction à usage unique, expirante, liée à l’utilisateur, ainsi que PKCE S256. Le token est chiffré avec AES-256-GCM avant sa persistance et n’est jamais renvoyé au client ou à l’administrateur.

`GOOGLE_REFRESH_TOKEN` et `OAUTH_REFRESH_TOKEN_STORE_PATH` restent uniquement pour les appels techniques historiques sans identité humaine. Une requête utilisateur ne retombe jamais sur ces credentials globaux.

## Exploitation

- Révoquer une connexion supprime le secret local et tente aussi la révocation chez Google.
- Une suspension de compte rend le coffre inaccessible immédiatement.
- Une connexion partagée exige un nom, un foyer et un droit d’administration du foyer. Son utilisation conversationnelle doit fournir explicitement son `integrationConnectionId` ; en son absence, seul le credential personnel peut être sélectionné.
- Ne jamais journaliser ou versionner les codes OAuth, secrets client, access tokens, refresh tokens ou la clé de chiffrement.

En production publique, utiliser HTTPS et prévoir la vérification Google des scopes sensibles avant d’ouvrir l’application au-delà des comptes de test.
