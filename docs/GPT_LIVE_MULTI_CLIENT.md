# GPT-Live multi-client

## Décision d'architecture

GPT-Live est une interface vocale, jamais une autorité métier. Desktop et Android utilisent WebRTC pour l'audio et les événements. Jarvis attache un WebSocket sideband à la même session avant de retourner la réponse SDP au client. Le client authentifié reste responsable de l'appel à `/v1/ingest`; le sideband ne reçoit ni ne conserve son jeton OIDC.

```text
Desktop / Android -- WebRTC audio + events -- GPT-Live
       |                                      |
       +-- OIDC /v1/ingest --> Jarvis -- sideband control
```

Jarvis conserve seul l'historique, les permissions, le routage, les confirmations, l'idempotence et le résultat réel. Le pipeline STT → ingest → TTS reste le fallback de référence.

Les réactions locales sans demande d'information ni d'action restent silencieuses lorsqu'une réponse n'est pas utile, ou tiennent en une phrase très courte. GPT-Live ne verbalise ni raisonnement, ni plan, ni commentaire d'attente pendant une délégation ; seule la réponse finale fournie par Jarvis est restituée.

## Contrats HTTP

- `POST /v1/voice/live/sessions` — OIDC + permission `chat`; crée la session, attache le sideband puis retourne `{ sessionId, sdp, expiresAt }`.
- `DELETE /v1/voice/live/sessions/:sessionId` — fermeture idempotente limitée au propriétaire.
- `POST /v1/voice/live/telemetry` — accepte uniquement les noms d'événements bornés, sans transcript ni audio.
- `POST /v1/ingest?sse=1` — inchangé; un tour Live ajoute `voiceTransport`, `liveSessionId` et `liveDelegationId` dans `clientContext`.

Pour un tour Live, le hook de sécurité vérifie avant la réservation d'idempotence que la session appartient à l'utilisateur et que le sideband a observé la délégation. Il tolère au maximum une seconde de décalage entre le data channel et le sideband. La clé attendue est :

```text
live-<32 premiers caractères hexadécimaux de SHA-256(sessionId + ":" + delegationId)>
```

Une même clé peut relire le résultat existant. Une autre clé pour la même délégation est refusée.

## Persistance et confidentialité

Les migrations SQLite `live_voice_registry` et `live_voice_client_telemetry` sont additives. Elles conservent l'identifiant de session, le propriétaire, un hash de l'appareil, les dates, les états, l'usage, les clés d'opération et les événements techniques bornés du pilote. Elles ne conservent aucun audio brut ni transcript complet.

Le contexte de démarrage contient au plus 20 messages et 6 000 octets UTF-8, borne conservatrice sous 6 000 tokens. Les secrets et métadonnées techniques ne sont pas ajoutés. `contextNote` reste séparé et explicitement marqué comme non fiable.

Les logs ne doivent jamais inclure SDP, audio, transcript complet, bearer token ou clé OpenAI. La télémétrie serveur rattache elle-même l'identité OIDC.

## Exploitation

Tous les flags sont désactivés par défaut. `OPENAI_LIVE_PILOT_OWNER_ONLY=true` réserve Desktop et Android aux comptes portant le rôle `owner` pendant le pilote ; la capacité publiée est calculée pour l'identité authentifiée. `voice.live.available` dans `/v1/capabilities` reflète le master flag, le flag client, cette restriction, la configuration OIDC/OpenAI, le budget et le circuit breaker. Le contrat publie aussi `idleTimeoutMs` et `delegationTimeoutMs`, afin que les clients appliquent les limites validées par le serveur.

Le budget convertit la durée cumulée au tarif public actuel de 0,05 USD/minute, facturé à la seconde. Les modèles et outils backend restent facturés séparément. Ce tarif doit être revérifié lors de chaque changement de modèle ou revue tarifaire : [tarification GPT-Live](https://developers.openai.com/api/docs/pricing#live-session-duration).

Le rapport de promotion est généré en lecture seule :

```powershell
npm run report:live-pilot -- --database <conversation.sqlite> --since 2026-10-15T00:00:00+02:00
```

Il expose le nombre de sessions connectées, le taux de connexion, les fallbacks, les états de délégation et les p95 de connexion, ingest et premier audio. Il ne lit ni ne produit de contenu conversationnel.

Ordre de promotion :

1. backend en production, flags désactivés ;
2. pilote Desktop propriétaire après validation des scénarios ;
3. Android après compilation et test WebRTC sur appareil minSdk 26 ;
4. Home Assistant seulement après 50 phrases françaises et au moins 95 % de sorties complètes.

Un redémarrage rattache les sessions enregistrées encore accessibles, puis les ferme. Les sessions expirées et celles remplacées sur le même appareil sont également fermées. Si l'attachement sideband échoue, la session fournisseur est raccrochée et le client reste en mode classique.

## Récupération

Avant toute tentative d'ingest, le client peut reprendre avec un transcript final fiable ou demander de répéter. Après `ingest_sent`, il ne crée jamais une nouvelle clé : il interroge `/v1/mutation-results/:key`. `missing` ne prouve jamais que l'action n'a pas été exécutée.

`operationStatus` est additif et vaut `not_applicable`, `accepted`, `succeeded`, `partial`, `uncertain` ou `failed`. Seul `succeeded` est présenté comme un succès confirmé.

## État des gates

- Phase 0 fournisseur : WebRTC Desktop réel, sideband corrélé et fermeture gracieuse validés le 15 octobre 2026.
- Backend : déployé sur le runtime PC public le 15 octobre 2026, migration SQLite 21 et sondes HTTPS/OIDC validées.
- Desktop : release instrumentée installée sur le PC et pilote propriétaire actif avec `OPENAI_LIVE_ENABLED=true`, `OPENAI_LIVE_DESKTOP_ENABLED=true` et `OPENAI_LIVE_PILOT_OWNER_ONLY=true`.
- Promotion Desktop : campagne mesurable ouverte à 0/30 conversations ; Android reste bloqué jusqu'à validation des mesures de connexion, latence, interruption et mutation exactement une fois.
- Android : contrat et machine d'état compilent; choix WebRTC et activation bloqués jusqu'au test sur appareil réel.
- Home Assistant : validateur de fidélité implémenté; activation bloquée jusqu'au corpus de 50 phrases.

Le runtime actif de cette promotion est le PC, pas VM400. Android et Home Assistant restent désactivés.
