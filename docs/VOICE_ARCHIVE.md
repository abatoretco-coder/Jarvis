# Archive vocale Home Assistant

Jarvis conserve les tours vocaux Home Assistant pour permettre une evaluation differee de la detection, de la transcription et de la synthese.

- Un identifiant `ha-turn-*` relie l'audio entrant, la conversation et l'audio sortant.
- Chaque tour possede au maximum un artefact `input` et un artefact `output`; un retry met a jour le meme enregistrement au lieu de creer un doublon.
- Les audios sont normalises en MP3 mono 64 kbit/s par `ffmpeg`, sans fichier temporaire, puis stockes dans `voice_artifacts` avec la transcription, le moteur, la latence et le fil de conversation.
- Les donnees restent dans le volume local de Jarvis, sont incluses dans les sauvegardes chiffrees de la base et ne sont exposees par aucune route publique. Le chiffrement du disque actif depend de la configuration Windows du PC.
- `VOICE_ARCHIVE_RETENTION_DAYS=0` desactive la purge automatique. Une valeur positive applique une retention bornee.
- La suppression explicite d'une conversation supprime ses artefacts lies par cascade.

L'audio est une donnee d'observation. Il n'est jamais reinjecte dans le contexte du modele; seul le texte de la conversation alimente la memoire conversationnelle.
