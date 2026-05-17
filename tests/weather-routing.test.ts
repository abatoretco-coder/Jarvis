/**
 * Weather routing & deterministic response tests
 * 
 * Covers:
 * 1. Deterministic weather path (current temp, humidity, condition, precipitation)
 * 2. Weather local vs external separation (weather agent vs search.news)
 * 3. Snapshot generation and edge cases
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  isClearlyExternalWeather,
  isClearlyLocalWeather,
  isDeterministicWeatherQuestion,
  isGeneralWeatherQuestion,
  isHumidityQuestion,
  isPrecipitationQuestion,
  isTemperatureQuestion,
  synthesizeDeterministicWeatherReply,
} from '../src/weather/deterministicWeatherReply';
import { buildWeatherSnapshotFromStates, type HaStateLike, type WeatherSnapshot } from '../src/weather/weatherSnapshot';

// Helper to create mock states
function createWeatherState(overrides?: Record<string, unknown>): HaStateLike {
  return {
    entity_id: 'weather.maison',
    state: 'partiel-nuageux',
    attributes: {
      friendly_name: 'Maison',
      temperature: 18.5,
      apparent_temperature: 17.2,
      humidity: 65,
      wind_speed: 12,
      wind_bearing: 230,
      precipitation_probability: 10,
      condition: 'partiel-nuageux',
      forecast: [
        { datetime: '2025-05-17T00:00:00', condition: 'partiel-nuageux', temperature: 20, templow: 15 },
        { datetime: '2025-05-18T00:00:00', condition: 'pluie', temperature: 18, templow: 14, precipitation: 70 },
      ],
      ...overrides,
    },
  };
}

function createSensorState(entityId: string, value: number, friendly?: string): HaStateLike {
  return {
    entity_id: entityId,
    state: String(value),
    attributes: {
      ...(friendly ? { friendly_name: friendly } : {}),
      unit_of_measurement: entityId.includes('temperature') ? '°C' : '%',
    },
  };
}

describe('Weather Routing & Deterministic Responses', () => {
  describe('Deterministic path detection', () => {
    it('should detect temperature questions and generate deterministic response', () => {
      const testCases = [
        'Quelle température fait-il ?',
        'Il fait combien chez moi ?',
        'Quelle est la température ?',
        "C'est combien degrés ?",
        'Combien il fait dehors ?',
      ];

      for (const userText of testCases) {
        expect(isTemperatureQuestion(userText)).toBe(true);
      }
    });

    it('should detect humidity questions', () => {
      const testCases = [
        'Quelle est l\'humidité ?',
        'Quel est le taux d\'humidité ?',
        'L\'humidité c\'est combien ?',
        'Hygrométrie ?',
      ];

      for (const userText of testCases) {
        expect(isHumidityQuestion(userText)).toBe(true);
      }
    });

    it('should detect precipitation questions', () => {
      const testCases = [
        'Il pleut dehors ?',
        'Est-ce qu\'il pleut ?',
        'Il va pleuvoir ?',
        'Pluie ?',
        'C\'est mouillé dehors ?',
      ];

      for (const userText of testCases) {
        expect(isPrecipitationQuestion(userText)).toBe(true);
      }
    });

    it('should detect general weather questions', () => {
      const testCases = [
        'Quel temps fait-il à la maison ?',
        'Quel est l\'état météo ?',
        'Comment est la météo ?',
        'Qu\'est-ce qu\'il fait dehors ?',
      ];

      for (const userText of testCases) {
        expect(isGeneralWeatherQuestion(userText)).toBe(true);
      }
    });

    it('should NOT detect non-weather questions as deterministic', () => {
      const testCases = [
        'Prévisions pour la semaine',
        'Il va faire beau demain ?',
        'Météo à Paris demain',
        'Comment je m\'habille demain ?',
        'Quel temps fera-t-il jeudi ?',
      ];

      for (const userText of testCases) {
        expect(isDeterministicWeatherQuestion(userText)).toBe(false);
      }
    });
  });

  describe('Weather local vs external separation', () => {
    it('should route local home weather to weather agent', () => {
      const localQuestions = [
        'Température chez moi',
        'Météo à la maison',
        'Il fait combien actuellement',
        'État météo local',
        'Quelle est l\'humidité du salon',
      ];

      // These should NOT mention other cities/locations
      for (const q of localQuestions) {
        expect(isClearlyLocalWeather(q)).toBe(true);
      }
    });

    it('should route external weather to search.news', () => {
      const externalQuestions = [
        'Quel temps à Paris demain',
        'Météo à Lyon',
        'Il pleut à Marseille',
        'Température à Londres',
        'Comment sera la météo à Tokyo',
        'Météo externe',
        'Prévisions pour Florence',
      ];

      for (const q of externalQuestions) {
        expect(isClearlyExternalWeather(q)).toBe(true);
      }
    });

    it('should NOT misroute forecast queries to deterministic path', () => {
      const forecastQueries = [
        'Prévisions',
        'Météo demain',
        'Il fera beau jeudi',
        'Quand il fera beau',
        'Prévisions pour la semaine',
      ];

      for (const q of forecastQueries) {
        expect(isDeterministicWeatherQuestion(q)).toBe(false);
      }
    });
  });

  describe('Weather snapshot building', () => {
    it('should build snapshot from weather entity', () => {
      const state = createWeatherState();
      const snapshot = buildWeatherSnapshotFromStates([state]);

      expect(snapshot).toBeDefined();
      expect(snapshot?.current?.temperature).toBe(18.5);
      expect(snapshot?.current?.humidity).toBe(65);
      expect(snapshot?.current?.condition).toBe('partiel-nuageux');
      expect(snapshot?.location).toBe('Maison');
    });

    it('should build snapshot from individual sensors', () => {
      const sensors = [
        createSensorState('sensor.maison_temperature', 19, 'Température'),
        createSensorState('sensor.maison_humidity', 68, 'Humidité'),
      ];

      const snapshot = buildWeatherSnapshotFromStates(sensors);
      expect(snapshot).toBeDefined();
      expect(snapshot?.sensors).toHaveLength(2);
    });

    it('should handle missing weather entity gracefully', () => {
      const sensors = [
        createSensorState('sensor.other_value', 42),
      ];

      const snapshot = buildWeatherSnapshotFromStates(sensors);
      // Should return null if no weather.maison and no weather sensors
      expect(snapshot).toBeNull();
    });

    it('should prioritize weather.maison over other weather entities', () => {
      const states = [
        { ...createWeatherState(), entity_id: 'weather.other' },
        { ...createWeatherState(), entity_id: 'weather.maison' },
      ];

      const snapshot = buildWeatherSnapshotFromStates(states);
      expect(snapshot?.current?.entityId).toBe('weather.maison');
    });

    it('should include forecast in snapshot', () => {
      const state = createWeatherState();
      const snapshot = buildWeatherSnapshotFromStates([state]);

      expect(snapshot?.forecast).toBeDefined();
      expect(snapshot?.forecast?.length).toBeGreaterThan(0);
      expect(snapshot?.forecast?.[0]?.condition).toBeDefined();
    });
  });

  describe('Deterministic response generation', () => {
    it('should generate temperature response with rounded value', () => {
      const snapshot = mockSnapshot({ temperature: 18.5 });
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Quelle température ?',
        weather: snapshot,
      });

      expect(response).toMatch(/Il fait actuellement \d+°C/);
      expect(response).toContain('19°C'); // 18.5 rounds to 19
    });

    it('should generate humidity response with percentage', () => {
      const snapshot = mockSnapshot({ humidity: 65 });
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Quelle est l\'humidité ?',
        weather: snapshot,
      });

      expect(response).toMatch(/L'humidité est actuellement de \d+%/);
      expect(response).toContain('65%');
    });

    it('should generate precipitation response with probability', () => {
      const snapshot = mockSnapshot({ precipitation: 35 });
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Il pleut ?',
        weather: snapshot,
      });

      expect(response).toMatch(/\d+% de chance de pluie/);
      expect(response).toContain('35%');
    });

    it('should handle rainy condition in precipitation response', () => {
      const snapshot = mockSnapshot({ 
        condition: 'pluie',
        precipitation: undefined,
      });
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Il pleut ?',
        weather: snapshot,
      });

      expect(response).toContain('Il pleut actuellement');
    });

    it('should handle clear/sunny condition in precipitation response', () => {
      const snapshot = mockSnapshot({ 
        condition: 'ensoleillé',
        precipitation: undefined,
      });
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Il pleut ?',
        weather: snapshot,
      });

      expect(response).toContain('Il ne pleut pas actuellement');
    });

    it('should generate general weather response with condition and temp', () => {
      const snapshot = mockSnapshot({
        condition: 'partiel-nuageux',
        temperature: 20,
      });
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Quel temps fait-il ?',
        weather: snapshot,
      });

      expect(response).toMatch(/À \w+ il est partiel-nuageux \(\d+°C\)/);
    });

    it('should return null for non-deterministic questions', () => {
      const snapshot = mockSnapshot({ temperature: 18 });
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Prévisions pour la semaine',
        weather: snapshot,
      });

      expect(response).toBeNull();
    });

    it('should return null if required data is missing', () => {
      const snapshot = mockSnapshot();
      snapshot.current!.temperature = undefined;

      const response = synthesizeDeterministicWeatherReply({
        userText: 'Quelle température ?',
        weather: snapshot,
      });

      expect(response).toBeNull();
    });
  });

  describe('Edge cases & fallbacks', () => {
    it('should fall back to general condition if temperature unavailable', () => {
      const snapshot = mockSnapshot({ temperature: undefined, condition: 'dégagé' });
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Quel temps ?',
        weather: snapshot,
      });

      expect(response).toContain('dégagé');
    });

    it('should handle missing location gracefully', () => {
      const snapshot = mockSnapshot();
      snapshot.location = '';
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Quel temps ?',
        weather: snapshot,
      });

      // Should still generate response, possibly with generic location
      expect(response).toBeDefined();
    });

    it('should not attempt deterministic response if snapshot is empty', () => {
      const emptySnapshot: WeatherSnapshot = {
        location: 'Unknown',
        sensors: [],
        forecast: [],
      };

      const response = synthesizeDeterministicWeatherReply({
        userText: 'Quelle température ?',
        weather: emptySnapshot,
      });

      expect(response).toBeNull();
    });

    it('should handle temperatures below 0 correctly', () => {
      const snapshot = mockSnapshot({ temperature: -5.3 });
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Quelle température ?',
        weather: snapshot,
      });

      expect(response).toContain('-5°C');
    });

    it('should handle very high temperatures', () => {
      const snapshot = mockSnapshot({ temperature: 45.8 });
      const response = synthesizeDeterministicWeatherReply({
        userText: 'Il fait combien ?',
        weather: snapshot,
      });

      expect(response).toContain('46°C');
    });
  });
});

function mockSnapshot(overrides?: Partial<WeatherSnapshot['current']>): WeatherSnapshot {
  return {
    location: 'Maison',
    current: {
      entityId: 'weather.maison',
      condition: 'partiel-nuageux',
      temperature: 18.5,
      humidity: 65,
      precipitation: 10,
      ...overrides,
    },
    sensors: [],
    forecast: [],
  };
}
