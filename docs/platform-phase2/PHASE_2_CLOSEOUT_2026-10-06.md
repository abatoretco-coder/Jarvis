# Phase 2 — Rapport de clôture PC

Date : 2026-10-06.

## Décision

La phase 2 est clôturée pour le socle PC. Le chantier 3 peut commencer sans dette d'authentification bloquante. L'activation avec un realm Keycloak réel et le port Android sont des étapes de déploiement/client ultérieures ; aucun endpoint ne doit être exposé sur Internet avant les chantiers 8 à 10.

## Relecture finale et corrections

- `/v1/ingest` n'est plus autorisé globalement par la seule permission `chat`. Le contrôle est réalisé au point d'exécution de la capacité sélectionnée.
- Les fast paths musique, agenda, mail, NAS, météo locale et maison sont couverts, ainsi que la liste/confirmation/annulation des mutations en attente et les routeurs sémantiques/LLM.
- Les services techniques à portée limitée peuvent entrer dans le dispatcher, mais ne peuvent exécuter que leurs permissions déclarées.
- Le Desktop possède maintenant le parcours natif complet : discovery HTTPS, PKCE S256, navigateur système, deep link, instance unique, échange de code, refresh, logout et lecture de l'état Jarvis.
- Le refresh token est chiffré dans Stronghold. Le mot de passe du coffre est généré par CSPRNG et conservé dans le trousseau natif via `keyring`.
- Les écrans distinguent connexion, attente d'approbation, compte actif, compte indisponible et erreur ; les changements d'état sont annoncés par une live region.
- La chaîne Desktop a été remise à niveau afin de supprimer tous les avis de dépendances de sévérité haute.

## Tests ajoutés

- table de correspondance routes/agents vers permissions ;
- principal de service borné, service legacy et compte humain actif/suspendu ;
- passage de `/v1/ingest` à travers le hook pour une clé de service non-`chat` ;
- refus réel d'un appel Spotify par un service `chat` et succès par un service `music` ;
- renouvellement OIDC sans secret client et conservation du refresh token en l'absence de rotation ;
- rendu UI de l'état `pending`, adresse du compte, logout et validation des champs OIDC.

## Preuves de validation

| Surface | Commande | Résultat |
| --- | --- | --- |
| Jarvis | `npm run verify` | vert : lint, build, typecheck, 57 suites, 515 tests, 13 capacités |
| Jarvis dépendances | `npm audit --audit-level high` | vert : 0 vulnérabilité |
| Desktop unité | `pnpm test` | vert : 17 fichiers, 77 tests |
| Desktop build | `pnpm build` | vert |
| Desktop E2E hermétique | `pnpm test:e2e` | vert : 12 scénarios, 1 runtime réel ignoré faute de variables |
| Desktop natif | `cargo check` puis `pnpm tauri build --debug --no-bundle` | vert : exécutable Windows généré |
| Desktop dépendances | `pnpm audit --audit-level high` | vert : aucune vulnérabilité haute ; 2 faibles et 2 modérées restent dans l'outillage |
| UI | capture 1440 × 1000 | état non connecté et configuration OIDC relus visuellement |

## Limites assumées

- Aucun test de connexion contre un realm de production n'a été exécuté : issuer, client, redirect URI et subject du premier propriétaire doivent être créés au déploiement PC.
- Le scénario Playwright `runtime PC` reste volontairement ignoré sans `E2E_RUNTIME_JARVIS_URL` et `E2E_RUNTIME_API_KEY`.
- Jest signale encore des handles asynchrones ouverts et force la sortie après une suite pourtant verte ; cette dette d'outillage n'altère pas les assertions mais doit être supprimée avant la préproduction longue durée.
- Le bundle Desktop dépasse encore 500 Ko et mérite un chantier de découpage, sans impact fonctionnel sur cette phase.
- Le link debug Windows remonte l'absence du PDB tiers `libsodium.pdb` ; l'exécutable est néanmoins produit et cette alerte n'affecte pas le binaire release.

## Activation PC

1. Créer le client public `jarvis-desktop` avec PKCE S256 et le redirect exact `com.jarvis.desktop:/oauth/callback`.
2. Configurer `OIDC_ENABLED`, issuer, audience et subject propriétaire côté serveur.
3. Désactiver les clés legacy avec `ALLOW_LEGACY_API_KEYS=false` hors développement.
4. Installer puis lancer le binaire Tauri afin que le protocole deep-link soit enregistré.
5. Tester première connexion `pending`, approbation propriétaire, renouvellement après redémarrage, suspension et logout.
