import { z } from 'zod';

export const spotifyActionSchema = z.enum([
  'pause',
  'play',
  'next',
  'previous',
  'volume_set',
  'search',
  'search_and_play',
  'queue_add',
  'clear_queue',
  'transfer',
  'like_track',
  'add_to_playlist',
  'list_devices',
  'now_playing',
]);

export const ingestSpotifyRequestSchema = z.object({
  threadId: z.string().min(1),
  domain: z.literal('spotify'),
  action: spotifyActionSchema,
  slots: z.record(z.string(), z.unknown()).default({}),
  context: z.record(z.string(), z.unknown()).default({}),
  understanding: z
    .object({
      entities: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
  correlation_id: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  text: z.string().optional(),
  clientContext: z.record(z.string(), z.unknown()).optional(),
});

export type IngestSpotifyRequest = z.infer<typeof ingestSpotifyRequestSchema>;

export type JarvisSpotifyStatus = 'success' | 'need_clarification' | 'error';

export type JarvisSpotifyResponse = {
  status: JarvisSpotifyStatus;
  tts: string;
  data?: Record<string, unknown>;
  options?: Array<Record<string, unknown>>;
  error_code?: string;
};

export type SpotifyCapability = {
  action: z.infer<typeof spotifyActionSchema>;
  description: string;
  /** Slots that MUST always be present in the JSON output for this action. */
  required: string[];
  /** Slots that MAY be present (when the user provides the info). */
  optional: string[];
  /** Slots that must NEVER appear for this action — their presence will break execution. */
  forbidden: string[];
  examples: string[];
};
