# Procédure de récupération administrateur hors ligne

Date de conception : 2026-10-06. Cette procédure devient exécutable au chantier 2, après livraison de la commande locale décrite ci-dessous.

## Conditions

L'opérateur doit avoir un accès local au PC/NAS, pouvoir arrêter Jarvis et lire la base. Cette procédure ne doit jamais être exposée par HTTP, SSH public automatisé ou l'interface Desktop.

## Procédure cible

1. Couper l'edge public ou arrêter le service Jarvis.
2. Sauvegarder et vérifier la base avec `npm run db:conversation -- backup ...`.
3. Exécuter localement `jarvis-admin recovery issue --subject <sub OIDC> --reason <ticket>`.
4. Vérifier le résumé issuer/subject/e-mail affiché et confirmer interactivement.
5. Transmettre le code à usage unique uniquement au propriétaire, hors journalisation.
6. Redémarrer Jarvis sur une interface privée et consommer le code dans les 15 minutes après une authentification OIDC du même sujet.
7. Vérifier les événements d'audit `owner_recovery_issued` et `owner_recovery_consumed`.
8. Révoquer les anciennes sessions et faire tourner tout credential suspect.
9. Réactiver l'edge public après contrôle d'accès complet.

## Échec sûr

En cas de code expiré, sujet différent, compte ambigu ou audit indisponible, la récupération échoue sans modifier les rôles. Un nouveau code doit être émis localement. Il n'existe aucun mot de passe universel ni variable d'environnement permettant de désactiver l'autorisation.
