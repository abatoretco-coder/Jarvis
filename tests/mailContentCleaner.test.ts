import { describe, expect, it } from '@jest/globals';

import { cleanMailDetailText } from '../src/mail/mailContentCleaner';

describe('cleanMailDetailText', () => {
  it('keeps the useful body while dropping visual chrome and legal footer noise', () => {
    const raw = [
      'Si vous ne visualisez pas cet email, cliquez ici',
      '',
      '_______________________________________________________________________',
      'Information a la suite de votre voyage - reference a rappeler : R42431463',
      'Nom : Loic Bourguignon',
      '',
      'Votre voyage :',
      'Gare de depart : LIMOGES-BENEDICTINS - Gare d\'arrivee : PARIS AUSTERLITZ',
      'Date et heure de depart : 17/05/2026 12:06',
      '',
      'Bonjour,',
      '',
      'Le chef de bord de votre train nous a fait part d\'un defaut de confort rencontre lors du voyage reference en objet.',
      'Nous regrettons sincerement cette situation et etudions actuellement les mesures de dedommagement que nous pourrions vous proposer.',
      'Nous vous ferons un retour sous 24 heures.',
      '',
      'Contactez-nous par telephone au',
      '08 08 80 83 30',
      '',
      '(service gratuit + prix appel)',
      '',
      'Visitez notre',
      'foire aux questions',
      '',
      'Cette communication vous est envoyee par SNCF Voyageurs dans le cadre de votre voyage.',
      'Vous disposez a tout moment d\'un droit d\'acces, de rectification ou de suppression de vos donnees personnelles.',
      'SNCF VOYAGEURS est une marque enregistree de SNCF Voyageurs - Tous droits de reproduction reserves.',
    ].join('\n');

    const cleaned = cleanMailDetailText(raw);

    expect(cleaned).toContain('Information a la suite de votre voyage - reference a rappeler : R42431463');
    expect(cleaned).toContain('Le chef de bord de votre train nous a fait part');
    expect(cleaned).toContain('Nous vous ferons un retour sous 24 heures.');
    expect(cleaned).not.toContain('Si vous ne visualisez pas cet email');
    expect(cleaned).not.toContain('Contactez-nous par telephone');
    expect(cleaned).not.toContain('Cette communication vous est envoyee');
    expect(cleaned).not.toContain('Tous droits de reproduction reserves');
    expect(cleaned).not.toContain('_______________________________________________________________________');
  });

  it('collapses spacer noise but preserves normal short transactional lines', () => {
    const raw = [
      'Julie Faye vous a envoye 10.00 EUR.',
      'La somme a ete creditee sur Anniv Rob1.',
      '',
      '͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏',
      '',
      'Reference : AB12CD',
    ].join('\n');

    const cleaned = cleanMailDetailText(raw);

    expect(cleaned).toBe([
      'Julie Faye vous a envoye 10.00 EUR.',
      'La somme a ete creditee sur Anniv Rob1.',
      '',
      'Reference : AB12CD',
    ].join('\n'));
  });

  it('cuts early support and legal boilerplate in short transactional emails', () => {
    const raw = [
      'Julie Faye vous a envoye 10.00 EUR',
      '',
      'La somme a ete creditee sur « Anniv Rob1 ».',
      '',
      'Une question ? Un probleme ?',
      '',
      'La reponse se trouve surement dans notre manuel d\'utilisation ( https://support.lydia.me/l/fr ).',
      '',
      'Cet email traite d\'une information importante. A ce titre, il ne contient pas de lien pour vous desabonner.',
      'Vous recevez cet email parce que vous avez un compte ouvert dans les livres de Lydia Solutions, meme si vous etes desabonne des emails commerciaux.',
      '',
      'Le nom de domaine lydia.me appartient a Lydia Solutions, y compris les adresses email avec le suffixe « @lydia.me ».',
      '',
      'LYDIA SOLUTIONS est agreee et supervisee par l\'Autorite de Controle Prudentiel et de Resolution (ACPR).',
      '',
      'LYDIA SOLUTIONS, SAS au capital de 1.794.792 EUR - RCS Paris 534 479 589 - 14 avenue de l\'Opera, 75001 Paris.',
    ].join('\n');

    const cleaned = cleanMailDetailText(raw);

    expect(cleaned).toBe([
      'Julie Faye vous a envoye 10.00 EUR',
      '',
      'La somme a ete creditee sur « Anniv Rob1 ».',
    ].join('\n'));
  });
});