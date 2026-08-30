export type VoiceResponseMode = 'short' | 'normal' | 'detailed';

export type VoiceResponseDomain = 'mail' | 'todo' | 'calendar' | 'search' | 'executor' | 'weather' | 'spotify' | 'culture' | 'general';

export type VoiceThreadState = {
  lastMailCount?: number;
  lastMailTop?: string[];
  lastMailRaw?: string;
};

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const m = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
  return m ? m[1] : trimmed;
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripWebSourceLabel(text: string): string {
  return text
    .replace(/(?:^|\s)source\s*:\s*(?:synth[eè]se\s+)?web\.?/giu, ' ')
    .replace(/(?:^|\s)(?:sources?|r[eÃ©]f[eÃ©]rences?)\s*:\s*(?:https?:\/\/\S+|www\.\S+)(?:\s*,?\s*(?:https?:\/\/\S+|www\.\S+))*\.?/giu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripOralNoise(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const codepoint = char.codePointAt(0) ?? 0;
      const isEmoji = (codepoint >= 0x1F000 && codepoint <= 0x1FAFF)
        || (codepoint >= 0x2300 && codepoint <= 0x27BF);
      return codepoint !== 0xFE0F && !isEmoji;
    })
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function sanitizeResponseAttribution(text: string, domain: VoiceResponseDomain): string {
  void domain;
  return stripOralNoise(stripWebSourceLabel(text));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function capSentences(text: string, maxSentences: number): string {
  const list = splitSentences(text);
  if (list.length <= maxSentences) return compact(text);
  return compact(list.slice(0, maxSentences).join(' '));
}

function normalizeTutoiement(text: string): string {
  return text
    .replace(/\b[Pp]ouvez-vous\b/g, 'Tu peux')
    .replace(/\b[Vv]oulez-vous\b/g, 'Tu veux')
    .replace(/\b[Ss]ouhaitez-vous\b/g, 'Tu veux')
    .replace(/\b[Dd]ites-moi\b/g, 'Dis-moi')
    .replace(/\b[Vv]ous pouvez\b/g, 'Tu peux')
    .replace(/\b[Vv]ous voulez\b/g, 'Tu veux')
    .replace(/\b[Vv]ous souhaitez\b/g, 'Tu veux')
    .replace(/\b[Vv]ous avez\b/g, 'Tu as')
    .replace(/\b[Vv]ous etes\b/g, 'Tu es')
    .replace(/\b[Vv]ous êtes\b/g, 'Tu es')
    .replace(/\b[Jj]e peux vous aider\b/g, "Je peux t'aider")
    .replace(/\b[Jj]e peux vous\b/g, 'Je peux te')
    .replace(/\bsi Tu veux\b/g, 'si tu veux')
    .replace(/\b[Pp]our vous\b/g, 'Pour toi')
    .replace(/\b[Aa]vec vous\b/g, 'Avec toi')
    .replace(/\b[Cc]hez vous\b/g, 'Chez toi');
}

export function isVoiceRequest(input: { voiceTurnId?: string; clientChannel?: string | null }): boolean {
  if (input.voiceTurnId && input.voiceTurnId.trim().length > 0) return true;
  const channel = (input.clientChannel ?? '').toLowerCase();
  return channel === 'voice' || channel.includes('voice-hub');
}

export function isLikelyTruncatedVoiceUtterance(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || /(?:\.\.\.|…)$/.test(trimmed);
}

export function resolveVoiceResponseMode(input: {
  text: string;
  clientContext?: Record<string, unknown>;
}): VoiceResponseMode {
  const forced = typeof input.clientContext?.['voice_mode'] === 'string'
    ? String(input.clientContext['voice_mode']).toLowerCase().trim()
    : typeof input.clientContext?.['voiceMode'] === 'string'
      ? String(input.clientContext['voiceMode']).toLowerCase().trim()
      : '';
  const t = input.text.toLowerCase();
  if (/(detaille|détaille|en detail|en détail|approfondis)/.test(t)) return 'detailed';
  if (/(resume vite|résume vite|en bref|rapidement|court)/.test(t)) return 'short';
  if (forced === 'short' || forced === 'normal' || forced === 'detailed') return forced;
  return 'normal';
}

export function isLastMailSummaryRequest(text: string): boolean {
  const t = text.toLowerCase();
  return /(resum|résum).*(dernier|mail|email|continue|suite)|dernier.*mail|dernier.*email|(continue|suite).*(resum|résum)/.test(t);
}

export function extractMailStateFromReply(text: string): VoiceThreadState | null {
  const compactText = compact(text);
  const countMatch = compactText.match(/Tu as\s+(\d+)\s+email/i);
  const count = countMatch ? Number.parseInt(countMatch[1] ?? '0', 10) : undefined;

  const idx = compactText.indexOf(':');
  const itemsPart = idx >= 0 ? compactText.slice(idx + 1).trim() : '';
  const top = itemsPart
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);

  if (!count && top.length === 0) return null;
  return {
    lastMailCount: count,
    lastMailTop: top,
    lastMailRaw: compactText,
  };
}

export function buildLastMailSummaryFromState(state: VoiceThreadState | undefined): string | null {
  if (!state) return null;
  const top = state.lastMailTop ?? [];
  if (top.length === 0 && !state.lastMailRaw) return null;

  if (top.length === 0) {
    return `Resume du dernier point mail: ${state.lastMailRaw}.`;
  }

  const first = top[0] ?? '';
  const countTxt = typeof state.lastMailCount === 'number'
    ? `Tu as ${state.lastMailCount} non lus.`
    : 'Voici le dernier point email.';

  return `${countTxt} Le plus récent : ${first}.`;
}

function countLikelyImportantItems(items: string[]): number {
  return items.filter((x) => /(urgent|important|asap|immediat|immédiat|deadline|rappel)/i.test(x)).length;
}

function formatMailOral(text: string, mode: VoiceResponseMode): string {
  const state = extractMailStateFromReply(text);
  if (!state) {
    if (mode === 'short') return firstSentence(text);
    return capSentences(text, mode === 'detailed' ? 4 : 2);
  }

  const top = state.lastMailTop ?? [];
  const important = countLikelyImportantItems(top);
  const count = state.lastMailCount ?? top.length;

  if (mode === 'short') {
    return `Tu as ${count} non lus. ${top[0] ? `Dernier: ${top[0]}.` : ''}`.trim();
  }

  const topLines = top.slice(0, mode === 'detailed' ? 3 : 2)
    .map((item, idx) => `${idx === 0 ? 'Premier' : idx === 1 ? 'Deuxième' : 'Troisième'} : ${item}.`)
    .join(' ');
  const importantText = important > 0 ? ` ${important} semble${important > 1 ? 'nt' : ''} important${important > 1 ? 's' : ''}.` : '';
  return `Tu as ${count} non lus.${importantText} ${topLines}`;
}

function formatExecutorOral(text: string, mode: VoiceResponseMode): string {
  return capSentences(text, mode === 'short' ? 1 : mode === 'detailed' ? 4 : 2);
}

function formatSearchOral(text: string, mode: VoiceResponseMode): string {
  if (mode === 'short') return firstSentence(text);
  return capSentences(text, mode === 'detailed' ? 4 : 2);
}

function formatTodoOral(text: string, mode: VoiceResponseMode): string {
  if (mode === 'short') return firstSentence(text);
  return capSentences(text, mode === 'detailed' ? 4 : 2);
}

function formatCultureOral(text: string, mode: VoiceResponseMode): string {
  const items = [...text.matchAll(/(?:^|\n)\d+\.\s+(.+?)(?=\n\d+\.|\n(?:Les données|Certaines sources)|$)/gsu)]
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item));
  if (!items.length) return capSentences(compact(text), mode === 'detailed' ? 4 : 2);

  const limit = mode === 'short' ? 2 : mode === 'detailed' ? 5 : 3;
  const ordinal = ['Premier choix', 'Deuxième', 'Troisième', 'Quatrième', 'Cinquième'];
  const choices = items.slice(0, limit).map((item, index) => {
    const natural = item
      .replace(/\s+—\s+/u, ', à ')
      .replace(/\s+·\s+/gu, ', ')
      .replace(/\b(\d{1,2}):(\d{2})\b/gu, '$1 h $2');
    return `${ordinal[index]}, ${natural}.`;
  });
  const warning = /Certaines sources/u.test(text)
    ? ' Certaines sources sont temporairement indisponibles.'
    : /Les données/u.test(text)
      ? ' Les données peuvent dater un peu.'
      : '';
  return `${choices.join(' ')}${warning}`;
}

export function formatVoiceResponse(input: {
  text: string;
  domain: VoiceResponseDomain;
  mode: VoiceResponseMode;
}): string {
  const sanitized = sanitizeResponseAttribution(input.text, input.domain);
  const clean = compact(sanitized);
  if (!clean) return clean;

  let body: string;
  switch (input.domain) {
    case 'mail':
      body = formatMailOral(clean, input.mode);
      break;
    case 'todo':
      body = formatTodoOral(clean, input.mode);
      break;
    case 'search':
      body = formatSearchOral(clean, input.mode);
      break;
    case 'executor':
      body = formatExecutorOral(clean, input.mode);
      break;
    case 'culture':
      body = formatCultureOral(sanitized, input.mode);
      break;
    default:
      body = input.mode === 'short' ? firstSentence(clean) : capSentences(clean, input.mode === 'detailed' ? 4 : 2);
      break;
  }

  return compact(normalizeTutoiement(body));
}
