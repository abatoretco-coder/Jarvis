import type { AuthorizedUser, PermissionKey } from './IdentityRepository';

export type PersonalVoicePermission = Extract<PermissionKey, 'mail' | 'calendar' | 'todo'>;
export type VoiceTodoScope = 'personal' | 'household' | 'ambiguous' | 'none';

export type PendingVoiceIdentityRequest = {
  originalText: string;
  permission: PersonalVoicePermission;
  stage: 'identity' | 'todo_scope';
  createdAtMs: number;
};

function normalizeVoiceText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('fr-FR')
    .replace(/[’']/gu, ' ')
    .replace(/[^a-z0-9\s-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function firstName(displayName: string): string {
  return normalizeVoiceText(displayName).split(' ')[0] ?? '';
}

export function inferVoiceTodoScope(text: string): VoiceTodoScope {
  const normalized = normalizeVoiceText(text);
  const hasTodoIntent = /\b(tache|taches|todo|to do|checklist|liste a faire)\b/u.test(normalized);
  if (!hasTodoIntent) return 'none';
  if (
    /\b(vie quotidienne|maison|foyer|familial|familiale|menage|courses|liste de courses|partage|partagee)\b/u.test(
      normalized
    )
  ) {
    return 'household';
  }
  if (
    /\b(microsoft to do|mon to do|ma todo|mes taches personnelles|tache personnelle|liste personnelle)\b/u.test(
      normalized
    )
  ) {
    return 'personal';
  }
  return 'ambiguous';
}

export function inferPersonalVoicePermission(
  text: string
): PersonalVoicePermission | undefined {
  const normalized = normalizeVoiceText(text);
  if (
    /\b(mail|mails|email|emails|courriel|courriels|gmail|boite mail|boite de reception)\b/u.test(
      normalized
    )
  ) {
    return 'mail';
  }
  if (
    /\b(agenda|calendrier|evenement|evenements|rdv|rendez vous|reunion|meeting)\b/u.test(
      normalized
    )
  ) {
    return 'calendar';
  }
  if (inferVoiceTodoScope(text) === 'personal') return 'todo';
  return undefined;
}

export type VoiceUserResolution =
  | { status: 'matched'; user: AuthorizedUser }
  | { status: 'ambiguous' }
  | { status: 'none' };

export function resolveClaimedVoiceUser(
  text: string,
  users: AuthorizedUser[],
  permission: PersonalVoicePermission
): VoiceUserResolution {
  const normalized = normalizeVoiceText(text);
  const candidates = users.filter(
    (user) =>
      user.status === 'active' &&
      user.permissions.includes(permission) &&
      firstName(user.displayName).length > 0
  );
  const matches = candidates.filter((user) => {
    const name = firstName(user.displayName);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return (
      new RegExp(`^(?:c est |je suis |ici |pour )?${escaped}$`, 'u').test(normalized) ||
      new RegExp(`\\b(?:c est|je suis|ici|pour|au nom de) ${escaped}\\b`, 'u').test(
        normalized
      ) ||
      new RegExp(`\\b${escaped} (?:qui te parle|a l appareil)\\b`, 'u').test(normalized) ||
      new RegExp(`^${escaped}\\b`, 'u').test(normalized)
    );
  });
  if (matches.length === 1) return { status: 'matched', user: matches[0]! };
  if (matches.length > 1) return { status: 'ambiguous' };
  return { status: 'none' };
}

export class PendingVoiceIdentityStore {
  private readonly pending = new Map<string, PendingVoiceIdentityRequest>();

  constructor(
    private readonly ttlMs = 2 * 60_000,
    private readonly maxEntries = 128
  ) {}

  put(
    key: string,
    request: Omit<PendingVoiceIdentityRequest, 'createdAtMs'>,
    now = Date.now()
  ): void {
    for (const [existingKey, existing] of this.pending) {
      if (now - existing.createdAtMs > this.ttlMs) this.pending.delete(existingKey);
    }
    while (this.pending.size >= this.maxEntries) {
      const oldestKey = this.pending.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.pending.delete(oldestKey);
    }
    this.pending.set(key, { ...request, createdAtMs: now });
  }

  get(key: string, now = Date.now()): PendingVoiceIdentityRequest | undefined {
    const request = this.pending.get(key);
    if (!request) return undefined;
    if (now - request.createdAtMs > this.ttlMs) {
      this.pending.delete(key);
      return undefined;
    }
    return request;
  }

  consume(key: string, now = Date.now()): PendingVoiceIdentityRequest | undefined {
    const request = this.get(key, now);
    if (request) this.pending.delete(key);
    return request;
  }
}
