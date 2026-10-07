# Phase 7A — Domicile simple et carte 2D

Statut : **facette logicielle PC terminée** le 2026-10-06. Le chantier 7 global reste ouvert jusqu’au mapping et aux essais des appareils réels.

## Règle produit

Jarvis n’est pas un SaaS. Il expose trois niveaux humains, un seul par compte :

1. `owner` — propriétaire et administration complète ;
2. `resident` — membre du foyer avec données personnelles et commandes domestiques usuelles ;
3. `guest` — invité limité aux lumières et médias.

Les anciens rôles `admin` sont migrés vers `owner`. Les comptes de service restent séparés et invisibles dans cette liste.

## Livré

- Migration SQLite v8 idempotente des anciens administrateurs et memberships.
- API `GET /v1/home` alimentée par le `home.json` versionné du domicile actif.
- Identifiant d’appareil Jarvis stable et distinct de l’`entity_id` Home Assistant : un remplacement matériel ne modifie ni la géométrie ni l’interface.
- Contrat explicite par appareil : capacités, disponibilité et niveau de risque.
- Réconciliation bornée avec les états Home Assistant ; une entité non mappée n’est jamais exposée par cette API.
- Filtrage serveur : un invité ne reçoit que les domaines `light` et `media_player`; une caméra nécessite la permission `cameras`.
- API `POST /v1/home/actions` avec liste fermée : lumières, média, robot et chauffage entre 12 °C et 25 °C.
- Refus des appareils non mappés et des actions non supportées.
- Vue Desktop « Domicile » : plan 2D, choix de pièce, état de disponibilité, consigne de chauffage et commandes directes sans OpenAI.
- Rafraîchissement automatique toutes les 10 secondes lorsque l’application est visible, plus reprise immédiate au retour au premier plan.
- Inventaire admin corrigé : « mappé » signifie présent dans le domicile Jarvis, pas seulement affecté à une zone Home Assistant.
- Réponses Home Assistant en erreur normalisées sans fuite de détail et état domestique marqué `no-store`.
- Fonctionnement OIDC ou clé de service historique pendant la préproduction PC.

## Choix de simplicité

- Aucun éditeur de plan générique dans cette tranche.
- Aucun moteur de règles ou de scènes parallèle à Home Assistant.
- Pas de WebSocket spécifique : pour cette installation personnelle, le rafraîchissement borné satisfait la convergence sans service supplémentaire.
- `home.json` reste la source canonique pour le mapping pièce–entité.

## Format de mapping

Chaque pièce accepte des objets simples dans `automation.spaces[].entities` :

```json
{
  "deviceId": "living-main-light",
  "entityId": "light.salon_plafonnier",
  "name": "Plafonnier"
}
```

`deviceId` est choisi une fois dans Jarvis et ne change pas. Seul `entityId` est remplacé si l’entité Home Assistant change. Les anciennes chaînes `"light.salon"` restent lisibles pour compatibilité, mais ne doivent plus être utilisées pour les nouveaux appareils.

## Validation

- Backend : 63 suites / 555 tests, lint, build, typecheck et contrôle des 13 capacités réussis.
- Desktop : 23 fichiers / 94 tests et build TypeScript/Vite réussis.
- Tests ajoutés : identité stable, refus des identifiants HA bruts, température obligatoire et bornée, mode HA hors ligne, erreur de commande normalisée et contrôle de chauffage UI.
- Le plan réel ne contient encore aucune entité Home Assistant ; l’interface affiche donc correctement les pièces vides jusqu’au relevé matériel.
- Le connecteur HA est configuré sur le PC mais l’instance était injoignable lors du contrôle du 2026-10-06 ; aucun parcours physique n’est donc déclaré validé.

## Suite du chantier 7

1. Relever les `entity_id` réels des lumières, TV, radiateurs, chauffe-eau, robot, sonnette et caméras.
2. Les associer aux six pièces dans `config/homes/.../home.json`.
3. Tester physiquement lumière, TV, robot et chauffage.
4. N’ajouter un flux poussé que si le rafraîchissement de 10 secondes se révèle insuffisant en usage réel.
