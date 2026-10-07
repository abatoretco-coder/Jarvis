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

Les sauvegardes persistantes sont écrites sous `runtime/backups`. Chaque point de sauvegarde comprend la base (`*.database.jarvisdb`) et le catalogue mutable des domiciles (`*.homes.zip.jarvisdb`) ; le profil complet ajoute les données d'identité (`*.identity.zip.jarvisdb`). Le service Jarvis est brièvement arrêté pour garantir la cohérence entre ces artefacts. Le drill vérifie aussi le chiffrement, le déchiffrement et le nombre de fichiers du home-store, puis supprime son dossier temporaire.

Avec `-Profile pc-preprod-full`, la commande effectue un bref arrêt coordonné de Jarvis et Keycloak, puis crée deux fichiers chiffrés portant le même horodatage :

- `jarvis-AAAAMMJJ-HHMMSS.database.jarvisdb` pour SQLite ;
- `jarvis-AAAAMMJJ-HHMMSS.identity.zip.jarvisdb` pour l’identité Keycloak.

Les services sont relancés même si la sauvegarde échoue. Conserver et copier hors du PC les deux fichiers de la paire.

## Restaurer

```powershell
$env:JARVIS_BACKUP_PASSPHRASE = '<même phrase>'
npm run pc -- restore -Profile pc-preprod -EnvFile ops/pc/env/pc-preprod.env -BackupPath runtime/backups/jarvis-AAAAMMJJ-HHMMSS.database.jarvisdb
```

La commande exige la sauvegarde `homes` portant le même horodatage, arrête Jarvis, place la base et le home-store existants en quarantaine `pre-restore-*`, restaure les deux ensembles, puis redémarre. En cas d’échec, les données précédentes restent disponibles dans le dossier de données.

Pour `pc-preprod-full`, définir aussi `KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD` et utiliser le fichier `*.database.jarvisdb` de la paire. Le script exige automatiquement le fichier d’identité associé, déchiffre et contrôle l’archive ZIP avant d’arrêter les services, puis met l’ancienne base et l’ancien dossier d’identité en quarantaine.

## Rollback applicatif

1. Arrêter le profil.
2. Conserver la base et la sauvegarde récentes ; ne jamais les supprimer pour revenir au code précédent.
3. Revenir à l’image ou au commit applicatif connu.
4. Vérifier la compatibilité de `PRAGMA user_version`. Les migrations sont additives mais un runtime plus ancien peut refuser une base plus récente.
5. Redémarrer et vérifier `/ready`, la connexion, l’historique et les intégrations.
