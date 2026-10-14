import type { FastifyBaseLogger } from 'fastify';

import type { HomeAssistantClient } from '../haClient';
import type { HomeCatalog, HomeTelemetryEntityMapping } from './HomeCatalog';
import {
  HomeTelemetryRepository,
  type HomeTelemetrySample,
} from './HomeTelemetryRepository';

type HaState = {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
};

const trackedDomains = new Set([
  'binary_sensor',
  'climate',
  'cover',
  'fan',
  'input_boolean',
  'input_number',
  'light',
  'lock',
  'media_player',
  'number',
  'select',
  'sensor',
  'switch',
  'vacuum',
  'water_heater',
  'weather',
]);

const retainedAttributes = new Set([
  'anti_legionella',
  'battery_level',
  'brightness',
  'color_temp_kelvin',
  'cloud_coverage',
  'current_temperature',
  'dew_point',
  'device_class',
  'energy',
  'heating_active',
  'hvac_action',
  'hvac_mode',
  'humidity',
  'operation_mode',
  'power',
  'precipitation_unit',
  'pressure',
  'pressure_unit',
  'preset_mode',
  'state_class',
  'temperature',
  'temperature_unit',
  'unit_of_measurement',
  'uv_index',
  'visibility',
  'visibility_unit',
  'wind_bearing',
  'wind_speed',
  'wind_speed_unit',
]);

const periodicDeviceClasses = new Set(['energy', 'humidity', 'power', 'temperature']);

function isHaState(value: unknown): value is HaState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.entity_id === 'string' && typeof candidate.state === 'string';
}

function sanitizedAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attributes) return undefined;
  const selected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!retainedAttributes.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      selected[key] = value;
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function finiteState(state: string): number | undefined {
  if (state.trim() === '') return undefined;
  const value = Number(state);
  return Number.isFinite(value) ? value : undefined;
}

export type HomeTelemetryCollectorOptions = {
  homeId: string;
  intervalMs: number;
  initialLookbackMs: number;
  maximumCatchupMs: number;
  retentionMs: number;
};

export class HomeTelemetryCollector {
  private timer?: NodeJS.Timeout;
  private activeSync?: Promise<number>;

  constructor(
    private readonly ha: HomeAssistantClient,
    private readonly catalog: HomeCatalog,
    private readonly repository: HomeTelemetryRepository,
    private readonly options: HomeTelemetryCollectorOptions,
    private readonly log?: Pick<FastifyBaseLogger, 'info' | 'warn'>
  ) {}

