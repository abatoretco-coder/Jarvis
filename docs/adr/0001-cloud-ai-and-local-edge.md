# ADR 0001 — IA cloud et périmètre local

- Statut : accepté
- Date : 2026-10-06

## Décision

Les traitements complexes de Jarvis utilisent des API cloud, en premier lieu OpenAI. Les runtimes Ollama, Wyoming/Faster-Whisper, Whisper Desktop et Kokoro ont été retirés. Les chemins déterministes (routage certain, confirmations, appels Home Assistant) restent sans LLM.

OpenWakeWord reste local dans Jarvis Desktop : son coût matériel est faible, il évite un flux audio permanent vers Internet et il ne remplit pas le même rôle qu'un modèle génératif. Après détection locale d'un candidat plausible, la transcription et la synthèse utilisent le compte OpenAI partagé configuré dans Jarvis.

## Conséquences

- Aucun GPU ni téléchargement de modèle lourd ne sera requis sur le PC ou le futur NAS.
- Les appels cloud auront des timeouts, retries bornés, budgets, télémétrie sans contenu sensible et un état dégradé explicite.
- Une panne d'IA ne devra jamais autoriser une mutation ambiguë.
- Les changements OpenWakeWord déjà présents sont conservés et intégrés comme lot séparé.
- Aucun endpoint ou credential TTS séparé ne peut réintroduire silencieusement un fournisseur local.

## Hors périmètre de cette ADR

Les caches de modèles locaux non versionnés peuvent nécessiter un nettoyage opérateur lorsqu'ils sont encore présents sur une machine historique ; aucun manifeste actif ne les consomme.
