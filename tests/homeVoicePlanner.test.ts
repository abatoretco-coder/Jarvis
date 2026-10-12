import { describe, expect, it, jest } from '@jest/globals';

import type { Env } from '../src/env';
import type { HomeActionExecution } from '../src/home/HomeActionExecutor';
import type { HomeCatalog, HomeDevice, HomeSnapshot } from '../src/home/HomeCatalog';
import {
  buildHomeVoiceActionCatalog,
  formatHomeVoiceActionReply,
  isHomeVoiceCommandAllowedForDevice,
  planHomeActionFromTextWithOpenAi,
} from '../src/home/HomeVoicePlanner';
import { completeOpenAiResponse } from '../src/openai/responsesClient';

jest.mock('../src/openai/responsesClient', () => ({
  completeOpenAiResponse: jest.fn(),
}));

const mockedComplete = completeOpenAiResponse as jest.MockedFunction<typeof completeOpenAiResponse>;

const devices: HomeDevice[] = [
  {
    deviceId: 'living-tv',
    roomId: 'living',
    domain: 'media_player',
    name: 'TV',
    state: 'on',
    available: true,
    mapped: true,
    presetId: 'television',
    placement: { x: 0, y: 0, z: 0, rotationDeg: 0, scale: 1 },
    capabilities: ['turn_off', 'set_volume', 'select_source'],
    riskLevel: 'low',
    sourceList: ['CANAL+', 'Netflix', 'HDMI 1'],
  },
  {
    deviceId: 'nono',
    roomId: 'kitchen',
    domain: 'vacuum',
    name: 'Nono',
    state: 'docked',
    available: true,
    mapped: true,
    presetId: 'vacuum',
    placement: { x: 1, y: 1, z: 0, rotationDeg: 0, scale: 1 },
    capabilities: ['start', 'return_to_base'],
    riskLevel: 'low',
  },
];

function makeCatalog(): HomeCatalog {
  const snapshot = { devices } as HomeSnapshot;
  return {
    snapshot: jest.fn(async () => snapshot),
  } as unknown as HomeCatalog;
}

function makeEnv(): Env {
  return {
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: 'https://api.openai.test/v1',
    OPENAI_MODEL_AGENT: 'gpt-5-mini',
    OPENAI_MAX_OUTPUT_TOKENS_AGENT: 512,
    OPENAI_TIMEOUT_MS: 1_000,
  } as Env;
}

describe('HomeVoicePlanner', () => {
  it('builds the planner catalog from the same live capabilities exposed to direct clients', () => {
    expect(JSON.parse(buildHomeVoiceActionCatalog(devices))).toEqual([
      expect.objectContaining({
        deviceId: 'living-tv',
        capabilities: ['turn_off', 'set_volume', 'select_source'],
        sources: ['CANAL+', 'Netflix', 'HDMI 1'],
      }),
      expect.objectContaining({
        deviceId: 'nono',
        state: 'docked',
        capabilities: ['start', 'return_to_base'],
      }),
    ]);
  });

  it('returns a structured command selected from the catalog', async () => {
    mockedComplete.mockResolvedValue(
      JSON.stringify({
        route: 'home_action',
        reason: 'source_tv_requested',
        command: {
          deviceId: 'living-tv',
          action: 'select_source',
          value: null,
          option: 'Netflix',
        },
      })
    );

    await expect(
      planHomeActionFromTextWithOpenAi({
        env: makeEnv(),
        catalog: makeCatalog(),
        text: 'Mets Netflix sur la télé',
      })
    ).resolves.toEqual({
      route: 'home_action',
      reason: 'source_tv_requested',
      command: { deviceId: 'living-tv', action: 'select_source', option: 'Netflix' },
    });

    expect(mockedComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'agent',
        jsonSchema: expect.objectContaining({ name: 'jarvis_home_action_plan' }),
      })
    );
  });

  it('rejects a model action that is absent from the selected device capabilities', async () => {
    mockedComplete.mockResolvedValue(
      JSON.stringify({
        route: 'home_action',
        reason: 'hallucinated',
        command: {
          deviceId: 'nono',
          action: 'select_source',
          value: null,
          option: 'Netflix',
        },
      })
    );

    await expect(
      planHomeActionFromTextWithOpenAi({
        env: makeEnv(),
        catalog: makeCatalog(),
        text: 'Mets Netflix sur Nono',
      })
    ).resolves.toEqual({ route: 'none', reason: 'home_action_not_in_catalog' });
  });

  it('rejects options and numeric values outside the selected live device catalog', () => {
    expect(
      isHomeVoiceCommandAllowedForDevice(devices[0]!, {
        deviceId: 'living-tv',
        action: 'select_source',
        option: 'Invented source',
      })
    ).toBe(false);
    expect(
      isHomeVoiceCommandAllowedForDevice(
        { ...devices[0]!, minTemperature: 12, maxTemperature: 28 },
        { deviceId: 'living-tv', action: 'set_temperature', value: 40 }
      )
    ).toBe(false);
  });

  it('rejects a structured model option that is not in the live device list', async () => {
    mockedComplete.mockResolvedValue(
      JSON.stringify({
        route: 'home_action',
        reason: 'hallucinated_source',
        command: {
          deviceId: 'living-tv',
          action: 'select_source',
          value: null,
          option: 'Disney+',
        },
      })
    );

    await expect(
      planHomeActionFromTextWithOpenAi({
        env: makeEnv(),
        catalog: makeCatalog(),
        text: 'Mets Disney plus sur la télé',
      })
    ).resolves.toEqual({ route: 'none', reason: 'home_action_not_in_catalog' });
  });

  it('formats authorization failures without leaking implementation details', () => {
    const result: HomeActionExecution = {
      ok: false,
      status: 403,
      code: 'guest_action_forbidden',
      domain: 'vacuum',
    };
    expect(formatHomeVoiceActionReply({ deviceId: 'nono', action: 'start' }, result, 'Nono')).toBe(
      'Ce compte n’est pas autorisé à piloter Nono.'
    );
  });
});
