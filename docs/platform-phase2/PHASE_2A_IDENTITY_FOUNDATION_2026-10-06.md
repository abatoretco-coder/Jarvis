# Phase 2A — Fondation identité

## Statut

Fondation backend terminée. Aucun login public ni fournisseur OIDC n'est encore activé.

## Livré

- migration SQLite additive v2, compatible avec les conversations existantes ;
- utilisateurs avec statuts `pending`, `active`, `suspended`, `rejected`, `revoked` ;
- identités OIDC uniques par couple issuer/subject et e-mail vérifié obligatoire ;
- rôles `owner`, `admin`, `resident`, `guest` ;
- catalogue de permissions atomiques sans grant implicite ;
- sessions `active`, `revoked`, `expired`, sans stockage de token ;
- provisionnement idempotent d'un profil `pending` ;
- transitions de statut autorisées explicitement ;
- révocation transactionnelle des sessions lors d'une suspension ou révocation.

## Décisions de sécurité

- Aucun rôle n'est attribué automatiquement à une nouvelle identité.
- Aucun rapprochement automatique n'est fait entre deux subjects OIDC partageant un e-mail.
- Un e-mail non vérifié est refusé.
- L'issuer est normalisé comme URL HTTP(S) ; signature, audience et expiration seront vérifiées par l'adaptateur OIDC de la phase suivante.
- Les clés API techniques existantes restent inchangées et aucun endpoint public ne consomme encore ces tables.

## Migration

La migration ne modifie ni ne backfille les conversations. Elle crée uniquement de nouvelles tables et index dans la transaction de migration. Le roll-forward est privilégié ; une ancienne version du runtime refusera correctement une base v2 plutôt que d'écrire dans un schéma inconnu.

## Suite

La phase 2B devra choisir/configurer le fournisseur OIDC, vérifier signature, issuer, audience et expiration, puis construire le contexte d'identité serveur. L'ownership des conversations reste volontairement au chantier 3.
