# Phase 9 — Préproduction PC durable

Statut au 2026-10-07 : **socle logiciel PC livré et vérifié**. La validation Android sur appareil réel reste en attente de l’autorisation USB du téléphone. La semaine représentative d’usage reste un critère temporel avant toute publication NAS.

## Périmètre livré

- `compose.pc.yaml` fournit les profils `dev`, `test`, `pc-preprod` et `pc-preprod-full`.
- Jarvis n’est publié que sur le loopback du PC et s’exécute en utilisateur non-root, sans capability Linux et sur un système de fichiers en lecture seule hors données et `/tmp`.
- SQLite est initialisé et migré avant l’écoute réseau. `/health` reste un liveness check et `/ready` vérifie l’intégrité de la base locale.
- Le profil complet ajoute Keycloak 26.8.0 et importe un realm minimal avec clients publics Desktop/Android et audience `jarvis-api`.
- Home Assistant demeure une dépendance externe configurée par `HA_BASE_URL` : lancer un second HA sous Docker Desktop ne représenterait ni les appareils ni la découverte du logement réel.
- Les services factuels et OpenAI demeurent des API externes ; aucun faux service local n’entre dans la préproduction.
- Les sauvegardes utilisent AES-256-GCM avec dérivation `scrypt`. Tous les profils produisent une base Jarvis et un home-store chiffrés et cohérents après un bref arrêt de Jarvis ; le profil complet ajoute les données Keycloak.
- Les logs Docker conservent les identifiants de requête Fastify ; les secrets restent masqués par le logger applicatif.

## Profils

| Profil | Usage | Exposition |
| --- | --- | --- |
| `dev` | rechargement TypeScript local | `127.0.0.1:18090` |
| `test` | lint, build, types,  tests et contrats dans Docker | aucune |
| `pc-preprod` | Jarvis durable avec SQLite persistante | `127.0.0.1:8090` |
| `pc-preprod-full` | Jarvis + Keycloak local | Jarvis `127.0.0.1:8090`, identité `127.0.0.1:8180` |

Les fichiers sous `ops/pc/env/*.example` ne contiennent que des valeurs de démonstration. Les vraies clés doivent rester dans un fichier ignoré par Git et être passé avec `-EnvFile`.

## Preuves exécutées

- configuration Compose validée pour tous les profils ;
- profil Docker `test` et validation hôte : 66 suites et 569 tests backend réussis ;
- profil `pc-preprod` : build, healthcheck, migration schéma 8 et redémarrage avec données persistantes réussis ;
- drill chiffré : sauvegarde, déchiffrement, restauration, `quick_check` et contraintes étrangères réussis, puis artefacts temporaires supprimés ;
- profil `pc-preprod-full` : realm Keycloak importé, discovery OIDC disponible et JWKS joignable depuis Jarvis (`2` clés) ;
- Desktop : 23 fichiers/94 tests unitaires, build, puis 12 scénarios Playwright réussis et 1 scénario runtime optionnel ignoré ;
- Android : build/tests JVM réussis ; validation sur téléphone en attente de la résolution ADB et de l’autorisation USB.

## Décisions et limites

- `OIDC_ALLOW_INSECURE_HTTP=true` est réservé au réseau Docker local. Le schéma d’environnement refuse cette option si `PUBLIC_EDGE_ENABLED=true`.
- L’identité locale utilise `start-dev`; elle n’est pas le déploiement NAS final.
- Les sauvegardes chiffrées sont plafonnées à 512 Mio pour éviter une allocation mémoire non bornée. Ce seuil est largement supérieur à la base PC actuelle et devra être réévalué si son volume évolue.
- La restauration refuse tout écrasement, vérifie les archives avant mutation, met les données existantes en quarantaine et ne redémarre les services qu’après restauration réussie.
- Une restauration `pc-preprod-full` exige les deux fichiers portant le même horodatage : `*.database.jarvisdb` et `*.identity.zip.jarvisdb`.

## Conditions de clôture opérationnelle

1. Rendre ADB disponible, autoriser le téléphone dans la fenêtre de débogage USB, puis installer et lancer l’APK de debug. Le projet ne contient actuellement aucune source `androidTest`, donc `connectedDebugAndroidTest` serait `NO-SOURCE` et ne constitue pas une preuve suffisante à lui seul.
2. Utiliser Jarvis sur une semaine représentative et consigner tout redémarrage, erreur OAuth ou perte de données.
3. Créer une vraie phrase de sauvegarde, hors dépôt, et conserver au moins une sauvegarde chiffrée hors du disque de données.
