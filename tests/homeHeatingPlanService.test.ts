import { describe, expect, jest, test } from '@jest/globals';

import { type HomeAssistantClient,HomeAssistantRequestError } from '../src/haClient';
import { HomeHeatingPlanService } from '../src/home/HomeHeatingPlanService';

function states() {
  return [
    { entity_id: 'input_boolean.jarvis_heating_schedule_enabled', state: 'on' },
    { entity_id: 'input_number.jarvis_temperature_comfort', state: '20.0' },
    { entity_id: 'input_number.jarvis_temperature_eco', state: '17.0' },
    {
      entity_id: 'sensor.planning_chauffage_jarvis',
      state: 'comfort',
      attributes: {
        weekday_morning_start: '06:30',
        weekday_morning_end: '08:30',
        weekday_evening_start: '18:00',
        weekday_evening_end: '22:30',
        weekend_start: '08:00',
        weekend_end: '22:30',
      },
    },
  ];
}

describe('HomeHeatingPlanService', () => {
  test('exposes the Home Assistant heating helpers as one stable plan', async () => {
    const ha = { getStates: jest.fn(async () => states()) } as unknown as HomeAssistantClient;

    await expect(new HomeHeatingPlanService(ha).get()).resolves.toEqual({
      available: true,
      enabled: true,
      activeMode: 'comfort',
      comfortTemperature: 20,
      ecoTemperature: 17,
      schedule: {
        weekdayMorning: { start: '06:30', end: '08:30' },
        weekdayEvening: { start: '18:00', end: '22:30' },
        weekend: { start: '08:00', end: '22:30' },
      },
    });
  });

  test('writes only requested settings to fixed allowlisted helpers', async () => {
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));
    const getStates = jest.fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce(states())
      .mockResolvedValueOnce(states().map((state) => {
        if (state.entity_id === 'input_boolean.jarvis_heating_schedule_enabled') return { ...state, state: 'off' };
        if (state.entity_id === 'input_number.jarvis_temperature_eco') return { ...state, state: '16.5' };
        return state;
      }));
    const ha = {
      getStates,
      callService,
    } as unknown as HomeAssistantClient;
    const service = new HomeHeatingPlanService(ha);

    await service.update({ enabled: false, ecoTemperature: 16.5 });

    expect(callService).toHaveBeenNthCalledWith(1, {
      domain: 'input_number',
      service: 'set_value',
      target: { entity_id: 'input_number.jarvis_temperature_eco' },
      serviceData: { value: 16.5 },
    });
    expect(callService).toHaveBeenNthCalledWith(2, {
      domain: 'input_boolean',
      service: 'turn_off',
      target: { entity_id: 'input_boolean.jarvis_heating_schedule_enabled' },
    });
  });

  test('does not report success when Home Assistant accepts but does not expose the target state', async () => {
    const callService = jest.fn<HomeAssistantClient['callService']>(async () => ({ status: 200, data: [] }));
    const service = new HomeHeatingPlanService({
      getStates: jest.fn(async () => states()),
      callService,
    } as unknown as HomeAssistantClient, async () => undefined);

    await expect(service.update({ comfortTemperature: 20.5 })).rejects.toMatchObject({
      outcome: 'uncertain',
      appliedFields: ['comfortTemperature'],
    });
    expect(callService).toHaveBeenCalledTimes(1);
  });

  test('rejects an incoherent target without mutating Home Assistant', async () => {
    const callService = jest.fn();
    const service = new HomeHeatingPlanService({
      getStates: jest.fn(async () => states()),
      callService,
    } as unknown as HomeAssistantClient);

    await expect(service.update({ ecoTemperature: 20 })).rejects.toMatchObject({
      outcome: 'failed',
      appliedFields: [],
    });
    expect(callService).not.toHaveBeenCalled();
  });

  test('reports a partial update when a later mutation is rejected', async () => {
    const callService = jest.fn<HomeAssistantClient['callService']>()
      .mockResolvedValueOnce({ status: 200, data: [] })
      .mockRejectedValueOnce(new HomeAssistantRequestError('rejected', 'rejected', false));
    const service = new HomeHeatingPlanService({
      getStates: jest.fn(async () => states()),
      callService,
    } as unknown as HomeAssistantClient);

    await expect(service.update({ comfortTemperature: 20.5, enabled: false }))
      .rejects.toMatchObject({
        outcome: 'partial',
        appliedFields: ['comfortTemperature'],
      });
    expect(callService).toHaveBeenCalledTimes(2);
  });

  test('reports an uncertain update and never retries after a transport timeout', async () => {
    const callService = jest.fn(async () => {
      throw new HomeAssistantRequestError('timeout', 'transport', true);
    });
    const service = new HomeHeatingPlanService({
      getStates: jest.fn(async () => states()),
      callService,
    } as unknown as HomeAssistantClient);

    await expect(service.update({ enabled: false })).rejects.toMatchObject({
      outcome: 'uncertain',
      appliedFields: [],
    });
    expect(callService).toHaveBeenCalledTimes(1);
  });

  test('degrades explicitly when helpers or schedule metadata are missing', async () => {
    const ha = {
      getStates: jest.fn(async () => [
        { entity_id: 'input_number.jarvis_temperature_comfort', state: 'unknown' },
      ]),
    } as unknown as HomeAssistantClient;

    await expect(new HomeHeatingPlanService(ha).get()).resolves.toMatchObject({
      available: false,
      activeMode: 'unknown',
      comfortTemperature: null,
      ecoTemperature: null,
      schedule: null,
    });
  });
});
