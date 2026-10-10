# Contrat de santé Jarvis

Version du contrat : `1.0`.

## Routes et responsabilités

| Route | Rôle | Sondages | Code HTTP |
| --- | --- | --- | --- |
| `GET /live` | Liveness pur du processus HTTP | aucun | `200` si le processus répond |
| `GET /ready` | Readiness de la dépendance obligatoire | intégrité de la base conversationnelle locale | `200` si prête, sinon `503` |
| `GET /health` | Diagnostic agrégé et rétrocompatible | base locale et Home Assistant borné/mis en cache | toujours `200` si Jarvis répond |

`GET /health` conserve `status: "ok"`, `timestamp`, `dependencies.llm`, `dependencies.voice`, `dependencies.planner`, `dependencies.homeassistant` et `dependencies.spotifyWebApi`. Ces champs sont maintenus pour les clients et scripts existants. Les nouveaux consommateurs utilisent `contractVersion` et `diagnostics`.

## États stables

- `healthy` : un contrôle réel a réussi ; une observation mise en cache reste explicitement signalée par `cached`.
- `degraded` : au niveau d’une dépendance, sa disponibilité est partielle ou non sondée ; au niveau agrégé, une dépendance optionnelle activement contrôlée est indisponible.
- `unavailable` : le contrôle réel a échoué ou a dépassé son délai.
- `not_configured` : les paramètres requis de l’intégration sont absents. Cet état ne prétend rien sur la disponibilité du fournisseur.

Chaque dépendance indique aussi `configured`, `required`, `observedAt`, `cached` et éventuellement un `reason` borné. Aucune URL interne, chemin de base, erreur brute, clé ou jeton n’est retourné.

## Dépendances

- `conversationDatabase` est obligatoire. Son indisponibilité rend `/ready` indisponible et place `diagnostics.status` à `unavailable`.
- `homeAssistant` est optionnel pour le processus Jarvis. Lorsqu’il est configuré, un contrôle authentifié et borné détermine sa disponibilité. Son indisponibilité place l’état agrégé à `degraded` sans faire échouer `/health`.
- `spotifyWebApi` n’est pas sondé par cette route afin d’éviter un appel externe et un rafraîchissement OAuth à chaque diagnostic. Sans configuration, son état est `not_configured`. Configuré sans observation live, son état est `degraded` avec `availability_not_checked` ; il n’est jamais déclaré `healthy` sur la seule présence de secrets.

Une dépendance optionnelle non sondée, comme Spotify, n’abaisse pas seule l’état agrégé. Le client doit lire son état propre avant d’afficher ou d’activer la fonctionnalité correspondante.

Le contrôle Home Assistant a un délai de 750 ms et un cache de 15 secondes. Le contrôle réussi de la base locale est conservé 5 secondes ; un échec n’est pas conservé pour permettre une récupération immédiate après initialisation ou réparation.

## Exemple abrégé

```json
{
  "status": "ok",
  "contractVersion": "1.0",
  "diagnostics": {
    "status": "degraded",
    "liveness": { "status": "healthy" },
    "readiness": { "status": "healthy" },
    "dependencies": {
      "conversationDatabase": { "status": "healthy", "required": true },
      "homeAssistant": { "status": "unavailable", "reason": "unreachable" },
      "spotifyWebApi": { "status": "not_configured", "configured": false }
    }
  }
}
```

## Adaptations recommandées des clients

### Jarvis Desktop

Le code actuel dans `src/hooks/useConversation.ts` peut continuer à appeler `/health` sans changement. Pour afficher un diagnostic utile :

1. typer `contractVersion` et `diagnostics` comme champs optionnels afin de rester compatible avec un ancien backend ;
2. considérer HTTP `200` + `status: "ok"` comme connectivité Jarvis ;
3. afficher séparément une base `unavailable`, un Home Assistant `unavailable` et une intégration `not_configured` ;
4. ne pas déconnecter l’utilisateur lorsque seule une dépendance optionnelle est `degraded` ou `not_configured` ;
5. réserver `/ready` aux écrans de diagnostic/démarrage, et `/live` aux contrôles fréquents sans dépendances.

### Jarvis APK

`EndpointRepositoryImpl.testConnection` peut garder `/health` puis `/v1/capabilities`. L’évolution recommandée est :

1. décoder le corps santé avec des champs optionnels et ignorer les champs inconnus ;
2. accepter un endpoint lorsque `/health` répond `200`, même si une dépendance optionnelle est dégradée ;
3. ne pas sélectionner l’endpoint pour les parcours conversation/historique lorsque `diagnostics.readiness.status == "unavailable"` ;
4. désactiver uniquement la surface concernée pour `not_configured` et présenter un message court pour `unavailable` ;
5. conserver les délais réseau courts existants et ne pas multiplier les appels `/health`, `/ready` et `/live` pour une même sélection.

Ces adaptations sont documentaires : cette modification ne change ni Jarvis Desktop, ni Jarvis APK, ni Home Assistant.
