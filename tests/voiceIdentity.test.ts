import { describe, expect, test } from '@jest/globals';

import type { AuthorizedUser } from '../src/identity/IdentityRepository';
import {
  inferPersonalVoicePermission,
  inferVoiceTodoScope,
  PendingVoiceIdentityStore,
  resolveClaimedVoiceUser,
} from '../src/identity/voiceIdentity';

const users: AuthorizedUser[] = [
  {
    userId: 'loic', email: 'loic@example.test', displayName: 'Loïc Bourguignon', status: 'active',
    roles: ['owner'], permissions: ['mail', 'calendar', 'todo'],
  },
  {
    userId: 'chloe', email: 'chloe@example.test', displayName: 'Chloé Guichard', status: 'active',
    roles: ['resident'], permissions: ['mail', 'calendar', 'todo'],
  },
];

describe('voice identity selection', () => {
  test('recognizes an explicit speaker declaration and a short clarification answer', () => {
    expect(resolveClaimedVoiceUser("C'est Loïc qui te parle, donne-moi mon agenda", users, 'calendar'))
      .toMatchObject({ status: 'matched', user: { userId: 'loic' } });
    expect(resolveClaimedVoiceUser('Chloé', users, 'mail'))
      .toMatchObject({ status: 'matched', user: { userId: 'chloe' } });
  });

  test('does not infer identity from a person merely mentioned later in the request', () => {
    expect(resolveClaimedVoiceUser('Quels rendez-vous ai-je avec Chloé ?', users, 'calendar'))
      .toEqual({ status: 'none' });
  });

  test('separates personal Microsoft To Do from household daily-life tasks', () => {
    expect(inferVoiceTodoScope('Ajoute ceci à mes tâches personnelles')).toBe('personal');
    expect(inferVoiceTodoScope('Ajoute le ménage aux tâches de la maison')).toBe('household');
    expect(inferVoiceTodoScope('Ajoute une tâche pour demain')).toBe('ambiguous');
    expect(inferPersonalVoicePermission('Montre ma Microsoft To Do')).toBe('todo');
    expect(inferPersonalVoicePermission('Montre les tâches de la maison')).toBeUndefined();
  });

  test('keeps the original request until identity is supplied and expires it', () => {
    const store = new PendingVoiceIdentityStore(1_000);
    store.put('salon', { originalText: 'Quel est mon prochain événement ?', permission: 'calendar', stage: 'identity' }, 10);
    expect(store.get('salon', 500)?.originalText).toContain('prochain événement');
    expect(store.consume('salon', 500)?.permission).toBe('calendar');
    expect(store.get('salon', 500)).toBeUndefined();
    store.put('salon', { originalText: 'Lis mes mails', permission: 'mail', stage: 'identity' }, 10);
    expect(store.get('salon', 1_011)).toBeUndefined();
  });
});
