import { z } from 'zod';

import type { Env } from '../env';
import type { HomeAssistantClient } from '../haClient';
import { completeOpenAiResponse } from '../openai/responsesClient';
import type { ExecutableHomeAction, HomeActionExecution } from './HomeActionExecutor';
import {
  type HomeCatalog,
  type HomeDevice,
  isHomeActionValueValid,
  TV_REMOTE_KEYS,
} from './HomeCatalog';

type LoggerLike = {
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
};

export type HomeVoicePlan =
  | { route: 'home_action'; reason: string; command: ExecutableHomeAction }
  | { route: 'none'; reason: string };

export function formatHomeVoiceActionReply(
  command: ExecutableHomeAction,
  result: HomeActionExecution,
  deviceName?: string
): string {
  const target = deviceName?.trim() || command.deviceId;
  if (result.ok) {
    if (result.operationStatus === 'succeeded') return `C’est fait pour ${target}.`;
    if (result.operationStatus === 'accepted') {
      return `Commande envoyée à ${target}, sans confirmation immédiate.`;
    }
    return `Commande envoyée à ${target}, mais son résultat reste incertain.`;
  }
  if (result.code === 'guest_action_forbidden' || result.code === 'client_scope_forbidden') {
    return `Ce compte n’est pas autorisé à piloter ${target}.`;
  }
  if (result.code === 'home_action_unsupported' || result.code === 'home_action_option_invalid') {
    return `Cette action n’est pas disponible pour ${target}.`;
  }
  if (result.code === 'home_device_not_mapped') {
    return `${target} n’est pas encore associé à un appareil Home Assistant.`;
  }
  if (result.code === 'home_device_not_found') return `Je ne trouve pas ${target}.`;
  return `Je n’ai pas pu piloter ${target}. Vérifie sa connexion.`;
}

const plannerResponseSchema = z.object({
  route: z.enum(['home_action', 'none']),
  reason: z.string().min(1).max(120),
  command: z
    .object({
      deviceId: z.string().min(1).max(64),
      action: z.string().min(1).max(64),
      value: z.number().finite().nullable(),
      option: z.string().min(1).max(120).nullable(),
    })
    .nullable(),
});

function plannerResponseFormat(deviceIds: string[]): {
  name: string;
  schema: Record<string, unknown>;
} {
  return {
    name: 'jarvis_home_action_plan',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['route', 'reason', 'command'],
      properties: {
        route: { type: 'string', enum: ['home_action', 'none'] },
        reason: { type: 'string', minLength: 1, maxLength: 120 },
        command: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['deviceId', 'action', 'value', 'option'],
          properties: {
            deviceId: { type: 'string', enum: deviceIds },
            action: { type: 'string', minLength: 1, maxLength: 64 },
            value: { type: ['number', 'null'] },
            option: { type: ['string', 'null'], minLength: 1, maxLength: 120 },
          },
        },
      },
    },
  };
}

function compactOptions(device: HomeDevice): Record<string, unknown> {
  return {
    ...(device.sourceList?.length ? { sources: device.sourceList } : {}),
    ...(device.soundOutputList?.length ? { soundOutputs: device.soundOutputList } : {}),
    ...(device.hvacModes?.length ? { hvacModes: device.hvacModes } : {}),
    ...(device.presetModes?.length ? { presetModes: device.presetModes } : {}),
    ...(device.operationModes?.length ? { operationModes: device.operationModes } : {}),
    ...(device.suctionModeOptions?.length ? { suctionModes: device.suctionModeOptions } : {}),
    ...(device.mopModeOptions?.length ? { mopModes: device.mopModeOptions } : {}),
    ...(device.domain === 'media_player' ? { remoteKeys: TV_REMOTE_KEYS } : {}),
    ...(device.minTemperature === undefined ? {} : { minTemperature: device.minTemperature }),
    ...(device.maxTemperature === undefined ? {} : { maxTemperature: device.maxTemperature }),
  };
}

export function buildHomeVoiceActionCatalog(devices: HomeDevice[]): string {
  return JSON.stringify(
    devices.map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      roomId: device.roomId,
      domain: device.domain,
      state: device.state,
      available: device.available,
      capabilities: device.capabilities,
      ...compactOptions(device),
    }))
  );
}

