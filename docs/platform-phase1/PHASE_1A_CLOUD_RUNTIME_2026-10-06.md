# Phase 1A — socle runtime IA cloud

Date : 2026-10-06.

## Statut

Tranche terminée. Jarvis démarre désormais avec `LLM_PROVIDER=openai` par défaut et refuse explicitement les anciens profils `ollama` et `hybrid`.

## Changements réalisés

- suppression du warmup Ollama dans l'entrypoint du conteneur ;
- suppression du client Wyoming et du chemin STT local côté serveur ;
- STT directement envoyé à l'endpoint cloud configuré, avec échec fermé si la clé manque ;
- TTS cloud utilisant soit les credentials OpenAI principaux, soit des credentials speech séparés ;
- routage LLM forcé sur le provider `openai`, sans fallback local ;
- synthèse Culture migrée de l'API native Ollama vers l'API cloud compatible OpenAI ;
- contrat `/health` explicite : LLM et STT cloud, aucun fallback local déclaré ;
- suppression des variables Ollama/hybrid du schéma de configuration effectif.

Les anciens adaptateurs Ollama encore présents dans certains modules étaient devenus inaccessibles. Ils ont depuis été supprimés avec les services Compose dans la tranche 1B.

## Périmètre de tests élargi

- politique de configuration : valeur par défaut, rejet `ollama`/`hybrid`, endpoint/modèles explicites ;
- TTS : credentials principaux, credentials dédiés, absence de clé ;
- STT intégration : succès multipart, clé absente, transcription vide ;
- santé : provider cloud et absence de fuite de clé ;
- Culture : recommandations, préférences, comparaisons et contraintes via endpoint cloud ;
- sauvegarde : absence de fichiers temporaires SQLite résiduels.

Toutes les requêtes fournisseur sont doublées localement dans les tests. Aucun secret ni appel OpenAI réel n'est utilisé.

Validation complète de la tranche :

- Jarvis : 51 suites, 462 tests, lint, build, typecheck et registre de capacités verts ;
- Desktop : 16 fichiers, 71 tests, build et `cargo check` verts ;
- Desktop E2E cloud hermétique : 12 scénarios verts, 1 runtime réel ignoré ;
- Android : 21 tests, lint et assemblage debug verts ;
- Agora : 8 suites, 87 tests ;
- Home Assistant : rendu Compose valide, sans lancement de service local.

## Choix de modèles

Les identifiants restent configurables et les valeurs historiques ne sont pas remplacées aveuglément dans cette tranche. La documentation OpenAI actuelle recommande les modèles récents via la Responses API ; le choix par capacité et la migration Chat Completions vers Responses seront benchmarkés en 1C afin d'éviter une bascule non mesurée. Référence : [OpenAI API — Models](https://developers.openai.com/api/docs/models).

## Tranches suivantes

1. **1B — terminée** : adaptateurs, service Compose, volumes et scripts Ollama retirés.
2. **1C — terminée** : configuration par capacité, Responses API, modèles évalués, budgets et télémétrie.
3. **Audio** : retirer Kokoro et le Whisper Desktop lourd, brancher l'audio cloud tout en conservant OpenWakeWord.
4. **Résilience** : tester pannes, timeouts, quotas, circuit breakers et commandes domotiques déterministes hors IA.
