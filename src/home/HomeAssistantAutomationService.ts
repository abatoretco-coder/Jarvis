import { createHash, randomUUID } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';

import {
  type HomeAssistantAutomationConfig,
  type HomeAssistantClient,
  HomeAssistantRequestError,
} from '../haClient';
import { resolveCatalogHomeAction } from './HomeActionExecutor';
import { type HomeCatalog, type HomeScene, sceneHasDeviceConflicts } from './HomeCatalog';
import type { HomeRuntimeStateRepository } from './HomeRuntimeStateRepository';

const MANAGED_V1_PREFIX = 'jarvis-managed:v1:scene=';
const MANAGED_V2_PREFIX = 'jarvis-managed:v2:scene=';
const automationIdPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const reloadAttempts = 20;
const reloadDelayMs = 100;
const interruptedOperationGraceMs = 2 * 60_000;

export type HomeAutomationSummary = {
  automationId: string | null;
  entityId: string;
  name: string;
  description: string;
  enabled: boolean;
  available: boolean;
  lastTriggered: string | null;
  mode: string | null;
  managedByJarvis: boolean;
  sceneId: string | null;
  schedule: { at: string; weekdays: number[] } | null;
  configurationStatus: 'current' | 'stale' | 'missing_scene' | 'unknown';
};

export type ManagedAutomationInput = {
  name: string;
  sceneId: string;
  at: string;
  weekdays: number[];
  enabled: boolean;
};

export type HomeAutomationReconciliationResult = {
  operationStatus: 'succeeded' | 'partial' | 'uncertain';
  updated: string[];
  skipped: Array<{ automationId: string; reason: 'missing_scene' | 'invalid_configuration' }>;
  failed: string[];
};

type SuspendedManagedAutomation = {
  operationId: string;
  automationId: string;
  entityId: string;
  sceneId: string;
};

type HaState = {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
};

function isHaState(value: unknown): value is HaState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.entity_id === 'string' && typeof candidate.state === 'string';
}

function managedMetadata(config: HomeAssistantAutomationConfig | null): {
  sceneId: string;
  fingerprint: string | null;
} | null {
  const description = config?.description;
  if (typeof description !== 'string') return null;
  if (description.startsWith(MANAGED_V1_PREFIX)) {
    const sceneId = description.slice(MANAGED_V1_PREFIX.length);
    return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(sceneId) ? { sceneId, fingerprint: null } : null;
  }
  if (!description.startsWith(MANAGED_V2_PREFIX)) return null;
  const match = description.match(/^jarvis-managed:v2:scene=([a-z0-9][a-z0-9_-]{0,63});fingerprint=([a-f0-9]{64})$/u);
  return match ? { sceneId: match[1]!, fingerprint: match[2]! } : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first && typeof first === 'object' && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : null;
}

function scheduleFromConfig(
  config: HomeAssistantAutomationConfig | null
): HomeAutomationSummary['schedule'] {
  if (!config) return null;
  const trigger = firstRecord(config.triggers ?? config.trigger);
  if (trigger?.trigger !== 'time' || typeof trigger.at !== 'string') return null;
  const condition = firstRecord(config.conditions ?? config.condition);
  const rawWeekdays = condition?.condition === 'time' ? condition.weekday : undefined;
  if (!Array.isArray(rawWeekdays)) return null;
  const selected = rawWeekdays.flatMap((value) => {
    const index = weekdays.indexOf(value as (typeof weekdays)[number]);
    return index >= 0 ? [index + 1] : [];
  });
  return { at: trigger.at.slice(0, 5), weekdays: selected };
}

function compileActions(catalog: HomeCatalog, scene: HomeScene): Array<Record<string, unknown>> {
  if (sceneHasDeviceConflicts(scene.steps)) throw new Error('home_scene_device_conflict');
  return scene.steps.map((step) => {
    const resolved = resolveCatalogHomeAction(catalog, step);
    if (!resolved.ok) throw new Error(resolved.code);
    return {
      action: `${resolved.call.domain}.${resolved.call.service}`,
      target: resolved.call.target,
      ...(resolved.call.serviceData ? { data: resolved.call.serviceData } : {}),
    };
  });
}

