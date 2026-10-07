# Incident, révocation et rotation

## Compte humain compromis

1. Dans le panel propriétaire, suspendre le compte. Cette opération révoque atomiquement ses sessions actives.
2. Révoquer ses connexions personnelles et ses droits spécifiques.
3. Vérifier dans l’audit les actions, cibles, IP et identifiants de corrélation associés, sans exporter de secrets.
4. Réactiver uniquement après rotation des accès du fournisseur OIDC.

## Secret d’origine compromis

1. Désactiver temporairement le tunnel ou l’edge.
2. Générer une valeur aléatoire dédiée d’au moins 32 caractères.
3. Mettre à jour `EDGE_PROXY_SECRET` dans le coffre du proxy et de Jarvis, jamais dans Git.
4. Redémarrer l’origine puis l’edge ; vérifier qu’une requête avec l’ancienne valeur reçoit `403 edge_required`.

## Clé de service compromise

1. Retirer l’entrée concernée de `SERVICE_API_KEYS_JSON` ou remplacer seulement son token.
2. Redémarrer Jarvis et vérifier les capacités minimales du service.
3. Rechercher `serviceId` dans l’audit. Ne jamais réactiver `ALLOW_LEGACY_API_KEYS` pour contourner l’incident.

## Sauvegarde et restauration des données

Avant une intervention :

```powershell
npm run db:conversation -- backup --source <conversation.sqlite> --destination <backup.sqlite>
npm run db:conversation -- verify --source <backup.sqlite>
```

La restauration doit cibler un nouveau fichier :

```powershell
npm run db:conversation -- restore --source <backup.sqlite> --destination <conversation-restored.sqlite>
```

Après vérification, arrêter Jarvis avant de basculer explicitement `CONVERSATION_DB_PATH`. La commande refuse l’écrasement d’un fichier existant.

## Critère de reprise

L’incident n’est clos qu’après révocation vérifiée, absence d’accès avec l’ancien secret, contrôle de l’audit et sauvegarde restaurable. En cas de doute, l’edge reste désactivé.
