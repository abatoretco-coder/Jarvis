export type VoiceResponseMode = 'short' | 'normal' | 'detailed';

export type VoiceResponseDomain = 'mail' | 'todo' | 'calendar' | 'search' | 'executor' | 'weather' | 'spotify' | 'general';

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

  return `${countTxt} Le plus recent: ${first}. Tu veux que je te fasse le top 3 ou seulement les urgents ?`;
}

function countLikelyImportantItems(items: string[]): number {
  return items.filter((x) => /(urgent|important|asap|immediat|immédiat|deadline|rappel)/i.test(x)).length;
}

function formatMailOral(text: string, mode: VoiceResponseMode): string {
  const state = extractMailStateFromReply(text);
  if (!state) {
    if (mode === 'short') return firstSentence(text);
    if (mode === 'detailed') return `${capSentences(text, 4)} Tu veux ensuite que je te propose la prochaine action ?`;
    return `${capSentences(text, 2)} Tu veux le plus urgent ou un resume global ?`;
  }

  const top = state.lastMailTop ?? [];
  const important = countLikelyImportantItems(top);
  const count = state.lastMailCount ?? top.length;

  if (mode === 'short') {
    return `Tu as ${count} non lus. ${top[0] ? `Dernier: ${top[0]}.` : ''}`.trim();
  }

  const topLines = top.slice(0, mode === 'detailed' ? 3 : 2).map((item, idx) => `${idx + 1}, ${item}.`).join(' ');
  const actions = 'Actions proposees: repondre, archiver, marquer lu.';
  const question = 'Tu veux que je traite le plus urgent ou que je continue le resume ?';

  return `Tu as ${count} non lus, dont ${important} potentiellement importants. ${topLines} ${actions} ${question}`;
}

function formatExecutorOral(text: string, mode: VoiceResponseMode): string {
  const base = capSentences(text, mode === 'short' ? 1 : 2);
  if (mode === 'short') return base;
  return `${base} Si tu veux, je peux annuler ou ajuster cette action.`;
}

function formatSearchOral(text: string, mode: VoiceResponseMode): string {
  if (mode === 'short') return firstSentence(text);
  const capped = capSentences(text, mode === 'detailed' ? 4 : 2);
  const sourced = /\bsource\s*:\s*(?:synth[eè]se\s+)?web\b/iu.test(capped)
    ? capped
    : `${capped} Source : web.`;
  void sourced;
  return mode === 'detailed' ? capped : `${capped} Je peux detailler si tu veux.`;
}

function formatTodoOral(text: string, mode: VoiceResponseMode): string {
  if (mode === 'short') return firstSentence(text);
  return capSentences(text, mode === 'detailed' ? 4 : 2);
}

export function formatVoiceResponse(input: {
  text: string;
  domain: VoiceResponseDomain;
  mode: VoiceResponseMode;
}): string {
  const clean = compact(sanitizeResponseAttribution(input.text, input.domain));
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
    default:
      body = input.mode === 'short' ? firstSentence(clean) : capSentences(clean, input.mode === 'detailed' ? 4 : 2);
      break;
  }

  return compact(normalizeTutoiement(body));
}
