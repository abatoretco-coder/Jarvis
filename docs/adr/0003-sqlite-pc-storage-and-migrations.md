# ADR 0003 — SQLite sur PC, migrations et sauvegardes

- Statut : accepté, à réévaluer avant exposition publique/NAS
- Date : 2026-10-06

## Décision

SQLite est conservé pour la version PC. Le volume existant est faible et Jarvis reste l'unique writer backend. Introduire PostgreSQL maintenant ajouterait une dépendance opérationnelle sans résoudre un problème observé.

La décision est encadrée par :

- WAL et clés étrangères activés ;
- migrations additives versionnées dans `schema_migrations` et `PRAGMA user_version` ;
- refus d'ouvrir une base plus récente que le runtime ;
- contrôle du checksum d'une migration déjà enregistrée ;
- adoption idempotente des bases historiques sans perte de lignes ;
- sauvegarde via l'API SQLite online backup, vérification `quick_check`, restauration sans écrasement.

## Seuils de réévaluation PostgreSQL

PostgreSQL sera réévalué avant le chantier 8/10 si l'un des critères apparaît : plusieurs writers/processus, haute disponibilité, réplication, migrations nécessitant de longues réécritures concurrentes, charge d'écriture soutenue ou besoin d'administration distante directe. L'accès public seul n'impose pas PostgreSQL : l'API reste l'unique frontière de données.

## Preuve

Le 2026-10-06, une base historique de 17 conversations et 43 messages a été sauvegardée puis restaurée. La copie restaurée a passé `PRAGMA quick_check`; son SHA-256 était identique à la sauvegarde.
