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
  ruleId?: string;
  groupKey?: string;
  task?: {
    title: string;
    dueDate?: string;
  };
};

type MailQualificationRule = {
  id: string;
  category: MailQualificationCategory;
  urgency?: MailUrgency;
  confidence: number;
  recommendedAction?: MailRecommendedAction;
  reason: string;
  fromIncludes?: string[];
  subjectIncludes?: string[];
  subjectAnyIncludes?: string[];
  snippetIncludes?: string[];
  groupKey?: string;
};

const PERSONAL_RULES: MailQualificationRule[] = [
  {
    id: 'ignore.fnac.marketing',
    category: 'ignore',
    confidence: 0.96,
    recommendedAction: 'archive',
    reason: 'Regle personnelle: les emails Fnac observes sont des promotions ou recommandations commerciales.',
    fromIncludes: ['info@fnac.com'],
  },
  {
    id: 'ignore.booking.campaigns',
    category: 'ignore',
    confidence: 0.96,
    recommendedAction: 'archive',
    reason: 'Regle personnelle: campagnes Booking.com marketing et offres Genius.',
    fromIncludes: ['email.campaign@sg.booking.com'],
  },
  {
    id: 'ignore.sncf.marketing',
    category: 'ignore',
    confidence: 0.9,
    recommendedAction: 'archive',
    reason: 'Regle personnelle: newsletter SNCF Connect sans information de voyage directe.',
    fromIncludes: ['info@mail.sncf-connect.com'],
    subjectAnyIncludes: ['ete', 'jeux', 'correspondances'],
  },
  {
    id: 'ignore.uber.receipts',
    category: 'ignore',
    confidence: 0.88,
    recommendedAction: 'archive',
    reason: 'Regle personnelle: recus Uber Eats a garder visibles dans le dashboard, mais pas dans le briefing.',
    fromIncludes: ['noreply@uber.com'],
    subjectAnyIncludes: ['commande', 'uber eats', 'recu'],
  },
  {
    id: 'ignore.retail.marketing',
    category: 'ignore',
    confidence: 0.9,
    recommendedAction: 'archive',
    reason: 'Regle personnelle: newsletters commerciales observees.',
    fromIncludes: ['noreply@kingofcotton.com', 'noreply@email.openai.com'],
  },
  {
    id: 'ignore.booking.verification',
    category: 'ignore',
    confidence: 0.92,
    recommendedAction: 'archive',
    reason: 'Regle personnelle: codes de verification Booking temporaires.',
    fromIncludes: ['noreply-iam@booking.com'],
    subjectAnyIncludes: ['code de verification', 'verification'],
  },
  {
    id: 'info.booking.reservations',
    category: 'info',
    confidence: 0.94,
    reason: 'Regle personnelle: confirmations de reservation Booking utiles pour le voyage.',
    fromIncludes: ['noreply@booking.com', 'email@cars.booking.com'],
    subjectAnyIncludes: ['reservation', 'confirmee', 'confirmée', 'location', 'prise en charge'],
    groupKey: 'travel.booking',
  },
  {
    id: 'info.airbnb.travel',
    category: 'info',
    confidence: 0.94,
    reason: 'Regle personnelle: reservations, recus et messages Airbnb utiles pour le voyage.',
    fromIncludes: ['automated@airbnb.com', 'express@airbnb.com'],
    subjectAnyIncludes: ['reservation', 'recu', 'reçu', 'voyage'],
    groupKey: 'travel.airbnb',
  },
  {
    id: 'info.travel.orders',
    category: 'info',
    confidence: 0.9,
    reason: 'Regle personnelle: commandes liees au voyage.',
    fromIncludes: ['web@traversiercnb.ca'],
    subjectAnyIncludes: ['commande', 'details', 'détails', 'traverse'],
    groupKey: 'travel.orders',
  },
  {
    id: 'action.github.failed-runs',
    category: 'action',
    urgency: 'medium',
    confidence: 0.95,
    recommendedAction: 'create_task',
    reason: 'Regle personnelle: echecs CI/securite GitHub a traiter, mais a regrouper par repo/workflow.',
    fromIncludes: ['notifications@github.com'],
    subjectAnyIncludes: ['run failed', 'pr run failed', 'secret scan', 'codeql', 'ci -'],
    groupKey: 'dev.github.failures',
  },
  {
    id: 'info.github.copilot-pr',
    category: 'info',
    confidence: 0.78,
    reason: 'Regle personnelle: commentaires Copilot PR utiles, mais moins urgents que les checks en echec.',
    fromIncludes: ['notifications@github.com'],
    subjectAnyIncludes: ['copilot', 'pr #', 'pull request'],
    groupKey: 'dev.github.pr-comments',
  },
  {
    id: 'action.vercel.failed-deployments',
    category: 'action',
    urgency: 'high',
    confidence: 0.96,
    recommendedAction: 'create_task',
    reason: 'Regle personnelle: deploiement production Vercel en echec.',
    fromIncludes: ['notifications@vercel.com'],
    subjectAnyIncludes: ['failed production deployment', 'failed deployment'],
    groupKey: 'dev.vercel.failures',
  },
  {
    id: 'action.airbnb.security',
    category: 'action',
    urgency: 'high',
    confidence: 0.9,
    recommendedAction: 'ask_user',
    reason: 'Regle personnelle: activite de compte Airbnb potentiellement sensible.',
    fromIncludes: ['automated@airbnb.com'],
    subjectAnyIncludes: ['nouveau mode de paiement', 'activite du compte', 'activité du compte'],
    groupKey: 'security.airbnb',
  },
];

