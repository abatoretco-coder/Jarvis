# Etape 5 - Renvoi de la reponse vers la source

## But
Expliquer comment la reponse construite est renvoyee a la source appelante.

## Vue runtime (code reel)
1. Jarvis calcule `assistantTextVoice` (ou texte brut si non-voix).
2. Persistance des messages user/assistant.
3. Pre-warm TTS en fond si mode voix.
4. Construction du payload final.
5. Validation schema (`responseSchema`).
6. Update `threadRepository.updateResponseTime`.
7. Renvoi vers la source:
- SSE: `event: response` puis fermeture stream
- HTTP: `reply.code(200).send(payload)`

## Cas 1 - Reponse HTTP classique
1. Jarvis envoie payload JSON sur /v1/ingest.
2. Champs principaux:
- threadId
- responseText
- replyMeta
- (spotify seulement) bloc music + status + planner

Notes:
- Les reponses Spotify single-target partent via un payload enrichi (`buildSpotifyIngestPayload`).
- Les fast-path follow-up (resume mail/continue) renvoient un payload simplifie (`threadId`, `responseText`) sans `replyMeta`.

## Cas 2 - Reponse SSE
1. Si client demande SSE, Jarvis ouvre un stream.
2. Detection SSE:
- `Accept: text/event-stream`
- ou query param `?sse=1` (fallback client desktop).
3. event `ack` envoye des que le routing cible est connu.
4. event `response` envoye quand resultat final est pret puis stream ferme.

## Cas 3 - Pipeline vocal
1. STT renvoie text transcrit au client.
2. Client appelle /v1/ingest avec ce texte.
3. Puis client appelle /v1/tts avec responseText pour recuperer audio.
4. Jarvis prechauffe aussi /v1/tts en fond (`warmTtsInBackground`) pour reduire la latence percue.

Preconditions importantes:
- Le client doit avoir le TTS active (ex: setting local `jarvis_v2_tts_enabled=1` sur Desktop).
- Sans appel client a `/v1/tts`, Jarvis renvoie bien le texte mais aucun audio n est joue.
- Si l appel `/v1/tts` est absent dans les logs, le probleme est cote client (pas cote construction de reponse ingest).

## Persistance et traçabilite avant renvoi
1. conversationService.persistMessages sauvegarde user/assistant.
2. threadRepository.updateResponseTime met a jour fenetre conversation.
3. replyMeta source/fallback renseigne le chemin pris.
4. Logs de fin: `ingest_complete` avec `elapsed_ms`.

## References code
- src/routes/ingest.ts
- src/conversation/ConversationService.ts
