import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, jest, test } from '@jest/globals';

import type { HomeAssistantClient } from '../src/haClient';
import { HomeCatalog } from '../src/home/HomeCatalog';
import { HomeRoutineScheduler } from '../src/home/HomeRoutineScheduler';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

test('runs an enabled Paris-time routine once per scheduled minute', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-routine-'));
  roots.push(root);
  const folder = join(root, 'home-test');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'home.json'),
    JSON.stringify({
      homeId: 'home-test',
      displayName: 'Chez moi',
      geometry: { quality: 'test', units: 'm' },
      rooms: [{ roomId: 'living', name: 'Salon', type: 'living_room', polygon: [[0, 0], [4, 0], [4, 3]] }],
      automation: {
        spaces: [{
          roomId: 'living',
          entities: [
            { deviceId: 'light-one', entityId: 'light.one', presetId: 'light' },
            { deviceId: 'light-two', entityId: 'light.two', presetId: 'light' },
          ],
        }],
        scenes: [{
          sceneId: 'scene-morning',
          name: 'Réveil',
          icon: 'light',
          steps: [
            { deviceId: 'light-one', action: 'turn_on' },
            { deviceId: 'light-two', action: 'turn_on' },
          ],
          voicePhrases: [],
          sortOrder: 0,
        }],
        routines: [{
          routineId: 'routine-morning',
          name: 'Réveil semaine',
          enabled: true,
          sceneId: 'scene-morning',
          trigger: { type: 'time', at: '08:30', weekdays: [1, 2, 3, 4, 5] },
        }],
      },
    })
  );
  const catalog = new HomeCatalog(root, 'home-test');
  const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
  const scheduler = new HomeRoutineScheduler(
    catalog,
    { callService } as unknown as HomeAssistantClient,
    { info: jest.fn() } as never
  );

  await scheduler.tick(new Date('2026-01-05T07:29:30.000Z'));
  await scheduler.tick(new Date('2026-01-05T07:30:02.000Z'));
  await scheduler.tick(new Date('2026-01-05T07:30:40.000Z'));

  expect(callService).toHaveBeenCalledTimes(2);
});
