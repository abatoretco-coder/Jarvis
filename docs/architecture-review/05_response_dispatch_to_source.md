# Etape 5 - Renvoi de la reponse vers la source

## But
Expliquer comment la reponse construite est renvoyee a la source appelante.

## Cas 1 - Reponse HTTP classique
1. Jarvis envoie payload JSON sur /v1/ingest.
2. Champs principaux:
- threadId
- responseText
- replyMeta
- (spotify seulement) bloc music + status + planner

## Cas 2 - Reponse SSE
1. Si client demande SSE, Jarvis ouvre un stream.
2. event ack envoye des que routing decide.
3. event response envoye quand resultat final est pret.

## Cas 3 - Pipeline vocal
1. STT renvoie text transcrit au client.
2. Client appelle /v1/ingest avec ce texte.
3. Puis client appelle /v1/tts avec responseText pour recuperer audio.

## Persistance et traçabilite avant renvoi
1. conversationService.persistMessages sauvegarde user/assistant.
2. threadRepository.updateResponseTime met a jour fenetre conversation.
3. replyMeta source/fallback renseigne le chemin pris.

## References code
- src/routes/ingest.ts
- src/conversation/ConversationService.ts
