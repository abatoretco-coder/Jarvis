# Jarvis Platform — clôture de la phase 0

Date : 2026-10-06.

## Relecture A–C

La relecture des changements précédents n'a trouvé aucune régression dans le générateur du domicile, la stabilisation temporelle des tests Culture ou la correction du contrat Android. Deux lacunes ont été corrigées avant clôture : le spike OIDC est désormais exécutable sur les deux clients, et la sauvegarde SQLite repose sur l'API online backup compatible WAL.

## État A–G

| Lot | Résultat | Preuve |
| --- | --- | --- |
| A — Worktrees et existant | Terminé | `WORKTREE_INVENTORY_2026-10-06.md`; lots OpenWakeWord, Kokoro et domicile isolés |
| B — Baseline tests | Terminé | `TEST_BASELINE_2026-10-06.md`; nouvelle validation finale à reporter ci-dessous |
| C — Contrats et secrets | Terminé | contrats `/v1` archivés; valeurs sensibles non reproduites |
| D — Périmètre IA | Terminé | ADR 0001 : OpenAI/API cloud, OpenWakeWord local, retrait futur Ollama/Whisper/Kokoro |
| E — Identité et sessions | Terminé | ADR 0002 et spike Desktop/Android : Keycloak, Authorization Code + PKCE S256 |
| F — Stockage et restauration | Terminé | ADR 0003, migrations v1, tests et drill réel de sauvegarde/restauration |
| G — Récupération propriétaire | Conception terminée | ADR 0004 et runbook hors ligne; implémentation avec le modèle d'identité au chantier 2 |

## Décisions de passage

- Les chantiers 1 (IA cloud) et 2 (identité) peuvent démarrer sur PC.
- Le chantier 1 ne doit pas modifier le lot OpenWakeWord existant avant son intégration dédiée.
- L'edge public reste interdit tant que le chantier 8 n'est pas validé.
- SQLite reste retenu jusqu'au gate PostgreSQL documenté dans l'ADR 0003.

## Validation finale

- Jarvis : 49 suites, 454 tests, lint, build, typecheck et capacités verts.
- Agora : 8 suites, 87 tests, build et typecheck verts.
- Desktop : 16 fichiers, 71 tests; build frontend et `cargo check` verts.
- Desktop E2E : 12 scénarios verts, 1 runtime réel ignoré faute de secrets rotés.
- Android : 21 tests, lint et assemblage debug verts.
- Home Assistant : `docker compose ... config --quiet` vert avec placeholders éphémères.
- Restauration réelle : 17 threads et 43 messages, intégrité et hash identiques.

La phase 0 est clôturée. L'exposition publique reste conditionnée à la réalisation du chantier 8 et à l'utilisation de credentials dédiés à l'environnement cible.

Les artefacts temporaires du drill de restauration ont été supprimés après conservation de leur hash et de leurs compteurs. Aucun composant OAuth Android tiers n'a été ajouté au binaire pendant le spike.
