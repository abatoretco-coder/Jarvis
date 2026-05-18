const FOOTER_START_PATTERNS = [
  /^(contactez[- ]nous|nous contacter)\b/i,
  /^(visitez notre|consultez notre|voir notre)\b/i,
  /^foire aux questions\b/i,
  /^service gratuit\s*\+\s*prix/i,
  /^cette communication vous est envoyee\b/i,
  /^vous disposez a tout moment d['’]un droit d['’]acces\b/i,
  /^en cas de reclamation\b/i,
  /^tous droits de reproduction reserves\b/i,
  /^societe anonyme au capital\b/i,
  /\bprivacy policy\b/i,
  /\bunsubscribe\b/i,
  /\bse desabonner\b/i,
  /^manage preferences\b/i,
  /^sent from my /i,
];

const STRONG_FOOTER_START_PATTERNS = [
  /^une question\s*\?\s*un probleme\s*\?$/i,
  /^la reponse se trouve .*manuel d['’]utilisation/i,
  /^cet email traite d['’]une information importante\b/i,
  /^le nom de domaine .* appartient a /i,
  /^.* est agreee et supervisee par l['’]autorite de controle prudentiel/i,
  /^.*\b(?:sas|sa|sarl|sasu)\b.*\brcs\b/i,
];

const LOW_VALUE_LINE_PATTERNS = [
  /^si vous ne visualisez pas cet email, cliquez ici\b/i,
  /^ajoutez-nous a vos contacts\b/i,
  /^cliquez ici pour /i,
  /^voir dans le navigateur\b/i,
  /^view in browser\b/i,
  /^download the app\b/i,
  /^telecharger l['’]application\b/i,
  /^powered by\b/i,
  /^envoye depuis /i,
];

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u00a0\u1680\u2000-\u200d\u202f\u205f\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function collapseInlineWhitespace(value: string): string {
  return value
    .replace(/[\u00a0\u1680\u2000-\u200d\u202f\u205f\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function isSeparatorLine(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  return compact.length >= 6 && /^[_\-=*#~.]+$/.test(compact);
}

function isLowInformationLine(value: string): boolean {
  if (!value) return true;
  if (isSeparatorLine(value)) return true;

  const compact = value.replace(/\s+/g, '');
  if (compact.length >= 16 && /^(.)\1+$/.test(compact)) return true;

  const letters = (value.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (letters === 0) return true;

  const uniqueChars = new Set(compact.toLowerCase()).size;
  return compact.length >= 24 && uniqueChars <= 3;
}

function isLowValueLine(value: string): boolean {
  if (isLowInformationLine(value)) return true;

  const normalized = normalizeForMatch(value);
  if (!normalized) return true;
  return LOW_VALUE_LINE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isFooterStartLine(value: string): boolean {
  const normalized = normalizeForMatch(value);
  if (!normalized) return false;
  return FOOTER_START_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isStrongFooterStartLine(value: string): boolean {
  const normalized = normalizeForMatch(value);
  if (!normalized) return false;
  return STRONG_FOOTER_START_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeMailBodyInput(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\u200c|\u200d|\ufeff/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanMailDetailText(text: string): string {
  const normalizedInput = normalizeMailBodyInput(text);
  if (!normalizedInput) return '';

  const lines = normalizedInput.split('\n');
  const cleaned: string[] = [];
  let blankPending = false;
  let keptMeaningfulLines = 0;

  for (const rawLine of lines) {
    const line = collapseInlineWhitespace(rawLine);
    if (!line) {
      blankPending = cleaned.length > 0;
      continue;
    }

    if (isStrongFooterStartLine(line) && keptMeaningfulLines >= 2) {
      break;
    }

    if (isFooterStartLine(line) && keptMeaningfulLines >= 4) {
      break;
    }

    if (isLowValueLine(line)) {
      continue;
    }

    if (blankPending && cleaned.length > 0 && cleaned[cleaned.length - 1] !== '') {
      cleaned.push('');
    }
    blankPending = false;

    if (cleaned[cleaned.length - 1] === line) continue;

    cleaned.push(line);
    keptMeaningfulLines += 1;
  }

  const compacted = cleaned
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return compacted || normalizedInput;
}