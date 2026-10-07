import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import Fastify from 'fastify';

import type { Env } from '../src/env';
import type { PermissionKey, RoleKey } from '../src/identity/IdentityRepository';
import { setRequestPrincipal } from '../src/identity/requestIdentity';
import { registerHomeRoutes } from '../src/routes/home';
import type { AppDeps } from '../src/server';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup(
  role: RoleKey = 'guest',
  permissions: PermissionKey[] = ['home'],
  writable = false
) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-home-'));
  roots.push(root);
  const folder = join(root, 'home-test');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'home.json'),
    JSON.stringify({
      homeId: 'home-test',
      displayName: 'Chez moi',
      geometry: { quality: 'approximate', units: 'm' },
      rooms: [
        {
          roomId: 'living',
          name: 'Salon',
          type: 'living_room',
          polygon: [
            [0, 0],
            [4, 0],
            [4, 3],
            [0, 3],
          ],
        },
      ],
      automation: {
        spaces: [
          {
            roomId: 'living',
            entities: [
              { deviceId: 'living-light', entityId: 'light.salon', name: 'Lampe principale' },
              { deviceId: 'living-vacuum', entityId: 'vacuum.robot' },
              { deviceId: 'living-camera', entityId: 'camera.salon' },
            ],
          },
        ],
      },
    })
  );
  const getStates = jest.fn(async () => [
    { entity_id: 'light.salon', state: 'on', attributes: { friendly_name: 'Salon' } },
    { entity_id: 'camera.salon', state: 'idle', attributes: { friendly_name: 'Caméra salon' } },
  ]);
  const callService = jest.fn(async (_input: unknown) => ({ status: 200, data: [] }));
  const recordActorAudit = jest.fn();
  const app = Fastify();
  app.addHook('preHandler', (request, _reply, done) => {
    setRequestPrincipal(request, {
      kind: 'user',
      userId: 'guest-id',
      email: 'guest@example.test',
      displayName: 'Invité',
      status: 'active',
      roles: [role],
      permissions,
      sessionId: 'session',
    });
    done();
  });
  registerHomeRoutes(app, {
    env: {
      HOME_CONFIG_ROOT: root,
      HOME_DATA_ROOT: writable ? join(root, 'runtime-homes') : '',
      ACTIVE_HOME_ID: 'home-test',
    } as Env,
    ha: { getStates, callService } as unknown as AppDeps['ha'],
    spotifyWebApi: {} as AppDeps['spotifyWebApi'],
    adminAudit: { recordActorAudit } as unknown as AppDeps['adminAudit'],
  });
  return { app, callService, getStates, recordActorAudit };
}

