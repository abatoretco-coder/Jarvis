# NAS Status Monitoring

## Scope

`NasStatusClient` reads the authenticated, read-only NAS collector snapshot. It never retries a request automatically: a connection failure, timeout, HTTP error, interrupted body, malformed JSON, or invalid payload remains observable to the caller.

## Snapshot Contract

Runtime validation applies before a response can replace the cache:

- host names and labels are non-empty and length-bounded;
- timestamps must be valid RFC 3339 date-times;
- uptime, load and byte counters must be finite and non-negative;
- percentages remain between 0 and 100 and agree with their byte counters within the collector's rounding tolerance;
- available or free bytes cannot exceed the corresponding total;
- temperatures, ports and collection sizes are bounded;
- response bodies are limited to 1 MiB before JSON parsing.

Empty filesystem, temperature and protocol collections are valid partial observations. Missing required fields and logical error objects returned with HTTP 200 are not valid snapshots. Invalid responses never replace a previously validated cache.

## Cache and Availability

The cache has three states:

1. Up to `NAS_STATUS_CACHE_TTL_MS`, the snapshot is returned as `fresh` without another request.
2. Between TTL and `NAS_STATUS_CACHE_STALE_MS`, the validated snapshot is returned as `stale` while one shared background refresh runs. Background errors are contained and logged with a stable code.
3. Beyond the stale duration, the caller waits for a refresh. Failure is surfaced instead of presenting an old snapshot as current.

When the stale duration is lower than the TTL, the TTL remains authoritative until it expires; the next access then performs a foreground refresh. Concurrent callers always share the same in-flight request.

Freshness uses the older of the local cache age and the collector's `generatedAt` age. A collector snapshot older than the configured cache window (with a five-second minimum tolerance for second-precision timestamps) is rejected, and a timestamp more than five minutes in the future is invalid. This prevents a newly fetched but already obsolete collector response from being described as current.

The optional `freshness` field is local cache metadata and cannot be supplied by the collector. Existing HTTP serialization remains unchanged because `src/routes/nasStatus.ts` explicitly selects the original public fields.

## Conversational Diagnostics

`formatNasStatus()` prefixes stale data with `Mesure NAS ancienne`. It distinguishes:

- a measured temperature from no temperature measurement;
- measured disks from no disk observation;
- available protocols from protocols confirmed unavailable;
- an empty protocol probe list from stopped services.

The formatter does not invent zero values for missing observations.

## Error Codes

Errors and logs expose stable operational codes rather than provider response bodies or network exception text:

- `nas_status_not_configured`
- `nas_status_timeout`
- `nas_status_network_error`
- `nas_status_body_read_failed`
- `nas_status_response_too_large`
- `nas_status_invalid_json`
- `nas_status_invalid_payload`
- `nas_status_snapshot_too_old`
- `nas_status_http_<status>`

There is no retry loop, so HTTP 429 and 5xx remain visible and cannot amplify an outage.

## Out-of-scope Follow-up

`src/routes/nasStatus.ts` is read-only in this change. It deliberately maps only the original snapshot fields and therefore cannot expose cache freshness to direct `/v1/nas/status` consumers. A later route-specific change may add compatible `freshness` metadata and distinguish stale data from a fully current `status: ok`, but only with route contract tests for existing clients.

The proactive context cache also records its own fetch timestamp after reading the NAS client. It should eventually preserve the collector freshness metadata rather than presenting the outer cache timestamp as proof that the underlying measurement is recent; that module is outside this change's allowed files.

All tests use mocked HTTP responses. No real NAS or Proxmox endpoint is contacted.
