# Runtime LLM local-first

## Configuration nominale

Jarvis utilise Ollama seul dans les profils PC et NAS standards :

```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=qwen3:8b
```

`OPENAI_API_KEY` n’est pas nécessaire au fonctionnement conversationnel normal. Jarvis adapte en interne sa configuration OpenAI-compatible vers l’API Ollama et n’active aucun fallback.

## Compatibilité explicite

Les modes `openai` et `hybrid` restent disponibles uniquement pour une activation opérateur explicite. En mode `hybrid`, les variables `LLM_FALLBACK_OPENAI_*` doivent être configurées volontairement ; aucun profil standard ne les active.

L’autorisation d’une action ne dépend jamais du modèle : le backend valide toujours l’action et ses arguments, puis applique les confirmations depuis le registre de capacités.

## Observation

Chaque réponse qui est passée par le routeur contient dans `replyMeta` :

```json
{
  "llmProvider": "ollama",
  "llmModel": "qwen3:8b",
  "llmLatencyMs": 911
}
```

`GET /health` expose `provider: ollama` et `fallback.configured: false`, sans exposer de clé.

## Réglage conseillé

Le modèle doit être présent avant le démarrage du runtime. Le déploiement ne télécharge jamais automatiquement un modèle Ollama.
