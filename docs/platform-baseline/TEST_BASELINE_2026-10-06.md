# Baseline de tests Jarvis Platform

Date d'exécution : 2026-10-06.

Les suites ont été lancées sans appel à un fournisseur cloud réel. Les E2E Desktop utilisent des doubles hermétiques locaux pour Home Assistant, Agora et le runtime LLM historique.

## Résultats

| Composant | Commande | Résultat |
| --- | --- | --- |
| Jarvis | `npm run verify` | vert : lint, build, typecheck, 49 suites et 454 tests, registre de 13 capacités cohérent |
| Agora | `npm run verify` | vert : build, typecheck, 8 suites et 87 tests |
| Desktop frontend | `npm run build` | vert ; avertissements Vite sur la taille des bundles et `eval` dans `onnxruntime-web` |
| Desktop unitaire | `npm test` | vert : 16 fichiers, 71 tests |
| Desktop E2E hermétique | `npm run test:e2e` | vert : 12 scénarios ; 1 scénario runtime réel volontairement ignoré faute de variables runtime |
| Desktop Tauri | `cargo check` dans `src-tauri` | vert |
| Android | `gradlew :jarvisremote:testDebugUnitTest :jarvisremote:lintDebug :jarvisremote:assembleDebug` | vert : 21 tests, APK debug assemblé, lint sans erreur bloquante |
| Home Assistant/Compose | `docker compose -f docker-compose.dev.yml config --quiet` avec placeholders éphémères | vert : interpolation et structure Compose valides |

## Défauts de baseline corrigés

### Générateur de plan et lint

Le générateur `scripts/generate-home-plan-assets.mjs` utilisait les globals Node `process` et `console` sans les déclarer à ESLint. Une déclaration de globals a été ajoutée ; aucun comportement de génération n'a changé.

### Test Culture dépendant de la date réelle

Deux assertions de `cultureIntelligence.ingest.test.ts` attendaient une occurrence future datée du 5 septembre 2026. À partir du 6 septembre, et notamment lors de cette exécution du 6 octobre, le service la classait correctement comme passée.

Le `describe` utilise désormais une horloge fixe au 29 août 2026, cohérente avec les fixtures. Le test ciblé passe avec 12/12 scénarios, puis la suite Jarvis complète passe avec 454/454 tests.

## Couverture ajoutée en clôture de phase 0

- 7 tests Jarvis couvrent migrations versionnées, adoption legacy, checksum/version future, sauvegarde WAL, restauration, intégrité et refus d'écrasement.
- 3 tests Desktop couvrent PKCE S256, requête publique sans secret et validation stricte du callback.
- 2 tests Android couvrent la politique native OIDC/PKCE sans dépendance OAuth embarquée.

## Avertissements conservés

- Jest force encore la sortie après les suites Jarvis et suggère de rechercher des handles asynchrones ouverts. La suite est verte, mais cette dette devra être diagnostiquée avant la préproduction longue durée.
- Le build Desktop produit deux bundles supérieurs à 500 Ko et remonte l'usage d'`eval` par `onnxruntime-web`.
- Android remonte 15 avertissements lint non bloquants et un avertissement d'initialisation des métriques lié à l'absence du dossier utilisateur `.android` ; tests, lint et assemblage terminent néanmoins avec succès.
- Le scénario `runtime PC` de Playwright nécessite `E2E_RUNTIME_JARVIS_URL` et `E2E_RUNTIME_API_KEY`. Il n'a pas été lancé pour éviter d'utiliser les secrets historiques avant rotation.
- La vérification Home Assistant porte ici sur Compose. Le contrôle `ha core check` contre une configuration réelle sera exécuté quand le profil PC cloud aura remplacé les dépendances Ollama/Kokoro.

## Critère de référence

Toute tranche des chantiers 1 et 2 devra au minimum conserver ces résultats. Les changements de contrat intentionnels devront ajouter leurs propres tests de migration et mettre à jour la photographie `/v1` au lieu de simplement modifier les assertions existantes.