function actionsFingerprint(actions: Array<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(actions)).digest('hex');
}

export function compileManagedAutomation(
  catalog: HomeCatalog,
  input: ManagedAutomationInput
): HomeAssistantAutomationConfig {
  const scene = catalog.getScene(input.sceneId);
  if (!scene) throw new Error('home_scene_not_found');
  const actions = compileActions(catalog, scene);
  return {
    alias: input.name,
    description: `${MANAGED_V2_PREFIX}${scene.sceneId};fingerprint=${actionsFingerprint(actions)}`,
    triggers: [{ trigger: 'time', at: `${input.at}:00` }],
    conditions: [
      {
        condition: 'time',
        weekday: input.weekdays.map((day) => weekdays[day - 1]),
      },
    ],
    actions,
    mode: 'single',
    initial_state: input.enabled,
  };
}

export class HomeAssistantAutomationService {
  private reconciliationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ha: HomeAssistantClient,
    private readonly catalog: HomeCatalog,
    private readonly wait: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly stateRepository?: HomeRuntimeStateRepository,
    private readonly log?: Pick<FastifyBaseLogger, 'info' | 'warn'>
  ) {}

  async list(): Promise<HomeAutomationSummary[]> {
    const rawStates = await this.ha.getStates();
    const states = (Array.isArray(rawStates) ? rawStates : [])
      .filter(isHaState)
      .filter((state) => state.entity_id.startsWith('automation.'))
      .slice(0, 200);
    return Promise.all(
      states.map(async (state) => {
        const attributes = state.attributes ?? {};
        const automationId =
          typeof attributes.id === 'string' && automationIdPattern.test(attributes.id)
            ? attributes.id
            : null;
        let config: HomeAssistantAutomationConfig | null = null;
        if (automationId) {
          try {
            config = await this.ha.getAutomationConfig(automationId);
          } catch {
            config = null;
          }
        }
        const managed = managedMetadata(config);
        const sceneId = managed?.sceneId ?? null;
        const scene = sceneId ? this.catalog.getScene(sceneId) : undefined;
        let expectedFingerprint: string | null = null;
        if (scene) {
          try {
            expectedFingerprint = actionsFingerprint(compileActions(this.catalog, scene));
          } catch {
            expectedFingerprint = null;
          }
        }
        return {
          automationId,
          entityId: state.entity_id,
          name:
            typeof attributes.friendly_name === 'string'
              ? attributes.friendly_name
              : state.entity_id,
          description:
            typeof config?.description === 'string' && !sceneId ? config.description : '',
          enabled: state.state === 'on',
          available: state.state !== 'unavailable',
          lastTriggered:
            typeof attributes.last_triggered === 'string' ? attributes.last_triggered : null,
          mode: typeof attributes.mode === 'string' ? attributes.mode : null,
          managedByJarvis: Boolean(sceneId),
          sceneId,
          schedule: scheduleFromConfig(config),
          configurationStatus: !managed
            ? 'unknown'
            : !scene
              ? 'missing_scene'
              : expectedFingerprint !== null && managed.fingerprint === expectedFingerprint
                ? 'current'
                : 'stale',
        };
      })
    );
  }

  async create(input: ManagedAutomationInput): Promise<{ automationId: string; operationStatus: 'succeeded' | 'accepted' | 'uncertain' }> {
    const automationId = `jarvis_${randomUUID().replaceAll('-', '')}`;
    try {
      await this.ha.saveAutomationConfig(
        automationId,
        compileManagedAutomation(this.catalog, input)
      );
    } catch (error) {
      if (error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted) {
        return { automationId, operationStatus: 'uncertain' };
      }
      throw error;
    }
    const operationStatus = await this.setEnabledWhenLoaded(automationId, input.enabled);
    return { automationId, operationStatus };
  }

  async update(automationId: string, input: ManagedAutomationInput): Promise<'succeeded' | 'accepted' | 'uncertain'> {
    this.assertAutomationId(automationId);
    const existing = await this.ha.getAutomationConfig(automationId);
    if (!managedMetadata(existing)) throw new Error('home_automation_not_managed');
    try {
      await this.ha.saveAutomationConfig(
        automationId,
        compileManagedAutomation(this.catalog, input)
      );
    } catch (error) {
      if (error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted) return 'uncertain';
      throw error;
    }
    return this.setEnabledWhenLoaded(automationId, input.enabled);
  }

  async setEnabled(automationId: string, enabled: boolean): Promise<'succeeded' | 'accepted' | 'uncertain'> {
    await this.assertManaged(automationId);
    const automation = await this.findById(automationId);
    return this.setEnabledAndVerify(automationId, automation.entityId, enabled);
  }

  async run(automationId: string): Promise<'accepted' | 'uncertain'> {
    await this.assertManaged(automationId);
    const automation = await this.findById(automationId);
    try {
      await this.ha.callService({
        domain: 'automation',
        service: 'trigger',
        target: { entity_id: automation.entityId },
        serviceData: { skip_condition: false },
      });
      return 'accepted';
    } catch (error) {
      if (error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted) return 'uncertain';
      throw error;
    }
  }

  async delete(automationId: string): Promise<'succeeded' | 'accepted' | 'uncertain'> {
    this.assertAutomationId(automationId);
    const existing = await this.ha.getAutomationConfig(automationId);
    if (!managedMetadata(existing)) throw new Error('home_automation_not_managed');
    try {
      await this.ha.deleteAutomationConfig(automationId);
    } catch (error) {
      if (error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted) return 'uncertain';
      throw error;
    }
    let readable = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await this.wait(150);
      try {
        const state = await this.findStateById(automationId);
        readable = true;
        if (!state) return 'succeeded';
      } catch {
        return 'accepted';
      }
    }
    return readable ? 'uncertain' : 'accepted';
  }

  private async findById(automationId: string): Promise<HomeAutomationSummary> {
    this.assertAutomationId(automationId);
    const state = await this.findStateById(automationId);
    if (!state) throw new Error('home_automation_not_found');
    return {
      automationId,
      entityId: state.entity_id,
      name:
        typeof state.attributes?.friendly_name === 'string'
          ? state.attributes.friendly_name
          : state.entity_id,
      description: '',
      enabled: state.state === 'on',
      available: state.state !== 'unavailable',
      lastTriggered:
        typeof state.attributes?.last_triggered === 'string'
          ? state.attributes.last_triggered
          : null,
      mode: typeof state.attributes?.mode === 'string' ? state.attributes.mode : null,
      managedByJarvis: false,
      sceneId: null,
      schedule: null,
      configurationStatus: 'unknown',
    };
  }

  private async assertManaged(automationId: string): Promise<void> {
    this.assertAutomationId(automationId);
    const config = await this.ha.getAutomationConfig(automationId);
    if (!managedMetadata(config)) throw new Error('home_automation_not_managed');
  }

  async reconcileCatalogMutation<T>(mutation: () => T | Promise<T>): Promise<{
    value: T;
    reconciliation: HomeAutomationReconciliationResult;
  }> {
    const previous = this.reconciliationTail;
    let release!: () => void;
    this.reconciliationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.reconcileCatalogMutationUnlocked(mutation);
    } finally {
      release();
    }
  }

  private async reconcileCatalogMutationUnlocked<T>(mutation: () => T | Promise<T>): Promise<{
    value: T;
    reconciliation: HomeAutomationReconciliationResult;
  }> {
    const operationId = randomUUID();
    const suspended = await this.suspendManagedAutomations(operationId);
    let value: T;
    try {
      value = await mutation();
    } catch (error) {
      const restoreStatus = await this.restoreManagedAutomations(suspended);
      if (restoreStatus !== 'succeeded') {
        throw new Error('home_automation_restore_uncertain', { cause: error });
      }
      throw error;
    }
    let reconciliation: HomeAutomationReconciliationResult;
    try {
      reconciliation = await this.reconcile();
    } catch (error) {
      const restoreStatus = await this.restoreManagedAutomations(suspended);
      if (restoreStatus !== 'succeeded') {
        throw new Error('home_automation_restore_uncertain', { cause: error });
      }
      throw error;
    }
    const blocked = new Set([
      ...reconciliation.failed,
      ...reconciliation.skipped.map((item) => item.automationId),
    ]);
    for (const automation of suspended.filter((item) => blocked.has(item.automationId))) {
      this.stateRepository?.updateAutomationSuspension(
        automation.operationId,
        automation.automationId,
        'skipped',
        'reconciliation_blocked'
      );
      this.log?.warn(
        { operationId: automation.operationId, automationId: automation.automationId },
        'managed home automation restoration skipped after reconciliation'
      );
    }
    const restoreStatus = await this.restoreManagedAutomations(
      suspended.filter((item) => !blocked.has(item.automationId) && this.catalog.getScene(item.sceneId))
    );
    if (restoreStatus === 'uncertain') reconciliation.operationStatus = 'uncertain';
    else if (restoreStatus === 'partial' && reconciliation.operationStatus === 'succeeded') {
      reconciliation.operationStatus = 'partial';
    }
    return { value, reconciliation };
  }

  async reconcile(): Promise<HomeAutomationReconciliationResult> {
    const operationId = randomUUID();
    const rawStates = await this.ha.getStates();
    const states = (Array.isArray(rawStates) ? rawStates : [])
      .filter(isHaState)
      .filter((state) => state.entity_id.startsWith('automation.'));
    const updated: string[] = [];
    const failed: string[] = [];
    const skipped: Array<{ automationId: string; reason: 'missing_scene' | 'invalid_configuration' }> = [];
    let uncertain = false;
    for (const state of states) {
      const automationId = typeof state.attributes?.id === 'string' ? state.attributes.id : '';
      if (!automationIdPattern.test(automationId)) continue;
      let config: HomeAssistantAutomationConfig;
      try {
        config = await this.ha.getAutomationConfig(automationId);
      } catch {
        if (automationId.startsWith('jarvis_')) {
          failed.push(automationId);
          uncertain = true;
        }
        continue;
      }
      const managed = managedMetadata(config);
      if (!managed) continue;
      const scene = this.catalog.getScene(managed.sceneId);
      if (!scene) {
        skipped.push({ automationId, reason: 'missing_scene' });
        continue;
      }
      const schedule = scheduleFromConfig(config);
      const name = typeof config.alias === 'string' ? config.alias.trim() : '';
      if (!schedule || !name) {
        skipped.push({ automationId, reason: 'invalid_configuration' });
        continue;
      }
      const wasEnabled = state.state === 'on';
      const suspension = wasEnabled ? {
        operationId,
        automationId,
        entityId: state.entity_id,
        sceneId: managed.sceneId,
      } : undefined;
      let desired: HomeAssistantAutomationConfig;
      try {
        desired = compileManagedAutomation(this.catalog, {
          name,
          sceneId: managed.sceneId,
          at: schedule.at,
          weekdays: schedule.weekdays,
          enabled: false,
        });
      } catch {
        skipped.push({ automationId, reason: 'invalid_configuration' });
        continue;
      }
      if (config.description === desired.description && JSON.stringify(config.actions ?? config.action) === JSON.stringify(desired.actions)) {
        continue;
      }
      try {
        if (wasEnabled) {
          this.stateRepository?.recordAutomationSuspension(suspension!);
          const disabledStatus = await this.setEnabledAndVerify(automationId, state.entity_id, false);
          if (disabledStatus !== 'succeeded') {
            this.stateRepository?.updateAutomationSuspension(
              operationId,
              automationId,
              'failed',
              `pause_${disabledStatus}`
            );
            failed.push(automationId);
            uncertain = true;
            await this.restoreManagedAutomations([suspension!]);
            continue;
          }
          this.stateRepository?.updateAutomationSuspension(operationId, automationId, 'suspended');
        }
        await this.ha.saveAutomationConfig(automationId, desired);
        const enabledStatus = await this.setEnabledWhenLoaded(automationId, wasEnabled);
        if (enabledStatus !== 'succeeded') {
          uncertain = true;
          if (suspension) {
            this.stateRepository?.updateAutomationSuspension(
              operationId,
              automationId,
              'failed',
              `restore_${enabledStatus}`
            );
          }
        } else if (suspension) {
          this.stateRepository?.updateAutomationSuspension(operationId, automationId, 'restored');
        }
        updated.push(automationId);
      } catch (error) {
        failed.push(automationId);
        if (suspension) {
          const restoreStatus = await this.restoreManagedAutomations([suspension]);
          if (restoreStatus !== 'succeeded') uncertain = true;
        }
        if (error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted) uncertain = true;
      }
    }
    return {
      operationStatus: uncertain
        ? 'uncertain'
        : failed.length > 0 || skipped.length > 0 ? 'partial' : 'succeeded',
      updated,
      skipped,
      failed,
    };
  }

  async recoverSuspendedAutomations(options: { includeRecent?: boolean } = {}): Promise<{
    operationStatus: 'succeeded' | 'partial' | 'uncertain';
    restored: string[];
    skipped: string[];
    failed: string[];
  }> {
    const recoverable = this.stateRepository?.listRecoverableAutomationSuspensions(
      options.includeRecent ? Number.MAX_SAFE_INTEGER : Date.now() - interruptedOperationGraceMs
    ) ?? [];
    const suspended = recoverable.map((item) => ({
      operationId: item.operationId,
      automationId: item.automationId,
      entityId: item.entityId,
      sceneId: item.sceneId,
    }));
    await this.restoreManagedAutomations(suspended);
    const finalStates = new Map(
      (this.stateRepository?.listAutomationSuspensions() ?? []).map((item) => [
        `${item.operationId}\u0000${item.automationId}`,
        item.state,
      ])
    );
    const restored: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const item of recoverable) {
      const key = `${item.operationId}\u0000${item.automationId}`;
      const state = finalStates.get(key);
      if (state === 'restored') restored.push(item.automationId);
      else if (state === 'skipped') skipped.push(item.automationId);
      else failed.push(item.automationId);
    }
    return {
      operationStatus: failed.length
        ? (restored.length || skipped.length ? 'partial' : 'uncertain')
        : skipped.length ? 'partial' : 'succeeded',
      restored,
      skipped,
      failed,
    };
  }

  private async suspendManagedAutomations(operationId: string): Promise<SuspendedManagedAutomation[]> {
    const rawStates = await this.ha.getStates();
    const states = (Array.isArray(rawStates) ? rawStates : [])
      .filter(isHaState)
      .filter((state) => state.entity_id.startsWith('automation.') && state.state === 'on');
    const suspended: SuspendedManagedAutomation[] = [];
    for (const state of states) {
      const automationId = typeof state.attributes?.id === 'string' ? state.attributes.id : '';
      if (!automationIdPattern.test(automationId)) continue;
      let config: HomeAssistantAutomationConfig | null;
      try {
        config = await this.ha.getAutomationConfig(automationId);
      } catch {
        await this.restoreManagedAutomations(suspended);
        throw new Error('home_automation_pause_unconfirmed');
      }
      const managed = managedMetadata(config);
      if (!managed) continue;
      const suspendedAutomation = {
        operationId,
        automationId,
        entityId: state.entity_id,
        sceneId: managed.sceneId,
      };
      this.stateRepository?.recordAutomationSuspension(suspendedAutomation);
      suspended.push(suspendedAutomation);
      let status: 'succeeded' | 'accepted' | 'uncertain';
      try {
        status = await this.setEnabledAndVerify(automationId, state.entity_id, false);
      } catch {
        await this.restoreManagedAutomations(suspended);
        throw new Error('home_automation_pause_unconfirmed');
      }
      if (status !== 'succeeded') {
        await this.restoreManagedAutomations(suspended);
        throw new Error('home_automation_pause_unconfirmed');
      }
      this.stateRepository?.updateAutomationSuspension(operationId, automationId, 'suspended');
      this.log?.info(
        { operationId, automationId, sceneId: managed.sceneId },
        'managed home automation suspended for catalog reconciliation'
      );
    }
    return suspended;
  }

  private async restoreManagedAutomations(
    automations: SuspendedManagedAutomation[]
  ): Promise<'succeeded' | 'partial' | 'uncertain'> {
    let uncertain = false;
    let skipped = false;
    for (const automation of automations) {
      try {
        const config = await this.ha.getAutomationConfig(automation.automationId);
        const managed = managedMetadata(config);
        if (!managed || managed.sceneId !== automation.sceneId || !this.catalog.getScene(automation.sceneId)) {
          this.stateRepository?.updateAutomationSuspension(
            automation.operationId,
            automation.automationId,
            'skipped',
            'automation_no_longer_safe'
          );
          this.log?.warn(
            { operationId: automation.operationId, automationId: automation.automationId },
            'managed home automation restoration skipped because configuration changed'
          );
          skipped = true;
          continue;
        }
        const status = await this.setEnabledWhenLoaded(automation.automationId, true);
        if (status !== 'succeeded') {
          uncertain = true;
          this.stateRepository?.updateAutomationSuspension(
            automation.operationId,
            automation.automationId,
            'failed',
            `restore_${status}`
          );
          this.log?.warn(
            { operationId: automation.operationId, automationId: automation.automationId, status },
            'managed home automation restoration could not be confirmed'
          );
        } else {
          this.stateRepository?.updateAutomationSuspension(
            automation.operationId,
            automation.automationId,
            'restored'
          );
          this.log?.info(
            { operationId: automation.operationId, automationId: automation.automationId },
            'managed home automation restored after reconciliation'
          );
        }
      } catch (error) {
        uncertain = true;
        const errorCode = error instanceof Error ? error.message : 'home_automation_restore_failed';
        this.stateRepository?.updateAutomationSuspension(
          automation.operationId,
          automation.automationId,
          'failed',
          errorCode
        );
        this.log?.warn(
          { operationId: automation.operationId, automationId: automation.automationId, errorCode },
          'managed home automation restoration failed'
        );
      }
    }
    return uncertain ? 'uncertain' : skipped ? 'partial' : 'succeeded';
  }

  private async findStateById(automationId: string): Promise<HaState | undefined> {
    const rawStates = await this.ha.getStates();
    return (Array.isArray(rawStates) ? rawStates : [])
      .filter(isHaState)
      .find((state) => state.attributes?.id === automationId);
  }

  private async setEnabledWhenLoaded(automationId: string, enabled: boolean): Promise<'succeeded' | 'accepted' | 'uncertain'> {
    for (let attempt = 0; attempt < reloadAttempts; attempt += 1) {
      const state = await this.findStateById(automationId);
      if (state) {
        return this.setEnabledAndVerify(automationId, state.entity_id, enabled);
      }
      if (attempt < reloadAttempts - 1) {
        await this.wait(reloadDelayMs);
      }
    }
    return 'accepted';
  }

  private async setEnabledAndVerify(
    automationId: string,
    entityId: string,
    enabled: boolean
  ): Promise<'succeeded' | 'accepted' | 'uncertain'> {
    try {
      await this.ha.callService({
        domain: 'automation',
        service: enabled ? 'turn_on' : 'turn_off',
        target: { entity_id: entityId },
      });
    } catch (error) {
      if (error instanceof HomeAssistantRequestError && error.operationMayHaveBeenAccepted) return 'uncertain';
      throw error;
    }
    let readable = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await this.wait(150);
      try {
        const state = await this.findStateById(automationId);
        if (!state) continue;
        readable = true;
        if (state.state === (enabled ? 'on' : 'off')) return 'succeeded';
      } catch {
        return 'accepted';
      }
    }
    return readable ? 'uncertain' : 'accepted';
  }

  private assertAutomationId(automationId: string): void {
    if (!automationIdPattern.test(automationId)) throw new Error('home_automation_invalid');
  }
}
