import type { FastifyBaseLogger } from 'fastify';

import type { HomeAssistantClient } from '../haClient';
import { executeCatalogHomeScene } from './HomeActionExecutor';
import type { HomeCatalog } from './HomeCatalog';

function parisScheduleParts(date: Date): { dateKey: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekdays: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return {
    dateKey: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
    weekday: weekdays[value('weekday')] ?? 0,
  };
}

export class HomeRoutineScheduler {
  private timer?: NodeJS.Timeout;
  private initializedMinute?: string;
  private readonly lastRun = new Map<string, string>();

  constructor(
    private readonly catalog: HomeCatalog,
    private readonly ha: HomeAssistantClient | undefined,
    private readonly log: FastifyBaseLogger
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = new Date()): Promise<void> {
    const current = parisScheduleParts(now);
    const minuteKey = `${current.dateKey}T${current.time}`;
    if (!this.initializedMinute) {
      // Do not replay a possibly already executed routine when Jarvis restarts mid-minute.
      this.initializedMinute = minuteKey;
      return;
    }
    for (const routine of this.catalog.getRoutines()) {
      if (
        !routine.enabled ||
        routine.trigger.at !== current.time ||
        !routine.trigger.weekdays.includes(current.weekday) ||
        this.lastRun.get(routine.routineId) === minuteKey
      ) continue;
      this.lastRun.set(routine.routineId, minuteKey);
      const scene = this.catalog.getScene(routine.sceneId);
      if (!scene) continue;
      const result = await executeCatalogHomeScene({ catalog: this.catalog, scene, ha: this.ha });
      this.log.info(
        { routineId: routine.routineId, sceneId: scene.sceneId, outcome: result.status },
        'home routine executed'
      );
    }
    this.initializedMinute = minuteKey;
  }
}
