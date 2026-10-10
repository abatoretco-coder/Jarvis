import { z } from 'zod';

import { parseTrustedProxyCidrs } from './security/edgePolicy';

const booleanFromEnv = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false']))
  .transform((v) => v === 'true');

const numberFromEnv = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().regex(/^\d+$/, 'must be an integer'))
  .transform((v) => Number(v));

const hhmmFromEnv = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be in HH:MM 24h format'));

const optionalNonEmptyString = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  return trimmed ? trimmed : undefined;
}, z.string().min(1).optional());

const optionalUrl = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  return trimmed ? trimmed : undefined;
}, z.string().url().optional());

const optionalNumberFromEnv = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  return trimmed ? Number(trimmed) : undefined;
}, z.number().optional());

const envSchema = z
  .object({
    BIND_HOST: z.string().default('0.0.0.0'),
    PORT: numberFromEnv.default(8090),
    LOG_LEVEL: z.string().default('info'),
    BODY_LIMIT_BYTES: numberFromEnv.default(1048576),

    // Public edge. Disabled on developer PCs; the reverse proxy is the only
    // caller allowed to reach the origin when enabled.
    PUBLIC_EDGE_ENABLED: booleanFromEnv.default(false),
    PUBLIC_BASE_URL: optionalUrl,
    ALLOWED_ORIGINS: optionalNonEmptyString,
    TRUSTED_PROXY_CIDRS: optionalNonEmptyString,
    EDGE_PROXY_SECRET: optionalNonEmptyString,
    HSTS_MAX_AGE_SECONDS: numberFromEnv.pipe(z.number().min(300).max(63072000)).default(31536000),

    REQUIRE_API_KEY: booleanFromEnv.default(true),
    ALLOW_LEGACY_API_KEYS: booleanFromEnv.default(false),
    API_KEY: optionalNonEmptyString,
    API_KEYS: optionalNonEmptyString,
    SERVICE_API_KEYS_JSON: optionalNonEmptyString,
    INGEST_ALLOWLIST_IPS: optionalNonEmptyString,
    RATE_LIMIT_WINDOW_MS: numberFromEnv.pipe(z.number().min(1000).max(3600000)).default(60000),
    RATE_LIMIT_MAX: numberFromEnv.pipe(z.number().min(10).max(10000)).default(240),
    RATE_LIMIT_MAX_TRACKED_CLIENTS: numberFromEnv
      .pipe(z.number().min(100).max(100000))
      .default(10000),
    RATE_LIMIT_AUTH_MAX: numberFromEnv.pipe(z.number().min(5).max(1000)).default(30),
    RATE_LIMIT_AI_MAX: numberFromEnv.pipe(z.number().min(5).max(10000)).default(120),
    RATE_LIMIT_AUDIO_MAX: numberFromEnv.pipe(z.number().min(5).max(10000)).default(60),
    RATE_LIMIT_SENSITIVE_MAX: numberFromEnv.pipe(z.number().min(5).max(1000)).default(20),

    // Human identity. Keycloak is the selected OIDC provider; API keys remain service credentials.
    OIDC_ENABLED: booleanFromEnv.default(false),
    OIDC_ISSUER_URL: optionalUrl,
    OIDC_AUDIENCE: optionalNonEmptyString,
    OIDC_JWKS_URL: optionalUrl,
    OIDC_ALLOWED_ALGORITHMS: z.string().default('RS256'),
    OIDC_CLOCK_TOLERANCE_SECONDS: numberFromEnv.pipe(z.number().min(0).max(120)).default(10),
    OIDC_MAX_TOKEN_BYTES: numberFromEnv.pipe(z.number().min(1024).max(32768)).default(8192),
    OIDC_BOOTSTRAP_OWNER_SUBJECT: optionalNonEmptyString,
    OIDC_ALLOW_INSECURE_HTTP: booleanFromEnv.default(false),
    // The public issuer remains HTTPS. This narrowly permits JWKS retrieval on
    // the isolated Docker edge network, never from a client-controlled host.
    OIDC_JWKS_ALLOW_INTERNAL_HTTP: booleanFromEnv.default(false),

    // Home Assistant connection (conversation/services)
    HA_BASE_URL: z.string().url().optional(),
    HA_TOKEN: optionalNonEmptyString,
    HA_LONG_LIVED_TOKEN: optionalNonEmptyString,
    HA_TIMEOUT_MS: numberFromEnv.default(5000),
    HA_CONVERSATION_MIN_INTERVAL_MS: numberFromEnv.default(300),
    HA_CONVERSATION_RETRY_COUNT: numberFromEnv.default(0),
    HA_CONVERSATION_RETRY_DELAY_MS: numberFromEnv.default(1200),
    HA_TTS_ENTITY_ID: optionalNonEmptyString,
    HA_TTS_FALLBACK_ENTITY_IDS: optionalNonEmptyString,
    HOME_CONFIG_ROOT: z.string().default('config/homes'),
    HOME_DATA_ROOT: z.string().default(''),
    ACTIVE_HOME_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/u)
      .default('home_fr_paris_10_fsm_236_lot_204'),

    // Read-only NAS metrics collector.
    NAS_STATUS_URL: optionalUrl,
    NAS_STATUS_TOKEN: optionalNonEmptyString,
    NAS_STATUS_TIMEOUT_MS: numberFromEnv.default(2500),
    NAS_STATUS_CACHE_TTL_MS: numberFromEnv.default(60000),
    NAS_STATUS_CACHE_STALE_MS: numberFromEnv.default(600000),

    // Proactive read-only context cache.
    // Keeps selected agent snapshots warm so common status questions can answer quickly.
    PROACTIVE_CONTEXT_CACHE_ENABLED: booleanFromEnv.default(false),
    PROACTIVE_CONTEXT_CACHE_AGENTS: optionalNonEmptyString,
    PROACTIVE_CONTEXT_CACHE_REFRESH_MS: numberFromEnv.default(60000),
    PROACTIVE_CONTEXT_CACHE_SPOTIFY_TTL_MS: numberFromEnv.default(30000),
    PROACTIVE_CONTEXT_CACHE_SPOTIFY_STALE_MS: numberFromEnv.default(300000),
    PROACTIVE_CONTEXT_CACHE_MAIL_TTL_MS: numberFromEnv.default(180000),
    PROACTIVE_CONTEXT_CACHE_MAIL_STALE_MS: numberFromEnv.default(900000),
    PROACTIVE_CONTEXT_CACHE_TODO_TTL_MS: numberFromEnv.default(300000),
    PROACTIVE_CONTEXT_CACHE_TODO_STALE_MS: numberFromEnv.default(1800000),
    PROACTIVE_CONTEXT_CACHE_CALENDAR_TTL_MS: numberFromEnv.default(300000),
    PROACTIVE_CONTEXT_CACHE_CALENDAR_STALE_MS: numberFromEnv.default(1800000),
    PROACTIVE_CONTEXT_CACHE_WEATHER_TTL_MS: numberFromEnv.default(600000),
    PROACTIVE_CONTEXT_CACHE_WEATHER_STALE_MS: numberFromEnv.default(1800000),
    PROACTIVE_CONTEXT_CACHE_HOME_TTL_MS: numberFromEnv.default(30000),
    PROACTIVE_CONTEXT_CACHE_HOME_STALE_MS: numberFromEnv.default(300000),
    PROACTIVE_CONTEXT_CACHE_NAS_TTL_MS: numberFromEnv.default(60000),
    PROACTIVE_CONTEXT_CACHE_NAS_STALE_MS: numberFromEnv.default(300000),
    PROACTIVE_CONTEXT_CACHE_NEWS_TTL_MS: numberFromEnv.default(1800000),
    PROACTIVE_CONTEXT_CACHE_NEWS_STALE_MS: numberFromEnv.default(7200000),
    PROACTIVE_CONTEXT_CACHE_DAILY_BRIEF_TTL_MS: numberFromEnv.default(300000),
    PROACTIVE_CONTEXT_CACHE_DAILY_BRIEF_STALE_MS: numberFromEnv.default(1800000),

    // Helix/Elix news service. Jarvis remains the public proxy for Desktop/mobile clients.
    HELIX_NEWS_BASE_URL: optionalUrl,
    HELIX_NEWS_API_TOKEN: optionalNonEmptyString,
    HELIX_NEWS_TIMEOUT_MS: numberFromEnv.default(60000),

    // Agora Culture / Sorties. Provider secrets never enter Jarvis.
    AGORA_BASE_URL: optionalUrl,
    AGORA_API_TOKEN: optionalNonEmptyString,
    AGORA_TIMEOUT_MS: numberFromEnv.default(8000),
    CONVERSATION_RESULT_SET_TTL_MS: numberFromEnv
      .pipe(z.number().min(60_000).max(604_800_000))
      .default(86_400_000),
    CULTURE_HOME_LATITUDE: optionalNumberFromEnv.pipe(z.number().min(-90).max(90).optional()),
    CULTURE_HOME_LONGITUDE: optionalNumberFromEnv.pipe(z.number().min(-180).max(180).optional()),
    CULTURE_DEFAULT_RADIUS_KM: z.coerce.number().positive().max(200).default(15),
    CULTURE_DEFAULT_PROFILE_ID: z.string().trim().min(1).max(128).default('local-default'),
    CULTURE_EXPLORATION_RATIO: z.coerce.number().min(0).max(0.5).default(0.25),
    CULTURE_FEEDBACK_RETENTION_DAYS: numberFromEnv.pipe(z.number().min(30).max(3650)).default(730),
    CULTURE_PROACTIVE_ENABLED: booleanFromEnv.default(false),
    CULTURE_PROACTIVE_THRESHOLD: z.coerce.number().min(0).max(200).default(92),
    CULTURE_PROACTIVE_COOLDOWN_MS: numberFromEnv
      .pipe(z.number().min(3_600_000).max(604_800_000))
      .default(86_400_000),
    CULTURE_PROACTIVE_LOOKAHEAD_HOURS: numberFromEnv.pipe(z.number().min(1).max(168)).default(48),
    // Compatibility aliases for existing NAS deployments.
    AGORA_HOME_LAT: optionalNumberFromEnv.pipe(z.number().min(-90).max(90).optional()),
    AGORA_HOME_LON: optionalNumberFromEnv.pipe(z.number().min(-180).max(180).optional()),
    AGORA_HOME_RADIUS_KM: z.coerce.number().positive().max(200).default(15),

    OPENAI_API_KEY: optionalNonEmptyString,
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    LLM_PROVIDER: z.literal('openai').default('openai'),
    // Perplexity — used for real-time search (sonar/sonar-pro per agent config). Takes priority over gpt-4o-search-preview.
    // Model is selected per search agent in src/search/agents.ts — no global override needed.
    PERPLEXITY_API_KEY: optionalNonEmptyString,
    PERPLEXITY_BASE_URL: z.string().url().default('https://api.perplexity.ai'),
    OPENAI_MODEL_SUMMARY: z.string().default('gpt-6-luna'),
    OPENAI_MODEL_AGENT: z.string().default('gpt-6-luna'),
    OPENAI_MODEL_MUSIC_AGENT: z.string().default('gpt-6-luna'),
    OPENAI_MODEL_ROUTER: z.string().default('gpt-6-luna'),
    OPENAI_MODEL_SYNTHESIS: z.string().default('gpt-6.1-sol'),
    OPENAI_MAX_OUTPUT_TOKENS_ROUTER: numberFromEnv.pipe(z.number().min(16).max(4096)).default(256),
    OPENAI_MAX_OUTPUT_TOKENS_SUMMARY: numberFromEnv.pipe(z.number().min(16).max(4096)).default(512),
    OPENAI_MAX_OUTPUT_TOKENS_AGENT: numberFromEnv.pipe(z.number().min(16).max(4096)).default(512),
    OPENAI_MAX_OUTPUT_TOKENS_MUSIC_AGENT: numberFromEnv
      .pipe(z.number().min(16).max(4096))
      .default(384),
    OPENAI_MAX_OUTPUT_TOKENS_SYNTHESIS: numberFromEnv
      .pipe(z.number().min(16).max(4096))
      .default(768),
    // Shared cloud resilience. Budgets are process-local operational guardrails,
    // not a replacement for provider-side project limits.
    OPENAI_RETRY_MAX: numberFromEnv.pipe(z.number().min(0).max(5)).default(2),
    OPENAI_RETRY_BASE_DELAY_MS: numberFromEnv.pipe(z.number().min(10).max(10_000)).default(250),
    OPENAI_RETRY_MAX_DELAY_MS: numberFromEnv.pipe(z.number().min(10).max(60_000)).default(2_000),
    OPENAI_CIRCUIT_FAILURE_THRESHOLD: numberFromEnv.pipe(z.number().min(1).max(100)).default(5),
    OPENAI_CIRCUIT_OPEN_MS: numberFromEnv
      .pipe(z.number().min(1_000).max(3_600_000))
      .default(30_000),
    OPENAI_BUDGET_WINDOW_MS: numberFromEnv
      .pipe(z.number().min(60_000).max(604_800_000))
      .default(86_400_000),
    OPENAI_BUDGET_MAX_REQUESTS: numberFromEnv.pipe(z.number().min(1).max(1_000_000)).default(2_000),
    OPENAI_BUDGET_MAX_TOKENS: numberFromEnv
      .pipe(z.number().min(1_000).max(1_000_000_000))
      .default(2_000_000),
    // Router circuit breaker settings
    ROUTER_TIMEOUT_MS: numberFromEnv.default(3000),
    ROUTER_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
    OPENAI_TIMEOUT_MS: numberFromEnv.default(12000),
    OPENAI_STT_TIMEOUT_MS: numberFromEnv.default(10000),
    OPENAI_TTS_TIMEOUT_MS: numberFromEnv.default(7000),
    // Audio endpoints can be overridden independently from text generation.
    OPENAI_STT_BASE_URL: optionalUrl,
    OPENAI_STT_MODEL: z.string().default('gpt-transcribe'),
    OPENAI_STT_LANGUAGE: optionalNonEmptyString,
    OPENAI_TTS_MODEL: z.string().default('gpt-realtime-2.1-mini'),
    OPENAI_TTS_VOICE: z.string().default('marin'),
    OPENAI_TTS_FORMAT: z.enum(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']).default('mp3'),
    // Optional speaking-style instructions for the configured OpenAI speech model.
    OPENAI_TTS_INSTRUCTIONS: optionalNonEmptyString,
    // Audio post-processing (applied to all TTS output via ffmpeg)
    TTS_SPEED: z.coerce.number().min(0.25).max(4.0).default(1.0), // atempo 0.5–2.0 (1.0=normal, 1.1=10% faster)
    TTS_PITCH_SEMITONES: z.coerce.number().min(-12).max(12).default(0), // pitch shift in semitones (0=unchanged)
    TTS_CLARITY: booleanFromEnv.default(false), // highpass rumble cut + 3kHz presence boost
    LIMIT_K: numberFromEnv.default(10),
    LIMIT_M: numberFromEnv.default(20),
    LIMIT_N: numberFromEnv.default(16),

    // Optional: default Spotify content to play when user says e.g. "mets la musique"
    // and we don't have Spotify Web API search configured.
    // Examples: spotify:playlist:... | spotify:album:... | spotify:track:... | https://open.spotify.com/...
    SPOTIFY_DEFAULT_PLAY_URI: optionalNonEmptyString,

    // Optional: Spotify Web API remote control (pause/play/next/previous/volume)
    // Uses refresh_token flow. Recommended scopes: user-read-playback-state user-modify-playback-state
    SPOTIFY_WEBAPI_CLIENT_ID: optionalNonEmptyString,
    SPOTIFY_WEBAPI_CLIENT_SECRET: optionalNonEmptyString,
    SPOTIFY_WEBAPI_REFRESH_TOKEN: optionalNonEmptyString,
    SPOTIFY_WEBAPI_TOKEN_STORE_PATH: z.string().default('/app/data/spotify-token.json'),
    // Optional: target a specific Spotify Connect device id (otherwise controls the current active device)
    SPOTIFY_WEBAPI_DEVICE_ID: optionalNonEmptyString,
    // Optional: fallback target device name when SPOTIFY_WEBAPI_DEVICE_ID is not found (e.g. after reconnect)
    SPOTIFY_WEBAPI_DEVICE_NAME: optionalNonEmptyString,
    // Optional: voice alias mapping for device targeting
    // - alias:phone -> default "S22+"
    // - alias:computer -> default SPOTIFY_WEBAPI_DEVICE_NAME (or "jarvis Home")
    // - alias:salon -> default "librespot"
    SPOTIFY_WEBAPI_DEVICE_ALIAS_PHONE_NAME: optionalNonEmptyString,
    SPOTIFY_WEBAPI_DEVICE_ALIAS_COMPUTER_NAME: optionalNonEmptyString,
    SPOTIFY_WEBAPI_DEVICE_ALIAS_SALON_NAME: optionalNonEmptyString,
    // Optional: retries/backoff when device id/name is missing from Spotify devices list
    SPOTIFY_WEBAPI_DEVICE_DISCOVERY_RETRIES: numberFromEnv.default(2),
    SPOTIFY_WEBAPI_DEVICE_DISCOVERY_DELAY_MS: numberFromEnv.default(500),
    // Optional: when true, playlist requests only match current user's playlists (no public catalog fallback)
    SPOTIFY_WEBAPI_USER_PLAYLISTS_ONLY: booleanFromEnv.default(true),
    SPOTIFY_WEBAPI_BASE_URL: z.string().url().default('https://api.spotify.com'),
    SPOTIFY_WEBAPI_ACCOUNTS_URL: z.string().url().default('https://accounts.spotify.com'),
    SPOTIFY_WEBAPI_TIMEOUT_MS: numberFromEnv.default(8000),
    SPOTIFY_WEBAPI_REQUEST_RETRIES: numberFromEnv.default(2),
    SPOTIFY_WEBAPI_REQUEST_RETRY_DELAY_MS: numberFromEnv.default(350),
    SPOTIFY_WEBAPI_REQUEST_RETRY_MAX_DELAY_MS: numberFromEnv.default(2500),
    SPOTIFY_WEBAPI_ACTION_RETRIES: numberFromEnv.default(1),
    SPOTIFY_WEBAPI_ACTION_RETRY_DELAY_MS: numberFromEnv.default(1200),
    // Optional: avoid refresh during expected WAN outages (example: backup window 03:00-03:20)
    // Jarvis will proactively refresh before this blackout if needed.
    SPOTIFY_WEBAPI_REFRESH_BLACKOUT_START: hhmmFromEnv.default('03:00'),
    SPOTIFY_WEBAPI_REFRESH_BLACKOUT_END: hhmmFromEnv.default('03:20'),
    SPOTIFY_WEBAPI_PRE_REFRESH_WINDOW_MS: numberFromEnv.default(1800000),

    // ── Semantic Router (Phase 1A — shadow mode) ────────────────────────────────
    // When enabled, the semantic router classifies every request via OpenAI embeddings.
    // shadow_mode=true → log only, no LLM override.
    SEMANTIC_ROUTER_ENABLED: booleanFromEnv.default(false),
    SEMANTIC_ROUTER_SHADOW_MODE: booleanFromEnv.default(true),
    // OpenAI embedding model used by the semantic router.
    SEMANTIC_ROUTER_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    SEMANTIC_ROUTER_ACCEPT_SCORE: z.coerce.number().min(0.5).max(0.99).default(0.84),
    SEMANTIC_ROUTER_MIN_MARGIN: z.coerce.number().min(0.01).max(0.3).default(0.08),
    SEMANTIC_ROUTER_MULTI_INTENT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
    SEMANTIC_ROUTER_TIMEOUT_MS: numberFromEnv.default(5000),
    // Pre-compute route embeddings at startup to reduce first-request latency.
    SEMANTIC_ROUTER_WARMUP_ON_STARTUP: booleanFromEnv.default(true),
    SEMANTIC_ROUTER_WARMUP_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(12),
    // Phase 1B: when true (and shadow mode=false), semantic accepted E2 routes can
    // execute directly, but only if explicitly allowlisted.
    SEMANTIC_ROUTER_ACTIVATION_ENABLED: booleanFromEnv.default(false),
    // Comma-separated route keys allowed for Phase 1B activation.
    // Example: "spotify.pause,spotify.play,weather.current_temperature"
    SEMANTIC_ROUTER_ACTIVATED_E2_ROUTES: optionalNonEmptyString,
    // Phase 2A: when true (and shadow mode=false), accepted E1 routes can execute
    // directly for the explicitly allowlisted safe routes.
    SEMANTIC_ROUTER_E1_ACTIVATION_ENABLED: booleanFromEnv.default(false),
    // Comma-separated route keys allowed for Phase 2A E1 activation.
    // Example: "search.deep.analysis,spotify.search_and_play"
    SEMANTIC_ROUTER_ACTIVATED_E1_ROUTES: optionalNonEmptyString,
    // Phase 2E: dedicated gate for high-risk E1 routes (mail send/reply/forward/trash,
    // plus explicitly marked destructive todo mutations).
    SEMANTIC_ROUTER_E1_HIGH_RISK_ACTIVATION_ENABLED: booleanFromEnv.default(false),
    // Comma-separated high-risk E1 routes allowed in live mode.
    SEMANTIC_ROUTER_ACTIVATED_E1_HIGH_RISK_ROUTES: optionalNonEmptyString,
    // Stricter confidence gates for high-risk E1 routes.
    SEMANTIC_ROUTER_HIGH_RISK_ACCEPT_SCORE: z.coerce.number().min(0.5).max(0.99).default(0.9),
    SEMANTIC_ROUTER_HIGH_RISK_MIN_MARGIN: z.coerce.number().min(0.01).max(0.3).default(0.12),

    // General fallback HA conversation agent (used when router is disabled or returns no confident target).
    // Override to point to your custom general agent instead of the default openai_conversation.
    HA_AGENT_GENERAL: z.string().min(1).default('conversation.openai_conversation'),

    // HA Agent Router — enables the LLM orchestrator router.
    // Format: "key:entity_id:hint|key2:entity_id2:hint2"
    // Leave empty to disable router and always use HA_AGENT_GENERAL.
    HA_AGENT_MAP: optionalNonEmptyString,

    // Persistent conversation memory (SQLite) - used by ThreadRepository/MessageRepository
    CONVERSATION_DB_PATH: z.string().default('/app/data/conversation-memory.sqlite'),
    CONVERSATION_RECENT_MESSAGES: numberFromEnv.default(10),

    // Optional: expose a minimal Home Assistant entity index for mapping/disambiguation
    EXPOSE_HA_INDEX: booleanFromEnv.default(false),

    // Persistent store for rotated OAuth refresh tokens (mail/todo).
    // Allows automatic token rotation to survive process restarts.
    OAUTH_REFRESH_TOKEN_STORE_PATH: z.string().default('/app/data/oauth-refresh-tokens.json'),
    // Base64-encoded 32-byte AES key used only for per-user OAuth refresh tokens.
    // Keep it outside the database and rotate by incrementing the key version.
    OAUTH_TOKEN_ENCRYPTION_KEY: optionalNonEmptyString,
    OAUTH_TOKEN_KEY_VERSION: numberFromEnv.pipe(z.number().int().min(1).max(1_000_000)).default(1),
    INTEGRATION_OAUTH_REDIRECT_URI: optionalUrl,

    // ── Microsoft Graph — Todo agent ─────────────────────────────────────────────
    // Required for todo.* sub-agent.
    // Register an app at https://portal.azure.com → Azure Active Directory → App registrations.
    // Scopes needed: Tasks.ReadWrite, offline_access
    // MICROSOFT_TENANT_ID: use "common" for personal accounts, your tenant UUID for corporate.
    MICROSOFT_TENANT_ID: z.string().default('common'),
    MICROSOFT_CLIENT_ID: optionalNonEmptyString,
    MICROSOFT_CLIENT_SECRET: optionalNonEmptyString,
    MICROSOFT_REFRESH_TOKEN: optionalNonEmptyString,

    // ── Google — Gmail mail agent + Calendar agent ───────────────────────────────
    // Required for mail.* (gmail) sub-agent and calendar.* sub-agent.
    // Create OAuth2 credentials at https://console.cloud.google.com → APIs & Services → Credentials.
    // Scopes needed: https://mail.google.com/ + https://www.googleapis.com/auth/calendar
    GOOGLE_CLIENT_ID: optionalNonEmptyString,
    GOOGLE_CLIENT_SECRET: optionalNonEmptyString,
    GOOGLE_REFRESH_TOKEN: optionalNonEmptyString,
    // OAuth redirect URI used for the oneshot setup flow.
    OAUTH_REDIRECT_URI: optionalNonEmptyString,

    // ── Google Calendar — dashboard agenda + calendar agent ──────────────────────
    // Comma-separated list of Google Calendar IDs to include in the dashboard agenda
    // section and calendar conversational queries.
    // Examples: "primary", "primary,famille@group.calendar.google.com,anniversaires@group.calendar.google.com"
    // Defaults to "primary" when not set.
    // Required scopes: https://www.googleapis.com/auth/calendar.readonly (read) or
    //                  https://www.googleapis.com/auth/calendar (read + write for create_event)
    GOOGLE_CALENDAR_CALENDAR_IDS: optionalNonEmptyString,
    // Calendar ID used for newly created events when the user does not name a calendar.
    // Keep GOOGLE_CALENDAR_CALENDAR_IDS for reads/searches across several calendars.
    GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_ID: optionalNonEmptyString,
    // Optional display label used in user-facing confirmations after creating events.
    GOOGLE_CALENDAR_DEFAULT_CREATE_CALENDAR_LABEL: optionalNonEmptyString,

    // ── Mail provider override ────────────────────────────────────────────────────
    // Mail is Gmail-only. Keep empty or set "gmail".
    MAIL_PROVIDER: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim().toLowerCase() || undefined : v),
      z.enum(['gmail']).optional()
    ),

    // ── Multi-account mail (indexed, up to 5) ────────────────────────────────────
    // When set, these override single-account GOOGLE_* vars.
    // MAIL_ACCOUNT_N_PROVIDER: "gmail"
    // Optional unlimited mode: MAIL_ACCOUNTS_JSON='[{"label":"perso","provider":"gmail",...}]'
    MAIL_ACCOUNTS_JSON: optionalNonEmptyString,

    MAIL_ACCOUNT_1_LABEL: optionalNonEmptyString,
    MAIL_ACCOUNT_1_PROVIDER: optionalNonEmptyString,
    MAIL_ACCOUNT_1_CLIENT_ID: optionalNonEmptyString,
    MAIL_ACCOUNT_1_CLIENT_SECRET: optionalNonEmptyString,
    MAIL_ACCOUNT_1_REFRESH_TOKEN: optionalNonEmptyString,
    MAIL_ACCOUNT_1_TENANT_ID: optionalNonEmptyString,

    MAIL_ACCOUNT_2_LABEL: optionalNonEmptyString,
    MAIL_ACCOUNT_2_PROVIDER: optionalNonEmptyString,
    MAIL_ACCOUNT_2_CLIENT_ID: optionalNonEmptyString,
    MAIL_ACCOUNT_2_CLIENT_SECRET: optionalNonEmptyString,
    MAIL_ACCOUNT_2_REFRESH_TOKEN: optionalNonEmptyString,
    MAIL_ACCOUNT_2_TENANT_ID: optionalNonEmptyString,

    MAIL_ACCOUNT_3_LABEL: optionalNonEmptyString,
    MAIL_ACCOUNT_3_PROVIDER: optionalNonEmptyString,
    MAIL_ACCOUNT_3_CLIENT_ID: optionalNonEmptyString,
    MAIL_ACCOUNT_3_CLIENT_SECRET: optionalNonEmptyString,
    MAIL_ACCOUNT_3_REFRESH_TOKEN: optionalNonEmptyString,
    MAIL_ACCOUNT_3_TENANT_ID: optionalNonEmptyString,

    MAIL_ACCOUNT_4_LABEL: optionalNonEmptyString,
    MAIL_ACCOUNT_4_PROVIDER: optionalNonEmptyString,
    MAIL_ACCOUNT_4_CLIENT_ID: optionalNonEmptyString,
    MAIL_ACCOUNT_4_CLIENT_SECRET: optionalNonEmptyString,
    MAIL_ACCOUNT_4_REFRESH_TOKEN: optionalNonEmptyString,
    MAIL_ACCOUNT_4_TENANT_ID: optionalNonEmptyString,

    MAIL_ACCOUNT_5_LABEL: optionalNonEmptyString,
    MAIL_ACCOUNT_5_PROVIDER: optionalNonEmptyString,
    MAIL_ACCOUNT_5_CLIENT_ID: optionalNonEmptyString,
    MAIL_ACCOUNT_5_CLIENT_SECRET: optionalNonEmptyString,
    MAIL_ACCOUNT_5_REFRESH_TOKEN: optionalNonEmptyString,
    MAIL_ACCOUNT_5_TENANT_ID: optionalNonEmptyString,
  })
  .transform((value) => ({
    ...value,
    HA_TOKEN: value.HA_TOKEN ?? value.HA_LONG_LIVED_TOKEN,
  }))
  .superRefine((val, ctx) => {
    if (val.ALLOW_LEGACY_API_KEYS || val.API_KEY || val.API_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOW_LEGACY_API_KEYS'],
        message: 'legacy global API keys are retired; use SERVICE_API_KEYS_JSON',
      });
    }

    if (val.REQUIRE_API_KEY) {
      let hasScoped = false;
      if (val.SERVICE_API_KEYS_JSON) {
        try {
          const parsed = JSON.parse(val.SERVICE_API_KEYS_JSON) as unknown;
          hasScoped = Array.isArray(parsed) && parsed.length > 0;
        } catch {
          // A dedicated validation error is added below.
        }
      }
      if (!hasScoped && !val.OIDC_ENABLED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SERVICE_API_KEYS_JSON'],
          message: 'OIDC or a scoped service credential is required when REQUIRE_API_KEY=true',
        });
      }
    }
    if (val.SERVICE_API_KEYS_JSON) {
      try {
        const parsed = JSON.parse(val.SERVICE_API_KEYS_JSON) as unknown;
        const permissions = new Set([
          'chat',
          'history',
          'mail',
          'calendar',
          'todo',
          'music',
          'home',
          'cameras',
          'admin',
          'nas.operations',
        ]);
        const valid =
          Array.isArray(parsed) &&
          parsed.length <= 100 &&
          parsed.every((entry) => {
            if (!entry || typeof entry !== 'object') return false;
            const candidate = entry as Record<string, unknown>;
            return (
              typeof candidate.id === 'string' &&
              candidate.id.trim().length > 0 &&
              candidate.id.length <= 128 &&
              typeof candidate.token === 'string' &&
              candidate.token.length >= 32 &&
              candidate.token.length <= 512 &&
              Array.isArray(candidate.permissions) &&
              candidate.permissions.length > 0 &&
              candidate.permissions.every(
                (permission) => typeof permission === 'string' && permissions.has(permission)
              )
            );
          });
        if (!valid) throw new Error();
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SERVICE_API_KEYS_JSON'],
          message: 'must be a valid scoped service credential array',
        });
      }
    }
    if (val.OPENAI_RETRY_MAX_DELAY_MS < val.OPENAI_RETRY_BASE_DELAY_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_RETRY_MAX_DELAY_MS'],
        message:
          'OPENAI_RETRY_MAX_DELAY_MS must be greater than or equal to OPENAI_RETRY_BASE_DELAY_MS',
      });
    }
    if (val.OIDC_ENABLED && (!val.OIDC_ISSUER_URL || !val.OIDC_AUDIENCE)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OIDC_ISSUER_URL'],
        message: 'OIDC_ISSUER_URL and OIDC_AUDIENCE are required when OIDC_ENABLED=true',
      });
    }
    if (val.PUBLIC_BASE_URL) {
      const publicUrl = new URL(val.PUBLIC_BASE_URL);
      if (
        publicUrl.protocol !== 'https:' ||
        publicUrl.username ||
        publicUrl.password ||
        publicUrl.pathname !== '/' ||
        publicUrl.search ||
        publicUrl.hash
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PUBLIC_BASE_URL'],
          message: 'must be an HTTPS origin without credentials, path, query or fragment',
        });
      }
    }
    if (val.ALLOWED_ORIGINS) {
      const origins = val.ALLOWED_ORIGINS.split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (
        origins.length > 20 ||
        origins.some((origin) => {
          try {
            const parsed = new URL(origin);
            return parsed.origin === 'null' || parsed.href !== `${parsed.origin}/`;
          } catch {
            return true;
          }
        })
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ALLOWED_ORIGINS'],
          message: 'must contain at most 20 comma-separated URL origins',
        });
      }
    }
    if (val.PUBLIC_EDGE_ENABLED) {
      if (!val.PUBLIC_BASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PUBLIC_BASE_URL'],
          message: 'is required when PUBLIC_EDGE_ENABLED=true',
        });
      }
      if (!val.TRUSTED_PROXY_CIDRS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRUSTED_PROXY_CIDRS'],
          message: 'is required when PUBLIC_EDGE_ENABLED=true',
        });
      }
      if (!val.EDGE_PROXY_SECRET || val.EDGE_PROXY_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EDGE_PROXY_SECRET'],
          message: 'must contain at least 32 characters when PUBLIC_EDGE_ENABLED=true',
        });
      }
      if (!val.OIDC_ENABLED || !val.REQUIRE_API_KEY || val.ALLOW_LEGACY_API_KEYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PUBLIC_EDGE_ENABLED'],
          message:
            'requires OIDC_ENABLED=true, REQUIRE_API_KEY=true and ALLOW_LEGACY_API_KEYS=false',
        });
      }
      if (val.OIDC_ALLOW_INSECURE_HTTP) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OIDC_ALLOW_INSECURE_HTTP'],
          message: 'must be false when PUBLIC_EDGE_ENABLED=true',
        });
      }
    }
    if (val.TRUSTED_PROXY_CIDRS) {
      try {
        parseTrustedProxyCidrs(val.TRUSTED_PROXY_CIDRS);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRUSTED_PROXY_CIDRS'],
          message: 'must contain at most 16 valid IP or CIDR values',
        });
      }
    }
    if (val.OAUTH_TOKEN_ENCRYPTION_KEY) {
      const decoded = Buffer.from(val.OAUTH_TOKEN_ENCRYPTION_KEY, 'base64');
      const decodedLength = decoded.length;
      const canonical = decoded.toString('base64') === val.OAUTH_TOKEN_ENCRYPTION_KEY;
      if (decodedLength !== 32 || !canonical) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OAUTH_TOKEN_ENCRYPTION_KEY'],
          message: 'must be a base64-encoded 32-byte key',
        });
      }
    }
    if (val.INTEGRATION_OAUTH_REDIRECT_URI) {
      const redirect = new URL(val.INTEGRATION_OAUTH_REDIRECT_URI);
      const loopback = ['localhost', '127.0.0.1', '::1'].includes(redirect.hostname);
      if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && loopback)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['INTEGRATION_OAUTH_REDIRECT_URI'],
          message: 'must use HTTPS (HTTP is limited to loopback development)',
        });
      }
    }
    for (const [name, value] of [
      ['OIDC_ISSUER_URL', val.OIDC_ISSUER_URL],
      ['OIDC_JWKS_URL', val.OIDC_JWKS_URL],
    ] as const) {
      if (!value) continue;
      const url = new URL(value);
      const loopback =
        url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
      const explicitlyAllowedLocalHttp =
        url.protocol === 'http:' && val.OIDC_ALLOW_INSECURE_HTTP && !val.PUBLIC_EDGE_ENABLED;
      const explicitlyAllowedInternalJwks =
        name === 'OIDC_JWKS_URL' &&
        url.protocol === 'http:' &&
        url.hostname === 'identity-edge-origin' &&
        url.port === '8080' &&
        val.OIDC_JWKS_ALLOW_INTERNAL_HTTP;
      if (
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && loopback) &&
        !explicitlyAllowedLocalHttp &&
        !explicitlyAllowedInternalJwks
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} must use HTTPS (HTTP is limited to loopback development)`,
        });
      }
    }
    const algorithms = val.OIDC_ALLOWED_ALGORITHMS.split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (
      algorithms.length === 0 ||
      algorithms.some(
        (algorithm) => !['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'].includes(algorithm)
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OIDC_ALLOWED_ALGORITHMS'],
        message: 'contains an unsupported signing algorithm',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(rawEnv: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment variables:\n${message}`);
  }
  return parsed.data;
}
