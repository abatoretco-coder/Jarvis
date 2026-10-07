# Phase 1F — Benchmark OpenAI du profil PC

Date du run de référence : 2026-10-06 à 13:19 UTC.

## Décision

La baseline PC de la roadmap 1B est validée. Les modèles configurés restent :

- `gpt-6-luna` pour routage, résumé, planification d'agent et musique ;
- `gpt-6.1-sol` pour la synthèse complexe.

Le benchmark doit être rejoué avant toute exposition publique, puis après chaque changement de modèle, de prompt, de schéma structuré ou de tarification.

## Méthode

Le script `scripts/evaluate-openai-capabilities.ts` exécute 15 cas synthétiques, soit trois cas par capacité texte. Les entrées ne contiennent aucune donnée personnelle et les réponses du modèle ne sont ni affichées ni sauvegardées.

Les critères automatiques sont :

- taux de réussite global supérieur ou égal à 90 % ;
- taux de réussite par capacité supérieur ou égal à deux cas sur trois ;
- validation structurelle stricte pour le routage, les plans d'agent et la musique ;
- présence des faits attendus pour les résumés et synthèses.

Cette approche suit la recommandation OpenAI d'utiliser des évaluations spécifiques au produit et des critères fonctionnels explicites, plutôt qu'une appréciation informelle : <https://developers.openai.com/api/docs/guides/evaluation-best-practices>.

Commande reproductible :

```powershell
npm run eval:openai:capabilities -- --env .env.pc
```

## Résultats du run de référence

| Capacité | Modèle | Score | p50 | p95 | Tokens | Coût estimé |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Routage | `gpt-6-luna` | 3/3 | 1 355 ms | 1 499 ms | 231 | 0,0000391 USD |
| Résumé | `gpt-6-luna` | 3/3 | 891 ms | 904 ms | 189 | 0,0000453 USD |
| Agent | `gpt-6-luna` | 3/3 | 1 163 ms | 1 383 ms | 338 | 0,0000622 USD |
| Musique | `gpt-6-luna` | 3/3 | 1 099 ms | 2 530 ms | 221 | 0,0000401 USD |
| Synthèse | `gpt-6.1-sol` | 3/3 | 7 014 ms | 7 495 ms | 257 | 0,0014340 USD |
| **Total** | — | **15/15** | **1 163 ms** | **7 495 ms** | **1 236** | **0,0016207 USD** |

Le runtime a enregistré 15 requêtes, 15 tentatives, aucun retry, aucune erreur, aucun rejet de budget et tous les circuits fermés.

## Hypothèse de coût

Le calcul utilise les tarifs publiés le 2026-10-06 :

- `gpt-6-luna` : 0,10 USD par million de tokens d'entrée et 0,50 USD par million de tokens de sortie ;
- `gpt-6.1-sol` : 2,00 USD par million de tokens d'entrée et 10,00 USD par million de tokens de sortie.

Tous les tokens d'entrée sont estimés au tarif non mis en cache, ce qui rend l'estimation conservatrice. Les tarifs proviennent de la page officielle [OpenAI — comparaison des modèles](https://developers.openai.com/api/docs/models/compare).

## Lecture opérationnelle

- Luna valide les quatre capacités structurées avec une latence généralement comprise entre 0,8 et 2,5 secondes et un coût négligeable sur ce corpus.
- Sol concentre environ 88 % du coût du run et porte le p95 global à 7,5 secondes.
- Ce compromis reste acceptable pour les synthèses complexes non déterministes, mais Sol ne doit pas être appelé pour les commandes directes ou les réponses déterministes.
- Une interface interactive doit afficher un état de traitement lorsque le chemin de synthèse complexe est engagé.

## Limites

- Quinze cas forment une baseline technique, pas une preuve statistique exhaustive.
- Le corpus synthétique doit progressivement être complété avec des cas réels anonymisés et consentis.
- La qualité automatisée doit être calibrée avec du jugement humain avant une ouverture à plusieurs utilisateurs.
- Les coûts audio ne sont pas inclus dans ce tableau ; leur disponibilité et leur latence ont été validées séparément en phase 1D.

## Statut roadmap

La roadmap 1B est clôturée sur le socle PC. La prochaine étape est le chantier 2 : identité, inscription, sessions et autorisation, sans encore exposer publiquement le NAS.
