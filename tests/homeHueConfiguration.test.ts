import { join } from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { HomeCatalog } from '../src/home/HomeCatalog';

describe('Philips Hue lighting integration', () => {
  test('maps the seven planned Hue lights to stable Home Assistant entities and rooms', () => {
    const catalog = new HomeCatalog(
      join(process.cwd(), 'config', 'homes'),
      'home_fr_paris_10_fsm_236_lot_204'
    );
    const expected = [
      ['hue-living-ceiling-1', 'light.plafonnier_salon_centre', 'room_living'],
      ['hue-living-ceiling-2', 'light.plafonnier_salon_couloir', 'room_living'],
      ['hue-kitchen-ceiling', 'light.plafonnier_cuisine', 'room_kitchen'],
      ['hue-bedroom-ceiling', 'light.plafonnier_chambre', 'room_bedroom'],
      ['hue-bathroom-spot-1', 'light.spot_salle_de_bain_1', 'room_bathroom'],
      ['hue-bathroom-spot-2', 'light.spot_salle_de_bain_2', 'room_bathroom'],
      ['hue-office-light', 'light.lampe_bureau', 'room_office'],
    ] as const;
    const projectedDevices = catalog.getHomeAssistantProjection().devices;

    for (const [deviceId, entityId, roomId] of expected) {
      expect(catalog.getMapping(deviceId)).toMatchObject({
        deviceId,
        entityId,
        presetId: 'light',
        icon: deviceId === 'hue-office-light' ? 'bulb' : 'ceiling-light',
      });
      expect(projectedDevices).toContainEqual(expect.objectContaining({ deviceId, entityId, roomId }));
    }
  });

  test('keeps the Hue bridge informational and wires the lights into the relevant scenes', async () => {
    const catalog = new HomeCatalog(
      join(process.cwd(), 'config', 'homes'),
      'home_fr_paris_10_fsm_236_lot_204'
    );
    const fixedCeilingDeviceIds = [
      'hue-living-ceiling-1',
      'hue-living-ceiling-2',
      'hue-kitchen-ceiling',
      'hue-bedroom-ceiling',
      'hue-bathroom-spot-1',
      'hue-bathroom-spot-2',
    ];
    const hueDeviceIds = [...fixedCeilingDeviceIds, 'hue-office-light'];

    expect(catalog.getMapping('hue-bridge')).toMatchObject({
      deviceId: 'hue-bridge',
      presetId: 'hub',
    });
    expect(catalog.getMapping('hue-bridge')?.entityId).toBeUndefined();
    expect((await catalog.snapshot()).devices.find((device) => device.deviceId === 'hue-bridge')).toMatchObject({
      mapped: false,
      available: false,
      capabilities: [],
    });
    expect(catalog.getScene('film')?.steps).toEqual(expect.arrayContaining([
      { deviceId: 'hue-living-ceiling-1', action: 'set_brightness', value: 1 },
      { deviceId: 'hue-living-ceiling-2', action: 'set_brightness', value: 1 },
    ]));
    expect(catalog.getScene('film')?.steps).not.toEqual(expect.arrayContaining([
      { deviceId: 'hue-kitchen-ceiling', action: 'turn_off' },
    ]));
    expect(catalog.getScene('living-evening')).toMatchObject({
      name: 'Soirée salon',
      steps: [
        { deviceId: 'hue-living-ceiling-1', action: 'set_brightness', value: 45 },
        { deviceId: 'hue-living-ceiling-2', action: 'set_brightness', value: 45 },
      ],
    });
    expect(catalog.getScene('leave-home')?.steps).toEqual(expect.arrayContaining(
      hueDeviceIds.map((deviceId) => ({ deviceId, action: 'turn_off' }))
    ));
    expect(catalog.getScene('ceilings-on')?.steps).toEqual(expect.arrayContaining(
      fixedCeilingDeviceIds.map((deviceId) => ({ deviceId, action: 'turn_on' }))
    ));
    expect(catalog.getScene('ceilings-off')?.steps).toEqual(expect.arrayContaining(
      fixedCeilingDeviceIds.map((deviceId) => ({ deviceId, action: 'turn_off' }))
    ));
    expect(catalog.getScene('ceilings-on')?.steps).not.toEqual(expect.arrayContaining([
      { deviceId: 'hue-office-light', action: 'turn_on' },
    ]));
  });

  test('configures bounded adaptive profiles for every installed Hue room', () => {
    const catalog = new HomeCatalog(
      join(process.cwd(), 'config', 'homes'),
      'home_fr_paris_10_fsm_236_lot_204'
    );

    expect(catalog.getAdaptiveLightingConfig()).toMatchObject({
      enabled: true,
      pollSeconds: 30,
      manualOverrideMinutes: 120,
      rooms: expect.arrayContaining([
        expect.objectContaining({
          roomId: 'room_living',
          deviceIds: ['hue-living-ceiling-1', 'hue-living-ceiling-2', 'tapo-plug-1', 'tapo-plug-2'],
          dimmedOffDeviceIds: ['tapo-plug-2'],
          phases: {
            dawn: { brightnessPercent: 75, colorTemperatureKelvin: 3500 },
            day: { brightnessPercent: 90, colorTemperatureKelvin: 3800 },
            dusk: { brightnessPercent: 65, colorTemperatureKelvin: 3000 },
            night: { brightnessPercent: 45, colorTemperatureKelvin: 2700 },
          },
          dimmedPhases: expect.objectContaining({
            dawn: { brightnessPercent: 18, colorTemperatureKelvin: 2500 },
            night: { brightnessPercent: 10, colorTemperatureKelvin: 2300 },
          }),
        }),
        expect.objectContaining({
          roomId: 'room_kitchen',
          deviceIds: ['hue-kitchen-ceiling'],
          phases: {
            dawn: { brightnessPercent: 90, colorTemperatureKelvin: 3800 },
            day: { brightnessPercent: 100, colorTemperatureKelvin: 4200 },
            dusk: { brightnessPercent: 80, colorTemperatureKelvin: 3500 },
            night: { brightnessPercent: 60, colorTemperatureKelvin: 3000 },
          },
        }),
        expect.objectContaining({
          roomId: 'room_bedroom',
          deviceIds: ['hue-bedroom-ceiling'],
          phases: {
            dawn: { brightnessPercent: 80, colorTemperatureKelvin: 3300 },
            day: { brightnessPercent: 80, colorTemperatureKelvin: 3500 },
            dusk: { brightnessPercent: 55, colorTemperatureKelvin: 2800 },
            night: { brightnessPercent: 35, colorTemperatureKelvin: 2500 },
          },
        }),
        expect.objectContaining({
          roomId: 'room_bathroom',
          deviceIds: ['hue-bathroom-spot-1', 'hue-bathroom-spot-2'],
          phases: {
            dawn: { brightnessPercent: 100, colorTemperatureKelvin: 3800 },
            day: { brightnessPercent: 100, colorTemperatureKelvin: 4000 },
            dusk: { brightnessPercent: 75, colorTemperatureKelvin: 3500 },
            night: { brightnessPercent: 50, colorTemperatureKelvin: 3000 },
          },
        }),
        expect.objectContaining({
          roomId: 'room_office',
          deviceIds: ['hue-office-light'],
          phases: {
            dawn: { brightnessPercent: 90, colorTemperatureKelvin: 4000 },
            day: { brightnessPercent: 100, colorTemperatureKelvin: 4200 },
            dusk: { brightnessPercent: 85, colorTemperatureKelvin: 3800 },
            night: { brightnessPercent: 55, colorTemperatureKelvin: 3200 },
          },
        }),
      ]),
    });
  });

  test('routes deterministic light commands by room, individual ceiling light and percentage', () => {
    const catalog = new HomeCatalog(
      join(process.cwd(), 'config', 'homes'),
      'home_fr_paris_10_fsm_236_lot_204'
    );

    expect(catalog.inferDeterministicVoiceScene('Mets les plafonniers du salon à 18 %')?.steps)
      .toEqual(expect.arrayContaining([
        { deviceId: 'hue-living-ceiling-1', action: 'set_brightness', value: 18 },
        { deviceId: 'hue-living-ceiling-2', action: 'set_brightness', value: 18 },
      ]));
    expect(catalog.inferDeterministicVoiceAction('Éteins le plafonnier de la cuisine')).toMatchObject({
      deviceId: 'hue-kitchen-ceiling',
      action: 'turn_off',
    });
    expect(catalog.inferDeterministicVoiceAction('Éteins la lampe du bureau')).toMatchObject({
      deviceId: 'hue-office-light',
      action: 'turn_off',
    });
    expect(catalog.inferDeterministicVoiceAction("Mets l'ampoule du bureau à 40 %")).toMatchObject({
      deviceId: 'hue-office-light',
      action: 'set_brightness',
      value: 40,
    });
    expect(catalog.inferDeterministicVoiceAction('Allume le plafonnier salon centre')).toMatchObject({
      deviceId: 'hue-living-ceiling-1',
      action: 'turn_on',
    });
    expect(catalog.inferDeterministicVoiceAction('Mets le plafonnier salon 1 au minimum')).toMatchObject({
      deviceId: 'hue-living-ceiling-1',
      action: 'set_brightness',
      value: 1,
    });
    expect(catalog.inferDeterministicVoiceAction('Éteins le plafonnier 2 du salon')).toMatchObject({
      deviceId: 'hue-living-ceiling-2',
      action: 'turn_off',
    });
    expect(catalog.inferDeterministicVoiceScene('Éteins tous les plafonniers')?.steps).toHaveLength(4);
    expect(catalog.inferDeterministicVoiceScene('Éteins tous les spots')?.steps).toHaveLength(2);
    expect(catalog.inferDeterministicVoiceScene('Éteins toutes les lumières')?.steps).toHaveLength(7);
    expect(catalog.inferDeterministicVoiceScene('Allume les plafonniers du salon puis la cuisine')).toBeUndefined();
    expect(catalog.inferDeterministicVoiceAction('Mets le plafonnier de la cuisine à 150 %')).toBeUndefined();
    expect(catalog.inferDeterministicVoiceScene('Allume la lumière')).toBeUndefined();
  });
});
