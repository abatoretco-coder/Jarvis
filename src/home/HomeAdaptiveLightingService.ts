import type { FastifyBaseLogger } from 'fastify';

import type { HomeAssistantClient } from '../haClient';
import { isHassState } from '../hass';
import type { AdaptiveLightingTarget } from './AdaptiveLightingPolicy';
import { resolveAdaptiveLightingTarget } from './AdaptiveLightingPolicy';
import { executeCatalogHomeAction, executeCatalogLightProfile } from './HomeActionExecutor';
import type { AdaptiveLightingRoomConfig, HomeActionName, HomeCatalog } from './HomeCatalog';
import type { HomeRuntimeStateRepository } from './HomeRuntimeStateRepository';

export type HomeLightingRoomMode = 'on' | 'maximum' | 'dimmed' | 'off';
export type HomeLightingRoomObservedMode = HomeLightingRoomMode | 'manual' | 'mixed';
export type HomeLightingRoomState = {
  roomId: string;
  mode: HomeLightingRoomObservedMode;
  available: boolean;
  deviceIds: string[];
  pending?: boolean;
  target?: AdaptiveLightingTarget;
};

export type HomeLightingRoomMutation = HomeLightingRoomState & {
  operationStatus: 'succeeded' | 'accepted' | 'uncertain' | 'partial' | 'failed';
  failedDeviceIds: string[];
};

type ObservedLight = {
  state: string;
  brightnessPercent?: number;
  colorTemperatureKelvin?: number;
  colorMode?: string;
};

type DesiredRoom = {
  mode: HomeLightingRoomMode;
  target?: AdaptiveLightingTarget;
  updatedAtMs?: number;
};

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function observedLight(state: unknown): ObservedLight | undefined {
  if (!isHassState(state)) return undefined;
  const attributes = state.attributes && typeof state.attributes === 'object'
    ? state.attributes as Record<string, unknown>
    : {};
  const brightness = finiteNumber(attributes.brightness);
  const colorTemperatureKelvin = finiteNumber(attributes.color_temp_kelvin);
  return {
    state: state.state,
    ...(brightness === undefined ? {} : { brightnessPercent: Math.round((brightness / 255) * 100) }),
    ...(colorTemperatureKelvin === undefined ? {} : { colorTemperatureKelvin }),
    ...(typeof attributes.color_mode === 'string' ? { colorMode: attributes.color_mode } : {}),
  };
}

function matchesTarget(current: ObservedLight, target: AdaptiveLightingTarget): boolean {
  return current.state === 'on'
    && (current.colorMode === undefined || current.colorMode === 'color_temp')
    && (current.brightnessPercent === undefined
      || Math.abs(current.brightnessPercent - target.brightnessPercent) <= 3)
    && (current.colorTemperatureKelvin === undefined
      || Math.abs(current.colorTemperatureKelvin - target.colorTemperatureKelvin) <= 150);
}

function observedFingerprint(current: ObservedLight): string {
  return JSON.stringify({
    state: current.state,
    brightnessPercent: current.brightnessPercent ?? null,
    colorTemperatureKelvin: current.colorTemperatureKelvin ?? null,
    colorMode: current.colorMode ?? null,
  });
}

function mutationStatus(
  results: Array<Awaited<ReturnType<typeof executeCatalogHomeAction>>>
): HomeLightingRoomMutation['operationStatus'] {
  const successes = results.filter((result) => result.ok);
  if (successes.length !== results.length) return successes.length ? 'partial' : 'failed';
  if (successes.some((result) => result.ok && result.operationStatus === 'uncertain')) return 'uncertain';
  if (successes.some((result) => result.ok && result.operationStatus === 'accepted')) return 'accepted';
  return 'succeeded';
}

