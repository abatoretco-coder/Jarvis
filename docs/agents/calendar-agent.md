# Google Calendar Agent

## Scope

The Calendar agent reads and mutates Google Calendar directly through the v3 API. The configured calendar allowlist controls every explicit target. When no target is supplied, reads aggregate the configured calendars and creates use `GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID` or `primary`.

## Functional Matrix

| Operation | Preconditions | Evidence of success | Failure and ambiguity policy |
| --- | --- | --- | --- |
| Calendar discovery | Valid OAuth credentials | All bounded `calendarList.list` pages are parsed | Missing or malformed pages fail; only owner/writer calendars are selected |
| List/search events | Allowed calendar IDs and valid Paris-local bounds | Every bounded page is collected and sorted | Partial calendars are named; all-source failure remains an error |
| Create event | Writable allowlisted calendar, valid start/end | Google returns the client-generated event ID | Network/408/5xx is uncertain and never replayed automatically |
| Repeat create | Same stable operation identity at the `/v1/ingest` boundary | The persistent mutation result is replayed without invoking Calendar again | Without an operation identity, an uncertain direct call must not be replayed automatically |
| Update event | A uniquely resolved event ID and calendar ID | PATCH returns the same event ID | Similar candidates require clarification; uncertain PATCH is not retried |
| Delete event | A uniquely resolved event ID and calendar ID | HTTP 204, or 404 when already absent | Similar candidates require clarification; uncertain DELETE is not retried |
| Recurring occurrence | Search uses `singleEvents=true` | The occurrence ID, not the parent series ID, is mutated | Whole-series or “this and following” editing is not exposed by the current agent contract |
| All-day event | Strict `YYYY-MM-DD` dates | Start is inclusive and end remains exclusive | Invalid dates and zero-length periods are rejected before the API call |
| Guests | Existing attendee list must be readable | Removal PATCH returns the event ID | Adding guests is not exposed by the current agent planner |

## Reliability Rules

1. OAuth refreshes are single-flight. A refused API request with HTTP 401 invalidates the cached access token and is replayed once with a fresh token. HTTP 403 permission failures do not refresh credentials.
2. Reads may be retried once after a network failure, quota response, or 5xx. `Retry-After` is honored only when it fits the bounded retry window; otherwise the failure is surfaced without an early retry.
3. POST, PATCH, and DELETE are never automatically retried after an uncertain network, 408, or 5xx result.
4. Calendar and event pagination is bounded to 20 pages and 2,000 items. At most 25 configured calendars are accepted, with at most four calendar reads in flight.
5. API paths are relative to the fixed Google Calendar v3 origin, redirects are rejected, collection shapes and page tokens are validated, and provider response bodies are not copied into public error messages.
6. Every independent event creation uses a fresh Google-compatible client event ID. Persistent deduplication is keyed by the caller's stable `Idempotency-Key` at `/v1/ingest`, so identical event contents remain valid independent requests while a replay of the same operation does not issue another POST, including after a backend restart.
7. Confirmed pending mutations use their persisted `proposalId` and atomic execution state as their operation identity. A repeated confirmation cannot start a second execution.

## Time Semantics

1. User-local date-times are interpreted in `Europe/Paris` and sent with that IANA time zone.
2. Invalid calendar dates and nonexistent local times during the spring DST jump are rejected.
3. The repeated hour during the autumn DST change is resolved deterministically to the later occurrence.
4. Query boundaries are converted to RFC3339 UTC instants. All-day dates are kept as calendar dates and their exclusive end is not shifted.
5. Moving an event start while preserving its duration uses absolute instants, then formats the derived end back in `Europe/Paris`.

## Out-of-scope Route Duplication

`src/routes/googleCalendar.ts` remains unchanged. Its private `googleCalendarRequest()` and OAuth refresh path currently differ from this shared client:

- no shared access-token cache or single-flight refresh;
- no one-time 401 recovery;
- no differentiated read retry versus uncertain mutation;
- provider response excerpts are embedded in thrown errors;
- no redirect policy or generic bounded pagination;
- POST does not provide a client event ID for reconciliation.

A later route-specific PR should migrate the route to the shared client only after contract tests prove compatibility for personal connection selection, `connectionId`, response status codes, `sendUpdates`, and route payloads. This PR deliberately does not merge the two implementations.

## Residual Limits

- Direct callers of `executeCalendarAgentAction()` do not provide an operation identity. After an uncertain create result they must not call the function again automatically: only the `/v1/ingest` path can recover or replay the persisted operation result across a backend restart.
- Creating recurring series, adding attendees, and selecting “entire series” versus “this and following” are not represented by the existing Calendar agent action contract. Existing occurrences can still be individually selected and changed by their instance ID.
- No live Google account is used by the test suite; all API and OAuth behavior is mocked.

## Validation

- Targeted regression tests cover pagination, OAuth expiry, permission and quota failures, uncertain mutations, creation reconciliation, ambiguous matches, recurring occurrences, and Europe/Paris DST boundaries.
- The repository validation command runs linting, production and test TypeScript builds, the complete Jest suite, and the capability architecture check.