const ACTION_PATTERNS = [
  /\b(peux[- ]tu|pouvez[- ]vous|merci de|merci d[' ]|besoin de (?:ton|votre) aide|j[' ]attends|en attente de (?:ton|votre))\b/i,
  /\b(reponds?|réponds?|repondre|répondre|reponse attendue|réponse attendue|a valider|à valider|validation requise|a completer|à compléter|a signer|à signer|a payer|à payer|a fournir|à fournir)\b/i,
  /\b(relance|dernier rappel|action requise|required action|please reply|can you|could you)\b/i,
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

const SECURITY_CONTEXT_PATTERNS = [
  /\b(securite|security|connexion|login|mot de passe|password|vulnerabilite|vulnerability|faille)\b/i,
  /\b(activite du compte|account activity|nouvel appareil|new device)\b/i,
];

const SECURITY_ACTION_PATTERNS = [
  /\b(si ce n[' ]etait pas vous|if (?:this|it) wasn[' ]t you|connexion (?:inconnue|suspecte)|suspicious (?:login|activity))\b/i,
  /\b(changez|modifier|reinitialiser|reset|securiser|verifier)\b.{0,40}\b(mot de passe|password|compte|account)\b/i,
  /\b(compromis|compromised|non autorise|unauthorized)\b/i,
];

const SECURITY_INFO_PATTERNS = [
  /\b(avis de securite|security advisory|vulnerabilite|vulnerability|faille de securite)\b/i,
];

const PAYMENT_ACTION_PATTERNS = [
  /\b(facture|paiement|payment|solde)\b.{0,50}\b(impayee?|echoue|failed|en retard|overdue|a regulariser|à regulariser)\b/i,
  /\b(impayee?|echoue|failed|en retard|past due|overdue|a regulariser|à regulariser)\b.{0,50}\b(facture|paiement|payment|solde)\b/i,
];

const TRANSACTION_CHANGE_PATTERNS = [
  /\b(annulation|annulee?|cancelled|canceled|changement|modification|modifiee?|reprogramme[er]?)\b.{0,50}\b(commande|reservation|booking|rendez[- ]vous|rdv|voyage|vol|train)\b/i,
  /\b(commande|reservation|booking|rendez[- ]vous|rdv|voyage|vol|train)\b.{0,50}\b(annulation|annulee?|cancelled|canceled|changement|modification|modifiee?|reprogramme[er]?)\b/i,
];

const AUTOMATED_SENDER_PATTERNS = [
  /\b(no[-_. ]?reply|noreply|ne[-_. ]?pas[-_. ]?repondre|notification|notifications|newsletter)\b/i,
];

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasAny(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function includesAll(needles: string[] | undefined, haystack: string): boolean {
  if (!needles?.length) return true;
  return needles.every((needle) => haystack.includes(normalizeText(needle)));
}

function includesAny(needles: string[] | undefined, haystack: string): boolean {
  if (!needles?.length) return true;
  return needles.some((needle) => haystack.includes(normalizeText(needle)));
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

function qualificationFromContentPriority(
  input: MailQualificationInput,
  combined: string
): MailQualification | null {
  const base = {
    briefingSummary: buildBriefingSummary(input),
  };

  if (hasAny(SECURITY_CONTEXT_PATTERNS, combined) && hasAny(SECURITY_ACTION_PATTERNS, combined)) {
    return {
      ...base,
      category: 'action',
      urgency: 'high',
      confidence: 0.93,
      reason: 'Le contenu signale un risque de securite qui demande une verification de l utilisateur.',
      recommendedAction: 'ask_user',
      ruleId: 'action.security-alert',
      groupKey: 'security.account-alerts',
      task: { title: taskTitleFor(input) },
    };
  }

  if (hasAny(PAYMENT_ACTION_PATTERNS, combined)) {
    return {
      ...base,
      category: 'action',
      urgency: 'high',
      confidence: 0.92,
      reason: 'Le contenu signale un paiement ou une facture en echec ou en retard.',
      recommendedAction: 'create_task',
      ruleId: 'action.payment-issue',
      groupKey: 'billing.payment-issues',
      task: { title: taskTitleFor(input) },
    };
  }

  if (hasAny(TRANSACTION_CHANGE_PATTERNS, combined)) {
    return {
      ...base,
      category: 'action',
      urgency: 'medium',
      confidence: 0.88,
      reason: 'Le contenu signale une annulation ou un changement de commande, reservation ou rendez-vous.',
      recommendedAction: 'create_task',
      ruleId: 'action.transaction-change',
      groupKey: 'transactions.changes',
      task: { title: taskTitleFor(input) },
    };
  }

  if (hasAny(SECURITY_INFO_PATTERNS, combined)) {
    return {
      ...base,
      category: 'info',
      urgency: 'low',
      confidence: 0.78,
      reason: 'Le contenu contient un avis de securite utile sans action explicite.',
      recommendedAction: 'none',
      ruleId: 'info.security-advisory',
      groupKey: 'security.advisories',
    };
  }

  return null;
}

function matchPersonalRule(input: MailQualificationInput): MailQualificationRule | null {
  const from = normalizeText(input.from);
  const subject = normalizeText(input.subject);
  const snippet = normalizeText(input.snippet ?? '');

  return PERSONAL_RULES.find((rule) =>
    includesAny(rule.fromIncludes, from)
    && includesAll(rule.subjectIncludes, subject)
    && includesAny(rule.subjectAnyIncludes, subject)
    && includesAll(rule.snippetIncludes, snippet)
  ) ?? null;
}

function qualificationFromRule(input: MailQualificationInput, rule: MailQualificationRule): MailQualification {
  const category = rule.category;
  const urgency = rule.urgency ?? (category === 'action' ? 'medium' : 'low');
  const recommendedAction = rule.recommendedAction
    ?? (category === 'action' ? 'create_task' : category === 'ignore' ? 'archive' : 'none');

  return {
    category,
    urgency,
    confidence: rule.confidence,
    reason: rule.reason,
    briefingSummary: buildBriefingSummary(input),
    recommendedAction,
    ruleId: rule.id,
    groupKey: rule.groupKey,
    ...(category === 'action'
      ? { task: { title: taskTitleFor(input) } }
      : {}),
  };
}

export function qualifyMail(input: MailQualificationInput): MailQualification {
  const personalRule = matchPersonalRule(input);

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

  if (personalRule?.category === 'action') return qualificationFromRule(input, personalRule);

  const contentPriority = qualificationFromContentPriority(input, combined);
  if (contentPriority) return contentPriority;

  if (personalRule) return qualificationFromRule(input, personalRule);

  if (hasActionSignal) {
    const urgency: MailUrgency = hasHighUrgencySignal ? 'high' : 'medium';
    const recommendedAction: MailRecommendedAction =
      /\?|\b(reponds?|réponds?|repondre|répondre|reponse attendue|réponse attendue|please reply)\b/i.test(combinedRaw)
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
      confidence: input.importantSender ? 0.8 : 0.74,
      reason: input.importantSender
        ? 'Le mail contient une information potentiellement utile provenant d un contact prioritaire.'
        : 'Le mail contient une information potentiellement utile a partager.',
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
