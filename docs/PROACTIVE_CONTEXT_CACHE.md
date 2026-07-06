# Proactive Context Cache

Status: implemented for read-only snapshots and conservative ingest shortcuts.
Last reviewed: 2026-07-04.

This document defines what Jarvis should keep warm before the user asks. The goal is to answer common status questions from fresh-enough context instead of doing every lookup synchronously during `POST /v1/ingest`.

## Intent

Jarvis should maintain small, domain-scoped snapshots for agents that are often queried:

1. answer fast when the user asks common questions;
2. avoid repeated OAuth/API calls for dashboards and voice turns;
3. keep enough context for follow-up questions such as "et le dernier mail ?" or "qu'est-ce qui joue ?";
4. never execute user-visible mutations from a proactive refresh.

This is not a second router. Routing still follows `docs/ROUTING_OVERVIEW.md`; warm context only gives an agent a recent read model or a prebuilt answer candidate.

## Current Cache Surface

Already present in code:

- `src/context/ProactiveContextCache.ts`: domain snapshot registry and prepared-answer builder.
- `src/routes/contextCache.ts`: `/v1/context-cache` status/read endpoint and `/v1/context-cache/refresh`.
- `src/cache/AsyncSnapshotCache.ts`: generic in-memory snapshot helper with fresh/stale behavior.
- `src/routing/routeScoring.ts`: route embedding warmup/cache.
- `src/routes/ingest.ts`: short-lived TTS warm cache and NAS status cache usage.
- `src/spotifyWebApi.ts`: access token cache, now-playing/device short cache, playlist cache, and proactive token refresh.
- `src/mail/mailAgent.ts`, `src/todo/todoAgent.ts`, `src/calendar/googleCalendarClient.ts`: OAuth access-token caches and keepalive refresh.
- `src/routes/dashboard.ts`: dashboard weather cache and dashboard read aggregations.

Still missing today:

- broader prepared-answer matching based on observed user phrasing;
- live-refresh override UI behavior for stale answers;
- a concrete News provider beyond opted-in backend availability;
- richer Mail/Todo/Calendar domain-specific prepared answers beyond dashboard sections.

## Proposed Warm Agents

| Agent | Keep warm | Refresh cadence | Fresh TTL | Stale window | Typical cached answers |
| --- | --- | ---: | ---: | ---: | --- |
| Music / Spotify | now playing, active device, device list, playlist index | 15-30 s while app is active, 2-5 min idle | 30 s | 5 min | "qu'est-ce qui joue ?", "ou est Spotify ?", "mets la suite", "sur quel appareil ?" |
| Mail | unread counts, top unread summaries, latest message metadata, last-read thread summary | 2-5 min | 3 min | 15 min | "j'ai des mails ?", "dernier mail ?", "mails importants ?", "resume ma boite" |
| Todo | due today, overdue, flagged/important, recent completed, lists | 5 min | 5 min | 30 min | "mes taches du jour ?", "qu'est-ce qui est en retard ?", "liste courses ?" |
| Calendar | next events, free/busy today/tomorrow, degraded config state | 2-5 min | 5 min | 30 min | "mon prochain rdv ?", "je suis libre quand ?", "agenda demain ?" |
| Weather local | HA weather snapshot, today min/max, tomorrow, hourly points, weekly trend | 5-10 min | 10 min | 30 min | "temperature ?", "max aujourd'hui ?", "meteo demain ?", "tendance semaine ?", "a 14h ?" |
| Home / Executors | selected HA entity states for lights, timers, covers, scenes | 10-30 s for volatile entities, 2 min otherwise | 30 s | 5 min | "la lumiere est allumee ?", "timer restant ?", "etat maison ?" |
| NAS / System | latest NAS health snapshot, disk/memory/temp summaries | 30-60 s | 60 s | 5 min | "le NAS va bien ?", "temperature disque ?", "espace restant ?" |
| News / Search | selected latest headlines only when user has opted into a dashboard/news surface | 15-30 min | 30 min | 2 h | "quoi de neuf ?", "resume l'actu" |
| Daily brief | Composed read model from weather, calendar, mail, todo and optional news | 5 min | 5 min | 30 min | "brief du jour", "brief du matin", "programme de la journee" |

Agents not recommended for broad warming:

- General HA conversation: keep as fallback only, not a parallel pre-warmed agent.
- Deep web/search analysis: refresh on demand unless a user-visible monitor/subscription exists.
- Any write/destructive action: never pre-execute; only prepare read context or draft/proposal text.

## Prepared Answer Contract

Each warm snapshot should optionally expose prepared answers for common questions. A prepared answer is safe to return only if it still matches the user's intent and the snapshot is fresh enough.

Suggested shape:

```ts
type PreparedContextAnswer = {
  domain: 'spotify' | 'mail' | 'todo' | 'calendar' | 'weather' | 'executor' | 'nas' | 'news';
  questionKey: string;
  answerText: string;
  fetchedAt: string;
  freshness: 'fresh' | 'stale';
  sourceRefs?: Array<{ type: string; id?: string; label?: string }>;
  requiresLiveRefresh?: boolean;
};
```

Rules:

1. Prepared answers may satisfy simple read-only questions.
2. If a question asks for "maintenant", "dernier", "nouveau", "urgent", or any wording that needs exact freshness, live refresh wins unless the snapshot is still fresh.
3. Mutations can reuse cached context to resolve candidates, but must still go through capability confirmation when the capability requires it.
4. User-facing text must not expose proposal IDs, access tokens, refresh tokens, raw calendar IDs, or route internals.

