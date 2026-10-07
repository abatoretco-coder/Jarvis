# Recette PC du vendredi 9 octobre 2026

## Décision actuelle

Le logiciel PC est prêt pour la recette du logement. Ce document ne présume
pas que le nouveau Wi‑Fi, un hostname public, un tunnel TLS ou les équipements
physiques existent déjà. L’ouverture Internet n’est autorisée qu’après réussite
de tous les contrôles ci-dessous.

## Avant l’ouverture Internet

- réserver une adresse privée stable au PC sur le routeur ;
- conserver Jarvis (`8090`), Keycloak (`8180`) et Home Assistant (`8123`) hors
  d’Internet ; aucune redirection directe de ces ports sur la box ;
- publier uniquement un point d’entrée HTTPS avec hostname stable, certificat
  valide, proxy/tunnel authentifié et secret d’origine ;
- injecter ce hostname dans le build Android et la configuration Desktop ;
- garder les secrets runtime dans les fichiers ignorés et dans les coffres
  prévus, jamais dans Git ou dans l’APK.

## Gate locale

Depuis `All VM/Jarvis` :

```powershell
npm run verify
npm run security:abuse
npm run pc -- start -Profile pc-preprod-full -EnvFile ops/pc/env/pc-preprod-full.env
npm run pc -- status -Profile pc-preprod-full
npm run pc -- drill -Profile pc-preprod-full
```

Attendus : conteneurs sains, `/ready` à `ready`, discovery OIDC disponible,
drill base/home-store/identité réussi et aucun secret imprimé.

## Gate téléphone

Pour la première recette USB locale :

```powershell
adb devices
adb reverse tcp:8090 tcp:8090
adb reverse tcp:8180 tcp:8180
adb install -r "..\Jarvis APK\jarvisremote\build\outputs\apk\debug\jarvisremote-debug.apk"
```

Vérifier connexion propriétaire, reprise après fermeture, historique, vue
Domicile, sélection de pièce, commande, confirmation sensible, perte/reprise
réseau et absence de crash fatal dans `adb logcat`.

## Gate externe

Basculer le téléphone sur les données mobiles, sans Wi‑Fi ni VPN, puis vérifier :

1. certificat et hostname valides, aucun accès possible aux ports internes ;
2. connexion et renouvellement de session propriétaire ;
3. comptes résident et invité limités à leurs droits ;
4. compte suspendu immédiatement refusé ;
5. historique isolé entre deux comptes et tentative IDOR refusée ;
6. limites de débit, CORS, taille de requête et secret d’origine effectifs ;
7. audit des connexions, refus et mutations présent dans le panel propriétaire.

## Gate équipements

Depuis Desktop, Android et la conversation, tester au minimum lumière, TV,
chauffage et robot : commande nominale, changement externe dans Home Assistant,
équipement indisponible, coupure Wi‑Fi, redémarrage Home Assistant et
réconciliation d’état. Une caméra ou une ouverture ne doit jamais être rendue
accessible à un invité par défaut.

## Go / no-go

Le go PC requiert toutes les gates vertes et une sauvegarde chiffrée copiée hors
du disque de données. Au premier échec d’identité, d’isolation, de TLS ou de
réconciliation d’une commande sensible : couper le point d’entrée public,
conserver les logs/audits et revenir au mode local. Le passage ultérieur au NAS
réutilisera les mêmes contrats, sans rouvrir le chantier fonctionnel PC.