describe('home routes', () => {
  test('returns the versioned plan with reconciled Home Assistant state', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ homeId: 'home-test', rooms: [{ roomId: 'living' }] });
    expect(response.json().devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: 'living-light',
          name: 'Lampe principale',
          state: 'on',
          available: true,
          capabilities: ['turn_on', 'turn_off', 'toggle'],
          riskLevel: 'low',
        }),
      ])
    );
    expect(response.json().devices).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceId: 'living-vacuum' })])
    );
    expect(response.json().devices).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceId: 'living-camera' })])
    );
    await app.close();
  });

  test('allows simple guest controls and denies broader domestic actions', async () => {
    const { app, callService, recordActorAudit } = setup();
    const light = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'toggle' },
    });
    expect(light.statusCode).toBe(200);
    expect(callService).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'light',
        service: 'toggle',
        target: { entity_id: 'light.salon' },
      })
    );
    expect(light.json()).toEqual({ status: 'ok', deviceId: 'living-light' });
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorKind: 'user',
        actorId: 'guest-id',
        action: 'home.action.toggle',
        targetId: 'living-light',
        outcome: 'success',
        metadata: { domain: 'light' },
      })
    );
    expect(JSON.stringify(recordActorAudit.mock.calls)).not.toContain('light.salon');
    const vacuum = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-vacuum', action: 'start' },
    });
    expect(vacuum.statusCode).toBe(403);
    expect(vacuum.json()).toEqual({ error: 'guest_action_forbidden' });
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.action.start',
        targetId: 'living-vacuum',
        outcome: 'denied',
      })
    );
    await app.close();
  });

  test('denies and audits a valid command when the account lacks home access', async () => {
    const { app, callService, recordActorAudit } = setup('resident', []);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'toggle' },
    });
    expect(response.statusCode).toBe(403);
    expect(callService).not.toHaveBeenCalled();
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorKind: 'user',
        actorId: 'guest-id',
        action: 'home.action.toggle',
        targetId: 'living-light',
        outcome: 'denied',
        metadata: { errorCode: 'forbidden' },
      })
    );
    await app.close();
  });

  test('requires the camera permission for camera reads', async () => {
    const withoutCamera = setup('resident');
    const denied = await withoutCamera.app.inject({ method: 'GET', url: '/v1/home' });
    expect(denied.json().devices).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceId: 'living-camera' })])
    );
    await withoutCamera.app.close();

    const withCamera = setup('resident', ['home', 'cameras']);
    const allowed = await withCamera.app.inject({ method: 'GET', url: '/v1/home' });
    expect(allowed.json().devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: 'living-camera',
          capabilities: ['view'],
          riskLevel: 'high',
        }),
      ])
    );
    await withCamera.app.close();
  });

  test('never accepts a raw Home Assistant entity or an incomplete temperature command', async () => {
    const { app, callService } = setup();
    const rawEntity = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'light.salon', action: 'toggle' },
    });
    expect(rawEntity.statusCode).toBe(400);
    const missingTemperature = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'set_temperature' },
    });
    expect(missingTemperature.statusCode).toBe(400);
    expect(callService).toHaveBeenCalledTimes(0);
    await app.close();
  });

  test('keeps the plan usable while Home Assistant is offline and normalizes command failures', async () => {
    const { app, callService, getStates, recordActorAudit } = setup();
    getStates.mockRejectedValueOnce(new Error('offline'));
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.headers['cache-control']).toBe('no-store');
    expect(snapshot.json().devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: 'living-light',
          available: false,
          state: 'unavailable',
        }),
      ])
    );
    callService.mockRejectedValueOnce(new Error('offline'));
    const command = await app.inject({
      method: 'POST',
      url: '/v1/home/actions',
      payload: { deviceId: 'living-light', action: 'toggle' },
    });
    expect(command.statusCode).toBe(502);
    expect(command.json()).toEqual({ error: 'home_assistant_unavailable' });
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.action.toggle',
        outcome: 'failed',
        metadata: { domain: 'light', errorCode: 'home_assistant_unavailable' },
      })
    );
    await app.close();
  });

  test('lets an owner place an unmapped preset and rejects stale revisions', async () => {
    const { app, recordActorAudit } = setup('owner', ['home', 'admin'], true);
    const initial = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(initial.json()).toMatchObject({ canEdit: true, revision: expect.any(String) });
    const revision = initial.json().revision as string;
    const created = await app.inject({
      method: 'PUT',
      url: '/v1/home/devices/living-draft-robot',
      payload: {
        expectedRevision: revision,
        roomId: 'living',
        name: 'Robot du salon',
        presetId: 'vacuum',
        placement: { x: 2, y: 1.5, z: 0, rotationDeg: 0, scale: 1 },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.device.upsert',
        targetId: 'living-draft-robot',
        outcome: 'success',
        metadata: { roomId: 'living', presetId: 'vacuum' },
      })
    );
    const snapshot = await app.inject({ method: 'GET', url: '/v1/home' });
    expect(snapshot.json().devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: 'living-draft-robot',
          mapped: false,
          state: 'not_configured',
          presetId: 'vacuum',
        }),
      ])
    );
    const stale = await app.inject({
      method: 'PUT',
      url: '/v1/home/devices/another-light',
      payload: {
        expectedRevision: revision,
        roomId: 'living',
        name: 'Autre lumière',
        presetId: 'light',
        placement: { x: 1, y: 1, z: 0, rotationDeg: 0, scale: 1 },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'home_config_conflict' });
    expect(recordActorAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'home.device.upsert',
        targetId: 'another-light',
        outcome: 'failed',
        metadata: { errorCode: 'home_config_conflict' },
      })
    );
    await app.close();
  });

  test('returns existing mappings only to an owner with home access', async () => {
    const owner = setup('owner', ['home', 'admin'], true);
    const configuration = await owner.app.inject({
      method: 'GET',
      url: '/v1/home/configuration',
    });
    expect(configuration.statusCode).toBe(200);
    expect(configuration.json().mappedEntities).toEqual(
      expect.arrayContaining([
        { deviceId: 'living-light', entityId: 'light.salon' },
        { deviceId: 'living-vacuum', entityId: 'vacuum.robot' },
      ])
    );
    await owner.app.close();

    const ownerWithoutHome = setup('owner', ['admin'], true);
    const denied = await ownerWithoutHome.app.inject({
      method: 'GET',
      url: '/v1/home/configuration',
    });
    expect(denied.statusCode).toBe(403);
    await ownerWithoutHome.app.close();
  });

  test('keeps home editing owner-only and validates placement server-side', async () => {
    const resident = setup('resident', ['home'], true);
    const denied = await resident.app.inject({ method: 'GET', url: '/v1/home/configuration' });
    expect(denied.statusCode).toBe(403);
    await resident.app.close();

    const owner = setup('owner', ['home', 'admin'], true);
    const snapshot = await owner.app.inject({ method: 'GET', url: '/v1/home' });
    const invalid = await owner.app.inject({
      method: 'PUT',
      url: '/v1/home/devices/outside-device',
      payload: {
        expectedRevision: snapshot.json().revision,
        roomId: 'living',
        name: 'Hors plan',
        presetId: 'light',
        placement: { x: 99, y: 99, z: 0, rotationDeg: 0, scale: 1 },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'home_device_invalid' });
    await owner.app.close();
  });
});
