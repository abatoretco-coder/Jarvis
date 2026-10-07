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

## Bootstrap restant

Le premier compte humain doit encore être inscrit dans Keycloak. Tant que son
`subject` n’est pas placé dans `OIDC_BOOTSTRAP_OWNER_SUBJECT` et que Jarvis
n’est pas redémarré, aucun compte n’obtient le rôle propriétaire. Cette étape
interactive est volontaire : aucun mot de passe utilisateur ou propriétaire
n’est généré par le déploiement.

Le profil reste strictement local et ne doit pas être exposé sur Internet.
