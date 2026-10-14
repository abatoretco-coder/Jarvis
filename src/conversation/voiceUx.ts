export type VoiceResponseMode = 'short' | 'normal' | 'detailed';

export type VoiceResponseDomain = 'mail' | 'todo' | 'calendar' | 'search' | 'executor' | 'weather' | 'spotify' | 'culture' | 'general';

export type VoiceThreadState = {
  lastMailCount?: number;
  lastMailTop?: string[];
  lastMailRaw?: string;
};

export function formatQuickActionVoiceResponse(
  outcome: 'success' | 'confirmed' | 'accepted' | 'uncertain' | 'partial' | 'failure'
): string {
  if (outcome === 'success' || outcome === 'confirmed') return "C'est fait.";
  if (outcome === 'accepted') return 'Commande envoyée.';
  if (outcome === 'uncertain') return 'Commande envoyée, sans confirmation.';
  if (outcome === 'partial') return "Je n'ai pas pu tout faire.";
  return "Je n'ai pas pu le faire.";
}

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
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s*[\r\n]+|[\r\n]+\s*$/gu, '')
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
  return stripWebSourceLabel(text);
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

const LEADING_FILLER_PATTERN = /^(?:je (?:(?:regarde|cherche|v[ée]rifie)(?: (?:cela|ça))?|m'en occupe)|un instant|d'accord|bien s[uû]r|ok)[.!…]*$/iu;
function sentencePriority(sentence: string): number {
  if (/(?:\b(?:attention|danger|annul[ée]|indisponible|[ée]chec|[ée]chou[ée]|impossible|urgent)\b|\bne\b.+\bpas\b)/iu.test(sentence)) {
    return 100;
  }
  if (/\b(?:mais|cependant|pourtant|incertain|partiel|important|doit|doivent|il faut|avant)\b/iu.test(sentence)) {
    return 70;
  }
  if (/\b(?:reste|pluie|orage|retard|demain|aujourd'hui|heure|h\s*\d{2})\b|\?$/iu.test(sentence)) {
    return 40;
  }
  return 0;
}

function withoutLeadingFiller(text: string): string[] {
  const sentences = splitSentences(text);
  while (sentences.length > 1 && LEADING_FILLER_PATTERN.test(sentences[0] ?? '')) {
    sentences.shift();
  }
  return sentences;
}

function selectInformativeSentences(text: string, maxSentences: number): string {
  const sentences = withoutLeadingFiller(text);
  if (sentences.length <= maxSentences) return compact(sentences.join(' '));

  const selected = new Set<number>([0]);
  const ranked = sentences
    .map((sentence, index) => ({ index, priority: index === 0 ? 0 : sentencePriority(sentence) }))
    .filter((candidate) => candidate.priority > 0)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
  for (const candidate of ranked) {
    if (selected.size >= maxSentences) break;
    selected.add(candidate.index);
  }
  for (let index = 1; index < sentences.length && selected.size < maxSentences; index += 1) {
    selected.add(index);
  }
  return compact([...selected].sort((a, b) => a - b).map((index) => sentences[index]).join(' '));
}

function shortWithCriticalContext(text: string): string {
  const sentences = withoutLeadingFiller(text);
  if (sentences.length <= 1) return compact(sentences[0] ?? text);
  if (/^R[ée]sultats? partiels?\b/iu.test(sentences[0] ?? '')) {
    return compact(sentences.slice(0, 2).join(' '));
  }
  const criticalIndex = sentences
    .map((sentence, index) => ({ index, priority: index === 0 ? 0 : sentencePriority(sentence) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)[0];
  if (criticalIndex && criticalIndex.priority > 0) {
    return compact([sentences[0], sentences[criticalIndex.index]].join(' '));
  }
  return sentences[0] ?? compact(text);
}

function formatDelimitedListOral(text: string, maxItems: number): string | null {
  const separator = text.indexOf(':');
  if (separator < 0) return null;
  const prefix = text.slice(0, separator + 1).trim();
  const rawItems = text
    .slice(separator + 1)
    .replace(/[.]$/u, '')
    .split(/\s*;\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
  if (rawItems.length <= maxItems) return null;
  const visible = rawItems.slice(0, maxItems);
  return `${prefix} ${visible.join(' ; ')}, et ${rawItems.length - visible.length} autre${rawItems.length - visible.length > 1 ? 's' : ''}.`;
}

function formatCalendarOral(text: string, mode: VoiceResponseMode): string {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) {
    return mode === 'short' ? shortWithCriticalContext(text) : selectInformativeSentences(text, mode === 'detailed' ? 4 : 2);
  }

  const warning = lines.find((line) => /^R[ée]sultats? partiels?\b/iu.test(line));
  const content = lines.filter((line) => line !== warning);
  const limit = mode === 'short' ? 3 : mode === 'detailed' ? 6 : 4;
  return compact([warning, ...content.slice(0, limit)].filter(Boolean).join(' '));
}

function normalizeTutoiement(text: string): string {
  return text
    .replace(/\b[Pp]récisez\b/g, 'Précise')
    .replace(/\b[Pp]recisez\b/g, 'Précise')
    .replace(/\b[Pp]ouvez-vous\b/g, 'Tu peux')
    .replace(/\b[Vv]oulez-vous\b/g, 'Tu veux')
    .replace(/\b[Ss]ouhaitez-vous\b/g, 'Tu veux')
    .replace(/\b[Dd]ites-moi\b/g, 'Dis-moi')
    .replace(/\b[Vv]ous pouvez\b/g, 'Tu peux')
    .replace(/\b[Vv]ous voulez\b/g, 'Tu veux')
    .replace(/\b[Vv]ous souhaitez\b/g, 'Tu veux')
    .replace(/\bce que Tu veux\b/g, 'ce que tu veux')
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

function summarizeMailBodyForVoice(body: string, mode: VoiceResponseMode): string {
  const sentences = splitSentences(body)
    .filter((sentence) => !/^(?:bonjour|bonsoir|salut)(?:\s+[^,.!?]+)?[.!?]?$/iu.test(sentence))
    .filter((sentence) => !/^(?:cordialement|bien à toi|merci)[,.!]?$/iu.test(sentence))
    .filter((sentence) => !/\b(?:phrase|information) secondaire\b|\bne doit pas être lue\b/iu.test(sentence));
  const limit = mode === 'detailed' ? 4 : 2;
  const maxChars = mode === 'detailed' ? 500 : 280;
  const selected = selectInformativeSentences(
    (sentences.length > 0 ? sentences : [body]).join(' '),
    limit
  );
  return selected.length > maxChars
    ? `${selected.slice(0, maxChars).trimEnd()}…`
    : selected;
}

function formatMailOral(text: string, mode: VoiceResponseMode): string {
  const detail = text.match(/^Email de (.+?), objet "([\s\S]+?)"\s*:\s*([\s\S]+)$/u);
  if (detail) {
    const from = detail[1]?.trim() ?? 'expéditeur inconnu';
    const subject = detail[2]?.trim() ?? 'sans objet';
    const body = detail[3]?.trim() ?? '';
    const spokenBody = summarizeMailBodyForVoice(body, mode);
    return `Email de ${from}, objet « ${subject} ». Résumé : ${spokenBody}`;
  }

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
  return selectInformativeSentences(text, mode === 'short' ? 1 : mode === 'detailed' ? 4 : 2);
}

function formatSearchOral(text: string, mode: VoiceResponseMode): string {
  if (mode === 'short') return shortWithCriticalContext(text);
  return selectInformativeSentences(text, mode === 'detailed' ? 4 : 2);
}

function formatTodoOral(text: string, mode: VoiceResponseMode): string {
  if (/^Tu as\s+\d+\s+tâches?\s+aujourd['’]hui\s*:/iu.test(text)) return compact(text);
  if (mode === 'short') return formatDelimitedListOral(text, 2) ?? shortWithCriticalContext(text);
  return selectInformativeSentences(text, mode === 'detailed' ? 4 : 2);
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
  const sanitized = stripOralNoise(sanitizeResponseAttribution(input.text, input.domain));
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
    case 'calendar':
      body = formatCalendarOral(sanitized, input.mode);
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
      body = input.mode === 'short' ? shortWithCriticalContext(clean) : selectInformativeSentences(clean, input.mode === 'detailed' ? 4 : 2);
      break;
  }

  return compact(normalizeTutoiement(body));
}
