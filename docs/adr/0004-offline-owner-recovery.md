# ADR 0004 — Récupération propriétaire hors ligne

- Statut : accepté pour implémentation au chantier 2
- Date : 2026-10-06

## Décision

La récupération d'administration ne sera ni une route publique permanente, ni une clé maître. Elle sera déclenchée par une commande locale exécutée sur l'hôte Jarvis avec accès au fichier de données.

Le mécanisme produira un grant à usage unique, lié au compte `owner`, expirant sous 15 minutes et stocké uniquement sous forme de hash. Sa consommation exigera une nouvelle authentification OIDC valide du même sujet, réactivera au plus le rôle `owner`, révoquera les sessions existantes et écrira deux événements d'audit append-only : émission et consommation/expiration.

## Garde-fous

- aucune écoute réseau et aucun mode « auth désactivée » ;
- refus si plusieurs propriétaires correspondent ou si l'identité cible est ambiguë ;
- affichage du secret une seule fois, jamais dans les logs ;
- confirmation interactive avec résumé de l'identité cible ;
- permissions minimales sur la base et le terminal opérateur ;
- rotation des credentials compromise après récupération.

La procédure opératoire est décrite dans `docs/platform-baseline/OFFLINE_ADMIN_RECOVERY.md`. La commande n'existe pas encore : elle sera livrée avec le modèle d'identité du chantier 2, avant toute exposition publique.