## Common Question Catalog

Music:

- `spotify.now_playing`: "Qu'est-ce qui joue ?", "C'est quoi cette musique ?"
- `spotify.active_device`: "Spotify est sur quel appareil ?"
- `spotify.list_devices`: "Quels appareils sont disponibles ?"
- `spotify.playback_state`: "La musique est en pause ?"

Mail:

- `mail.unread_summary`: "J'ai des mails ?", "Combien de non lus ?"
- `mail.latest_summary`: "Resume le dernier mail."
- `mail.important_summary`: "J'ai des mails importants ?"
- `mail.waiting_reply`: "A quoi je dois repondre ?"

Todo:

- `todo.today`: "Quelles sont mes taches du jour ?"
- `todo.overdue`: "Qu'est-ce qui est en retard ?"
- `todo.next`: "C'est quoi la prochaine tache ?"
- `todo.lists`: "Quelles listes j'ai ?"

Calendar:

- `calendar.next_event`: "C'est quoi mon prochain rdv ?"
- `calendar.today`: "J'ai quoi aujourd'hui ?"
- `calendar.tomorrow`: "Et demain ?"
- `calendar.free_busy`: "Je suis libre quand ?"

Weather:

- `weather.temperature`: "Il fait combien ?"
- `weather.conditions`: "Quel temps il fait ?"
- `weather.precipitation`: "Il pleut ?"
- `weather.humidity`: "C'est humide ?"
- `weather.today_high`: "Quelle est la maximale aujourd'hui ?"
- `weather.today_low`: "Quelle est la minimale aujourd'hui ?"
- `weather.today_outfit`: "Comment je m'habille aujourd'hui ?"
- `weather.tomorrow`: "Quel temps il fait demain ?"
- `weather.weekly_trend`: "C'est quoi la tendance de la semaine ?"
- `weather.today_by_hour`: "Quel temps il fera a 14h aujourd'hui ?"

Daily brief:

- `daily_brief.today`: "Brief du jour", "Brief du matin", "Programme de la journee"

Executors / Home:

- `executor.timer_state`: "Il reste combien au minuteur ?"
- `executor.light_state`: "La lumiere est allumee ?"
- `executor.cover_state`: "Les volets sont comment ?"
- `executor.scene_state`: "La maison est en mode quoi ?"

NAS / System:

- `nas.health`: "Le NAS va bien ?"
- `nas.storage`: "Il reste combien de place ?"
- `nas.thermal`: "Les temperatures sont OK ?"

## Runtime Flow

1. Warm scheduler refreshes snapshots out of band.
2. Snapshot registry stores `{ value, fetchedAt, ttlMs, staleMs, source }`.
3. Ingest routing chooses the agent as usual.
4. Agent receives both `userText` and optional `warmContext`.
5. Agent can:
   - return a prepared answer directly;
   - use the snapshot as context for synthesis;
   - force a live refresh when freshness is insufficient.
6. `replyMeta` records `contextCache.hit`, `contextCache.freshness`, and `contextCache.fetchedAt`.

## Daily Brief Program

The "brief du jour" is a composed warm answer intended for the morning voice flow: the user has just woken up and wants the practical shape of the day without waiting on several agents.

Default order:

1. Weather outfit signal: min/max today, current condition, and short practical hint.
2. Weather outlook: tomorrow first, then weekly trend when available.
3. Calendar: today and next event.
4. Mail: important/unread summary.
5. Todo: today's tasks, overdue tasks, then next task.
6. News: short headline summary only when the news backend is configured.

Current implementation:

- Provider domain: `daily_brief`.
- Primary prepared answer: `daily_brief.today`.
- Source snapshots: `weather`, `calendar`, `mail`, `todo`, `news`.
- Endpoint: `GET /v1/context-cache?domain=daily_brief`.
- Direct ingest shortcut: "brief du jour", "brief du matin", "programme de la journee".

The brief must stay read-only. It can summarize tasks, mail, calendar and news, but it must not archive mail, mark tasks done, create events, or trigger automations.

## Implementation Roadmap

1. Expand the prepared-answer matcher from conservative regexes to route-catalog examples.
2. Thread warm context deeper into specialized agent calls for synthesis, not only direct prepared answers.
3. Add telemetry dashboards for hit rate, stale usage, live-refresh override, and refresh failures.
4. Add a concrete News provider when the news backend exposes a small headline snapshot contract.
5. Add config flags:
   - `PROACTIVE_CONTEXT_CACHE_ENABLED`
   - `PROACTIVE_CONTEXT_CACHE_AGENTS`
   - per-agent TTL/cadence overrides
6. Add more tests for:
   - fresh hit answer;
   - stale answer plus background refresh;
   - live refresh override for freshness-sensitive wording;
   - no proactive mutation execution;
   - no general HA prewarm.

## Guardrails

- Read-only warming only.
- Per-domain TTLs; no global "one freshness fits all".
- No silent fallback from one domain cache to another.
- Stale data must be labeled in metadata; voice text can stay natural.
- Proactive refresh must degrade quietly and never block ingest startup.
- Secrets and OAuth tokens stay in token stores only, never in snapshots or prepared answers.
