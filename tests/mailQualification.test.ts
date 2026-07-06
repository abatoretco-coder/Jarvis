import { describe, expect, it } from '@jest/globals';

import { qualifyMail, shouldMentionMail } from '../src/mail/mailQualification';

describe('mail qualification', () => {
  it('classifies direct requests as action items', () => {
    const qualification = qualifyMail({
      from: 'Jean Dupont <jean@example.com>',
      subject: 'Validation devis',
      snippet: 'Peux-tu valider le devis avant vendredi ?',
    });

    expect(qualification.category).toBe('action');
    expect(qualification.recommendedAction).toBe('reply');
    expect(shouldMentionMail(qualification, 'briefing')).toBe(true);
  });

  it('keeps useful informational mail visible', () => {
    const qualification = qualifyMail({
      from: 'SNCF <info@sncf.fr>',
      subject: 'Information a la suite de votre voyage',
      snippet: 'Nous vous ferons un retour sous 24 heures.',
    });

    expect(qualification.category).toBe('info');
    expect(shouldMentionMail(qualification, 'mail_question')).toBe(true);
  });

  it('hides newsletters and automated noise from briefings', () => {
    const qualification = qualifyMail({
      from: 'Newsletter <newsletter@example.com>',
      subject: 'Promo de la semaine',
      snippet: 'Offre speciale. Se desabonner.',
      listId: '<weekly.example.com>',
    });

    expect(qualification.category).toBe('ignore');
    expect(shouldMentionMail(qualification, 'briefing')).toBe(false);
    expect(shouldMentionMail(qualification, 'mail_question')).toBe(false);
  });
});
