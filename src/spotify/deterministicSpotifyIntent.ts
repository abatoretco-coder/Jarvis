function normalizeForMatch(input: string): string {
  return String(input ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function hasGenericMusicResumeIntent(text: string): boolean {
  const source = normalizeForMatch(text);
  if (!source) return false;
  const deviceSuffix = '( sur( le| la| mon| ma)? (pc|ordi|ordinateur|computer|jarvis|vm400|tel|telephone|mobile|phone|salon|enceinte|living room|livingroom))?';

  const exact = new Set([
    'reprends',
    'relance',
    'demarre',
    'start',
    'play',
    'mets la musique',
    'met la musique',
    'joue de la musique',
    'lance de la musique',
    'lance spotify',
    'mets spotify',
    'met spotify',
    'reprends spotify',
    'relance spotify',
  ]);
  if (exact.has(source)) return true;

  return new RegExp(`^((re)?lance|reprends|demarre|start|play)( la)?( musique| spotify)?${deviceSuffix}$`).test(source)
    || new RegExp(`^(mets|met|joue|lance)( de)? la musique( sur spotify)?${deviceSuffix}$`).test(source);
}

export function evaluateGenericResumeGate(input: {
  text?: string;
  query?: string;
}): {
  enabled: boolean;
  offReason?: 'query_present' | 'non_generic_command';
} {
  const normalizedQuery = normalizeForMatch(input.query ?? '');
  if (normalizedQuery) {
    return { enabled: false, offReason: 'query_present' };
  }

  if (!hasGenericMusicResumeIntent(input.text ?? '')) {
    return { enabled: false, offReason: 'non_generic_command' };
  }

  return { enabled: true };
}

export function evaluateSearchAndPlayDeterministicGate(input: {
  action: string;
  slots: Record<string, unknown>;
  userText: string;
  requestText?: string;
}): {
  enabled: boolean;
  offReason?: 'action_not_search_and_play' | 'target_present' | 'non_generic_command';
  hasTarget: boolean;
} {
  if (input.action !== 'search_and_play') {
    return { enabled: false, offReason: 'action_not_search_and_play', hasTarget: false };
  }

  const hasTarget = Boolean(
    typeof input.slots.query === 'string' && input.slots.query.trim().length > 0
    || typeof input.slots.text === 'string' && input.slots.text.trim().length > 0
    || typeof input.slots.uri === 'string' && input.slots.uri.trim().length > 0
    || typeof input.slots.track_uri === 'string' && input.slots.track_uri.trim().length > 0
    || typeof input.slots.context_uri === 'string' && input.slots.context_uri.trim().length > 0
  );
  if (hasTarget) {
    return { enabled: false, offReason: 'target_present', hasTarget: true };
  }

  const combinedText = `${input.userText} ${input.requestText ?? ''}`.trim();
  if (!hasGenericMusicResumeIntent(combinedText)) {
    return { enabled: false, offReason: 'non_generic_command', hasTarget: false };
  }

  return { enabled: true, hasTarget: false };
}