export function isHomeVoiceCommandAllowedForDevice(
  device: HomeDevice,
  command: ExecutableHomeAction
): boolean {
  if (
    command.deviceId !== device.deviceId ||
    !device.capabilities.includes(command.action) ||
    !isHomeActionValueValid(command.action, command.value, command.option)
  ) {
    return false;
  }

  const allowedOptions: readonly string[] | undefined =
    command.action === 'select_source'
      ? device.sourceList
      : command.action === 'select_sound_output'
        ? device.soundOutputList
        : command.action === 'set_hvac_mode'
          ? device.hvacModes
          : command.action === 'set_preset_mode'
            ? device.presetModes
            : command.action === 'set_operation_mode'
              ? device.operationModes
              : command.action === 'set_suction_mode'
                ? device.suctionModeOptions
                : command.action === 'set_mop_mode'
                  ? device.mopModeOptions
                  : command.action === 'remote_key'
                    ? TV_REMOTE_KEYS
                    : undefined;
  if (allowedOptions && !allowedOptions.includes(command.option ?? '')) return false;
  if (
    [
      'select_source',
      'select_sound_output',
      'set_hvac_mode',
      'set_preset_mode',
      'set_operation_mode',
      'set_suction_mode',
      'set_mop_mode',
    ].includes(command.action) &&
    !allowedOptions?.length
  ) {
    return false;
  }

  if (command.action === 'set_temperature' && command.value !== undefined) {
    if (device.minTemperature !== undefined && command.value < device.minTemperature) return false;
    if (device.maxTemperature !== undefined && command.value > device.maxTemperature) return false;
  }
  return true;
}

export async function planHomeActionFromTextWithOpenAi(input: {
  env: Env;
  catalog: HomeCatalog;
  ha?: HomeAssistantClient;
  text: string;
  correlationId?: string;
  userId?: string;
  log?: LoggerLike;
}): Promise<HomeVoicePlan> {
  const apiKey = input.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return { route: 'none', reason: 'openai_api_key_missing' };

  const snapshot = await input.catalog.snapshot(input.ha);
  const devices = snapshot.devices.filter(
    (device) => device.mapped && device.capabilities.length > 0
  );
  if (devices.length === 0) return { route: 'none', reason: 'home_action_catalog_empty' };

  const content = await completeOpenAiResponse({
    apiKey,
    baseUrl: input.env.OPENAI_BASE_URL,
    model: input.env.OPENAI_MODEL_AGENT,
    capability: 'agent',
    messages: [
      {
        role: 'system',
        content: [
          'Tu planifies une unique action domotique Jarvis.',
          'Le catalogue fourni est la seule source de vérité.',
          'Choisis exactement un deviceId et une action présents dans la même entrée.',
          'N invente jamais un appareil, une action, une option ou une valeur.',
          'Pour une option, recopie exactement une valeur proposée par le catalogue.',
          'value est réservé aux actions numériques; option aux actions textuelles; sinon utilise null.',
          'La demande peut aussi contenir des clauses destinées à d’autres services (musique, recherche, conversation) : ignore-les et ne planifie que la partie domotique.',
          'S’il existe exactement une action domotique non ambiguë et réalisable, planifie-la même si une autre clause concerne un autre service.',
          'Si la demande est une question, ambiguë, contient zéro ou plusieurs actions domotiques, ou n’est pas réalisable avec le catalogue, réponds route=none et command=null.',
          'Tu ne pilotes rien toi-même : tu produis seulement une commande structurée qui sera revalidée côté serveur.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Demande: ${JSON.stringify(input.text)}`,
          `Catalogue: ${buildHomeVoiceActionCatalog(devices)}`,
          `Métadonnées: ${JSON.stringify({ correlationId: input.correlationId ?? null, userId: input.userId ?? null })}`,
        ].join('\n'),
      },
    ],
    maxOutputTokens: Math.min(384, input.env.OPENAI_MAX_OUTPUT_TOKENS_AGENT),
    timeoutMs: input.env.OPENAI_TIMEOUT_MS,
    jsonSchema: plannerResponseFormat(devices.map((device) => device.deviceId)),
    reasoningEffort: 'none',
  });

  const parsed = plannerResponseSchema.parse(JSON.parse(content) as unknown);
  if (parsed.route === 'none' || !parsed.command) {
    return { route: 'none', reason: parsed.reason };
  }

  const device = devices.find((candidate) => candidate.deviceId === parsed.command?.deviceId);
  const command: ExecutableHomeAction = {
    deviceId: parsed.command.deviceId,
    action: parsed.command.action as ExecutableHomeAction['action'],
    ...(parsed.command.value === null ? {} : { value: parsed.command.value }),
    ...(parsed.command.option === null ? {} : { option: parsed.command.option }),
  };
  if (!device || !isHomeVoiceCommandAllowedForDevice(device, command)) {
    input.log?.warn?.(
      {
        correlation_id: input.correlationId,
        device_id: parsed.command.deviceId,
        action: parsed.command.action,
      },
      'home_voice_planner_capability_rejected'
    );
    return { route: 'none', reason: 'home_action_not_in_catalog' };
  }

  input.log?.info?.(
    {
      correlation_id: input.correlationId,
      device_id: command.deviceId,
      action: command.action,
    },
    'home_voice_planner_selected'
  );
  return { route: 'home_action', reason: parsed.reason, command };
}
