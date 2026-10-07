# Validation cybersécurité et déploiement PC local — 7 octobre 2026

## Périmètre

Contrôle du backend Jarvis, du Desktop Tauri, de l’audit domestique, de l’image Docker, de l’edge et de la sauvegarde locale. L’APK Android et l’exposition Internet restent hors périmètre.

## Durcissements appliqués

- audit des actions domestiques réussies, refusées et échouées, avec acteur, cible, corrélation et métadonnées bornées ;
- aucune entité Home Assistant ni valeur secrète dans les événements ajoutés ;
- refus audité avant exécution lorsqu’un compte ne possède pas la permission `home` ;
- suppression de `unsafe-eval` dans la CSP Desktop ;
- suppression de la permission HTTP Tauri générique `https://**`, remplacée par les origines effectivement utilisées ;
- ajout explicite de Keycloak local sur les ports de développement autorisés ;
- validation du nombre d’entrées, de la taille décompressée et des chemins internes avant toute restauration ZIP.

## Preuves

- backend complet : 66 suites, 573 tests ;
- sécurité ciblée : 56 tests d’abus et 46 tests autorisation/audit ;
- Desktop : 24 fichiers, 99 tests ;
- E2E : 12 scénarios réussis, 1 scénario runtime explicitement ignoré ;
- dépendances backend et Desktop : aucune vulnérabilité connue au seuil élevé ;
- image runtime : zéro vulnérabilité détectée par le scanner ;
- configuration Caddy/edge valide ;
- MSI et installeur NSIS produits après compilation Tauri ;
- runtime PC reconstruit, conteneur sain, `/ready` au schéma 8 ;
- Desktop release démarré localement et processus Windows réactif.

## Limites assumées

- le test dynamique d’une archive volontairement traversante a été refusé par la politique d’exécution locale avant création de l’artefact ; le contrôle est néanmoins présent dans le script, analysé par PowerShell et le drill nominal reste vert ;
- ce déploiement utilise le profil local `pc-preprod`, sans identité multi-utilisateur active ; le profil OIDC complet demande encore des secrets runtime réels et le bootstrap nominatif du propriétaire ;
- aucune conclusion de sécurité Internet n’est tirée de cette validation locale.

## Décision

Statut : **READY WITH MINOR ISSUES** pour validation fonctionnelle locale sur ce PC. Le runtime n’est pas autorisé à être exposé sur Internet et ne constitue pas encore la préproduction multi-utilisateur complète.
