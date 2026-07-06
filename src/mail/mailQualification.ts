export type MailQualificationCategory = 'ignore' | 'info' | 'action';
export type MailUrgency = 'low' | 'medium' | 'high';
export type MailRecommendedAction = 'none' | 'reply' | 'create_task' | 'remind_later' | 'ask_user' | 'archive';

export type MailQualificationInput = {
  from: string;
  subject: string;
  snippet?: string;
  listId?: string;
  autoSubmitted?: string;
  importantSender?: boolean;
};

export type MailQualification = {
  category: MailQualificationCategory;
  urgency: MailUrgency;
  confidence: number;
  reason: string;
  briefingSummary: string;
  recommendedAction: MailRecommendedAction;
  task?: {
    title: string;
    dueDate?: string;
  };
};

const ACTION_PATTERNS = [
  /\b(peux[- ]tu|pouvez[- ]vous|merci de|merci d[' ]|besoin de|j[' ]attends|en attente de)\b/i,
  /\b(reponds?|réponds?|reponse attendue|réponse attendue|a valider|à valider|validation|valider)\b/i,
  /\b(relance|dernier rappel|action requise|required action|please reply|can you|could you)\b/i,
  /\b(avant le|d[' ]ici|deadline|echeance|échéance|urgent|asap|des que possible|dès que possible)\b/i,
  /\?$/,
];

const HIGH_URGENCY_PATTERNS = [
  /\b(urgent|asap|immediat|immédiat|dernier rappel|incident|bloque|bloqué|critique|impaye|impayé)\b/i,
  /\b(aujourd[' ]hui|avant ce soir|dans les 24 ?h|sous 24 ?h)\b/i,
];

const INFO_PATTERNS = [
  /\b(compte rendu|cr\b|information|mise a jour|mise à jour|update|changement|modification)\b/i,
  /\b(document|piece jointe|pièce jointe|facture|devis|recu|reçu|commande|livraison)\b/i,
  /\b(rendez[- ]vous|rdv|invitation|confirmation|annulation|retard|remboursement)\b/i,
  /\b(disponible|publie|publié|envoye|envoyé|partage|partagé)\b/i,
];

const IGNORE_PATTERNS = [
  /\b(newsletter|promo|promotion|soldes|offre speciale|offre spéciale|black friday)\b/i,
  /\b(reseaux sociaux|réseaux sociaux|nouveau commentaire|nouveaux commentaires|like|likes)\b/i,
  /\b(se desabonner|se désabonner|unsubscribe|manage preferences|view in browser)\b/i,
  /\b(code de connexion|security code|verification code|code de verification)\b/i,
];

const AUTOMATED_SENDER_PATTERNS = [
  /\b(no[-_. ]?reply|noreply|ne[-_. ]?pas[-_. ]?repondre|notification|notifications|newsletter)\b/i,
];

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim() ?? '').find(Boolean) ?? '';
}

function hasAny(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function buildBriefingSummary(input: MailQualificationInput): string {
  const subject = input.subject.trim() || '(sans objet)';
  const from = input.from.replace(/<[^>]+>/g, '').trim() || 'Inconnu';
  return `${from} - ${subject}`;
}

function taskTitleFor(input: MailQualificationInput): string {
  const subject = input.subject.trim();
  const from = input.from.replace(/<[^>]+>/g, '').trim() || 'cet expediteur';
  return subject ? `Traiter le mail de ${from}: ${subject}` : `Traiter le mail de ${from}`;
}

export function qualifyMail(input: MailQualificationInput): MailQualification {
  const subject = input.subject.trim() || '(sans objet)';
  const combinedRaw = [input.from, input.subject, input.snippet, input.listId, input.autoSubmitted]
    .filter(Boolean)
    .join(' ');
  const combined = normalizeText(combinedRaw);
  const sender = normalizeText(input.from);
  const isAutomated =
    hasAny(AUTOMATED_SENDER_PATTERNS, sender)
    || Boolean(input.listId?.trim())
    || normalizeText(input.autoSubmitted ?? '') === 'auto-generated';
  const hasActionSignal = hasAny(ACTION_PATTERNS, combined);
  const hasHighUrgencySignal = hasAny(HIGH_URGENCY_PATTERNS, combined);
  const hasInfoSignal = hasAny(INFO_PATTERNS, combined);
  const hasIgnoreSignal = hasAny(IGNORE_PATTERNS, combined);

  if (hasActionSignal || (input.importantSender && hasInfoSignal)) {
    const urgency: MailUrgency = hasHighUrgencySignal ? 'high' : 'medium';
    const recommendedAction: MailRecommendedAction =
      /\?|\b(reponds?|réponds?|reponse attendue|réponse attendue|please reply)\b/i.test(combinedRaw)
        ? 'reply'
        : 'create_task';

    return {
      category: 'action',
      urgency,
      confidence: clampConfidence(hasHighUrgencySignal ? 0.9 : 0.82),
      reason: hasHighUrgencySignal
        ? 'Le mail contient un signal d action avec urgence.'
        : 'Le mail semble demander une reponse, une validation ou un suivi.',
      briefingSummary: buildBriefingSummary(input),
      recommendedAction,
      task: {
        title: taskTitleFor({ ...input, subject }),
      },
    };
  }

  if (hasInfoSignal && !hasIgnoreSignal) {
    return {
      category: 'info',
      urgency: 'low',
      confidence: 0.74,
      reason: 'Le mail contient une information potentiellement utile a partager.',
      briefingSummary: buildBriefingSummary(input),
      recommendedAction: 'none',
    };
  }

  if (isAutomated || hasIgnoreSignal) {
    return {
      category: 'ignore',
      urgency: 'low',
      confidence: clampConfidence(isAutomated && hasIgnoreSignal ? 0.88 : 0.76),
      reason: isAutomated
        ? 'Le mail ressemble a une notification automatique ou une newsletter sans action claire.'
        : 'Le mail ressemble a du bruit ou a une communication promotionnelle.',
      briefingSummary: buildBriefingSummary(input),
      recommendedAction: 'archive',
    };
  }

  return {
    category: 'info',
    urgency: 'low',
    confidence: 0.55,
    reason: 'Aucun signal fort de bruit ou d action; le mail reste visible comme information faible confiance.',
    briefingSummary: buildBriefingSummary(input),
    recommendedAction: 'none',
  };
}

export function shouldMentionMail(qualification: MailQualification, context: 'briefing' | 'mail_question'): boolean {
  if (qualification.category === 'ignore') return false;
  if (context === 'mail_question') return true;
  return qualification.category === 'action' || qualification.confidence >= 0.6;
}
