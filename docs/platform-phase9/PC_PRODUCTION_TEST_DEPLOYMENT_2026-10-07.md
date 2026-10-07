# Déploiement PC production-test — 7 octobre 2026

## État déployé

Le profil `pc-preprod-full` est actif sur le PC :

- API Jarvis : `127.0.0.1:8090` ;
- Keycloak : `127.0.0.1:8180` ;
- aucun port lié à une interface LAN ou publique ;
- conteneur Jarvis en lecture seule, sans capacités Linux et avec
  `no-new-privileges` ;
- secrets locaux provisionnés hors Git ;
- secrets d’administration et de sauvegarde protégés par Windows DPAPI.

Le Desktop Tauri release a été reconstruit, les installateurs MSI et NSIS ont
été produits, puis le binaire release a été démarré.

## Contrôles exécutés

- `/ready` : `ready`, schéma SQLite 8 ;
- discovery OIDC : issuer local attendu ;
- JWKS : deux clés publiées ;
- `/v1/auth/me` anonyme : `401` ;
- jeton de service généré : accepté ;
- image runtime : aucune vulnérabilité détectée ;
- sauvegarde chiffrée complète : base, home-store et identité ;
- drill chiffrement, restauration et intégrité : réussi ;
- Desktop release et deux installateurs : produits ;
- processus Desktop : lancé et réactif.

## Bootstrap propriétaire

Le compte nominatif propriétaire a été créé dans Keycloak, son adresse a été
marquée comme vérifiée et son `subject` a été placé dans
`OIDC_BOOTSTRAP_OWNER_SUBJECT`. Un mot de passe temporaire impose son
remplacement à la première connexion. Jarvis attribuera alors le rôle
propriétaire, créera le foyer initial et rattachera les données historiques.

Le profil reste strictement local et ne doit pas être exposé sur Internet.
