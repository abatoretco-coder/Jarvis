import type { PermissionKey } from '../identity/IdentityRepository';

export type IntegrationProviderKey =
  | 'google-calendar'
  | 'gmail'
  | 'microsoft-todo'
  | 'spotify';

export type IntegrationProvider = {
  key: IntegrationProviderKey;
  label: string;
  permission: PermissionKey;
  oauthFamily: 'google' | 'microsoft' | 'spotify';
  scopes: readonly string[];
  aiDisclosure?: string;
};

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
  {
    key: 'google-calendar',
    label: 'Google Calendar',
    permission: 'calendar',
    oauthFamily: 'google',
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar',
    ],
    aiDisclosure:
      'Les titres et horaires strictement utiles peuvent être transmis au fournisseur IA pour répondre à une demande conversationnelle.',
  },
  {
    key: 'gmail',
    label: 'Gmail',
    permission: 'mail',
    oauthFamily: 'google',
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
    ],
    aiDisclosure:
      'Seuls les extraits nécessaires à la demande peuvent être transmis au fournisseur IA.',
  },
  {
    key: 'microsoft-todo',
    label: 'Microsoft To Do',
    permission: 'todo',
    oauthFamily: 'microsoft',
    scopes: ['offline_access', 'User.Read', 'Tasks.ReadWrite'],
  },
  {
    key: 'spotify',
    label: 'Spotify',
    permission: 'music',
    oauthFamily: 'spotify',
    scopes: [
      'user-read-private',
      'user-read-email',
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-recently-played',
      'user-library-read',
      'user-library-modify',
      'playlist-read-private',
      'playlist-read-collaborative',
      'playlist-modify-private',
      'playlist-modify-public',
    ],
  },
] as const;

export function findIntegrationProvider(value: string): IntegrationProvider | undefined {
  return INTEGRATION_PROVIDERS.find((provider) => provider.key === value);
}
