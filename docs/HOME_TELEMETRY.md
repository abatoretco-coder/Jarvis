# Historique domotique Jarvis

Jarvis conserve désormais un historique local des entités Home Assistant rattachées au catalogue de la maison. Home Assistant reste la source de vérité instantanée ; Jarvis en importe périodiquement l'historique et le conserve dans sa base SQLite afin de permettre des analyses croisées durables.

## Données conservées

- états et changements des lampes, interrupteurs, radiateurs et chauffe-eau ;
- températures, humidité, puissance et énergie lorsque les capteurs correspondants sont mappés ;
- température extérieure et conditions météo locales (humidité, pression, vent, nébulosité) ;
- consignes et attributs utiles du chauffage (`current_temperature`, `temperature`, `hvac_action`, etc.) ;
- métadonnées de rattachement à la pièce et à l'équipement.

Seules les entités déclarées dans `config/homes/<homeId>/home.json` sont importées. Les attributs sont filtrés par liste blanche : les libellés privés, images, jetons et autres attributs non nécessaires ne sont pas copiés.

Les sources contextuelles qui ne correspondent pas à un appareil contrôlable, comme la météo extérieure ou un futur compteur général, peuvent être déclarées dans `telemetry.entities`. La température extérieure de référence est `sensor.temperature_exterieure_jarvis` et les conditions proviennent de `weather.forecast_maison`.

Le chauffe-eau inclut son interrupteur d'alimentation. Les sondes de référence de la chambre et du bureau sont déjà déclarées ; tant que Home Assistant les expose comme `unavailable` ou ne les expose pas, Jarvis peut historiser cette indisponibilité mais ne peut pas produire une mesure de température inexistante.

## Synchronisation et conservation

Au démarrage, Jarvis récupère par défaut les quatorze derniers jours disponibles dans Home Assistant, puis synchronise toutes les cinq minutes. Le curseur est persistant : un redémarrage reprend après la dernière synchronisation réussie. Une nouvelle entité bénéficie de sa propre fenêtre de rattrapage même si le foyer possède déjà un curseur récent. Un retard important est parcouru par tranches bornées, sans sauter de période, jusqu'au rattrapage complet. Les doublons sont ignorés par clé `(maison, entité, horodatage)`.

Les transitions historiques réelles sont conservées sans transformer l'état de bordure artificiel renvoyé par Home Assistant en événement. En parallèle, les grandeurs thermiques, énergétiques et météo reçoivent un échantillon explicite toutes les cinq minutes, y compris lorsqu'elles sont stables. Cela permet un rééchantillonnage fiable pour les futurs modèles d'inertie et de déperdition.

La conservation est illimitée par défaut et reste isolée par `home_id`. Une valeur positive de `HOME_TELEMETRY_RETENTION_DAYS` peut réactiver une purge pour une installation qui le souhaiterait.

Variables de configuration :

```dotenv
HOME_TELEMETRY_ENABLED=true
HOME_TELEMETRY_SYNC_INTERVAL_MS=300000
HOME_TELEMETRY_INITIAL_LOOKBACK_HOURS=336
HOME_TELEMETRY_MAX_CATCHUP_DAYS=14
HOME_TELEMETRY_RETENTION_DAYS=0
```

## API

- `GET /v1/home/telemetry/entities` : entités connues et état de la dernière synchronisation ;
- `GET /v1/home/telemetry/history?entityId=...&from=...&to=...&limit=...` : points historiques d'une entité.

Ces routes utilisent exclusivement `ACTIVE_HOME_ID`, exigent la permission `home`, refusent les invités et désactivent la mise en cache HTTP.

## Ajout du Linky

Lorsque le compteur Linky sera connecté à Home Assistant, ajouter ses entités de puissance et d'énergie au catalogue de la maison. Elles seront alors collectées par le même mécanisme et pourront être corrélées aux changements d'état du chauffage, du chauffe-eau et de l'éclairage. Les capteurs cumulés doivent conserver leurs attributs Home Assistant `device_class`, `state_class` et `unit_of_measurement` pour distinguer correctement puissance instantanée et énergie cumulée.
