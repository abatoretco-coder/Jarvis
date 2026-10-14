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

  it.each([
    {
      name: 'simple invoice',
      input: {
        from: 'Facturation <billing@example.com>',
        subject: 'Votre facture d octobre est disponible',
        snippet: 'Montant : 48,20 EUR. Reference F-2026-1042.',
      },
      category: 'info',
      urgency: 'low',
    },
    {
      name: 'unpaid invoice with a deadline',
      input: {
        from: 'Facturation <billing@example.com>',
        subject: 'Facture impayee - action requise avant le 20 octobre',
        snippet: 'Merci de regulariser 48,20 EUR avant l echeance.',
      },
      category: 'action',
      urgency: 'high',
    },
    {
      name: 'order confirmation',
      input: {
        from: 'Boutique <orders@example.com>',
        subject: 'Confirmation de votre commande 8142',
        snippet: 'Votre commande est confirmee et sera livree vendredi.',
      },
      category: 'info',
      urgency: 'low',
    },
    {
      name: 'order cancellation',
      input: {
        from: 'Boutique <orders@example.com>',
        subject: 'Annulation de votre commande 8142',
        snippet: 'Votre commande a ete annulee. Contactez-nous si cette annulation est incorrecte.',
      },
      category: 'action',
      urgency: 'medium',
    },
  ])('classifies $name conservatively', ({ input, category, urgency }) => {
    const qualification = qualifyMail(input);

    expect(qualification.category).toBe(category);
    expect(qualification.urgency).toBe(urgency);
  });

  it('lets a security action override a matching marketing sender rule', () => {
    const input = {
      from: 'Fnac <info@fnac.com>',
      subject: 'Alerte de securite sur votre compte',
      snippet: "Nouvelle connexion detectee. Si ce n'etait pas vous, changez votre mot de passe immediatement.",
      listId: '<marketing.fnac.com>',
    };

    const qualification = qualifyMail(input);

    expect(qualification.category).toBe('action');
    expect(qualification.urgency).toBe('high');
    expect(qualification.recommendedAction).toBe('ask_user');
    expect(qualification.ruleId).toBe('action.security-alert');
  });

  it('does not let a booking confirmation rule hide a cancellation', () => {
    const qualification = qualifyMail({
      from: 'Booking.com <noreply@booking.com>',
      subject: 'Votre reservation 8241 est annulee',
      snippet: 'Votre hebergement a annule la reservation. Choisissez une autre option.',
    });

    expect(qualification.category).toBe('action');
    expect(qualification.ruleId).toBe('action.transaction-change');
  });

  it('keeps a security newsletter visible even without a requested action', () => {
    const qualification = qualifyMail({
      from: 'Security Newsletter <newsletter@example.com>',
      subject: 'Avis de securite mensuel',
      snippet: 'Une vulnerabilite a ete corrigee dans la version 4.2. Aucune action n est requise.',
      listId: '<security.example.com>',
    });

    expect(qualification.category).toBe('info');
    expect(qualification.recommendedAction).toBe('none');
  });

  it('groups repeated CI failures while leaving non-urgent GitHub notifications informational', () => {
    const failure = qualifyMail({
      from: 'GitHub <notifications@github.com>',
      subject: '[acme/widget] Run failed: CI - main',
      snippet: 'The workflow failed again.',
    });
    const notification = qualifyMail({
      from: 'GitHub <notifications@github.com>',
      subject: '[acme/widget] Pull request #42 received a review comment',
      snippet: 'A reviewer left a comment on the pull request.',
    });

    expect(failure.category).toBe('action');
    expect(failure.groupKey).toBe('dev.github.failures');
    expect(notification.category).toBe('info');
    expect(notification.groupKey).toBe('dev.github.pr-comments');
  });

  it('recognizes an explicit reply request from an unknown sender despite accents and formatting', () => {
    const qualification = qualifyMail({
      from: 'personne.inconnue@example.net',
      subject: '  RéPONSE   attendue  ',
      snippet: 'Pouvez vous me répondre, s’il vous plaît ?\nMerci.',
    });

    expect(qualification.category).toBe('action');
    expect(qualification.recommendedAction).toBe('reply');
  });

  it('is deterministic for ambiguous input', () => {
    const input = {
      from: 'Contact <unknown@example.net>',
      subject: 'A propos de notre prochain echange',
      snippet: 'Bonjour, voici quelques elements.',
    };

    expect(qualifyMail(input)).toEqual(qualifyMail(input));
    expect(qualifyMail(input).category).toBe('info');
    expect(qualifyMail(input).confidence).toBeLessThan(0.6);
  });

  it('does not promote a rhetorical newsletter question to an action', () => {
    const qualification = qualifyMail({
      from: 'Newsletter <newsletter@example.com>',
      subject: 'Besoin de vacances ?',
      snippet: 'Decouvrez nos offres. Ou partirez-vous cet ete ?',
      listId: '<offers.example.com>',
    });

    expect(qualification.category).toBe('ignore');
  });

  it('does not treat a commercial deadline as a requested action', () => {
    const qualification = qualifyMail({
      from: 'Newsletter <newsletter@example.com>',
      subject: 'Offre speciale valable avant le 20 octobre',
      snippet: 'Profitez de 20 pour cent de remise avant ce soir.',
      listId: '<offers.example.com>',
    });

    expect(qualification.category).toBe('ignore');
  });

  it('uses an important sender only to raise informational confidence', () => {
    const qualification = qualifyMail({
      from: 'Camille <camille@example.com>',
      subject: 'Facture disponible',
      snippet: 'La facture de septembre est disponible dans votre espace.',
      importantSender: true,
    });

    expect(qualification.category).toBe('info');
    expect(qualification.confidence).toBe(0.8);
  });

  it('does not treat an account loyalty promotion as a security incident', () => {
    const qualification = qualifyMail({
      from: 'Programme fidelite <newsletter@shop.example>',
      subject: 'Verifiez votre compte fidelite',
      snippet: 'Votre compte contient 500 points. Profitez de notre promotion.',
      listId: '<loyalty.shop.example>',
    });

    expect(qualification.category).toBe('ignore');
  });
});
