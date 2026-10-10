# Pilotage du robot — 9 octobre 2026

## Périmètre livré

Le robot `Nono le Robot` est déclaré dans la cuisine. Jarvis expose le même contrat de pilotage à ses trois clients : Desktop, Web et Android.

Commandes disponibles :

- démarrer et arrêter le nettoyage ;
- retourner à la base ;
- localiser le robot ;
- choisir la puissance d'aspiration ;
- choisir le niveau de lavage.
- charger l'historique des nettoyages sur les 30 derniers jours ;
- sélectionner une ou plusieurs pièces et un à trois passages ;
- lancer un nettoyage ciblé avec les niveaux d'aspiration et de lavage sélectionnés.
- piloter la station : vider le bac, laver les serpillières, démarrer ou arrêter leur séchage ;
- consulter les statistiques de la session, les totaux et l'usure des brosses, du filtre et des serpillières.

État affiché : disponibilité, activité, batterie, état de charge, puissance d'aspiration et niveau de lavage.

## Architecture

Les clients ne contactent jamais Xiaomi ni Home Assistant directement. Ils appellent l'API Jarvis authentifiée, qui contrôle les droits puis traduit la commande vers les entités Home Assistant explicitement associées au robot.

Le démarrage ciblé utilise exclusivement `xiaomi_vacuum_local.clean_rooms`. Jarvis récupère d'abord les pièces réellement publiées par le connecteur et rejette tout identifiant inconnu. Il n'existe aucun repli vers un nettoyage complet.

Les commandes vocales exactes `lance le robot`, `arrête le robot` et `renvoie le robot à sa base` utilisent les quick actions déterministes. Une commande non reconnue n'est pas remplacée silencieusement par une action approximative.

## Sécurité et erreurs

- Le rôle `guest` ne peut pas piloter le robot.
- Les options d'aspiration et de lavage sont validées contre la liste réellement publiée par Home Assistant avant exécution.
- Une entité auxiliaire absente ou indisponible produit une erreur explicite ; aucun fallback ne déclenche une autre commande.
- Modifier l'entité principale du robot supprime ses anciennes associations auxiliaires afin d'éviter de commander un autre appareil.
- Les scènes sont intégralement prévalidées avant la première commande.
- L'historique est chargé à la demande, borné à 30 jours et limité à 50 sessions.

## Configuration actuelle

- Robot : `vacuum.xiaomi_de_1150317461_c102gl`
- Batterie : `sensor.xiaomi_de_1150317461_c102gl_battery_level_p_3_1`
- Charge : `sensor.xiaomi_de_1150317461_c102gl_charging_state_p_3_2`
- Localisation : `button.xiaomi_de_1150317461_c102gl_position_a_7_1`
- Aspiration : `select.xiaomi_de_1150317461_c102gl_mode_p_2_3`
- Lavage : `select.xiaomi_de_1150317461_c102gl_mop_mode_p_4_5`
- Station : boutons Xiaomi `start_dust_arrest`, `start_mop_wash`, `start_dry` et `stop_dry`
- Télémétrie : temps et surface de session, compteurs cumulés, durée de séchage restante et niveaux d'usure

## Activation restante

Le contrôle global, la télémétrie et l'historique utilisent déjà l'intégration officielle Xiaomi Home. Le nettoyage par pièce nécessite en plus l'activation de l'intégration locale dédiée au X20+, car elle seule expose les segments de carte et vérifie le démarrage effectif du robot. Cette activation requiert une authentification Xiaomi Cloud afin de télécharger la carte et les noms de pièces.

Le mode « aspiration seule » n'est pas exposé de manière fiable par les connecteurs actuellement validés pour ce firmware. Jarvis ne l'affiche donc pas et n'envoie pas une valeur non documentée. Il sera ajouté uniquement lorsqu'une commande déterministe aura été validée sur le robot réel.

## Validation

La validation automatisée couvre le contrat API, la télémétrie, les droits invités, la validation des segments Xiaomi, l'historique, les cibles Home Assistant, les options invalides, le changement d'entité, les scènes, le rendu Desktop/Web et le build Android. Les tests ne démarrent pas physiquement le robot : Home Assistant est simulé pour les commandes d'écriture.
