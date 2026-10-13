import { type HomeAssistantClient,HomeAssistantRequestError } from '../haClient';

const entities = {
  enabled: 'input_boolean.jarvis_heating_schedule_enabled',
  comfort: 'input_number.jarvis_temperature_comfort',
  eco: 'input_number.jarvis_temperature_eco',
  period: 'sensor.planning_chauffage_jarvis',
} as const;

type HaState = {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
};

export type HomeHeatingPlan = {
  available: boolean;
  enabled: boolean;
  activeMode: 'comfort' | 'eco' | 'unknown';
  comfortTemperature: number | null;
  ecoTemperature: number | null;
  schedule: {
    weekdayMorning: { start: string; end: string };
    weekdayEvening: { start: string; end: string };
    weekend: { start: string; end: string };
  } | null;
};

export type HomeHeatingPlanUpdate = {
  enabled?: boolean;
  comfortTemperature?: number;
  ecoTemperature?: number;
};

export type HomeHeatingPlanUpdateResult = HomeHeatingPlan & {
  operationStatus: 'succeeded';
  updatedFields: Array<'comfortTemperature' | 'ecoTemperature' | 'enabled'>;
};

export class HomeHeatingPlanUpdateError extends Error {
  constructor(
    public readonly outcome: 'failed' | 'partial' | 'uncertain',
    public readonly appliedFields: Array<'comfortTemperature' | 'ecoTemperature' | 'enabled'>,
    cause?: unknown,
    public readonly observedPlan?: HomeHeatingPlan
  ) {
    super(`home_heating_plan_${outcome}`, { cause });
    this.name = 'HomeHeatingPlanUpdateError';
  }
}

function isHaState(value: unknown): value is HaState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.entity_id === 'string' && typeof candidate.state === 'string';
}

function finiteState(state: HaState | undefined): number | null {
  if (!state) return null;
  const parsed = Number(state.state);
  return Number.isFinite(parsed) ? parsed : null;
}

function timeAttribute(state: HaState | undefined, key: string): string | null {
  const value = state?.attributes?.[key];
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(value)
    ? value
    : null;
}

