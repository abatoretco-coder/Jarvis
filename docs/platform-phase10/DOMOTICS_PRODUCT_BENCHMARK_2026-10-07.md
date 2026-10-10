# Jarvis Home — benchmark et cible produit

Date : 2026-10-07

## Positionnement

Jarvis n'est pas une télécommande de plus. La valeur cible est un cockpit unique du domicile :

- le même catalogue d'équipements, de pièces et d'actions sur mobile, desktop et conversation ;
- une action enregistrée une fois, exécutable par bouton ou par phrase vocale ;
- aucun renvoi vers Home Assistant ou vers l'application du constructeur pour l'usage courant ;
- une panne ou une fonction indisponible reste explicite, sans fallback silencieux de moindre qualité.

## Benchmark retenu

| Produit | Force à reprendre dans Jarvis |
| --- | --- |
| Apple Home | catégories agrégées, scènes, automatisations par heure/présence/capteur, commande Siri |
| Google Home | favoris réordonnables, commandes rapides, curseurs directement dans les tuiles, routines avec déclencheurs/conditions/actions |
| SmartThings | plan 2D/3D opérationnel, filtres éclairage/température/énergie, routines visibles sur la carte |
| Homey | moteur lisible « Quand / Et / Alors », tableaux de bord personnalisables, historique et énergie, rôles simples |
| Home Assistant | séparation saine entre scène, script et automatisation ; large couverture d'équipements ; voix et tableaux de bord |
| Philips Hue | scènes lumineuses, couleurs/effets, transitions réveil/sommeil, présence et synchronisation média |
| Roborock | pièces/zones, modes et puissance, ordre de nettoyage, cartes multi-étages, zones interdites, entretien |
| Tado / Nest | planning pièce par pièce, consigne temporaire, retour au planning, présence, fenêtre ouverte, suivi énergétique |

## Modèle fonctionnel Jarvis

Toutes les interfaces consomment le même moteur :

1. **Commande** — une opération atomique sur un équipement.
2. **Action rapide** — une commande nommée, favorite, avec zéro à cinq phrases vocales.
3. **Scène** — plusieurs états appliqués ensemble, par exemple « Cinéma ».
4. **Routine** — déclencheur + conditions + scène/script, par exemple « départ du foyer ».
5. **Vue** — domicile, pièce, catégorie ou usage, sans dupliquer la logique d'exécution.

## Capacités attendues par famille

### Lumière

- marche/arrêt, intensité, température de blanc, couleur, effet ;
- groupe par pièce/zone ; scène ; transition ; minuterie ; présence ;
- état agrégé et identification claire des équipements hors ligne.

### Chauffage et eau chaude

- consigne et mode, durée de la dérogation, retour au planning ;
- planning hebdomadaire par pièce, présence/absence, fenêtre ouverte ;
- température/humidité, historique, consommation et sécurité antigel.

### Robot

- démarrer/pause/base ; pièce, zone, ordre ; aspiration/lavage ;
- carte, zones interdites, progression, batterie, consommables et erreurs.

### Média

- marche/arrêt, lecture/pause, volume, source, destination ;
- favoris, reprise, groupes, scène cinéma et synchronisation lumière.

### Accès et sécurité

- sonnette, caméra, serrure, ouverture, alarme et historique ;
- confirmation explicite pour les actions sensibles ;
- permissions owner/résident/invité appliquées côté serveur.

### Énergie et qualité du logement

- consommation instantanée et historique par appareil/zone ;
- eau, température, humidité, qualité de l'air, fumée et fuite ;
- alertes actionnables et routines de réduction de consommation.

## Roadmap

### P0 — Socle unifié (réalisé dans cette tranche)

- actions rapides persistées dans le fichier versionné du domicile ;
- création/suppression owner-only ; exécution selon les droits du compte ;
- boutons mobiles ; phrase vocale exacte sans interprétation LLM ;
- validation des capacités, détection des phrases ambiguës, audit et rate limiting ;
- mêmes erreurs explicites que le pilotage direct.

### P1 — Contrôles riches et personnalisation

Statut : **partiel** — luminosité et volume livrés ; couleur, source média, modes et réordonnancement restent à faire.

- édition et réordonnancement des favoris ; plusieurs phrases par action ;
- luminosité/couleur, volume/source, chauffage avec durée, robot par pièce/zone ;
- composants identiques sur desktop et Android ; widgets et écran verrouillé ensuite.

### P2 — Scènes et routines

Statut : **socle livré** — ambiances parallèles et horaires hebdomadaires actifs ; conditions, délais et autres déclencheurs restent à faire.

- scène multi-équipements avec stratégie d'échec explicite et résultat par étape ;
- moteur déclencheur/conditions/actions, simulation et journal d'exécution ;
- horaires, présence, capteurs, géolocalisation et lever/coucher du soleil.

### P3 — Cockpit spatial et intelligence du logement

- équipements pilotables sur plan 2D puis vue 3D ; états et alertes sur la carte ;
- énergie, historiques, maintenance et tableaux de bord par usage ;
- suggestions facultatives : Jarvis propose, l'owner valide, aucun changement silencieux.

