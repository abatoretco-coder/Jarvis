import { randomUUID } from 'node:crypto';

import type { HomeAssistantAutomationConfig, HomeAssistantClient } from '../haClient';
import { resolveCatalogHomeAction } from './HomeActionExecutor';
import type { HomeCatalog, HomeScene } from './HomeCatalog';

const MANAGED_PREFIX = 'jarvis-managed:v1:scene=';
const automationIdPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const reloadAttempts = 20;
const reloadDelayMs = 100;

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
};

export type ManagedAutomationInput = {
  name: string;
  sceneId: string;
  at: string;
  weekdays: number[];
  enabled: boolean;
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

function managedSceneId(config: HomeAssistantAutomationConfig | null): string | null {
  const description = config?.description;
  if (typeof description !== 'string' || !description.startsWith(MANAGED_PREFIX)) return null;
  const sceneId = description.slice(MANAGED_PREFIX.length);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(sceneId) ? sceneId : null;
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

export function compileManagedAutomation(
  catalog: HomeCatalog,
  input: ManagedAutomationInput
): HomeAssistantAutomationConfig {
  const scene = catalog.getScene(input.sceneId);
  if (!scene) throw new Error('home_scene_not_found');
  return {
    alias: input.name,
    description: `${MANAGED_PREFIX}${scene.sceneId}`,
    triggers: [{ trigger: 'time', at: `${input.at}:00` }],
    conditions: [
      {
        condition: 'time',
        weekday: input.weekdays.map((day) => weekdays[day - 1]),
      },
    ],
    actions: compileActions(catalog, scene),
    mode: 'single',
    initial_state: input.enabled,
  };
}

export class HomeAssistantAutomationService {
  constructor(
    private readonly ha: HomeAssistantClient,
    private readonly catalog: HomeCatalog
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
        const sceneId = managedSceneId(config);
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
        };
      })
    );
  }

  async create(input: ManagedAutomationInput): Promise<{ automationId: string }> {
    const automationId = `jarvis_${randomUUID().replaceAll('-', '')}`;
    await this.ha.saveAutomationConfig(
      automationId,
      compileManagedAutomation(this.catalog, input)
    );
    await this.setEnabledWhenLoaded(automationId, input.enabled);
    return { automationId };
  }

  async update(automationId: string, input: ManagedAutomationInput): Promise<void> {
    this.assertAutomationId(automationId);
    const existing = await this.ha.getAutomationConfig(automationId);
    if (!managedSceneId(existing)) throw new Error('home_automation_not_managed');
    await this.ha.saveAutomationConfig(
      automationId,
      compileManagedAutomation(this.catalog, input)
    );
    await this.setEnabledWhenLoaded(automationId, input.enabled);
  }

  async setEnabled(automationId: string, enabled: boolean): Promise<void> {
    const automation = await this.findById(automationId);
    await this.ha.callService({
      domain: 'automation',
      service: enabled ? 'turn_on' : 'turn_off',
      target: { entity_id: automation.entityId },
    });
  }

  async run(automationId: string): Promise<void> {
    const automation = await this.findById(automationId);
    await this.ha.callService({
      domain: 'automation',
      service: 'trigger',
      target: { entity_id: automation.entityId },
      serviceData: { skip_condition: false },
    });
  }

  async delete(automationId: string): Promise<void> {
    this.assertAutomationId(automationId);
    const existing = await this.ha.getAutomationConfig(automationId);
    if (!managedSceneId(existing)) throw new Error('home_automation_not_managed');
    await this.ha.deleteAutomationConfig(automationId);
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
    };
  }

  private async findStateById(automationId: string): Promise<HaState | undefined> {
    const rawStates = await this.ha.getStates();
    return (Array.isArray(rawStates) ? rawStates : [])
      .filter(isHaState)
      .find((state) => state.attributes?.id === automationId);
  }

  private async setEnabledWhenLoaded(automationId: string, enabled: boolean): Promise<void> {
    for (let attempt = 0; attempt < reloadAttempts; attempt += 1) {
      const state = await this.findStateById(automationId);
      if (state) {
        await this.ha.callService({
          domain: 'automation',
          service: enabled ? 'turn_on' : 'turn_off',
          target: { entity_id: state.entity_id },
        });
        return;
      }
      if (attempt < reloadAttempts - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, reloadDelayMs));
      }
    }
    throw new Error('home_automation_not_found');
  }

  private assertAutomationId(automationId: string): void {
    if (!automationIdPattern.test(automationId)) throw new Error('home_automation_invalid');
  }
}
