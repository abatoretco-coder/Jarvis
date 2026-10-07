# Phase 1D — Audio cloud

Date : 2026-10-06.

## Statut

Terminée. La détection d'activation OpenWakeWord reste locale et légère ; la transcription et la synthèse passent exclusivement par Jarvis vers le compte de service OpenAI partagé.

## Architecture livrée

- STT serveur sur `/audio/transcriptions`, modèle par défaut `gpt-transcribe` ;
- TTS serveur par WebSocket `/realtime`, modèle par défaut `gpt-realtime-2.1-mini`, voix `marin`, avec encapsulation PCM en WAV pour les clients ;
- suppression des credentials et endpoints TTS séparés afin d'éviter la réintroduction silencieuse d'un backend local ;
- suppression de Kokoro dans les Compose PC/NAS et du stack Wyoming/Faster-Whisper ;
- suppression du modèle Whisper navigateur et de `@xenova/transformers` dans Jarvis Desktop ;
- conservation du sidecar OpenWakeWord : seuls les candidats plausibles déclenchent un appel STT cloud ;
- rejet fermé si OpenWakeWord est indisponible, sans envoyer tout le bruit ambiant au cloud ;
- clients Desktop et Android alignés sur l'identifiant de transport `openai`.

## Confidentialité et UX

- aucun transcript ni corps d'erreur fournisseur n'est journalisé côté backend, Desktop ou Android ;
- les journaux conservent seulement statuts, tailles, durées et nombres de caractères ;
- Desktop et Android indiquent clairement que la voix de Jarvis est générée par IA ;
- les tests restent hermétiques et n'envoient aucun audio utilisateur à un service externe.

## Validation

- Jarvis : typage et tests audio/intégration ;
- Desktop : 16 fichiers de tests, 71 tests, build Vite ;
- Android : tests, lint et assemblage debug ;
- déploiement : validateurs Compose PC/NAS, avec garde explicite contre Kokoro et Whisper local.

Un smoke test réel borné a validé le 2026-10-06 la boucle complète sur un texte non personnel : génération Realtime (`gpt-realtime-2.1-mini`) en 2,761 s, fichier WAV de 112 844 octets, puis transcription (`gpt-transcribe`) en 1,370 s avec un résultat non vide. Le script reproductible `scripts/evaluate-openai-audio.ts` ne journalise ni clé, ni audio, ni transcript.

## Suite

La prochaine tranche de la roadmap 1B porte sur la résilience : retries bornés, circuit breaker, budget de consommation et états dégradés explicites.
