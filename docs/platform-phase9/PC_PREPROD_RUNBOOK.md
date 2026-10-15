# Runbook PC préproduction

Toutes les commandes sont lancées depuis `All VM/Jarvis`.

## Préparer les secrets

Copier l’exemple approprié vers un fichier ignoré par Git, remplacer les valeurs factices, puis le sélectionner avec `-EnvFile` :

```powershell
Copy-Item ops/pc/env/pc-preprod.env.example ops/pc/env/pc-preprod.env
npm run pc -- config -Profile pc-preprod -EnvFile ops/pc/env/pc-preprod.env
```

Pour le profil avec Keycloak, provisionner une fois les secrets locaux. La
commande génère le fichier d’environnement ignoré par Git, un jeton de service,
la clé de chiffrement OAuth, le mot de passe d’administration Keycloak et la
phrase de sauvegarde. Les deux derniers sont protégés par Windows DPAPI et ne
sont jamais affichés :

```powershell
npm run pc -- provision -Profile pc-preprod-full
npm run pc -- config -Profile pc-preprod-full -EnvFile ops/pc/env/pc-preprod-full.env
```

Après l’inscription du premier compte dans Keycloak, renseigner son `subject`
dans `OIDC_BOOTSTRAP_OWNER_SUBJECT`, puis redémarrer Jarvis. À sa connexion
suivante, ce compte devient l’unique propriétaire initial. Ne jamais exposer le
profil tant que ce bootstrap n’est pas terminé.

Le script peut effectuer la mise à jour sans afficher ni réécrire les autres
secrets du fichier :

```powershell
npm run pc -- set-owner -Profile pc-preprod-full -EnvFile ops/pc/env/pc-preprod-full.env -OwnerSubject '<subject-keycloak>'
npm run pc -- restart -Profile pc-preprod-full -EnvFile ops/pc/env/pc-preprod-full.env
```

## Exploiter Jarvis

```powershell
npm run pc -- start -Profile pc-preprod -EnvFile ops/pc/env/pc-preprod.env
npm run pc -- status -Profile pc-preprod
npm run pc -- logs -Profile pc-preprod
npm run pc -- restart -Profile pc-preprod -EnvFile ops/pc/env/pc-preprod.env
npm run pc -- stop -Profile pc-preprod
```

Pour la validation multi-utilisateur locale, remplacer `pc-preprod` par
`pc-preprod-full` et utiliser son fichier d’environnement.

L’API doit répondre sur `http://127.0.0.1:8090`. `GET /ready` doit retourner `status=ready`.

## Valider et déployer le routage conversationnel

Avant de reconstruire le profil public, valider le catalogue canonique et tous
les garde-fous du dépôt :

```powershell
npm run check:capabilities
npm run lint
npm run build
npm run typecheck:test
npm test -- --runInBand
```

Créer ensuite une sauvegarde cohérente, reconstruire le profil public et lancer
ses sondes externes :

```powershell
npm run pc -- backup -Profile pc-preprod-full
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/https-runtime.ps1 start -Mode public
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/https-runtime.ps1 test -Mode public
```

Après un changement de capacités, vérifier dans les logs que l'agent attendu est
exposé au routeur, puis tester une requête directe et une continuation utilisant
l'historique (par exemple une lecture d'agenda suivie de « ajoute aussi… »).

## Tester dans Docker

```powershell
npm run pc -- test -Profile test
```

## Sauvegarder

La phrase n’est jamais passée en argument ni enregistrée dans le dépôt. Après
`provision`, le script la recharge automatiquement depuis le secret DPAPI :

```powershell
$env:JARVIS_BACKUP_PASSPHRASE = '<phrase unique de 32 caractères minimum>'
npm run pc -- backup -Profile pc-preprod
npm run pc -- drill -Profile pc-preprod
```

Les sauvegardes persistantes sont écrites sous `runtime/backups`. Chaque point de sauvegarde comprend la base (`*.database.jarvisdb`), le catalogue mutable des domiciles (`*.homes.zip.jarvisdb`) et un manifeste chiffré (`*.manifest.json.jarvisdb`) portant les noms, tailles et SHA-256 des composants. Le profil complet ajoute les données d'identité (`*.identity.zip.jarvisdb`). Le service Jarvis est brièvement arrêté pour garantir la cohérence entre ces artefacts. Le drill vérifie aussi le chiffrement, le déchiffrement et le nombre de fichiers du home-store, puis supprime son dossier temporaire.

