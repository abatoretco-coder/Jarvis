# Matrice d’abus

| Risque | Contrôle | Preuve automatisée |
| --- | --- | --- |
| Brute force / rafale distribuée | quotas IP et identité | `security.test.ts` |
| Proxy ou origine falsifiés | CIDR explicites, secret d’origine, HTTPS et host exact | `security.test.ts`, `env.llmProvider.test.ts` |
| CORS permissif | origines exactes et préflight fermé | `security.test.ts` |
| Élévation invité → admin | autorisation serveur et audit des refus | `adminControlPlane.test.ts` |
| IDOR / fuite inter-utilisateur | ownership obligatoire dans les repositories | `userDataOwnership.test.ts`, `conversationAuthorization.test.ts` |
| Replay de mutation admin | idempotency key liée à l’empreinte | `adminControlPlane.test.ts` |
| Compte suspendu encore actif | révocation atomique des sessions | `identityRepository.test.ts`, `identityRoutes.test.ts` |
| Requête ou audio volumineux | `BODY_LIMIT_BYTES` et limites audio | `security.test.ts`, `audioRuntime.test.ts` |
| Épuisement OpenAI | budget, retries et circuit breaker | `openAiResilience.test.ts` |
| Fuite de secret dans les réponses/logs | redaction et erreurs publiques bornées | `security.test.ts`, `adminControlPlane.test.ts` |

Les attaques volumétriques en amont, certificats publics, règles WAF et isolation réseau NAS ne peuvent pas être prouvés sur le PC sans activer l’edge réel. Elles restent des critères bloquants avant ouverture Internet.
