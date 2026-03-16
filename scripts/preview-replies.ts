import { buildReply } from '../src/replyBuilder';
import type { ExecutedAction, JarvisAction } from '../src/types';

function printCase(name: string, input: Parameters<typeof buildReply>): void {
  const reply = buildReply(...input);
  // eslint-disable-next-line no-console
  console.log(`\n== ${name} ==`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(reply, null, 2));
}

const jarvisBase: { skill: string; intent: string; result: unknown; actions: JarvisAction[] } = {
  skill: 'test',
  intent: 'test',
  result: { message: 'ok' },
  actions: [],
};

printCase('Executed single action', [
  { ...jarvisBase, actions: [{ type: 'notify.send', message: 'hello' }] },
  [{ action: { type: 'notify.send', message: 'hello' }, status: 'executed' }],
  [],
  'envoie une notif',
]);

printCase('Rights denied', [
  { ...jarvisBase, actions: [{ type: 'home_assistant.service_call', domain: 'light', service: 'turn_on' }] },
  [{ action: { type: 'home_assistant.service_call', domain: 'light', service: 'turn_on' }, status: 'skipped' }],
  [{ type: 'rights.denied', reason: 'service_not_allowed', action: { type: 'home_assistant.service_call', domain: 'light', service: 'turn_on' } }],
  'allume la cuisine',
]);

printCase('HA not configured', [
  { ...jarvisBase, actions: [{ type: 'weather.query', when: 'now' }] },
  [{ action: { type: 'weather.query', when: 'now' }, status: 'skipped', error: 'ha_not_configured' }],
  [{ type: 'action.skipped', reason: 'ha_not_configured', action: { type: 'weather.query', when: 'now' } }],
  'météo',
]);

printCase('Unsupported action', [
  { ...jarvisBase, actions: [{ type: 'spotify.webapi.play' }] },
  [{ action: { type: 'spotify.webapi.play' }, status: 'skipped', error: 'unsupported_action' }],
  [{ type: 'action.skipped', reason: 'unsupported_action', action: { type: 'spotify.webapi.play' } }],
  'reprends la musique',
]);

printCase('Multi-actions mixed result', [
  {
    ...jarvisBase,
    actions: [
      { type: 'calendar.get_events', startDateTime: new Date().toISOString(), endDateTime: new Date().toISOString() },
    ],
  },
  [
    {
      action: { type: 'calendar.get_events', startDateTime: new Date().toISOString(), endDateTime: new Date().toISOString() },
      status: 'failed',
      error: 'calendar_failed',
    } satisfies ExecutedAction,
  ],
  [
    {
      type: 'action.failed',
      reason: 'calendar_failed',
      error: 'boom',
      action: { type: 'calendar.get_events', startDateTime: new Date().toISOString(), endDateTime: new Date().toISOString() },
    },
  ],
  'ajoute du pain et montre mon agenda',
]);

// Keep node exit code 0; this is a preview tool.
