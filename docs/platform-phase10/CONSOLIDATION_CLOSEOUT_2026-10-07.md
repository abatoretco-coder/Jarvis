# Clôture de consolidation — 7 octobre 2026

## Résultat

Le contrôle transversal précédant la validation multi-utilisateur PC est clôturé. Les régressions trouvées pendant la revue ont été corrigées sans ajouter de nouvelle infrastructure :

- fixture E2E alignée sur le bootstrap Desktop courant ;
- renouvellement OIDC replanifié après chaque rotation de jeton et couvert par un test multi-cycle ;
- consigne de chauffage reconciliée avec Home Assistant lorsqu’elle n’est pas en cours de saisie ;
- écriture du home-store réalisée sur une copie avec sauvegarde `.previous` et restauration en cas d’échec ;
- actions et mutations domotiques inscrites dans l’audit persistant lorsque le runtime OIDC est actif, sans journaliser de secret ;
- sauvegarde, restauration, quarantaine et drill étendus au home-store chiffré.

## Preuves fraîches

- backend : lint, build, typecheck, 66 suites et 572 tests, capacités cohérentes ;
- Desktop : 24 fichiers et 99 tests, puis build de production ;
- E2E hermétique : 12 scénarios réussis, 1 scénario runtime volontairement ignoré ;
- drill : base SQLite et home-store chiffrés, déchiffrés et restaurés, puis artefacts temporaires supprimés ;
- profil Compose `pc-preprod-full` résolu sans erreur.

## Décision

Statut du lot : **READY** pour passer à la validation multi-utilisateur sur PC. Cela ne constitue pas une autorisation de publication Internet ni une clôture du cockpit Android ou des appareils physiques.

Le prochain jalon exige des secrets runtime réels, un compte propriétaire OIDC nominatif et la validation des parcours propriétaire, résident et invité. Les valeurs d’exemple ne doivent pas être utilisées pour démarrer une préproduction durable.
