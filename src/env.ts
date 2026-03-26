import { z } from 'zod';

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

const envSchema = z
  .object({
  BIND_HOST: z.string().default('0.0.0.0'),
  PORT: numberFromEnv.default('8090'),
  LOG_LEVEL: z.string().default('info'),
  BODY_LIMIT_BYTES: numberFromEnv.default('1048576'),

  REQUIRE_API_KEY: booleanFromEnv.default('true'),
  API_KEY: optionalNonEmptyString,
  API_KEYS: optionalNonEmptyString,
  INGEST_ALLOWLIST_IPS: optionalNonEmptyString,

  // Home Assistant connection (conversation/services)
  HA_BASE_URL: z.string().url().optional(),
  HA_TOKEN: optionalNonEmptyString,
  HA_LONG_LIVED_TOKEN: optionalNonEmptyString,
  HA_TIMEOUT_MS: numberFromEnv.default('5000'),
  HA_CONVERSATION_MIN_INTERVAL_MS: numberFromEnv.default('300'),
  HA_CONVERSATION_RETRY_COUNT: numberFromEnv.default('0'),
  HA_CONVERSATION_RETRY_DELAY_MS: numberFromEnv.default('1200'),
  HA_TTS_ENTITY_ID: optionalNonEmptyString,
  HA_TTS_FALLBACK_ENTITY_IDS: optionalNonEmptyString,

  OPENAI_API_KEY: optionalNonEmptyString,
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL_SUMMARY: z.string().default('gpt-4o-mini'),
  OPENAI_MODEL_MUSIC_AGENT: z.string().default('gpt-4o-mini'),
  // Model used by the HA agent router (should be fast + cheap, e.g. gpt-4o-mini)
  OPENAI_MODEL_ROUTER: z.string().default('gpt-4o-mini'),
  // Router circuit breaker settings
  ROUTER_TIMEOUT_MS: numberFromEnv.default('6000'),
  ROUTER_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.70),
  OPENAI_TIMEOUT_MS: numberFromEnv.default('12000'),
  OPENAI_STT_TIMEOUT_MS: numberFromEnv.default('10000'),
  OPENAI_TTS_TIMEOUT_MS: numberFromEnv.default('7000'),
  OPENAI_STT_MODEL: z.string().default('whisper-1'),
  OPENAI_STT_LANGUAGE: optionalNonEmptyString,
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  OPENAI_TTS_VOICE: z.string().default('alloy'),
  OPENAI_TTS_FORMAT: z.enum(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']).default('mp3'),
  // Optional: pass speaking style instructions to gpt-4o-mini-tts (e.g. deep voice, pacing)
  OPENAI_TTS_INSTRUCTIONS: optionalNonEmptyString,
  // Audio post-processing (applied to all TTS output via ffmpeg)
  TTS_SPEED: z.coerce.number().min(0.25).max(4.0).default(1.0),           // atempo 0.5–2.0 (1.0=normal, 1.1=10% faster)
  TTS_PITCH_SEMITONES: z.coerce.number().min(-12).max(12).default(0),     // pitch shift in semitones (0=unchanged)
  TTS_CLARITY: booleanFromEnv.default('false'),                            // highpass rumble cut + 3kHz presence boost
  LIMIT_K: numberFromEnv.default('10'),
  LIMIT_M: numberFromEnv.default('20'),
  LIMIT_N: numberFromEnv.default('16'),

  // Optional: default Spotify content to play when user says e.g. "mets la musique"
  // and we don't have Spotify Web API search configured.
  // Examples: spotify:playlist:... | spotify:album:... | spotify:track:... | https://open.spotify.com/...
  SPOTIFY_DEFAULT_PLAY_URI: optionalNonEmptyString,

  // Optional: Spotify Web API remote control (pause/play/next/previous/volume)
  // Uses refresh_token flow. Recommended scopes: user-read-playback-state user-modify-playback-state
  SPOTIFY_WEBAPI_CLIENT_ID: optionalNonEmptyString,
  SPOTIFY_WEBAPI_CLIENT_SECRET: optionalNonEmptyString,
  SPOTIFY_WEBAPI_REFRESH_TOKEN: optionalNonEmptyString,
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
  SPOTIFY_WEBAPI_DEVICE_DISCOVERY_RETRIES: numberFromEnv.default('2'),
  SPOTIFY_WEBAPI_DEVICE_DISCOVERY_DELAY_MS: numberFromEnv.default('500'),
  // Optional: when true, playlist requests only match current user's playlists (no public catalog fallback)
  SPOTIFY_WEBAPI_USER_PLAYLISTS_ONLY: booleanFromEnv.default('true'),
  SPOTIFY_WEBAPI_BASE_URL: z.string().url().default('https://api.spotify.com'),
  SPOTIFY_WEBAPI_ACCOUNTS_URL: z.string().url().default('https://accounts.spotify.com'),
  SPOTIFY_WEBAPI_TIMEOUT_MS: numberFromEnv.default('8000'),
  SPOTIFY_WEBAPI_REQUEST_RETRIES: numberFromEnv.default('2'),
  SPOTIFY_WEBAPI_REQUEST_RETRY_DELAY_MS: numberFromEnv.default('350'),
  SPOTIFY_WEBAPI_REQUEST_RETRY_MAX_DELAY_MS: numberFromEnv.default('2500'),
  SPOTIFY_WEBAPI_ACTION_RETRIES: numberFromEnv.default('1'),
  SPOTIFY_WEBAPI_ACTION_RETRY_DELAY_MS: numberFromEnv.default('1200'),
  // Optional: avoid refresh during expected WAN outages (example: backup window 03:00-03:20)
  // Jarvis will proactively refresh before this blackout if needed.
  SPOTIFY_WEBAPI_REFRESH_BLACKOUT_START: hhmmFromEnv.default('03:00'),
  SPOTIFY_WEBAPI_REFRESH_BLACKOUT_END: hhmmFromEnv.default('03:20'),
  SPOTIFY_WEBAPI_PRE_REFRESH_WINDOW_MS: numberFromEnv.default('1800000'),

  // General fallback HA conversation agent (used when router is disabled or returns no confident target).
  // Override to point to your custom general agent instead of the default openai_conversation.
  HA_AGENT_GENERAL: z.string().min(1).default('conversation.openai_conversation'),

  // HA Agent Router — enables the LLM orchestrator router.
  // Format: "key:entity_id:hint|key2:entity_id2:hint2"
  // Leave empty to disable router and always use HA_AGENT_GENERAL.
  HA_AGENT_MAP: optionalNonEmptyString,

  // Persistent conversation memory (SQLite) - used by ThreadRepository/MessageRepository
  CONVERSATION_DB_PATH: z.string().default('/app/data/conversation-memory.sqlite'),
  CONVERSATION_RECENT_MESSAGES: numberFromEnv.default('10'),

  // Optional: expose a minimal Home Assistant entity index for mapping/disambiguation
  EXPOSE_HA_INDEX: booleanFromEnv.default('false'),
})
  .transform((value) => ({
    ...value,
    HA_TOKEN: value.HA_TOKEN ?? value.HA_LONG_LIVED_TOKEN,
  }))
  .superRefine((val, ctx) => {
    const hasSingle = Boolean(val.API_KEY?.trim());
    const hasMulti = Boolean(
      val.API_KEYS
        ?.split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0).length
    );

    if (val.REQUIRE_API_KEY && !hasSingle && !hasMulti) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_KEY'],
        message: 'API_KEY or API_KEYS is required when REQUIRE_API_KEY=true',
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


