# Fallback hybride Ollama → OpenAI

## Configuration

Conserver les identifiants et modèles OpenAI dans les variables `OPENAI_*`, puis activer le mode hybride :

```env
LLM_PROVIDER=hybrid
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=qwen3:4b-instruct
LLM_LOCAL_ROUTER_TIMEOUT_MS=1200
LLM_FALLBACK_OPENAI_TIMEOUT_MS=6000
```

En mode `hybrid`, les valeurs `OPENAI_API_KEY`, `OPENAI_BASE_URL` et `OPENAI_MODEL_ROUTER` sont conservées automatiquement comme fournisseur de secours. Les appels du routeur partent d’abord vers Ollama.

## Décision de fallback

OpenAI est utilisé seulement si la réponse Ollama est inutilisable : délai dépassé, JSON invalide, aucune cible reconnue ou confiance sous `ROUTER_CONFIDENCE_THRESHOLD`.

L’autorisation d’une action ne dépend jamais du modèle : le backend valide toujours l’action et ses arguments, puis applique les confirmations depuis le registre de capacités.

## Observation

Chaque réponse qui est passée par le routeur contient dans `replyMeta` :

```json
{
  "llmProvider": "openai",
  "llmModel": "gpt-4o-mini",
  "llmLatencyMs": 911,
  "llmFallbackReason": "local_timeout"
}
```

Les raisons possibles sont `local_timeout`, `local_invalid_json`, `local_invalid_target`, `local_low_confidence`, `local_http_error` et `local_error`.

`GET /health` expose également si le fallback est configuré, sans exposer de clé.

## Réglage conseillé

`qwen3:4b-instruct` met environ 0,34–0,40 s à chaud pour le vrai prompt de routage, mais son premier chargement peut prendre environ 4,4 s. Avec `LLM_LOCAL_ROUTER_TIMEOUT_MS=1200`, la première demande bascule vers OpenAI puis les suivantes restent locales. Augmenter ce délai à `5000` privilégie la confidentialité au premier appel ; le diminuer privilégie la réactivité.
