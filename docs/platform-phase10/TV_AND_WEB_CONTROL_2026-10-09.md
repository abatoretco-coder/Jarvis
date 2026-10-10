# Pilotage TV LG et Jarvis Web — 2026-10-09

## Livré

- La LG webOS du séjour est enregistrée sous l'identité Jarvis stable `living-room-tv` et mappée à `media_player.lg_webos_tv_oled55c66lb`.
- Desktop, Android et Web consomment le même snapshot et le même endpoint d'actions Jarvis.
- Le Web réutilise le frontend Desktop à l'adresse `https://jarvis-abato.duckdns.org/app/`.
- Le client OIDC public `jarvis-web` utilise Authorization Code + PKCE et une session limitée à l'onglet.
- Home Assistant reste privé ; seul Jarvis est exposé par le frontal HTTPS.

## Contrôles disponibles

| Groupe | Commandes |
| --- | --- |
| Alimentation | allumer, éteindre |
| Son | volume précis, volume +/−, mute, sortie audio |
| Lecture | lecture/pause, lecture, pause, stop, précédent, suivant |
| Contenu | source ou application exposée par la TV |
| Accès direct | favoris dynamiques Canal+, YouTube, Netflix, Prime Video, Disney+, Plex et Live TV lorsqu'ils sont installés |
| Chaînes | accès direct par numéro, nom exact ou fragment de nom via `media_player.play_media` |
| Navigation | accueil, retour, directions, OK, menu, guide, info, quitter |
| TV | chaîne +/−, pavé numérique, touches rouge/verte/jaune/bleue |

Les sources, la sortie audio, le volume, le mute et le média courant sont issus de l'état Home Assistant. Quand la TV est éteinte ou hors réseau, Jarvis affiche l'indisponibilité ; seule la commande d'allumage reste proposée.

## Limites assumées

- Jarvis ne transmet aucune commande webOS libre : les touches sont dans une liste blanche serveur.
- Le pointeur gyroscopique Magic Remote, la saisie clavier libre et les réglages LG ThinQ non exposés par l'intégration Home Assistant ne sont pas simulés.
- Les applications visibles dépendent de `source_list` annoncé par la TV lorsqu'elle est joignable.
- Les favoris ne sont jamais simulés : un bouton n'apparaît que si la source correspondante est réellement publiée par la TV.
- L'APK a été construite et testée, mais n'a pas été installée le 9 octobre car aucun terminal ADB n'était connecté.

## Preuves

- Backend TypeScript compilé ; 18 tests de routes domicile réussis, dont source TV, touche webOS autorisée et rejet d'une touche arbitraire.
- Frontend Web compilé ; 25 tests ciblés Desktop/auth/domicile réussis.
- Android : tests JVM et assemblage debug réussis.
- Caddy validé ; `/app/`, sa configuration, OIDC discovery et l'isolation de l'origine répondent en HTTPS.
- Le snapshot public authentifié contient la TV, son mapping et ses capacités. La TV était `unavailable` lors de la recette matérielle.

## Retour arrière

- Retirer le mapping `living-room-tv` du home-store masque la TV sans toucher à Home Assistant.
- Retirer le bloc `/app` de Caddy et le client `jarvis-web` désactive le Web sans affecter Desktop ou Android.
- Les contrôles natifs restent utilisables même si le build Web est absent.
