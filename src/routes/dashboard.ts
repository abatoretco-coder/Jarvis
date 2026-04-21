import type { FastifyInstance } from 'fastify';

import { buildMailAccounts, callMailAgent } from '../mail/mailAgent';
import type { AppDeps } from '../server';
import { callTodoAgent } from '../todo/todoAgent';

type HaState = {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
};

type DashboardSection = {
  title: string;
  summary: string;
  lines: string[];
  source: string;
  status: 'ok' | 'empty' | 'error';
};

const LOCAL_LINKS = [
  {
    label: 'assistant',
    title: 'Assistant',
    description: 'Revenir a la conversation Jarvis.',
    kind: 'tab',
    value: 'chat',
  },
  {
    label: 'home-assistant',
    title: 'Home Assistant',
    description: 'Pilotage et etats de la maison.',
    kind: 'url',
    value: 'http://192.168.1.38:8123',
  },
  {
    label: 'threads',
    title: 'Historique',
    description: 'Voir les fils et syntheses recentes.',
    kind: 'tab',
    value: 'threads',
  },
  {
    label: 'settings',
    title: 'Parametres',
    description: 'Reglages desktop et audio.',
    kind: 'tab',
    value: 'settings',
  },
] as const;

function mapWeatherConditionToWmo(condition: string): number {
  switch (condition.trim().toLowerCase()) {
    case 'sunny':
    case 'clear':
    case 'clear-night':
      return 0;
    case 'partlycloudy':
    case 'partly-cloudy':
      return 2;
    case 'cloudy':
    case 'overcast':
      return 3;
    case 'fog':
      return 45;
    case 'hail':
      return 82;
    case 'lightning':
    case 'lightning-rainy':
      return 95;
    case 'pouring':
      return 82;
    case 'rainy':
      return 61;
    case 'snowy':
      return 71;
    case 'snowy-rainy':
      return 85;
    case 'windy':
    case 'windy-variant':
      return 48;
    default:
      return 3;
  }
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function splitSummary(summary: string): string[] {
  const normalized = summary
    .replace(/\s+/g, ' ')
    .replace(/\s+\|\s+/g, '|')
    .trim();

  if (!normalized) return [];

  const rawParts = normalized.includes('|')
    ? normalized.split('|')
    : normalized.split(/(?<=[.!?])\s+/);

  return rawParts
    .map((part) => part.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

function classifySummary(summary: string): DashboardSection['status'] {
  const lower = summary.toLowerCase();
  if (!summary.trim()) return 'empty';
  if (lower.includes('non disponible') || lower.includes('impossible') || lower.includes('manquants')) return 'error';
  if (lower.includes('aucun') || lower.includes('pas de')) return 'empty';
  return 'ok';
}

function makeSection(title: string, source: string, summary: string): DashboardSection {
  return {
    title,
    source,
    summary,
    lines: splitSummary(summary),
    status: classifySummary(summary),
  };
}

function formatDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildAgendaSection(states: HaState[]): DashboardSection {
  const calendars = states
    .filter((state) => state.entity_id.startsWith('calendar.'))
    .map((state) => {
      const attributes = state.attributes ?? {};
      return {
        title: String(attributes.friendly_name ?? state.entity_id.replace(/^calendar\./, '')),
        message: String(attributes.message ?? state.state ?? '').trim(),
        start: formatDateTime(attributes.start_time),
      };
    })
    .filter((item) => item.message || item.start)
    .slice(0, 5);

  if (calendars.length === 0) {
    return makeSection('Agenda', 'home-assistant', 'Aucun evenement d agenda disponible via Home Assistant.');
  }

  const lines = calendars.map((item) => [item.title, item.start, item.message].filter(Boolean).join(' — '));
  return {
    title: 'Agenda',
    source: 'home-assistant',
    summary: `${calendars.length} evenement${calendars.length > 1 ? 's' : ''} reperes dans Home Assistant.`,
    lines,
    status: 'ok',
  };
}

function buildWeatherPayload(states: HaState[]): Record<string, unknown> | null {
  const weatherEntity = states.find((state) => state.entity_id.startsWith('weather.'));
  if (!weatherEntity) return null;

  const attributes = weatherEntity.attributes ?? {};
  const forecast = Array.isArray(attributes.forecast) ? attributes.forecast as Array<Record<string, unknown>> : [];
  const conditionCode = mapWeatherConditionToWmo(String(weatherEntity.state ?? attributes.condition ?? 'cloudy'));
  const location = String(attributes.friendly_name ?? weatherEntity.entity_id.replace(/^weather\./, ''));
  const temperature = asNumber(attributes.temperature);
  const humidity = asNumber(attributes.humidity);
  const windSpeed = asNumber(attributes.wind_speed);
  const windBearing = asNumber(attributes.wind_bearing);
  const daily = (forecast.length > 0 ? forecast.slice(0, 7) : [{ temperature, templow: temperature, precipitation: 0, wind_speed: windSpeed, condition: weatherEntity.state }])
    .map((item, index) => ({
      date: typeof item.datetime === 'string' ? item.datetime : new Date(Date.now() + index * 86_400_000).toISOString(),
      code: mapWeatherConditionToWmo(String(item.condition ?? weatherEntity.state ?? 'cloudy')),
      max: asNumber(item.temperature, temperature),
      min: asNumber(item.templow, temperature),
      precipSum: asNumber(item.precipitation, 0),
      windMax: asNumber(item.wind_speed, windSpeed),
    }));

  return {
    location,
    temp: temperature,
    feelsLike: temperature,
    tempMax: daily[0]?.max ?? temperature,
    tempMin: daily[0]?.min ?? temperature,
    conditionCode,
    humidity,
    windSpeed,
    windDir: windBearing,
    precipitation: daily[0]?.precipSum ?? 0,
    daily,
    hourly: [],
  };
}

export function registerDashboardRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/dashboard', async (_req, reply) => {
    const haStatesPromise = deps.ha
      ? deps.ha.getStates()
        .then((data) => Array.isArray(data) ? data as HaState[] : [])
        .catch((error) => {
          app.log.warn({ error }, 'dashboard_ha_states_failed');
          return [] as HaState[];
        })
      : Promise.resolve([] as HaState[]);

    const mailPromise = callMailAgent(
      'Liste mes 5 emails recents au format tres bref, un item par ligne avec expediteur et sujet.',
      {
        mailAccounts: buildMailAccounts(deps.env),
        OPENAI_API_KEY: deps.env.OPENAI_API_KEY,
        OPENAI_BASE_URL: deps.env.OPENAI_BASE_URL,
        OPENAI_TIMEOUT_MS: deps.env.OPENAI_TIMEOUT_MS,
      },
      app.log,
    ).catch((error) => {
      app.log.warn({ error }, 'dashboard_mail_failed');
      return 'Impossible de recuperer les emails pour le moment.';
    });

    const todoPromise = callTodoAgent(
      'Liste mes 5 taches actives au format tres bref, un item par ligne.',
      {
        MICROSOFT_CLIENT_ID: deps.env.MICROSOFT_CLIENT_ID,
        MICROSOFT_CLIENT_SECRET: deps.env.MICROSOFT_CLIENT_SECRET,
        MICROSOFT_REFRESH_TOKEN: deps.env.MICROSOFT_REFRESH_TOKEN,
        MICROSOFT_TENANT_ID: deps.env.MICROSOFT_TENANT_ID,
        OPENAI_API_KEY: deps.env.OPENAI_API_KEY,
        OPENAI_BASE_URL: deps.env.OPENAI_BASE_URL,
        OPENAI_TIMEOUT_MS: deps.env.OPENAI_TIMEOUT_MS,
      },
      app.log,
    ).catch((error) => {
      app.log.warn({ error }, 'dashboard_todo_failed');
      return 'Impossible de recuperer les taches pour le moment.';
    });

    const [haStates, mailSummary, todoSummary] = await Promise.all([haStatesPromise, mailPromise, todoPromise]);
    const weather = buildWeatherPayload(haStates);
    const agenda = buildAgendaSection(haStates);

    return reply.code(200).send({
      status: 'ok',
      generatedAt: new Date().toISOString(),
      weather,
      organization: {
        mail: makeSection('Mail', 'jarvis-mail', mailSummary),
        tasks: makeSection('Taches', 'jarvis-todo', todoSummary),
        agenda,
        links: LOCAL_LINKS,
      },
    });
  });
}