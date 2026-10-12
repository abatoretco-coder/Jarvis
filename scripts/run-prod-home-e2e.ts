import { randomUUID } from 'node:crypto';

import { liveBaseUrl, liveOwnerTokens, logoutLiveOwner } from './live-e2e-auth';

type HomeDevice = {
  deviceId: string;
  name: string;
  domain: string;
  state: string;
  mapped: boolean;
  available: boolean;
  capabilities: string[];
};

type HomeSnapshot = {
  controlStatus: string;
  devices: HomeDevice[];
};

type IngestResponse = {
  responseText: string;
  replyMeta?: { kind?: string; source?: string; routeKey?: string; semanticDecision?: string };
};

const baseUrl = liveBaseUrl();

async function responseBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`http_${response.status}:${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  if (process.env.E2E_LIVE_CONFIRM !== 'production') {
    throw new Error('Set E2E_LIVE_CONFIRM=production to run reversible live home actions.');
  }
  const tokens = await liveOwnerTokens();
  const headers = { authorization: `Bearer ${tokens.access_token}` };
  const getHome = async () =>
    responseBody<HomeSnapshot>(await fetch(`${baseUrl}/v1/home`, { headers }));
  const postJson = (path: string, body: unknown, extraHeaders: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
  const runAction = async (deviceId: string, action: 'turn_on' | 'turn_off') =>
    responseBody<{ operationStatus: string; observedState?: string }>(
      await postJson(
        '/v1/home/actions',
        { deviceId, action },
        { 'idempotency-key': `home-e2e-${randomUUID()}` }
      )
    );
  const waitForState = async (deviceId: string, expected: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    let snapshot = await getHome();
    let device = snapshot.devices.find((item) => item.deviceId === deviceId);
    while (device?.state !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      snapshot = await getHome();
      device = snapshot.devices.find((item) => item.deviceId === deviceId);
    }
    if (device?.state !== expected) {
      throw new Error(`home_state_timeout:${deviceId}:${expected}:${device?.state ?? 'missing'}`);
    }
    return device;
  };

  try {
    const initial = await getHome();
    if (initial.controlStatus !== 'ready') {
      throw new Error(`home_control_not_ready:${initial.controlStatus}`);
    }
    const requiredDevices = [
      { label: 'Nono', match: (device: HomeDevice) => /nono/iu.test(device.name) },
      { label: 'TV', match: (device: HomeDevice) => device.domain === 'media_player' },
    ];
    const mappedRadiators = initial.devices.filter(
      (device) => device.domain === 'climate' && device.mapped
    );
    if (mappedRadiators.length < 2) {
      throw new Error(`required_device_missing:radiators:${mappedRadiators.length}`);
    }
    for (const required of requiredDevices) {
      const device = initial.devices.find(required.match);
      if (!device?.mapped) throw new Error(`required_device_missing:${required.label}`);
    }

    const lamp = initial.devices.find(
      (device) =>
        /lampe.*lave/iu.test(device.name) &&
        device.mapped &&
        device.available &&
        device.capabilities.includes('turn_on') &&
        device.capabilities.includes('turn_off')
    );
    if (!lamp || !['on', 'off'].includes(lamp.state)) {
      throw new Error(`reversible_lamp_unavailable:${lamp?.state ?? 'missing'}`);
    }
    const originalState = lamp.state as 'on' | 'off';
    const changedState = originalState === 'on' ? 'off' : 'on';
    const changeAction = changedState === 'on' ? 'turn_on' : 'turn_off';
    const restoreAction = originalState === 'on' ? 'turn_on' : 'turn_off';
    const voiceText = changedState === 'on' ? 'Allume la lampe à lave.' : 'Éteins la lampe à lave.';
    const results: Array<Record<string, unknown>> = [];

    try {
      const invalid = await postJson(
        '/v1/home/actions',
        { deviceId: lamp.deviceId, action: 'set_volume' },
        { 'idempotency-key': `home-e2e-invalid-${randomUUID()}` }
      );
      results.push({
        id: 'direct.invalid_action',
        ok: invalid.status === 400,
        status: invalid.status,
      });
      if (invalid.status !== 400) throw new Error(`invalid_action_status:${invalid.status}`);

      const direct = await runAction(lamp.deviceId, changeAction);
      await waitForState(lamp.deviceId, changedState);
      results.push({
        id: 'direct.reversible_lamp',
        ok: true,
        operationStatus: direct.operationStatus,
      });
      await runAction(lamp.deviceId, restoreAction);
      await waitForState(lamp.deviceId, originalState);

      const ingest = await responseBody<IngestResponse>(
        await postJson('/v1/ingest', {
          threadId: `home-live-e2e-${randomUUID()}`,
          text: voiceText,
          clientContext: {
            language: 'fr',
            channel: 'desktop',
            deviceType: 'desktop',
            transport: 'prod-home-e2e',
            supportsProgressiveResponse: 'false',
          },
        })
      );
      await waitForState(lamp.deviceId, changedState);
      results.push({
        id: 'text.reversible_lamp',
        ok: true,
        reply: ingest.responseText,
        source: ingest.replyMeta?.source,
        routeKey: ingest.replyMeta?.routeKey,
        decision: ingest.replyMeta?.semanticDecision,
      });

      const general = await responseBody<IngestResponse>(
        await postJson('/v1/ingest', {
          threadId: `text-live-e2e-${randomUUID()}`,
          text: 'Quelle est la capitale de la France ?',
          clientContext: { language: 'fr', channel: 'desktop', transport: 'prod-home-e2e' },
        })
      );
      const generalOk = /\bparis\b/iu.test(general.responseText);
      results.push({ id: 'text.general', ok: generalOk, reply: general.responseText });
      if (!generalOk) throw new Error('general_text_reply_incorrect');
    } finally {
      const current = await getHome().catch(() => undefined);
      const currentLamp = current?.devices.find((device) => device.deviceId === lamp.deviceId);
      if (currentLamp?.state !== originalState) {
        await runAction(lamp.deviceId, restoreAction);
        await waitForState(lamp.deviceId, originalState);
      }
    }

    const final = await getHome();
    const restored = final.devices.find((device) => device.deviceId === lamp.deviceId)?.state;
    results.push({ id: 'restore.physical_state', ok: restored === originalState, state: restored });
    process.stdout.write(
      `HOME_LIVE_SUMMARY ${JSON.stringify({
        passed: results.filter((item) => item.ok === true).length,
        total: results.length,
        originalState,
        restoredState: restored,
        results,
      })}\n`
    );
    if (results.some((item) => item.ok !== true)) process.exitCode = 1;
  } finally {
    await logoutLiveOwner(tokens).catch(() => undefined);
  }
}

void main().catch((error) => {
  process.stderr.write(
    `HOME_LIVE_FATAL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