export class HomeAdaptiveLightingService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly desiredRooms = new Map<string, DesiredRoom>();
  private readonly lastObservedStates = new Map<string, string>();
  private readonly pendingUntil = new Map<string, number>();
  private readonly commandGraceUntil = new Map<string, number>();

  constructor(
    private readonly catalog: HomeCatalog,
    private readonly ha: HomeAssistantClient,
    private readonly log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
    private readonly stateRepository?: HomeRuntimeStateRepository
  ) {
    for (const intent of this.stateRepository?.listLightingIntents() ?? []) {
      this.desiredRooms.set(intent.roomId, {
        mode: intent.mode,
        ...(intent.target ? { target: intent.target } : {}),
        updatedAtMs: intent.updatedAtMs,
      });
    }
  }

  start(): void {
    const config = this.catalog.getAdaptiveLightingConfig();
    if (!config?.enabled || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.pollSeconds * 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private roomDeviceIds(room: AdaptiveLightingRoomConfig): string[] {
    return [...new Set([...room.deviceIds, ...this.catalog.getRoomLightDeviceIds(room.roomId)])];
  }

  private target(
    room: AdaptiveLightingRoomConfig,
    mode: Exclude<HomeLightingRoomMode, 'off'>,
    now: Date
  ): AdaptiveLightingTarget {
    const target = resolveAdaptiveLightingTarget({
      room,
      mode: mode === 'maximum' ? 'on' : mode,
      now,
    });
    return mode === 'maximum'
      ? { ...target, brightnessPercent: 100 }
      : target;
  }

  private deviceShouldBeOn(room: AdaptiveLightingRoomConfig, deviceId: string, mode: HomeLightingRoomMode): boolean {
    return mode !== 'off' && (mode !== 'dimmed' || !room.dimmedOffDeviceIds?.includes(deviceId));
  }

  private applyRoomProfile(
    deviceId: string,
    target: AdaptiveLightingTarget,
    transitionSeconds: number
  ): ReturnType<typeof executeCatalogHomeAction> {
    const entityId = this.catalog.getMapping(deviceId)?.entityId;
    if (!entityId?.startsWith('light.')) {
      // Some actual lamps are exposed by Home Assistant as switches (smart
      // plugs). They participate in the room mode but cannot receive a
      // brightness or colour-temperature profile.
      return executeCatalogHomeAction({
        catalog: this.catalog,
        ha: this.ha,
        command: { deviceId, action: 'turn_on' },
        allowAlreadySatisfied: true,
      });
    }
    return executeCatalogLightProfile({
      catalog: this.catalog,
      ha: this.ha,
      profile: {
        deviceId,
        brightnessPercent: target.brightnessPercent,
        colorTemperatureKelvin: target.colorTemperatureKelvin,
        transitionSeconds,
      },
    });
  }

  async reconcileActions(actions: Array<{ deviceId: string; action: HomeActionName }>): Promise<void> {
    const config = this.catalog.getAdaptiveLightingConfig();
    if (!config?.enabled) return;
    for (const command of actions) {
      const room = config.rooms.find((candidate) => this.roomDeviceIds(candidate).includes(command.deviceId));
      if (!room) continue;
      // A per-light action is an intentional customization. It must not be
      // overwritten by the previously selected room-wide mode.
      this.desiredRooms.delete(room.roomId);
      this.pendingUntil.delete(room.roomId);
      this.commandGraceUntil.delete(room.roomId);
      this.stateRepository?.deleteLightingIntent(room.roomId);
    }
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runTick(now);
    } finally {
      this.running = false;
    }
  }

  async getRoomStates(now = new Date()): Promise<HomeLightingRoomState[]> {
    const config = this.catalog.getAdaptiveLightingConfig();
    if (!config?.enabled) return [];
    const rawStates = await this.ha.getStates();
    const states = new Map(
      (Array.isArray(rawStates) ? rawStates : [])
        .filter(isHassState)
        .map((state) => [state.entity_id, state] as const)
    );
    return config.rooms.map((room) => {
      const deviceIds = this.roomDeviceIds(room);
      const lights = deviceIds.flatMap((deviceId) => {
        const entityId = this.catalog.getMapping(deviceId)?.entityId;
        const current = entityId ? observedLight(states.get(entityId)) : undefined;
        return current ? [{ deviceId, current }] : [];
      });
      const availableLights = lights.filter(({ current }) => !['unavailable', 'unknown'].includes(current.state));
      const matchesMode = (mode: HomeLightingRoomMode, target?: AdaptiveLightingTarget) => availableLights.length > 0
        && availableLights.every(({ deviceId, current }) => this.deviceShouldBeOn(room, deviceId, mode)
          ? current.state === 'on' && (!target || matchesTarget(current, target))
          : current.state !== 'on');
      const allOff = matchesMode('off');
      const onTarget = this.target(room, 'on', now);
      const maximumTarget = this.target(room, 'maximum', now);
      const dimmedTarget = this.target(room, 'dimmed', now);
      const desired = this.desiredRooms.get(room.roomId);
      const matchesOn = matchesMode('on', onTarget);
      const matchesMaximum = matchesMode('maximum', maximumTarget);
      const matchesDimmed = matchesMode('dimmed', dimmedTarget);
      const desiredMatches = desired?.mode === 'off'
        ? allOff
        : desired?.target
          ? matchesMode(desired.mode, desired.target)
          : false;
      const mode: HomeLightingRoomObservedMode = desired && desiredMatches
        ? desired.mode
        : allOff
          ? 'off'
          : matchesDimmed
              ? 'dimmed'
              : matchesMaximum
                ? 'maximum'
              : matchesOn
                ? 'on'
                : 'mixed';
      const target = desired?.mode !== 'off' && desired?.target
        ? desired.target
        : mode === 'dimmed'
          ? dimmedTarget
          : mode === 'maximum'
            ? maximumTarget
          : mode === 'on'
            ? onTarget
            : undefined;
      const pending = (this.pendingUntil.get(room.roomId) ?? 0) > now.getTime();
      return {
        roomId: room.roomId,
        mode,
        available: availableLights.length > 0,
        deviceIds,
        ...(pending ? { pending: true } : {}),
        ...(target ? { target } : {}),
      };
    });
  }

  async setRoomMode(
    roomId: string,
    mode: HomeLightingRoomMode,
    now = new Date()
  ): Promise<HomeLightingRoomMutation | undefined> {
    const config = this.catalog.getAdaptiveLightingConfig();
    const room = config?.enabled ? config.rooms.find((candidate) => candidate.roomId === roomId) : undefined;
    if (!config || !room) return undefined;
    const deviceIds = this.roomDeviceIds(room);
    const rawStates = await this.ha.getStates();
    const states = new Map(
      (Array.isArray(rawStates) ? rawStates : [])
        .filter(isHassState)
        .map((state) => [state.entity_id, state] as const)
    );
    for (const deviceId of deviceIds) {
      const entityId = this.catalog.getMapping(deviceId)?.entityId;
      const current = entityId ? observedLight(states.get(entityId)) : undefined;
      if (current) this.lastObservedStates.set(deviceId, observedFingerprint(current));
    }
    const target = mode === 'off' ? undefined : this.target(room, mode, now);
    const results = await Promise.all(deviceIds.map((deviceId) => !this.deviceShouldBeOn(room, deviceId, mode)
      ? executeCatalogHomeAction({
          catalog: this.catalog,
          ha: this.ha,
          command: { deviceId, action: 'turn_off' },
          allowAlreadySatisfied: true,
        })
      : this.applyRoomProfile(deviceId, target!, config.transitionSeconds))) as Array<Awaited<ReturnType<typeof executeCatalogHomeAction>>>;
    const failedDeviceIds = deviceIds.filter((_, index) => !results[index]?.ok);
    const operationStatus = mutationStatus(results);
    if (operationStatus !== 'failed') {
      this.desiredRooms.set(roomId, { mode, ...(target ? { target } : {}), updatedAtMs: now.getTime() });
      this.stateRepository?.saveLightingIntent({ roomId, mode, ...(target ? { target } : {}) }, now.getTime());
      this.commandGraceUntil.set(
        roomId,
        now.getTime() + (config.transitionSeconds + config.pollSeconds + 10) * 1_000
      );
      if (operationStatus === 'accepted' || operationStatus === 'uncertain') {
        this.pendingUntil.set(roomId, now.getTime() + (config.transitionSeconds + config.pollSeconds + 10) * 1_000);
      } else {
        this.pendingUntil.delete(roomId);
      }
    }
    return {
      roomId,
      mode,
      available: results.some((result) => result.ok),
      deviceIds,
      ...(target ? { target } : {}),
      ...(operationStatus === 'accepted' || operationStatus === 'uncertain' ? { pending: true } : {}),
      operationStatus,
      failedDeviceIds,
    };
  }

  private async runTick(now: Date): Promise<void> {
    const config = this.catalog.getAdaptiveLightingConfig();
    if (!config?.enabled) return;
    if (this.stateRepository) {
      const persisted = new Map(
        this.stateRepository.listLightingIntents().map((intent) => [intent.roomId, intent] as const)
      );
      for (const roomId of this.desiredRooms.keys()) {
        if (!persisted.has(roomId)) this.desiredRooms.delete(roomId);
      }
      for (const intent of persisted.values()) {
        this.desiredRooms.set(intent.roomId, {
          mode: intent.mode,
          ...(intent.target ? { target: intent.target } : {}),
          updatedAtMs: intent.updatedAtMs,
        });
        const graceUntil = intent.updatedAtMs
          + (config.transitionSeconds + config.pollSeconds + 10) * 1_000;
        if (graceUntil > now.getTime()) this.commandGraceUntil.set(intent.roomId, graceUntil);
      }
    }
    let rawStates: unknown;
    try {
      rawStates = await this.ha.getStates();
    } catch (error) {
      this.log.warn(
        { errorCode: error instanceof Error ? error.message : 'room_lighting_state_failed' },
        'room lighting could not read Home Assistant state'
      );
      return;
    }
    const states = new Map(
      (Array.isArray(rawStates) ? rawStates : [])
        .filter(isHassState)
        .map((state) => [state.entity_id, state] as const)
    );

    for (const room of config.rooms) {
      let desired = this.desiredRooms.get(room.roomId);
      for (const deviceId of this.roomDeviceIds(room)) {
        const entityId = this.catalog.getMapping(deviceId)?.entityId;
        const current = entityId ? observedLight(states.get(entityId)) : undefined;
        if (!current) continue;
        const previousFingerprint = this.lastObservedStates.get(deviceId);
        const currentFingerprint = observedFingerprint(current);
        this.lastObservedStates.set(deviceId, currentFingerprint);
        if (!desired || ['unavailable', 'unknown'].includes(current.state)) continue;
        if ((this.pendingUntil.get(room.roomId) ?? 0) > now.getTime()) continue;
        if ((this.commandGraceUntil.get(room.roomId) ?? 0) > now.getTime()) continue;

        const previousState = previousFingerprint
          ? (JSON.parse(previousFingerprint) as { state?: string }).state
          : undefined;
        const reconnected = ['unavailable', 'unknown'].includes(previousState ?? '') && current.state === 'on';
        const manuallyChanged = previousFingerprint !== undefined
          && previousFingerprint !== currentFingerprint
          && !reconnected;
        if (manuallyChanged) {
          this.desiredRooms.delete(room.roomId);
          this.pendingUntil.delete(room.roomId);
          this.commandGraceUntil.delete(room.roomId);
          this.stateRepository?.deleteLightingIntent(room.roomId);
          this.log.info(
            { deviceId, roomId: room.roomId, previousMode: desired.mode },
            'room lighting intent released after manual change'
          );
          desired = undefined;
          continue;
        }

        const shouldBeOn = this.deviceShouldBeOn(room, deviceId, desired.mode);
        const shouldRestoreOff = !shouldBeOn && reconnected;
        const shouldRestoreProfile = shouldBeOn && desired.target && reconnected
          && !matchesTarget(current, desired.target);
        if (!shouldRestoreOff && !shouldRestoreProfile) continue;

        const result = !shouldBeOn
          ? await executeCatalogHomeAction({
              catalog: this.catalog,
              ha: this.ha,
              command: { deviceId, action: 'turn_off' },
              allowAlreadySatisfied: true,
            })
          : await this.applyRoomProfile(deviceId, desired.target!, config.transitionSeconds);
        if (!result.ok) {
          this.log.warn(
            { deviceId, roomId: room.roomId, mode: desired.mode, errorCode: result.code },
            'room lighting mode reconciliation failed'
          );
        } else {
          this.commandGraceUntil.set(
            room.roomId,
            now.getTime() + (config.transitionSeconds + config.pollSeconds + 10) * 1_000
          );
          this.log.info(
            { deviceId, roomId: room.roomId, mode: desired.mode },
            'room lighting mode restored after device reconnect'
          );
        }
      }
    }
  }
}
