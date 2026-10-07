# Phase 1E — Résilience des appels OpenAI

Date de clôture technique : 2026-10-06.

## Résultat

Tous les appels OpenAI du runtime Jarvis passent désormais par une politique de résilience commune : Responses, embeddings, transcription et synthèse vocale. Cette tranche ne donne jamais au modèle le droit d'exécuter une mutation ; elle protège uniquement le transport vers le fournisseur cloud.

## Politique appliquée

- Deux retries au maximum par défaut, avec backoff exponentiel borné.
- Retry uniquement pour les erreurs de transport, timeouts, HTTP 408, 409, 429 et 5xx.
- Prise en compte de `Retry-After`, avec plafond local pour éviter une attente non bornée.
- Aucun retry pour les erreurs d'authentification, d'autorisation ou de validation.
- Circuit breaker indépendant par capacité : `router`, `summary`, `agent`, `music`, `synthesis`, `embedding`, `stt` et `tts`.
- Une seule sonde est admise en état half-open ; un succès referme le circuit.
- Budget partagé par fenêtre sur le nombre de requêtes logiques et les tokens connus.

La sélection des statuts retryables suit les recommandations OpenAI sur les erreurs transitoires et le backoff exponentiel : <https://platform.openai.com/docs/guides/rate-limits>.

## Configuration

Les profils PC et NAS rendent les garde-fous explicites :

```dotenv
OPENAI_RETRY_MAX=2
OPENAI_RETRY_BASE_DELAY_MS=250
OPENAI_RETRY_MAX_DELAY_MS=2000
OPENAI_CIRCUIT_FAILURE_THRESHOLD=5
OPENAI_CIRCUIT_OPEN_MS=30000
OPENAI_BUDGET_WINDOW_MS=86400000
OPENAI_BUDGET_MAX_REQUESTS=2000
OPENAI_BUDGET_MAX_TOKENS=2000000
```

Le budget est volontairement un garde-fou en mémoire du processus. Il repart à zéro lors d'un redémarrage et ne remplace donc pas les limites de projet et alertes de facturation configurées chez le fournisseur.

## Observabilité et confidentialité

`GET /v1/stats`, protégé par la politique d'accès des routes `/v1`, expose :

- état global `ok` ou `degraded` ;
- consommation de la fenêtre et plafonds ;
- requêtes, tentatives, retries, succès, erreurs et rejets ;
- latence, statut HTTP, modèle et état du circuit par capacité.

Le snapshot ne contient ni clé, ni prompt, ni transcription, ni sortie du modèle. Le `/health` public ne reçoit aucun de ces détails.

## Garanties et limites

- Une panne cloud ne déclenche aucune nouvelle mutation : les décisions d'autorisation et l'exécution restent côté serveur.
- Les commandes déterministes conservent leurs chemins existants et peuvent fonctionner sans génération lorsque leur contrat le permet.
- Un retry peut exceptionnellement correspondre à une requête déjà reçue par le fournisseur si la réponse réseau a été perdue. Les retries restent donc courts et bornés, et le budget compte la requête logique avant son exécution.
- Les tokens audio ne sont pas toujours publiés par les transports utilisés ; l'audio reste couvert par le budget de requêtes.

## Validation

- Tests unitaires : retry transitoire, absence de retry sur 401, ouverture du circuit, récupération half-open, budgets requêtes/tokens, parsing `Retry-After` et absence de contenu dans la télémétrie.
- Tests d'intégration : Responses, embeddings existants, STT, TTS et préchauffage vocal.
- Validation complète : lint, compilation TypeScript, typecheck des tests, Jest et registre des capacités.

## Suite réalisée dans la roadmap 1B

La résilience technique est terminée. Le benchmark qualité/coût du profil PC a ensuite été exécuté et documenté dans `PHASE_1F_PRODUCTION_BENCHMARK_2026-10-06.md`.
