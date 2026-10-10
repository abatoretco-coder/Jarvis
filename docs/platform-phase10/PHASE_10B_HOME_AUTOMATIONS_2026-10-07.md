# Phase 10B — Actions riches, ambiances et horaires

Date : 2026-10-07

Statut : **socle logiciel livré, recette matérielle en attente**.

## Livré

- commandes directes déterministes pour marche/arrêt, température, luminosité et volume ;
- actions rapides persistées et exécutables depuis Desktop, Android ou par phrase Jarvis ;
- ambiances composées de 2 à 20 actions, validées avant toute exécution ;
- exécution parallèle avec résultat par étape et statut `success`, `partial` ou `failed` ;
- phrases vocales d'ambiance, résolues dans `/v1/ingest` ;
- horaires hebdomadaires en heure `Europe/Paris`, sans rejeu au redémarrage en milieu de minute ;
- création et suppression owner-only ; filtrage invité et droits serveur à l'exécution ;
- audit typé des équipements, actions rapides, ambiances et horaires ;
- suppression en cascade des ambiances et horaires devenus orphelins ;
- sections Android `Actions`, `Ambiances` et `Horaires`, masquées lorsqu'elles ne sont pas utilisables ;
- cockpit Desktop `Actions`, `Scènes` et `Routines`, avec phrases vocales, luminosité, volume, contrôles dérivés des capacités et confirmations sensibles ;
- contrats HTTP Android vérifiés avec un faux serveur, repository testé et APK assemblée/lintée.

## Invariants

- Un bouton appelle directement un endpoint typé ; aucun LLM n'intervient.
- Toute voix entre par Jarvis. L'interprétation libre ne donne jamais accès à un service Home Assistant arbitraire.
- Une ambiance est entièrement prévalidée avant le premier appel afin d'éviter une exécution partielle causée par un refus de droits ou une configuration invalide.
- Un échec fournisseur après prévalidation reste visible par étape ; il n'est jamais transformé en succès global.
- Les routines ne contiennent pas de secret ni d'`entity_id` Home Assistant : seulement des identifiants Jarvis.

## Limites assumées de cette tranche

- déclencheur horaire hebdomadaire uniquement ; présence, soleil, capteurs et événements appareil restent à développer ;
- pas encore de délai, branche conditionnelle ou séquence : une ambiance applique ses états en parallèle ;
- pas encore de couleur, température de blanc, source média, mode HVAC ou zones du robot ;
- pas encore d'écran d'historique persistant des exécutions planifiées ; les exécutions sont journalisées ;
- la création d'une ambiance réutilise des actions rapides existantes pour garder l'éditeur mobile simple ;
- aucun effet physique n'est déclaré validé avant raccordement des équipements réels.

## Prochain lot

1. Déclencheurs présence, capteur, état appareil et lever/coucher du soleil.
2. Conditions `toutes` / `au moins une`, détection des conflits et activation/désactivation.
3. Scripts séquentiels avec délais et politique d'arrêt explicite.
4. Couleur et température de blanc, source/volume média, mode chauffage et robot par pièce/zone.
5. Historique persistant, simulation et test manuel de routine.
6. Recette croisée Desktop/Android sur les appareils physiques.

## Validation

- Backend complet : lint, build, typage, cohérence des capacités et **69 suites / 586 tests** réussis.
- Android : build, lint et **43 tests JVM** réussis.
- Desktop : build frontend, **28 suites / 127 tests** et **14 parcours E2E** réussis ; contrôle visuel 1440×1000 et 390×844 sans débordement horizontal.
- APK finale : contrat HTTP des actions, ambiances et horaires couvert ; installation et redémarrage réussis sur `emulator-5554`, écran Compose rendu et aucune erreur `AndroidRuntime`.
- Durcissement mobile live : session conservée lors d'une panne réseau, polling limité aux écrans visibles, configuration sans URL technique et contrôles non configurés désactivés.
- Recette physique : non déclarée tant que les équipements et le téléphone réel ne sont pas raccordés.

## Audit des artefacts et de la documentation

- Le contrat mobile canonique est maintenu dans `Jarvis APK/docs/JARVIS_REMOTE_API.md`.
- Le benchmark produit et la roadmap fonctionnelle restent dans `DOMOTICS_PRODUCT_BENCHMARK_2026-10-07.md` ; ce document de phase ne les duplique pas.
- Les résultats Gradle, rapports de lint, APK et fichiers de test restent des artefacts générés dans `build/` et ne deviennent pas de la documentation versionnée.
- Aucun dump UI ou fichier de diagnostic temporaire n'est conservé dans les dépôts.
- L'APK de recette est générée sous `Jarvis APK/jarvisremote/build/outputs/apk/debug/jarvisremote-debug.apk` ; elle n'est pas assimilée à un binaire de production signé.
