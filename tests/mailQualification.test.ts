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

  it('applies personal ignore rules for recurring marketing senders', () => {
    const qualification = qualifyMail({
      from: 'Fnac <info@fnac.com>',
      subject: 'Votre setup de pro | PC, ecrans, composants',
      snippet: 'Decouvrez notre selection.',
    });

    expect(qualification.category).toBe('ignore');
    expect(qualification.ruleId).toBe('ignore.fnac.marketing');
  });

  it('keeps travel confirmations as informational items', () => {
    const qualification = qualifyMail({
      from: 'Booking.com <noreply@booking.com>',
      subject: 'Merci ! Votre reservation a Hotel Danube Bleu est confirmee',
      snippet: 'Votre reservation a Forestville est confirmee.',
    });

    expect(qualification.category).toBe('info');
    expect(qualification.ruleId).toBe('info.booking.reservations');
    expect(qualification.groupKey).toBe('travel.booking');
  });

  it('marks developer failures as grouped action items', () => {
    const qualification = qualifyMail({
      from: 'GitHub <notifications@github.com>',
      subject: '[abatoretco-coder/Kargo_dev] Run failed: CodeQL Security Analysis - main',
      snippet: 'All jobs have failed.',
    });

    expect(qualification.category).toBe('action');
    expect(qualification.ruleId).toBe('action.github.failed-runs');
    expect(qualification.groupKey).toBe('dev.github.failures');
    expect(qualification.recommendedAction).toBe('create_task');
  });

  it('treats Airbnb account activity as a security action', () => {
    const qualification = qualifyMail({
      from: 'Airbnb <automated@airbnb.com>',
      subject: "Activite du compte : ajout d'un nouveau mode de paiement",
      snippet: "Si vous n'avez pas effectue cet ajout, verifiez votre compte.",
    });

    expect(qualification.category).toBe('action');
    expect(qualification.urgency).toBe('high');
    expect(qualification.ruleId).toBe('action.airbnb.security');
    expect(qualification.recommendedAction).toBe('ask_user');
  });
});
