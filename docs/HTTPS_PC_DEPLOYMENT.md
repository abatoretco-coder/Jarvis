# HTTPS sur le PC Jarvis

Jarvis utilise une seule origine HTTPS pour l'API et la connexion OIDC. Home Assistant, Keycloak et l'origine Node ne sont jamais publiés directement.

## Validation locale

```powershell
cd 'D:\Projets\NAS\All VM\Jarvis'
.\scripts\https-runtime.ps1 configure -Mode rehearsal
.\scripts\https-runtime.ps1 start
.\scripts\https-runtime.ps1 test
```

L'origine de répétition est `https://jarvis.localhost:8443`. Son certificat est émis par la CA locale de Caddy : ce mode sert aux tests techniques, pas aux téléphones ni à Internet.

## Activation publique

Déploiement PC actif : `https://jarvis-abato.duckdns.org`.

Prérequis :

- un nom DNS public dédié dont l'enregistrement A pointe vers l'IPv4 publique de la Bbox ;
- une réservation DHCP Bbox pour le PC (`192.168.1.2`) ;
- les redirections TCP Bbox `80 -> 192.168.1.2:80` et `443 -> 192.168.1.2:443` ;
- les règles entrantes Windows limitées à TCP 80 et 443 ;
- aucun transfert vers 8090, 8180 ou 8123.

Puis :

```powershell
.\scripts\https-runtime.ps1 configure -Mode public -PublicBaseUrl 'https://jarvis-abato.duckdns.org'
.\scripts\https-runtime.ps1 start
.\scripts\https-runtime.ps1 test
```

Le DNS dynamique DuckDNS est rafraîchi par la tâche planifiée Windows `Jarvis DuckDNS`, toutes les cinq minutes. Son jeton est conservé uniquement sous forme chiffrée DPAPI dans le répertoire d'exécution ignoré par Git.

Le mode public refuse les IP, les noms locaux et les ports HTTPS non standard. Caddy obtient et renouvelle automatiquement le certificat public. La clé entre Caddy et l'origine est aléatoire, protégée par Windows DPAPI et jamais écrite dans le dépôt.

Le proxy public ne publie que le realm `jarvis`; le realm administratif Keycloak `master`, la console et les métriques restent inaccessibles depuis Internet. HSTS est appliqué à l'API, à l'application Web et aux pages de connexion. Les clients publics Web, Desktop et Android imposent PKCE `S256`.

Les identités machines sont limitées par identifiant et par route : `home-assistant-pc` ne peut appeler que `POST /v1/ingest`, tandis que `pc-agent` ne peut appeler que ses routes de polling et de confirmation. Desktop n'utilise plus de clé statique et s'authentifie exclusivement par OIDC.

## Contrôles après publication

- tester l'URL depuis les données mobiles, Wi-Fi désactivé ;
- vérifier que `/ready` et `/realms/jarvis/.well-known/openid-configuration` répondent en HTTPS ;
- vérifier que `http://127.0.0.1:8090/ready` renvoie `403` ;
- vérifier que les ports 8090, 8180 et 8123 sont injoignables depuis Internet ;
- basculer ensuite la configuration embarquée de Desktop et Android sur la même URL HTTPS, puis reconstruire les deux clients.

La publication n'est considérée terminée qu'après un test externe réel de connexion, d'expiration/rafraîchissement de session et d'une commande Home Assistant autorisée.

## Sortie Spotify du PC

Jarvis expose toujours la cible logique `PC` dans l'interface Musique. Si Spotify Connect voit déjà le poste, un clic transfère et reprend directement la lecture. Sinon, l'agent Windows ouvre Spotify, Jarvis attend que le poste apparaisse dans Spotify Connect, puis effectue le transfert. Un échec reste explicite : aucune autre sortie n'est sélectionnée silencieusement.

L'agent n'ouvre aucun port entrant. Il interroge uniquement l'API Jarvis en HTTPS avec une identité de service dédiée, limitée à la permission `music`, et n'accepte que la commande fermée `open_spotify`. Son secret est chiffré par DPAPI dans le répertoire d'exécution ignoré par Git.

```powershell
.\scripts\pc-agent-runtime.ps1 install
.\scripts\pc-agent-runtime.ps1 status
```

`install` inscrit aussi l'agent au démarrage de la session Windows. En cas d'indisponibilité temporaire du registre Docker, une image locale déjà reconstruite peut être redéployée avec `https-runtime.ps1 start -Mode public -NoBuild`.

## Lecteur Spotify et téléphone

Desktop, Web et Android utilisent le même contrat déterministe : lecture/pause, précédent/suivant, position, volume, aléatoire, répétition, file d'attente, recherche, favoris et historique récent. La bibliothèque utilise les endpoints Spotify génériques `/me/library`; l'historique nécessite le scope `user-read-recently-played`. Après l'ajout de ce scope, chaque utilisateur Spotify déjà connecté doit reconnecter une fois son intégration.

La cible `Téléphone` reste toujours visible. Sur Android, un appui explicite peut ouvrir Spotify localement, puis Jarvis attend l'apparition du téléphone dans Spotify Connect et transfère la lecture. Desktop et Web ne prétendent pas pouvoir démarrer une application sur un téléphone distant : si Spotify n'y est pas actif, l'échec est affiché explicitement et aucune autre sortie n'est choisie.
