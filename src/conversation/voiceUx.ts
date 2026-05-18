export type VoiceResponseMode = 'short' | 'normal' | 'detailed';

export type VoiceResponseDomain = 'mail' | 'todo' | 'search' | 'executor' | 'weather' | 'spotify' | 'general';

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

export function isVoiceRequest(input: { voiceTurnId?: string; clientChannel?: string | null }): boolean {
  if (input.voiceTurnId && input.voiceTurnId.trim().length > 0) return true;
  return (input.clientChannel ?? '').toLowerCase() === 'voice';
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
  if (forced === 'short' || forced === 'normal' || forced === 'detailed') return forced;

  const t = input.text.toLowerCase();
  if (/(detaille|détaille|en detail|en détail|approfondis)/.test(t)) return 'detailed';
  if (/(resume vite|résume vite|en bref|rapidement|court)/.test(t)) return 'short';
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
  if (mode === 'detailed') return `${capSentences(text, 4)} Source: synthese web. Niveau de confiance: moyen a eleve.`;
  return `${capSentences(text, 2)} Source: synthese web. Je peux detailler si tu veux.`;
}

function formatTodoOral(text: string, mode: VoiceResponseMode): string {
  if (mode === 'short') return firstSentence(text);
  const capped = capSentences(text, mode === 'detailed' ? 4 : 2);
  return `${capped} Tu veux que je te lise la prochaine echeance ?`;
}

export function formatVoiceResponse(input: {
  text: string;
  domain: VoiceResponseDomain;
  mode: VoiceResponseMode;
  gracefulFallback: boolean;
}): string {
  const clean = compact(input.text);
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

  if (!input.gracefulFallback) return compact(body);
  return compact(`J ai eu un delai, je reprends en mode direct. ${body}`);
}