export class HomeHeatingPlanService {
  constructor(
    private readonly ha: HomeAssistantClient,
    private readonly wait: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {}

  async get(): Promise<HomeHeatingPlan> {
    const raw = await this.ha.getStates();
    const states = new Map(
      (Array.isArray(raw) ? raw : [])
        .filter(isHaState)
        .map((state) => [state.entity_id, state] as const)
    );
    const enabled = states.get(entities.enabled);
    const comfort = states.get(entities.comfort);
    const eco = states.get(entities.eco);
    const period = states.get(entities.period);
    const times = {
      weekdayMorningStart: timeAttribute(period, 'weekday_morning_start'),
      weekdayMorningEnd: timeAttribute(period, 'weekday_morning_end'),
      weekdayEveningStart: timeAttribute(period, 'weekday_evening_start'),
      weekdayEveningEnd: timeAttribute(period, 'weekday_evening_end'),
      weekendStart: timeAttribute(period, 'weekend_start'),
      weekendEnd: timeAttribute(period, 'weekend_end'),
    };
    const hasSchedule = Object.values(times).every((value) => value !== null);
    const available = Boolean(enabled && comfort && eco && period);

    return {
      available,
      enabled: enabled?.state === 'on',
      activeMode: period?.state === 'comfort' ? 'comfort' : period?.state === 'eco' ? 'eco' : 'unknown',
      comfortTemperature: finiteState(comfort),
      ecoTemperature: finiteState(eco),
      schedule: hasSchedule
        ? {
            weekdayMorning: { start: times.weekdayMorningStart!, end: times.weekdayMorningEnd! },
            weekdayEvening: { start: times.weekdayEveningStart!, end: times.weekdayEveningEnd! },
            weekend: { start: times.weekendStart!, end: times.weekendEnd! },
          }
        : null,
    };
  }

  async update(input: HomeHeatingPlanUpdate): Promise<HomeHeatingPlanUpdateResult> {
    const fields = Object.entries(input).filter(([, value]) => value !== undefined);
    if (fields.length === 0) throw new HomeHeatingPlanUpdateError('failed', []);
    if (
      (input.comfortTemperature !== undefined
        && (!Number.isFinite(input.comfortTemperature)
          || input.comfortTemperature < 16
          || input.comfortTemperature > 24
          || input.comfortTemperature * 2 % 1 !== 0))
      || (input.ecoTemperature !== undefined
        && (!Number.isFinite(input.ecoTemperature)
          || input.ecoTemperature < 12
          || input.ecoTemperature > 21
          || input.ecoTemperature * 2 % 1 !== 0))
    ) {
      throw new HomeHeatingPlanUpdateError('failed', []);
    }
    const current = await this.get();
    if (!current.available || current.comfortTemperature === null || current.ecoTemperature === null) {
      throw new HomeHeatingPlanUpdateError('failed', []);
    }
    const comfort = input.comfortTemperature ?? current.comfortTemperature;
    const eco = input.ecoTemperature ?? current.ecoTemperature;
    if (eco >= comfort) throw new HomeHeatingPlanUpdateError('failed', []);

    const operations: Array<{
      field: 'comfortTemperature' | 'ecoTemperature' | 'enabled';
      call: () => ReturnType<HomeAssistantClient['callService']>;
    }> = [];
    const comfortOperation = input.comfortTemperature === undefined ? null : {
        field: 'comfortTemperature',
        call: () => this.ha.callService({
          domain: 'input_number',
          service: 'set_value',
          target: { entity_id: entities.comfort },
          serviceData: { value: input.comfortTemperature },
        }),
      } as const;
    const ecoOperation = input.ecoTemperature === undefined ? null : {
        field: 'ecoTemperature',
        call: () => this.ha.callService({
          domain: 'input_number',
          service: 'set_value',
          target: { entity_id: entities.eco },
          serviceData: { value: input.ecoTemperature },
        }),
      } as const;
    // Preserve the invariant during a two-field transition as well as at the
    // final target: lower Eco first when Confort decreases, otherwise raise
    // Confort before Eco.
    if (comfortOperation && ecoOperation) {
      operations.push(...(comfort < current.comfortTemperature
        ? [ecoOperation, comfortOperation]
        : [comfortOperation, ecoOperation]));
    } else {
      if (comfortOperation) operations.push(comfortOperation);
      if (ecoOperation) operations.push(ecoOperation);
    }
    if (input.enabled !== undefined) {
      operations.push({
        field: 'enabled',
        call: () => this.ha.callService({
          domain: 'input_boolean',
          service: input.enabled ? 'turn_on' : 'turn_off',
          target: { entity_id: entities.enabled },
        }),
      });
    }

    const appliedFields: HomeHeatingPlanUpdateResult['updatedFields'] = [];
    for (const operation of operations) {
      try {
        await operation.call();
        appliedFields.push(operation.field);
      } catch (error) {
        const outcome = error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted
          ? 'uncertain'
          : appliedFields.length > 0
            ? 'partial'
            : 'failed';
        const observedPlan = await this.get().catch(() => undefined);
        throw new HomeHeatingPlanUpdateError(outcome, appliedFields, error, observedPlan);
      }
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await this.wait(250);
      try {
        const verified = await this.get();
        const matches = verified.available
          && (input.enabled === undefined || verified.enabled === input.enabled)
          && (input.comfortTemperature === undefined
            || verified.comfortTemperature === input.comfortTemperature)
          && (input.ecoTemperature === undefined || verified.ecoTemperature === input.ecoTemperature);
        if (matches) {
          return { ...verified, operationStatus: 'succeeded', updatedFields: appliedFields };
        }
      } catch (error) {
        lastError = error;
      }
    }
    const observedPlan = await this.get().catch(() => undefined);
    throw new HomeHeatingPlanUpdateError('uncertain', appliedFields, lastError, observedPlan);
  }
}
