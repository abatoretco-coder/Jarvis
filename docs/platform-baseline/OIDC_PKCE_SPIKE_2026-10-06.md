# Spike OIDC + PKCE Desktop et Android

Date : 2026-10-06.

## Résultat

Le fournisseur retenu est Keycloak. Le protocole commun est Authorization Code + PKCE S256 avec navigateur système et clients publics sans secret embarqué.

## Desktop

Le spike `Jarvis Desktop/src/auth/oidcPkce.ts` prouve :

- le challenge S256 avec le vecteur RFC 7636 ;
- une authorization URL HTTPS avec `code`, `openid profile email offline_access`, `state`, `nonce` et PKCE ;
- l'absence de `client_secret` ;
- le rejet des callbacks ayant un URI, un état ou un nombre de codes inattendu.

La production ajoutera les plugins Tauri deep-link, single-instance et Stronghold. Sous Windows, les deep links peuvent arriver dans une nouvelle instance et doivent rester traités comme une entrée hostile.

## Android

Le spike compile une politique native sans dépendance OAuth embarquée. Les tests refusent HTTP et tout redirect URI non enregistré. Le chantier 2 sélectionnera le composant navigateur maintenu après revue de sécurité. Le callback public devra être un HTTPS App Link vérifié; le schéma privé du spike est limité au développement.

## Vérification exécutée

- Desktop : 3 tests PKCE/callback verts.
- Android : `OidcClientPolicyTest`, 2 tests verts, sans dépendance OAuth ajoutée à l'APK.

## Travail reporté au chantier 2

Discovery OIDC, ouverture du navigateur, échange du code, stockage chiffré des tokens, refresh, logout, validation JWT serveur et écrans `pending`/connexion. Aucun flux de production n'a été activé par le spike.
