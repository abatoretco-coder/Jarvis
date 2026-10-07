# Phase 1C — Responses API et capacités cloud

Date : 2026-10-06.

## Statut

Terminée. Cette tranche ouvre la nouvelle **roadmap 1B — orchestration IA cloud par capacité**.

## Architecture livrée

Tous les appels texte OpenAI passent par un client partagé vers `/v1/responses`. Le client :

- impose `store: false` ;
- borne `max_output_tokens` ;
- accepte les sorties texte, JSON et JSON Schema ;
- traite explicitement les réponses `failed`, `incomplete` et vides ;
- n'envoie l'effort de raisonnement qu'aux familles de modèles compatibles ;
- agrège requêtes, succès, échecs, latence, modèle et tokens sans conserver prompts, réponses ou credentials.

La migration suit la recommandation OpenAI d'utiliser la Responses API pour les nouveaux développements et son contrat de sorties structurées :

- [Migration vers Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Modèles OpenAI actuels](https://developers.openai.com/api/docs/guides/latest-model)
- [Structured Outputs avec Responses](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)

## Matrice par capacité

| Capacité | Modèle par défaut | Sortie maximale | Effort |
| --- | --- | ---: | --- |
| Routage | `gpt-6-luna` | 256 | none |
| Résumé | `gpt-6-luna` | 512 | none |
| Planification d'agent | `gpt-6-luna` | 512 | none |
| Musique | `gpt-6-luna` | 384 | none |
| Synthèse complexe | `gpt-6.1-sol` | 768 | low |

Ces valeurs sont des défauts configurables, pas des identifiants enfouis dans la logique métier. `gpt-6-luna` privilégie latence/coût pour les tâches structurées ; `gpt-6.1-sol` est réservé aux synthèses nécessitant davantage de qualité. `gpt-6-astra` n'est pas le défaut afin de ne pas imposer le modèle le plus coûteux à chaque appel.

## Sécurité et confidentialité

- aucune clé n'apparaît dans `/health` ;
- le healthcheck public ne publie ni modèles, ni endpoints, ni télémétrie détaillée ;
- aucun prompt ou texte utilisateur n'est stocké dans la télémétrie ;
- les erreurs fournisseur et sorties invalides ne recopient aucun extrait de réponse dans les logs ;
- les appels sans clé échouent fermés ;
- les sorties LLM restent non fiables : schéma, registre de capacités, contrôles serveur et confirmations gouvernent l'exécution ;
- aucun appel réel OpenAI n'est lancé par les tests ou les scripts de validation.

## Validation

Les tests hermétiques couvrent le chemin `/responses`, `store:false`, les budgets, JSON Schema, les sorties typées, les réponses incomplètes, la compatibilité modèle/raisonnement et l'absence de fuite dans la télémétrie. Les suites métier vérifient calendrier, mail, tâches, musique, Culture, météo, recherche, résumés et orchestration.

Un smoke test réel borné a été exécuté le 2026-10-06 avec cinq requêtes non personnelles et sans journaliser les réponses : 5 succès sur 5, 301 tokens au total. Les latences observées étaient de 1,8 à 4,7 secondes selon la capacité. Le script reproductible est `scripts/evaluate-openai-capabilities.ts` ; il n'affiche ni clé ni contenu de réponse.

Ce smoke test valide disponibilité, contrat et résultat attendu sur un cas simple par capacité. Le benchmark élargi a ensuite été exécuté en phase 1F ; il reste à rejouer avant le déploiement public et après tout changement de modèle ou de prompt.

## Suite de la roadmap 1B

1. **audio cloud — terminé** : retrait de Kokoro et Whisper Desktop, conservation d'OpenWakeWord ;
2. **résilience — terminée en phase 1E** : retry borné, circuit breaker, quotas et modes dégradés ;
3. **benchmark réel — terminé en phase 1F** : baseline PC qualité, coût et latence, à rejouer avant exposition publique.