  start(): void {
    if (this.timer) return;
    void this.syncNow();
    this.timer = setInterval(() => void this.syncNow(), this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeSync;
  }

  syncNow(nowMs = Date.now()): Promise<number> {
    if (this.activeSync) return this.activeSync;
    this.activeSync = this.performSync(nowMs).finally(() => {
      this.activeSync = undefined;
    });
    return this.activeSync;
  }

  private trackedMappings(): Map<string, HomeTelemetryEntityMapping> {
    return new Map(
      this.catalog.getTelemetryEntities()
        .filter((mapping) => trackedDomains.has(mapping.entityId.split('.')[0] ?? ''))
        .map((mapping) => [mapping.entityId, mapping])
    );
  }

  private toSample(
    state: HaState,
    mapping: HomeTelemetryEntityMapping,
    source: HomeTelemetrySample['source'],
    capturedAtMs: number,
    observedAtOverrideMs?: number
  ): HomeTelemetrySample | undefined {
    const observedAtMs = observedAtOverrideMs ?? Date.parse(state.last_updated ?? state.last_changed ?? '');
    if (!Number.isFinite(observedAtMs)) return undefined;
    const attributes = sanitizedAttributes(state.attributes);
    const domain = state.entity_id.split('.')[0] ?? 'unknown';
    return {
      entity: {
        homeId: this.options.homeId,
        entityId: state.entity_id,
        deviceId: mapping.deviceId,
        roomId: mapping.roomId,
        domain,
        role: mapping.role,
        ...(typeof state.attributes?.unit_of_measurement === 'string'
          ? { unitOfMeasurement: state.attributes.unit_of_measurement }
          : {}),
        ...(typeof state.attributes?.device_class === 'string'
          ? { deviceClass: state.attributes.device_class }
          : {}),
        ...(typeof state.attributes?.state_class === 'string'
          ? { stateClass: state.attributes.state_class }
          : {}),
      },
      observedAtMs,
      state: state.state,
      ...(finiteState(state.state) === undefined ? {} : { numericValue: finiteState(state.state) }),
      ...(attributes ? { attributes } : {}),
      source,
      capturedAtMs,
    };
  }

  private shouldSamplePeriodically(state: HaState, mapping: HomeTelemetryEntityMapping): boolean {
    const domain = state.entity_id.split('.')[0] ?? '';
    return ['climate', 'water_heater', 'weather'].includes(domain)
      || mapping.role.startsWith('external_')
      || periodicDeviceClasses.has(
        typeof state.attributes?.device_class === 'string' ? state.attributes.device_class : ''
      );
  }

  private async performSync(nowMs: number): Promise<number> {
    const mappings = this.trackedMappings();
    if (mappings.size === 0) return 0;
    this.repository.markSyncAttempt(this.options.homeId, nowMs);
    const previous = this.repository.getSyncState(this.options.homeId);
    const knownEntityIds = new Set(
      this.repository.listEntities(this.options.homeId).map((entity) => entity.entityId)
    );
    const hasUnseenEntity = [...mappings.keys()].some((entityId) => !knownEntityIds.has(entityId));
    const requestedStart = previous.historyCursorAtMs !== undefined && !hasUnseenEntity
      ? previous.historyCursorAtMs
      : nowMs - this.options.initialLookbackMs;
    const overlapMs = previous.historyCursorAtMs !== undefined && !hasUnseenEntity ? 1_000 : 0;
    const startMs = requestedStart - overlapMs;
    const historyEndMs = Math.min(nowMs, requestedStart + this.options.maximumCatchupMs);
    try {
      const [rawStates, rawHistory] = await Promise.all([
        this.ha.getStates(),
        this.ha.getHistoryForEntities(
          [...mappings.keys()],
          new Date(startMs),
          new Date(historyEndMs),
          true
        ),
      ]);
      const samples: HomeTelemetrySample[] = [];
      for (const state of Array.isArray(rawStates) ? rawStates : []) {
        if (!isHaState(state)) continue;
        const mapping = mappings.get(state.entity_id);
        if (!mapping) continue;
        const sample = this.toSample(
          state,
          mapping,
          'home_assistant_snapshot',
          nowMs,
          this.shouldSamplePeriodically(state, mapping) ? nowMs : undefined
        );
        if (sample) samples.push(sample);
      }
      for (const group of Array.isArray(rawHistory) ? rawHistory : []) {
        if (!Array.isArray(group)) continue;
        for (const state of group) {
          if (!isHaState(state)) continue;
          const mapping = mappings.get(state.entity_id);
          if (!mapping) continue;
          const sample = this.toSample(state, mapping, 'home_assistant_history', nowMs);
          if (!sample || sample.observedAtMs < startMs || sample.observedAtMs > historyEndMs) continue;
          const isHistoryBoundary = Math.abs(sample.observedAtMs - startMs) <= 1;
          if (isHistoryBoundary) {
            if (!knownEntityIds.has(state.entity_id)) {
              samples.push({ ...sample, source: 'home_assistant_snapshot' });
            }
            continue;
          }
          samples.push(sample);
        }
      }
      const inserted = this.repository.ingest(samples);
      this.repository.markSyncSuccess(this.options.homeId, historyEndMs, Date.now());
      if (this.options.retentionMs > 0) {
        this.repository.purgeBefore(this.options.homeId, nowMs - this.options.retentionMs);
      }
      this.log?.info({ homeId: this.options.homeId, inserted }, 'home telemetry synchronized');
      return inserted;
    } catch (error) {
      this.repository.markSyncFailure(this.options.homeId, nowMs, 'home_telemetry_sync_failed');
      this.log?.warn(
        { homeId: this.options.homeId, errorCode: 'home_telemetry_sync_failed', errorName: error instanceof Error ? error.name : 'unknown' },
        'home telemetry synchronization failed'
      );
      return 0;
    }
  }
}
