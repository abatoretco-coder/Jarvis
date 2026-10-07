# Associer les appareils Home Assistant au plan

Cette opération se fait une fois par appareil. Elle ne modifie jamais le dessin du logement.

1. Démarrer Home Assistant et Jarvis sur le PC.
2. Ouvrir dans le panel propriétaire **Permissions et appareils** pour relever l’`entity_id` et vérifier sa disponibilité.
3. Ouvrir `config/homes/home_fr_paris_10_fsm_236_lot_204/home.json`.
4. Dans la pièce concernée, ajouter un objet dans `automation.spaces[].entities` :

```json
{
  "deviceId": "living-tv",
  "entityId": "media_player.television_salon",
  "name": "Télévision"
}
```

5. Redémarrer Jarvis, ouvrir **Domicile**, puis vérifier l’état avant d’envoyer une commande.

## Nommage conseillé

- `bedroom-main-light`
- `living-tv`
- `living-vacuum`
- `office-heater`

Le `deviceId` est l’identité durable dans Jarvis. En cas de remplacement d’un appareil, conserver ce champ et changer seulement `entityId`.

## Garde-fous

- Ne jamais copier de token Home Assistant dans `home.json`.
- Ne mapper que des entités observées dans l’inventaire propriétaire.
- Les invités sont limités aux lumières et médias, même si un autre appareil est présent dans le fichier.
- Les commandes de serrure, alarme, caméra et chauffe-eau ne sont pas exposées dans cette facette.