Avec `-Profile pc-preprod-full`, la commande effectue un bref arrêt coordonné de Jarvis et Keycloak, puis crée quatre fichiers chiffrés portant le même horodatage :

- `jarvis-AAAAMMJJ-HHMMSS.database.jarvisdb` pour SQLite ;
- `jarvis-AAAAMMJJ-HHMMSS.homes.zip.jarvisdb` pour le home-store ;
- `jarvis-AAAAMMJJ-HHMMSS.identity.zip.jarvisdb` pour l’identité Keycloak ;
- `jarvis-AAAAMMJJ-HHMMSS.manifest.json.jarvisdb` pour la cohérence de l’ensemble.

Les services sont relancés même si la sauvegarde échoue. Conserver et copier hors du PC tous les fichiers de l’ensemble. Les sauvegardes antérieures sans manifeste restent restaurables ; le script signale alors que la cohérence inter-composants ne peut être garantie que par les noms correspondants et leur structure interne.

## Restaurer

```powershell
$env:JARVIS_BACKUP_PASSPHRASE = '<même phrase>'
npm run pc -- restore -Profile pc-preprod -EnvFile ops/pc/env/pc-preprod.env -BackupPath runtime/backups/jarvis-AAAAMMJJ-HHMMSS.database.jarvisdb
```

Avant d’arrêter Jarvis, la commande déchiffre et vérifie SQLite, extrait entièrement les ZIP dans des dossiers temporaires, refuse les chemins hors destination, doublons, liens symboliques, archives vides ou trop volumineuses, puis contrôle les `home.json`. Le manifeste est vérifié lorsqu’il existe. Aucune donnée active n’est modifiée pendant cette prévalidation.

Après prévalidation, les données existantes sont déplacées sous `runtime/pc-preprod/restore-quarantine/<operationId>`, puis les composants validés sont installés. SQLite et les structures Home/Identity sont revérifiés avant un `docker compose up --wait --wait-timeout 120`. Cette séquence est contrôlée et récupérable mais n’est pas une transaction atomique entre plusieurs chemins du système de fichiers.

Pour `pc-preprod-full`, définir aussi `KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD`. Le script exige l’archive d’identité associée, l’extrait entièrement avant l’arrêt et exige la base Keycloak `h2/keycloakdb.mv.db` non vide.

Si l’installation, la validation ou le démarrage échoue, le runtime partiel est arrêté, les nouveaux composants sont conservés sous `failed-install`, les anciens sont remis en place sans écrasement et leur redémarrage est tenté. Un échec de cette compensation produit `manual_recovery_required` et ne déclenche aucune suppression automatique.

### Restauration interrompue

Chaque étape sensible est enregistrée dans `runtime/pc-preprod/restore-state.json`. `start`, `restart`, `backup` et une nouvelle `restore` refusent de continuer si ce journal indique une opération inachevée. Un verrou exclusif empêche aussi deux opérations PC sensibles de se chevaucher.

1. Arrêter le profil et copier le journal ainsi que tout le dossier `restore-quarantine/<operationId>` vers un emplacement de diagnostic.
2. Comparer les chemins `target`, `staged` et `previous` du journal avec les fichiers présents. Ne rien écraser et ne rien supprimer tant que l’état de chaque composant n’est pas établi.
3. Vérifier la base choisie avec `npm run db:conversation -- verify --source <chemin>` ; vérifier les `home.json` et, pour le profil complet, `identity/h2/keycloakdb.mv.db`.
4. Remettre soit l’ensemble précédent, soit l’ensemble restauré complet. Ne jamais mélanger les générations.
5. Après vérification seulement, conserver une copie du journal puis marquer son `state` `rolled_back` ou `completed`. Redémarrer et contrôler `/ready`.

Le harnais local de défaillance, sans Docker ni données réelles, s’exécute avec :

```powershell
npm run test:pc-restore
```

## Rollback applicatif

1. Arrêter le profil.
2. Conserver la base et la sauvegarde récentes ; ne jamais les supprimer pour revenir au code précédent.
3. Revenir à l’image ou au commit applicatif connu.
4. Vérifier la compatibilité de `PRAGMA user_version`. Les migrations sont additives mais un runtime plus ancien peut refuser une base plus récente.
5. Redémarrer et vérifier `/ready`, la connexion, l’historique et les intégrations.
