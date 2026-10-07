# Phase 8 — Edge et cybersécurité

Statut au 2026-10-07 : **socle PC livré, activation Internet interdite**. La clôture NAS reste conditionnée au réseau réel, au tunnel retenu et à un pilote limité.

## Architecture retenue

Un seul edge TLS appelle l’API Jarvis. Home Assistant, Keycloak, SQLite, les métriques NAS et les interfaces d’administration des services ne sont jamais publiés directement.

```text
Client Desktop/mobile
        │ HTTPS + OIDC
        ▼
Edge unique / tunnel sortant
        │ réseau privé + secret d’origine
        ▼
Jarvis API ─── Home Assistant / identité / données
```

Sur PC, `Caddyfile.pc-preprod` écoute uniquement sur `127.0.0.1:8443` avec une autorité TLS locale. Il sert à répéter le contrat proxy sans ouvrir le poste sur le LAN ou Internet. Le NAS conservera le même contrat applicatif mais remplacera le certificat local par le tunnel ou le certificat public retenu.

## Contrôles livrés

- démarrage refusé en mode public sans HTTPS canonique, OIDC, proxy explicitement approuvé et secret d’origine de 32 caractères minimum ;
- clés API historiques interdites en mode public ; les comptes de service nominatifs et limités restent autorisés ;
- confiance `X-Forwarded-*` limitée à une liste d’IP/CIDR, jamais à tous les intermédiaires ni à un nombre de sauts ;
- contrôle constant-time du secret injecté par l’edge, du protocole HTTPS et du hostname public unique ;
- CORS exact, préflight borné et absence de wildcard ; les clients natifs sans en-tête `Origin` restent compatibles ;
- CSP restrictive pour l’API, anti-framing, `no-store`, HSTS uniquement après passage HTTPS par l’edge ;
- limites indépendantes par IP et par compte/service, avec quota renforcé pour admin, intégrations, NAS et commandes du logement ;
- limites existantes sur taille des requêtes, appels audio et budgets OpenAI conservées ;
- journalisation de sécurité sans token, secret proxy ni corps sensible.
- contexte Docker excluant secrets, données et bases locales ; npm absent du runtime et paquets Alpine corrigés avant livraison de l’image.

## Limites volontaires

- aucun port ni tunnel public n’est activé dans cette phase PC ;
- aucun WAF maison : le filtrage volumétrique restera celui de l’edge, complété par les limites Jarvis ;
- aucune interface distante vers le système, Docker ou le shell ;
- le HSTS PC est court (`300` secondes). Le passage à un an ne se fait qu’après validation TLS du vrai hostname.

## Validation

- `npm run security:dependencies` : audit des dépendances de production ;
- `npm run security:abuse` : authentification, IDOR, élévation de privilège, replay, isolation des données et épuisement IA ;
- `npm run security:edge-config` : validation du Caddyfile avec l’image officielle Caddy épinglée ;
- `npm run security:image` : reconstruction puis scan Trivy épinglé de l’image pour les vulnérabilités corrigibles HIGH/CRITICAL et les secrets ;
- `npm run verify` : validation complète du backend.

## Conditions restant à valider sur NAS

1. Le firewall ou le réseau de conteneurs empêche toute connexion directe à l’origine Jarvis.
2. Le tunnel sortant ou reverse proxy ne publie qu’un hostname applicatif.
3. Les interfaces Home Assistant, Keycloak, Docker et NAS restent privées.
4. La révocation et la restauration du runbook sont répétées avec les volumes NAS.
5. Un compte invité compromis est testé depuis un réseau externe avant ouverture aux proches.
