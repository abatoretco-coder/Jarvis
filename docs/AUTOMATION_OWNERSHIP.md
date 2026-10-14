# Responsabilités des automatisations et des tâches

## Domotique

- Home Assistant est la source d’autorité des automatisations horaires. Les anciennes routines du catalogue Jarvis sont conservées pour compatibilité de lecture et suppression, mais `HomeRoutineScheduler` n’est pas démarré en production.
- Jarvis compile et réconcilie uniquement les automatisations Home Assistant qu’il marque `jarvis-managed`. Home Assistant continue donc à les exécuter lorsque Jarvis est indisponible.
- Les scènes Jarvis sont des commandes explicites et immédiates. Elles ne constituent pas un second moteur horaire.
- L’éclairage adaptatif conserve l’intention de mode par pièce (`allumé`, `tamisé`, `éteint`). Une modification manuelle observée dans Home Assistant ou une application tierce libère cette intention. Une reconnexion d’ampoule conserve au contraire le mode choisi.
- Avant une mutation du catalogue, les automatisations Jarvis actives sont suspendues puis restaurées seulement si leur scène et leur métadonnée gérée sont encore valides. Le journal SQLite permet une reprise après redémarrage.

## Tâches

- Microsoft To Do contient les tâches personnelles. Les formulations « Microsoft To Do », « mes tâches personnelles » ou « ma liste personnelle » ciblent ce système.
- Vie quotidienne contient les listes partagées du foyer, notamment courses et tâches ménagères. Les formulations « maison », « foyer », « partagé » ou « liste de courses » ciblent ce système.
- Une formulation sans portée explicite reste ambiguë et Jarvis demande une clarification. Il n’existe pas de synchronisation bidirectionnelle entre les deux systèmes.
- Les récurrences Vie quotidienne sont activées par le processeur durable du backend, jamais par une simple consultation. Chaque complétion est conservée dans l’historique des occurrences.
