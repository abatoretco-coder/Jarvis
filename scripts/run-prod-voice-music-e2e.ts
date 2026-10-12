import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Tokens = { access_token: string; refresh_token: string };
type Playback = {
  isPlaying: boolean;
  progressMs: number;
  shuffle: boolean;
  repeat: 'off' | 'track' | 'context';
  track: null | { id: string; title: string; artists: string[] };
  device: null | { id: string; name: string; volumePercent?: number };
};
type MusicSnapshot = {
  connected: boolean;
  playback: Playback | null;
  devices: Array<{ id: string; name: string; availability?: string; isActive: boolean }>;
  playlists: Array<{ id: string; name: string; uri: string }>;
};
type Queue = {
  current: null | { uri?: string };
  queue: Array<{ uri?: string }>;
};
type MusicSearch = { items: Array<{ uri?: string; name?: string; artists?: string[] }> };
type IngestResponse = {
  responseText: string;
  replyMeta?: { routeKey?: string; semanticDecision?: string };
};
type VoiceResult = {
  id: string;
  spoken: string;
  transcript: string;
  route?: string;
  decision?: string;
  reply: string;
  ok: boolean;
  ttsMs: number;
  sttMs: number;
  ingestMs: number;
  beforePlaying?: boolean;
  afterPlaying?: boolean;
  beforeTrack?: string;
  afterTrack?: string;
  afterArtist?: string;
  device?: string;
  inputAudioSource?: 'production-tts' | 'local-sapi-fallback';
  productionTtsError?: string;
  error?: string;
};

const baseUrl = (process.env.E2E_LIVE_BASE_URL ?? 'https://jarvis-abato.duckdns.org').replace(
  /\/app\/?$/u,
  ''
);
const ownerEmail = process.env.E2E_LIVE_OWNER_EMAIL ?? 'abatoretco@gmail.com';
const keycloakUrl = process.env.E2E_LIVE_KEYCLOAK_URL ?? 'http://127.0.0.1:8180';
const identityContainer = process.env.E2E_LIVE_IDENTITY_CONTAINER ?? 'jarvis-pc-identity-1';
const useProductionTtsForInput = process.env.E2E_LIVE_USE_PRODUCTION_TTS_INPUT === '1';
const results: VoiceResult[] = [];

function dockerEnv(name: string): string {
  return execFileSync('docker', ['exec', identityContainer, 'printenv', name], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function synthesizeLocalSpeech(text: string): Buffer {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-voice-e2e-'));
  const output = join(directory, 'command.wav');
  const script = [
    '& {',
    'Add-Type -AssemblyName System.Speech;',
    '$voice = [System.Speech.Synthesis.SpeechSynthesizer]::new();',
    'try { $voice.SetOutputToWaveFile($env:JARVIS_SPEECH_PATH); $voice.Speak($env:JARVIS_SPEECH_TEXT) } finally { $voice.Dispose() }',
    '}',
  ].join(' ');
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, JARVIS_SPEECH_TEXT: text, JARVIS_SPEECH_PATH: output },
    });
    return readFileSync(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`http_${response.status}:${body.slice(0, 500)}`);
  return JSON.parse(body) as T;
}

async function form<T>(
  url: string,
  body: Record<string, string>,
  headers?: HeadersInit
): Promise<T> {
  return jsonResponse<T>(
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body),
    })
  );
}

