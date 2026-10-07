# Inventaire des secrets — sans valeurs

Date de référence : 2026-10-06.

Les profils `.env`, `.env.pc` et `.env.nas` sont ignorés par Git. Une recherche par motifs de clés connus dans les fichiers suivis de Jarvis, Jarvis Desktop et Jarvis APK n'a trouvé aucun littéral ressemblant aux clés actives observées.

Les profils locaux contiennent néanmoins des valeurs non vides pour plusieurs catégories sensibles. Aucune valeur n'est reproduite dans ce document.

## Secrets système et interservices

- `API_KEY`, `API_KEYS`
- `AGORA_API_TOKEN`
- `HA_TOKEN`
- `NAS_STATUS_TOKEN`
- `HELIX_NEWS_API_TOKEN` dans le profil PC

## Fournisseurs IA et données externes

- `OPENAI_API_KEY`
- `PERPLEXITY_API_KEY`
- `OPENAGENDA_API_KEY` dans le profil PC
- `TICKETMASTER_API_KEY` dans le profil PC

## OAuth et services personnels

- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_REFRESH_TOKEN`
- `SPOTIFY_WEBAPI_CLIENT_SECRET`
- `SPOTIFY_WEBAPI_REFRESH_TOKEN`

## Action préalable aux smoke tests cloud

1. Révoquer et recréer les clés OpenAI et Perplexity.
2. Régénérer les clés Jarvis, Agora et NAS Status.
3. Révoquer ou renouveler les refresh tokens Microsoft et Spotify.
4. Vérifier et, si nécessaire, renouveler Home Assistant, OpenAgenda, Ticketmaster et Helix.
5. Ne jamais recopier les nouvelles valeurs dans un document, un rapport de test ou une commande dont la sortie est conservée.
6. Séparer les nouveaux secrets `dev`, `test` et `pc-preprod` dès le chantier 1.

La rotation effective nécessite l'accès aux consoles des fournisseurs et n'est donc pas considérée comme réalisée par cet inventaire.
