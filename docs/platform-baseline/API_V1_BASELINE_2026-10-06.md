# Contrat API Jarvis `/v1` avant identité utilisateur

Date de référence : 2026-10-06.

Cette photographie décrit le contrat réellement consommé par Jarvis Desktop et Jarvis APK avant l'introduction d'OIDC. Elle sert de filet de compatibilité, pas de modèle d'autorisation cible.

## Authentification actuelle

- `GET /health` est public.
- Lorsque `REQUIRE_API_KEY=true`, toutes les routes `/v1/*` exigent la clé technique dans `X-API-Key` ou `Authorization: Bearer`.
- La même clé représente actuellement Desktop, Android et les autres clients : elle n'identifie pas une personne.
- Le callback Google et le mode temporaire de configuration OAuth possèdent des exceptions dédiées.
- Aucune route métier n'applique encore un ownership utilisateur authentifié.

Conséquences pour la migration :

- un JWT utilisateur ne devra jamais être comparé à la liste des clés techniques ;
- les principaux humains et les principaux de service devront être distingués explicitement par le middleware ;
- `user_id`, `threadId` et les autres identifiants fournis par le client ne constituent pas une preuve de propriété ;
- les clés historiques resteront limitées au développement local ou aux services internes pendant la transition.

## Contrats communs Desktop et Android

| Méthode et route | Requête actuelle | Réponse minimale consommée |
| --- | --- | --- |
| `GET /health` | aucune | `status`, `timestamp`, état synthétique des dépendances |
| `GET /v1/capabilities` | aucune | `status`, `timestamp`, capacités annoncées |
| `POST /v1/ingest` | `threadId`, `text`, `clientContext`; SSE avec `?sse=1` | `threadId`, `responseText`; métadonnées optionnelles |
| `POST /v1/stt/:engineId` | octets WAV, `Content-Type`, `X-Voice-Turn-Id` optionnel | `text` ou `result`, `engineId` |
| `POST /v1/tts` | `text`, `language` et `provider` optionnels | flux audio et en-tête `X-TTS-Provider` |
| `GET /v1/threads` | `channel`, `limit` | `{ items: [...] }` |
| `GET /v1/threads/:threadId/history` | `limit` | thread, résumé et messages ordonnés |
| `DELETE /v1/threads/:threadId` | aucune | `threadId`, `deleted` |

Le nom canonique est `threadId`. Le document Android antérieur montrait `thread_id`, mais le DTO Kotlin et le backend utilisent bien `threadId` ; cette photographie corrige cette divergence documentaire.

## Routes consommées uniquement par Desktop

- Dashboard agrégé : `GET /v1/dashboard`.
- Mail : `GET /v1/mail/messages`, `GET /v1/mail/message`, `POST /v1/mail/trash`.
- Tâches : `GET /v1/todo/lists`, `GET|POST|PATCH /v1/todo/tasks`, `PATCH /v1/todo/tasks/:taskId`.
- Agenda Google : liste des calendriers et CRUD des événements sous `/v1/calendar/google/*`.
- Actualités : `GET /v1/news/items`, `POST /v1/news/summary`.

## Routes backend non consommées directement par les deux clients principaux

- Profil Culture et favoris sous `/v1/culture/*`.
- Cache proactif sous `/v1/context-cache*`.
- Mutations en attente sous `/v1/pending-mutations*`.
- État NAS : `GET /v1/nas/status`.
- Index Home Assistant : `GET /v1/ha/index` lorsque explicitement activé.
- Diagnostic agent conversationnel : `GET /v1/conversation-agent/screening`.
- Variantes TTS : `POST /v1/tts/ha` et `POST /v1/tts/openai`.
- Métriques de latence en mémoire : `GET /v1/stats`.

## Invariants de validation observés

- `threadId` : 1 à 128 caractères, alphabet `[A-Za-z0-9._:-]`.
- texte conversationnel : 32 000 caractères maximum.
- note de contexte : 8 000 caractères maximum.
- identifiant STT : même alphabet et longueur maximale que `threadId`.
- texte TTS : 1 à 5 000 caractères.
- historique : limite comprise entre 1 et 500 ; liste des threads entre 1 et 200.
- taille globale du corps bornée par `BODY_LIMIT_BYTES`.

## Forme minimale de `POST /v1/ingest`

```json
{
  "threadId": "desktop-example",
  "text": "Allume la lumière du salon",
  "clientContext": {
    "language": "fr",
    "channel": "desktop"
  }
}
```

Réponse synchrone minimale :

```json
{
  "threadId": "desktop-example",
  "responseText": "La lumière du salon est allumée."
}
```

Les champs `replyMeta`, `usedSummaryVersion`, `sources`, `cultureCandidates` et `voiceAudio` sont optionnels. La migration IA peut modifier leur contenu interne, mais ne doit pas retirer `threadId` ou `responseText` sans versionner le contrat.

## Risques à couvrir au chantier identité

1. Les routes d'historique permettent actuellement un accès par connaissance de `threadId`.
2. Le `user_id` Culture est fourni par le client et n'est pas lié à une identité authentifiée.
3. La clé Desktop est conservée dans `localStorage`.
4. Les routes de mutation vérifient le contexte conversationnel, mais pas encore un propriétaire authentifié.
5. Le rate limiting est principalement indexé par IP et ne distingue pas encore comptes, capacités ou coûts IA.