async function ownerTokens(): Promise<Tokens> {
  const admin = await form<{ access_token: string }>(
    `${keycloakUrl}/realms/master/protocol/openid-connect/token`,
    {
      client_id: 'admin-cli',
      grant_type: 'password',
      username: dockerEnv('KC_BOOTSTRAP_ADMIN_USERNAME'),
      password: dockerEnv('KC_BOOTSTRAP_ADMIN_PASSWORD'),
    }
  );
  const ownerResponse = await fetch(
    `${keycloakUrl}/admin/realms/jarvis/users?username=${encodeURIComponent(ownerEmail)}&exact=true`,
    { headers: { authorization: `Bearer ${admin.access_token}` } }
  );
  const owners = await jsonResponse<Array<{ id: string }>>(ownerResponse);
  if (owners.length !== 1) throw new Error('owner_keycloak_user_not_found');

  const impersonation = await fetch(
    `${keycloakUrl}/admin/realms/jarvis/users/${encodeURIComponent(owners[0].id)}/impersonation`,
    { method: 'POST', headers: { authorization: `Bearer ${admin.access_token}` } }
  );
  if (!impersonation.ok) throw new Error(`owner_impersonation_failed:${impersonation.status}`);
  const cookieHeaders = (
    impersonation.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.() ?? [impersonation.headers.get('set-cookie') ?? ''];
  const cookie = cookieHeaders
    .map((value) => value.split(';', 1)[0])
    .filter(Boolean)
    .join('; ');
  if (!cookie) throw new Error('owner_impersonation_cookie_missing');

  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const redirectUri = `${baseUrl}/app/`;
  const state = randomUUID();
  const authorization = new URL(`${keycloakUrl}/realms/jarvis/protocol/openid-connect/auth`);
  authorization.search = new URLSearchParams({
    client_id: 'jarvis-web',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const callbackResponse = await fetch(authorization, {
    headers: { cookie },
    redirect: 'manual',
  });
  const location = callbackResponse.headers.get('location');
  if (callbackResponse.status !== 302 || !location)
    throw new Error('owner_impersonation_authorization_failed');
  const callback = new URL(location);
  if (callback.searchParams.get('state') !== state || !callback.searchParams.get('code')) {
    throw new Error('owner_impersonation_callback_invalid');
  }
  return form<Tokens>(`${keycloakUrl}/realms/jarvis/protocol/openid-connect/token`, {
    client_id: 'jarvis-web',
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code')!,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

async function main(): Promise<void> {
  const readOnly = process.env.E2E_LIVE_READ_ONLY === '1';
  const playbackOverride = process.env.E2E_LIVE_PLAYBACK_OVERRIDE;
  const playQuery = process.env.E2E_LIVE_PLAY_QUERY?.trim();
  if (playbackOverride && playbackOverride !== 'play' && playbackOverride !== 'pause') {
    throw new Error('E2E_LIVE_PLAYBACK_OVERRIDE must be play or pause.');
  }
  if (!readOnly && process.env.E2E_LIVE_CONFIRM !== 'production') {
    throw new Error(
      'Set E2E_LIVE_CONFIRM=production to run state-changing checks against the live Spotify account.'
    );
  }
  const tokens = await ownerTokens();
  const headers = { authorization: `Bearer ${tokens.access_token}` };
  let original: MusicSnapshot | undefined;
  let originalQueue: Queue | undefined;
  let spotifyConnectionId = '';

  const get = async <T>(path: string): Promise<T> =>
    jsonResponse<T>(await fetch(`${baseUrl}${path}`, { headers }));
  const post = async <T>(
    path: string,
    body: unknown,
    extra: Record<string, string> = {}
  ): Promise<T> =>
    jsonResponse<T>(
      await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', ...extra },
        body: JSON.stringify(body),
      })
    );
  const music = () => get<MusicSnapshot>('/v1/music');
  const action = (body: Record<string, unknown>) =>
    post('/v1/music/actions', body, {
      'idempotency-key': `voice-e2e-${randomUUID()}`,
    });
  const waitFor = async (predicate: (snapshot: MusicSnapshot) => boolean, timeoutMs = 12_000) => {
    const deadline = Date.now() + timeoutMs;
    let snapshot = await music();
    while (!predicate(snapshot) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      snapshot = await music();
    }
    return snapshot;
  };
  const ensurePlaying = async () => {
    const snapshot = await music();
    if (snapshot.playback?.isPlaying) return;
    const playlist = snapshot.playlists[0];
    if (!playlist) throw new Error('voice_e2e_playlist_missing');
    await action({ action: 'play_playlist', playlistUri: playlist.uri, deviceId: 'zone:pc' });
    const playing = await waitFor((value) => value.playback?.isPlaying === true);
    if (!playing.playback?.isPlaying) throw new Error('voice_e2e_seed_playback_failed');
  };
  const ensurePaused = async () => {
    const snapshot = await music();
    if (!snapshot.playback) {
      await ensurePlaying();
    }
    const playing = await music();
    if (playing.playback?.isPlaying) {
      await action({
        action: 'pause',
        ...(playing.playback.device?.id ? { deviceId: playing.playback.device.id } : {}),
      });
    }
    await waitFor((value) => value.playback?.isPlaying === false);
  };
  const seedPlaylist = async () => {
    const snapshot = await music();
    const playlist = snapshot.playlists[0];
    if (!playlist) throw new Error('voice_e2e_playlist_missing');
    await action({ action: 'play_playlist', playlistUri: playlist.uri, deviceId: 'zone:pc' });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const playing = await waitFor((value) => value.playback?.isPlaying === true);
    if (!playing.playback?.isPlaying) throw new Error('voice_e2e_seed_playback_failed');
    return playing;
  };

  const voiceCase = async (
    id: string,
    spoken: string,
    assertion: (snapshot: MusicSnapshot) => boolean
  ): Promise<MusicSnapshot | undefined> => {
    const startedAt = Date.now();
    let ttsAt = startedAt;
    let sttAt = startedAt;
    let ingestAt = startedAt;
    try {
      const turnId = `voice-music-${randomUUID()}`;
      let productionTtsError: string | undefined;
      let audio: Buffer;
      let inputAudioSource: 'production-tts' | 'local-sapi-fallback';
      let inputContentType = 'audio/wav';
      if (useProductionTtsForInput) {
        const tts = await fetch(`${baseUrl}/v1/tts`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', 'x-voice-turn-id': turnId },
          body: JSON.stringify({ text: spoken, language: 'fr', provider: 'openai' }),
        });
        productionTtsError = tts.ok ? undefined : `tts_http_${tts.status}`;
        audio = tts.ok ? Buffer.from(await tts.arrayBuffer()) : synthesizeLocalSpeech(spoken);
        inputAudioSource = tts.ok ? 'production-tts' : 'local-sapi-fallback';
        inputContentType = tts.ok ? (tts.headers.get('content-type') ?? 'audio/wav') : 'audio/wav';
      } else {
        audio = synthesizeLocalSpeech(spoken);
        inputAudioSource = 'local-sapi-fallback';
      }
      ttsAt = Date.now();
      const stt = await jsonResponse<{ text: string }>(
        await fetch(`${baseUrl}/v1/stt/openai`, {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': inputContentType,
            'x-voice-turn-id': turnId,
          },
          body: audio,
        })
      );
      sttAt = Date.now();
      const before = await music();
      const ingest = await post<IngestResponse>(
        '/v1/ingest',
        {
          threadId: turnId,
          text: stt.text,
          integrationConnectionId: spotifyConnectionId,
          clientContext: {
            language: 'fr',
            channel: 'voice',
            deviceType: 'desktop',
            transport: 'prod-voice-music-e2e',
            supportsProgressiveResponse: 'false',
          },
        },
        { 'x-voice-turn-id': turnId, 'x-client-channel': 'voice' }
      );
      ingestAt = Date.now();
      const after = await waitFor(assertion);
      const row: VoiceResult = {
        id,
        spoken,
        transcript: stt.text,
        route: ingest.replyMeta?.routeKey,
        decision: ingest.replyMeta?.semanticDecision,
        reply: ingest.responseText,
        ok: assertion(after),
        ttsMs: ttsAt - startedAt,
        sttMs: sttAt - ttsAt,
        ingestMs: ingestAt - sttAt,
        beforePlaying: before.playback?.isPlaying,
        afterPlaying: after.playback?.isPlaying,
        beforeTrack: before.playback?.track?.title,
        afterTrack: after.playback?.track?.title,
        afterArtist: after.playback?.track?.artists.join(', '),
        device: after.playback?.device?.name,
        inputAudioSource,
        ...(productionTtsError ? { productionTtsError } : {}),
      };
      results.push(row);
      process.stdout.write(`VOICE_CASE ${JSON.stringify(row)}\n`);
      return after;
    } catch (error) {
      const row: VoiceResult = {
        id,
        spoken,
        transcript: '',
        reply: '',
        ok: false,
        ttsMs: ttsAt - startedAt,
        sttMs: sttAt - ttsAt,
        ingestMs: ingestAt - sttAt,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(row);
      process.stdout.write(`VOICE_CASE ${JSON.stringify(row)}\n`);
      return undefined;
    }
  };

  const restore = async () => {
    if (!original) return;
    if (!original.playback) {
      const current = await music();
      await action({
        action: 'pause',
        ...(current.playback?.device?.id ? { deviceId: current.playback.device.id } : {}),
      }).catch(() => undefined);
      return;
    }
    const deviceId = original.playback.device?.id;
    const uri = originalQueue?.current?.uri;
    if (deviceId) await action({ action: 'transfer', deviceId });
    if (uri) await action({ action: 'play_item', uri, ...(deviceId ? { deviceId } : {}) });
    if (original.playback.track?.id) {
      await waitFor((value) => value.playback?.track?.id === original?.playback?.track?.id);
    }
    const queuedUris =
      originalQueue?.queue
        .map((item) => item.uri)
        .filter((item): item is string => Boolean(item)) ?? [];
    for (const queuedUri of queuedUris) {
      if (!/^spotify:(?:track|episode):[A-Za-z0-9]+$/u.test(queuedUri)) continue;
      await action({ action: 'add_queue', uri: queuedUri, ...(deviceId ? { deviceId } : {}) });
    }
    if (original.playback.progressMs > 0) {
      await action({
        action: 'seek',
        positionMs: original.playback.progressMs,
        ...(deviceId ? { deviceId } : {}),
      });
    }
    await action({
      action: 'shuffle',
      state: original.playback.shuffle,
      ...(deviceId ? { deviceId } : {}),
    });
    await action({
      action: 'repeat',
      repeatMode: original.playback.repeat,
      ...(deviceId ? { deviceId } : {}),
    });
    if (original.playback.device?.volumePercent !== undefined) {
      await action({
        action: 'volume',
        volumePercent: original.playback.device.volumePercent,
        ...(deviceId ? { deviceId } : {}),
      });
    }
    await action({
      action: original.playback.isPlaying ? 'play' : 'pause',
      ...(deviceId ? { deviceId } : {}),
    });
  };

  try {
    const me = await get<{ email: string }>('/v1/auth/me');
    if (me.email !== ownerEmail) throw new Error('owner_session_mismatch');
    const connections = await get<{
      connections: Array<{ connectionId: string; provider: string; status: string }>;
    }>('/v1/integrations');
    const spotify = connections.connections.find(
      (item) => item.provider === 'spotify' && item.status === 'active'
    );
    if (!spotify) throw new Error('owner_spotify_connection_missing');
    spotifyConnectionId = spotify.connectionId;
    original = await music();
    originalQueue = await get<Queue>('/v1/music/queue');
    process.stdout.write(
      `VOICE_INITIAL ${JSON.stringify({
        connected: original.connected,
        isPlaying: original.playback?.isPlaying,
        track: original.playback?.track?.title,
        artist: original.playback?.track?.artists.join(', '),
        device: original.playback?.device?.name,
        devices: original.devices.map(
          (item) => `${item.name}:${item.availability}:${item.isActive}`
        ),
      })}\n`
    );
    if (readOnly) {
      original = undefined;
      return;
    }
    if (playQuery) {
      const search = await get<MusicSearch>(
        `/v1/music/search?type=track&q=${encodeURIComponent(playQuery)}`
      );
      const match = search.items[0];
      if (!match?.uri) throw new Error('voice_e2e_play_query_not_found');
      await action({
        action: 'play_item',
        uri: match.uri,
        ...(original.playback?.device?.id ? { deviceId: original.playback.device.id } : {}),
      });
      const restored = await waitFor(
        (value) => value.playback?.track?.title === match.name && value.playback.isPlaying
      );
      process.stdout.write(
        `VOICE_PLAY_QUERY ${JSON.stringify({
          query: playQuery,
          isPlaying: restored.playback?.isPlaying,
          track: restored.playback?.track?.title,
          artist: restored.playback?.track?.artists.join(', '),
          device: restored.playback?.device?.name,
        })}\n`
      );
      original = undefined;
      return;
    }
    if (playbackOverride) {
      await action({
        action: playbackOverride,
        ...(original.playback?.device?.id ? { deviceId: original.playback.device.id } : {}),
      });
      const overridden = await waitFor(
        (value) => value.playback?.isPlaying === (playbackOverride === 'play')
      );
      process.stdout.write(
        `VOICE_PLAYBACK_OVERRIDE ${JSON.stringify({
          requested: playbackOverride,
          isPlaying: overridden.playback?.isPlaying,
          track: overridden.playback?.track?.title,
          device: overridden.playback?.device?.name,
        })}\n`
      );
      original = undefined;
      return;
    }

    const ttsSmokeStartedAt = Date.now();
    const ttsSmoke = await fetch(`${baseUrl}/v1/tts`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'x-voice-turn-id': `voice-tts-${randomUUID()}`,
      },
      body: JSON.stringify({ text: 'Test vocal Jarvis.', language: 'fr', provider: 'openai' }),
    });
    const ttsSmokeBytes = Buffer.from(await ttsSmoke.arrayBuffer());
    process.stdout.write(
      `VOICE_TTS_SMOKE ${JSON.stringify({
        ok: ttsSmoke.ok && ttsSmokeBytes.length > 44,
        status: ttsSmoke.status,
        bytes: ttsSmokeBytes.length,
        elapsedMs: Date.now() - ttsSmokeStartedAt,
      })}\n`
    );
    if (!ttsSmoke.ok || ttsSmokeBytes.length <= 44)
      throw new Error(`voice_tts_smoke_failed:${ttsSmoke.status}`);

    await ensurePaused();
    await voiceCase(
      'launch.generic',
      'Lance la musique.',
      (value) => value.playback?.isPlaying === true
    );
    await ensurePlaying();
    await voiceCase(
      'pause.generic',
      'Mets la musique en pause.',
      (value) => value.playback?.isPlaying === false
    );
    await ensurePaused();
    await voiceCase(
      'resume.generic',
      'Reprends la musique.',
      (value) => value.playback?.isPlaying === true
    );
    const nextSeed = await seedPlaylist();
    const nextId = nextSeed.playback?.track?.id;
    await voiceCase('next.explicit', 'Passe au morceau suivant.', (value) =>
      Boolean(value.playback?.track?.id && value.playback.track.id !== nextId)
    );
    const switchSeed = await seedPlaylist();
    const switchId = switchSeed.playback?.track?.id;
    await voiceCase('switch.natural', 'Change de musique.', (value) =>
      Boolean(value.playback?.track?.id && value.playback.track.id !== switchId)
    );
    await ensurePlaying();
    await voiceCase('search.artist', 'Mets du Daft Punk.', (value) => {
      const haystack = `${value.playback?.track?.title ?? ''} ${value.playback?.track?.artists.join(' ') ?? ''}`;
      return /daft punk/iu.test(haystack);
    });

    await ensurePlaying();
    await voiceCase(
      'pause.pc',
      'Mets la musique en pause sur le PC.',
      (value) => value.playback?.isPlaying === false
    );
    await ensurePaused();
    await voiceCase(
      'resume.pc',
      'Reprends la musique sur le PC.',
      (value) => value.playback?.isPlaying === true
    );
    const pcNextSeed = await seedPlaylist();
    const pcNextId = pcNextSeed.playback?.track?.id;
    await voiceCase('next.pc', 'Passe au morceau suivant sur le PC.', (value) =>
      Boolean(value.playback?.track?.id && value.playback.track.id !== pcNextId)
    );
    const pcSwitchSeed = await seedPlaylist();
    const pcSwitchId = pcSwitchSeed.playback?.track?.id;
    await voiceCase('switch.pc', 'Change de musique sur le PC.', (value) =>
      Boolean(value.playback?.track?.id && value.playback.track.id !== pcSwitchId)
    );
    await ensurePlaying();
    await voiceCase('search.artist.pc', 'Mets du Daft Punk sur le PC.', (value) => {
      const haystack = `${value.playback?.track?.title ?? ''} ${value.playback?.track?.artists.join(' ') ?? ''}`;
      return /daft punk/iu.test(haystack);
    });
  } finally {
    try {
      await restore();
    } catch (error) {
      process.stdout.write(
        `VOICE_RESTORE_ERROR ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    await form(`${keycloakUrl}/realms/jarvis/protocol/openid-connect/logout`, {
      client_id: 'jarvis-web',
      refresh_token: tokens.refresh_token,
    }).catch(() => undefined);
  }

  const passed = results.filter((item) => item.ok).length;
  const average = (key: 'ttsMs' | 'sttMs' | 'ingestMs') =>
    Math.round(results.reduce((sum, item) => sum + item[key], 0) / Math.max(1, results.length));
  process.stdout.write(
    `VOICE_SUMMARY ${JSON.stringify({
      passed,
      total: results.length,
      failed: results.filter((item) => !item.ok).map((item) => item.id),
      avgTtsMs: average('ttsMs'),
      avgSttMs: average('sttMs'),
      avgIngestMs: average('ingestMs'),
    })}\n`
  );
  if (passed !== results.length) process.exitCode = 1;
}

void main().catch((error) => {
  process.stderr.write(
    `VOICE_FATAL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
