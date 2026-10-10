# Connexions personnelles OAuth

Jarvis conserve un client d’application par famille de fournisseur au niveau système, mais chaque consentement et chaque refresh token appartiennent à un utilisateur Jarvis précis. Le client Google est commun à Gmail et Google Calendar.

## Configuration serveur

Le déploiement PC public utilise exactement ce callback pour les trois consoles fournisseur :

`https://jarvis-abato.duckdns.org/v1/integrations/oauth/callback`

1. Google : créer un client OAuth **Web application**, activer Gmail API et Google Calendar API, puis définir `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET`.
2. Microsoft : enregistrer le callback comme plateforme **Web** et autoriser les permissions déléguées `User.Read` et `Tasks.ReadWrite`.
3. Spotify : enregistrer le callback HTTPS à l’identique. En mode développement, ajouter chaque compte autorisé à la liste des utilisateurs de l’application.
4. Conserver tous les identifiants dans `.env.pc`, qui est ignoré par Git. `scripts/https-runtime.ps1` n’en importe que les sept variables OAuth explicitement autorisées et refuse une paire client/secret incomplète.
5. Démarrer avec `./scripts/https-runtime.ps1 start -Mode public`, puis connecter chaque service depuis **Réglages > Connexions** dans Jarvis Desktop ou Web.

La clé `OAUTH_TOKEN_ENCRYPTION_KEY` de 32 octets encodée en base64 reste dans l’environnement runtime privé ; elle ne doit pas être déplacée dans `.env.pc`.

Le Desktop appelle l’API authentifiée `/v1/integrations`, ouvre la page de consentement dans le navigateur puis actualise l’état. Le callback public vérifie une transaction à usage unique, expirante, liée à l’utilisateur, ainsi que PKCE S256. Le token est chiffré avec AES-256-GCM avant sa persistance et n’est jamais renvoyé au client ou à l’administrateur.

`GOOGLE_REFRESH_TOKEN` et `OAUTH_REFRESH_TOKEN_STORE_PATH` restent uniquement pour les appels techniques historiques sans identité humaine. Une requête utilisateur ne retombe jamais sur ces credentials globaux.

## Exploitation

- Révoquer une connexion supprime le secret local et tente aussi la révocation chez Google.
- Une suspension de compte rend le coffre inaccessible immédiatement.
- Une connexion partagée exige un nom, un foyer et un droit d’administration du foyer. Son utilisation conversationnelle doit fournir explicitement son `integrationConnectionId` ; en son absence, seul le credential personnel peut être sélectionné.
- Ne jamais journaliser ou versionner les codes OAuth, secrets client, access tokens, refresh tokens ou la clé de chiffrement.

En production publique, prévoir la vérification Google des scopes sensibles avant d’ouvrir l’application au-delà des comptes de test. Le mode Google **Testing** suffit pour la mise au point avec les comptes autorisés, mais ses refresh tokens expirent après sept jours ; passer ensuite l’application en **In production** évite une reconnexion hebdomadaire.
