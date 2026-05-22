# Etape 6 - Adaptation finale selon source (texte vs voix)

## But
Comprendre comment la meme reponse metier est transformee différemment selon que la source attend du texte ou du vocal.

## Texte
1. Reponse conservee en format informatif standard.
2. toSingleParagraphPlainText harmonise la sortie.
3. Metadata replyMeta permet debug et observabilite.

## Voix
1. Detection mode voix (voiceTurnId/channel).
2. formatVoiceResponse applique un style selon domain:
- mail, todo, search, executor, weather, spotify, general.
3. mode short/normal/detailed ajuste la densite.
4. gracefulFallback peut injecter une phrase de reprise si fallback.

## TTS
1. /v1/tts transforme responseText en audio.
2. Race entre HA TTS et OpenAI TTS selon config.
3. Premier succes gagne, loser aborted.
4. Retour audio binaire + x-tts-provider.

## Pourquoi cette separation est importante
1. Meme logique metier, rendu adapte au canal.
2. Evite de dupliquer orchestration metier par type de client.
3. Permet d ajuster UX vocale sans casser logique de routing.

## References code
- src/conversation/voiceUx.ts
- src/routes/ingest.ts