## Benchmark approfondi des usages et automatisations

### Modèle commun observé

Les solutions mûres convergent vers trois blocs :

- **déclencheur** : horaire, lever/coucher du soleil, présence, capteur, état d'un appareil, bouton ou voix ;
- **conditions** : jours, plage horaire, personne présente, pièce occupée, état d'un autre appareil ;
- **actions** : état d'un équipement, scène, média, notification, délai ou séquence.

Jarvis doit afficher ce modèle simplement dans l'APK, tout en conservant un moteur typé et validé côté serveur.

### Éclairage programmé

Usages à couvrir :

- lever progressif : luminosité et température de couleur évoluent sur une durée définie ;
- profil circadien : blanc froid et lumineux le jour, chaud et atténué le soir ;
- extinction à heure fixe, après une durée ou après absence dans la pièce ;
- chemin de nuit : quelques lampes à faible intensité sur détection de mouvement ;
- simulation de présence et variation selon lever/coucher du soleil ;
- dérogation manuelle avec durée claire : temporaire, jusqu'au prochain créneau ou permanente.

Un simple `turn_on` ne suffit donc pas. Une étape lumière doit pouvoir porter au minimum : intensité, couleur ou température de blanc, transition et durée éventuelle.

### Ambiances croisées

Une ambiance est une **scène multi-domaines** appliquant des états cohérents ensemble :

- **Cinéma** : lumières atténuées et chaudes, volets fermés, TV et système audio allumés, volume défini ;
- **Dîner** : zone repas chaude, autres lumières réduites, playlist et volume doux ;
- **Concentration** : éclairage blanc neutre, playlist dédiée, température de confort, notifications domestiques réduites ;
- **Réveil** : lumière progressive, volets, chauffage, informations puis musique ;
- **Coucher** : lumière chaude puis extinction, média arrêté, chauffage nuit, portes vérifiées ;
- **Retour** : éclairage adapté à l'heure, température de confort et musique facultative ;
- **Départ** : extinction, média arrêté, chauffage éco, robot éventuellement lancé et sécurité activée.

La scène décrit des états simultanés. Une séquence ou un script ajoute l'ordre, les délais et les décisions.

### Automatisations prioritaires

1. Horaires récurrents et événements solaires.
2. Présence du foyer et occupation d'une pièce.
3. Capteurs : mouvement, ouverture, température, humidité, fuite, fumée.
4. État des appareils : TV allumée, robot sur sa base, média en lecture.
5. Consommation et tarifs : chauffe-eau, recharge ou appareils décalables.
6. Commande ponctuelle : « la prochaine fois que je rentre », puis suppression automatique.

### Règles de fonctionnement Jarvis

- Un **bouton** exécute directement une commande ou une scène typée. Il ne passe jamais par un LLM.
- Toute **voix** entre par `/v1/ingest`, donc par Jarvis. Une phrase personnalisée exacte peut être reconnue localement par Jarvis ; une formulation libre passe par le routeur conversationnel. Dans les deux cas, seul l'exécuteur domotique autorisé agit sur les équipements.
- Le LLM peut comprendre l'intention ou proposer une routine, mais il ne reçoit jamais le droit d'appeler librement un service ou une entité Home Assistant.
- Une scène retourne un résultat par étape. Un échec partiel n'est jamais présenté comme un succès complet.
- Une automatisation est testable, activable/désactivable et historisée.
- Les conflits sont détectés avant activation, notamment deux routines opposées au même horaire.
- Priorité proposée : sécurité > commande manuelle récente > scène manuelle > routine horaire > optimisation énergétique.
- Les actions sensibles conservent confirmation et droits serveur, quel que soit le canal d'entrée.

### Écrans à construire

- **Actions** : favoris réordonnables et boutons instantanés.
- **Ambiances** : création visuelle multi-équipements, aperçu et test.
- **Routines** : assistant simple « Quand / Si / Alors », sans YAML.
- **Planning** : vue semaine pour lumière, chauffage et appareils programmés.
- **Historique** : déclencheur, étapes, durée, résultat et cause d'échec.
- **Dérogations** : état manuel actif, durée restante et bouton de retour au planning.

## Sources primaires

- Apple Home : https://support.apple.com/en-gb/102313
- Google Home : https://support.google.com/googlehome/answer/15684394
- SmartThings Map View : https://www.samsung.com/us/support/answer/ANS10004030/
- Homey : https://www.homey.app/en-us/
- Home Assistant : https://www.home-assistant.io/docs/automation/which-tool-to-use/
- Philips Hue : https://www.philips-hue.com/en-us/explore-hue/features
- Roborock : https://global.roborock.com/pages/roborock-app
- Tado : https://help.tado.com/en/articles/3405566-can-i-adjust-the-temperature-manually-on-my-app-how-long-does-this-manual-change-stay-active
- Google Nest : https://support.google.com/googlehome/answer/9243487
