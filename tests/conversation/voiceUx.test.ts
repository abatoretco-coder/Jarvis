import { describe, expect, it } from '@jest/globals';

import {
  buildLastMailSummaryFromState,
  extractMailStateFromReply,
  formatQuickActionVoiceResponse,
  formatVoiceResponse,
  isLastMailSummaryRequest,
  isLikelyTruncatedVoiceUtterance,
  isVoiceRequest,
  resolveVoiceResponseMode,
  sanitizeResponseAttribution,
} from '../../src/conversation/voiceUx';

describe('voiceUx', () => {
  it('keeps quick-action acknowledgements sharp and non-technical', () => {
    expect(formatQuickActionVoiceResponse('success')).toBe("C'est fait.");
    expect(formatQuickActionVoiceResponse('accepted')).toBe('Commande envoyée.');
    expect(formatQuickActionVoiceResponse('uncertain')).toBe('Commande envoyée, sans confirmation.');
    expect(formatQuickActionVoiceResponse('partial')).toBe("Je n'ai pas pu tout faire.");
    expect(formatQuickActionVoiceResponse('failure')).toBe("Je n'ai pas pu le faire.");
  });

  it('detects detailed mode from user request', () => {
    const mode = resolveVoiceResponseMode({ text: 'detaille la reponse stp' });
    expect(mode).toBe('detailed');
  });

  it('lets an explicit detail request override the voice-hub short profile', () => {
    const mode = resolveVoiceResponseMode({
      text: 'Detaille la reponse',
      clientContext: { voiceMode: 'short' },
    });
    expect(mode).toBe('detailed');
  });

  it('recognizes Home Assistant voice hubs as voice requests', () => {
    expect(isVoiceRequest({ clientChannel: 'ha.voice-hub.5a3d5d9d' })).toBe(true);
  });

  it('accepts short voice commands and rejects explicit truncation', () => {
    expect(isLikelyTruncatedVoiceUtterance('pause')).toBe(false);
    expect(isLikelyTruncatedVoiceUtterance('stop')).toBe(false);
    expect(isLikelyTruncatedVoiceUtterance('Demar...')).toBe(true);
    expect(isLikelyTruncatedVoiceUtterance('Demar...'.replace('...', '…'))).toBe(true);
  });

  it('extracts mail state from inbox summary', () => {
    const state = extractMailStateFromReply('Tu as 5 emails non lu : Alice : Sujet A ; Bob : Sujet B ; Carol : Sujet C.');
    expect(state?.lastMailCount).toBe(5);
    expect(state?.lastMailTop?.length).toBe(3);
  });

  it('builds a last-mail follow-up summary', () => {
    const text = buildLastMailSummaryFromState({
      lastMailCount: 5,
      lastMailTop: ['Alice : Sujet A'],
    });
    expect(text).toContain('Tu as 5 non lus');
    expect(text).toContain('Alice');
  });

  it('formats mail responses as a concise spoken summary', () => {
    const out = formatVoiceResponse({
      text: 'Tu as 5 emails non lu : Alice : Sujet A ; Bob : Sujet B ; Carol : Sujet C.',
      domain: 'mail',
      mode: 'normal',
    });
    expect(out).toContain('Tu as 5 non lus');
    expect(out).toContain('Premier : Alice');
    expect(out).not.toContain('Tu veux');
  });

  it('summarizes the email body when reading a message in short mode', () => {
    const out = formatVoiceResponse({
      text: 'Email de Alice, objet "Compte-rendu. Version finale" : Bonjour Loïc. La livraison est confirmée pour mardi matin. Il faut transmettre le code au transporteur. Cette dernière phrase est secondaire et ne doit pas être lue.',
      domain: 'mail',
      mode: 'short',
    });
    expect(out).toContain('Résumé :');
    expect(out).toContain('livraison est confirmée');
    expect(out).toContain('transmettre le code');
    expect(out).not.toContain('dernière phrase');
  });

  it('keeps an important later sentence in the spoken email summary', () => {
    const out = formatVoiceResponse({
      text: 'Email de Alice, objet "Livraison" : Le colis est préparé. Le transporteur passera mardi. Attention, le code doit être transmis avant 8 heures.',
      domain: 'mail',
      mode: 'normal',
    });
    expect(out).toContain('Le colis est préparé.');
    expect(out).toContain('Attention, le code doit être transmis avant 8 heures.');
    expect(out).not.toContain('transporteur passera');
  });

  it('removes web source labels outside the search agent', () => {
    const out = formatVoiceResponse({
      text: 'La tache est creee. Source : web.',
      domain: 'todo',
      mode: 'short',
    });
    expect(out).toBe('La tache est creee.');
  });

  it('does not append a next-due-date prompt to todo voice replies', () => {
    const out = formatVoiceResponse({
      text: "C'est note. J'ai ajoute Faire du sport dans ta liste Taches pour demain.",
      domain: 'todo',
      mode: 'normal',
    });

    expect(out).toContain('pour demain');
    expect(out).not.toContain('prochaine echeance');
  });

  it('does not append unsolicited follow-up prompts to search or executor replies', () => {
    expect(formatVoiceResponse({
      text: 'La réponse tient en une phrase.', domain: 'search', mode: 'normal',
    })).toBe('La réponse tient en une phrase.');
    expect(formatVoiceResponse({
      text: 'Le minuteur est lancé.', domain: 'executor', mode: 'normal',
    })).toBe('Le minuteur est lancé.');
  });

  it('removes web source labels for search-agent responses', () => {
    const out = formatVoiceResponse({
      text: 'La reponse est confirmee. Source : web.',
      domain: 'search',
      mode: 'normal',
    });
    expect(out).not.toContain('Source : web.');
    expect(out.match(/Source\s*:\s*web/giu)).toBeNull();
  });

  it('applies the attribution rule to non-voice responses too', () => {
    expect(sanitizeResponseAttribution('Action terminee. Source : web.', 'executor')).toBe('Action terminee.');
    expect(sanitizeResponseAttribution('Resultat trouve. Source : web.', 'search')).toBe('Resultat trouve.');
    expect(sanitizeResponseAttribution('Resultat trouve. Source: https://example.com/info', 'search')).toBe('Resultat trouve.');
  });

  it('preserves written formatting and emoji while removing source labels', () => {
    const out = sanitizeResponseAttribution(
      'Résumé :\n- Premier point ✅\n- Deuxième point\nSource : https://example.com/info',
      'search'
    );
    expect(out).toContain('\n- Premier point ✅\n- Deuxième point');
    expect(out).not.toContain('Source :');
  });

  it('normalizes common vouvoiement forms into tutoiement for voice replies', () => {
    const out = formatVoiceResponse({
      text: 'Vous pouvez continuer. Je peux vous aider si vous voulez.',
      domain: 'general',
      mode: 'normal',
    });
    expect(out).toContain('Tu peux continuer.');
    expect(out).toContain("Je peux t'aider");
    expect(out).toContain('si tu veux');
  });

  it('keeps the useful result after a partial-result warning in short mode', () => {
    const out = formatVoiceResponse({
      text: "Résultat partiel : 1 service spécialisé n'a pas répondu. Il fera 22 degrés à Paris.",
      domain: 'general',
      mode: 'short',
    });
    expect(out).toContain('Résultat partiel');
    expect(out).toContain('22 degrés');
  });

  it('drops conversational filler and keeps a later critical fact', () => {
    const out = formatVoiceResponse({
      text: 'Je regarde cela. La température est de 18 degrés. Il va pleuvoir à partir de 16 heures.',
      domain: 'general',
      mode: 'normal',
    });
    expect(out).toBe('La température est de 18 degrés. Il va pleuvoir à partir de 16 heures.');
  });

  it('prioritizes a warning over a non-critical middle sentence', () => {
    const out = formatVoiceResponse({
      text: 'Le trajet dure trente minutes. Le départ se fait depuis République. Attention, la ligne est interrompue après 22 heures.',
      domain: 'general',
      mode: 'normal',
    });
    expect(out).toContain('Le trajet dure trente minutes.');
    expect(out).toContain('Attention, la ligne est interrompue');
    expect(out).not.toContain('République');
  });

  it('keeps an cancellation warning over an earlier date mention', () => {
    const out = formatVoiceResponse({
      text: 'Le dossier est prêt. La réunion est demain. Attention, elle est annulée.',
      domain: 'general',
      mode: 'normal',
    });
    expect(out).toBe('Le dossier est prêt. Attention, elle est annulée.');
  });

  it('keeps calendar warnings and bounds event lists in short mode', () => {
    const out = formatVoiceResponse({
      text: [
        'Résultats partiels : agendas indisponibles (travail).',
        '3 résultats pour "demain" :',
        'mercredi 14 octobre à 09:00 : Stand-up',
        'mercredi 14 octobre à 12:00 : Déjeuner',
        'mercredi 14 octobre à 18:00 : Sport',
      ].join('\n'),
      domain: 'calendar',
      mode: 'short',
    });
    expect(out).toContain('Résultats partiels');
    expect(out).toContain('Stand-up');
    expect(out).toContain('Déjeuner');
    expect(out).not.toContain('Sport');
  });

  it('bounds todo lists even when items are separated with semicolons', () => {
    const out = formatVoiceResponse({
      text: 'Tu as 4 tâches : Appeler Alice ; Acheter du lait ; Réserver le train ; Ranger le bureau.',
      domain: 'todo',
      mode: 'short',
    });
    expect(out).toContain('Appeler Alice');
    expect(out).toContain('Acheter du lait');
    expect(out).not.toContain('Réserver le train');
    expect(out).toContain('2 autres');
  });

  it("reads every task due today even in short mode", () => {
    const out = formatVoiceResponse({
      text: "Tu as 6 tâches aujourd'hui : Appeler Alice ; Acheter du lait ; Réserver le train ; Ranger le bureau ; Envoyer le devis ; Sortir les poubelles.",
      domain: 'todo',
      mode: 'short',
    });
    expect(out).toContain('Appeler Alice');
    expect(out).toContain('Sortir les poubelles');
    expect(out).not.toContain('autres');
  });

  it('uses tutoiement for imperative Spotify-style prompts', () => {
    const out = formatVoiceResponse({
      text: 'Précisez ce que vous souhaitez écouter.',
      domain: 'spotify',
      mode: 'short',
    });
    expect(out).toBe('Précise ce que tu veux écouter.');
  });

  it('turns Culture result lists into concise spoken choices', () => {
    const out = formatVoiceResponse({
      text: [
        'Voici les meilleurs choix disponibles :',
        '1. Film A — Pathé Convention, ven. 28 août, 20:00 · VF · 15 EUR',
        '2. Film B — UGC Lyon, ven. 28 août, 20:30 · VO · prix non communiqué',
        '3. Film C — Cinéma X, ven. 28 août, 21:00 · VOSTFR · 12 EUR',
        '4. Film D — Cinéma Y, ven. 28 août, 21:15 · VF · 11 EUR',
      ].join('\n'),
      domain: 'culture',
      mode: 'normal',
    });

    expect(out).toContain('Premier choix, Film A, à Pathé Convention');
    expect(out).toContain('Deuxième, Film B, à UGC Lyon');
    expect(out).toContain('Troisième, Film C');
    expect(out).not.toContain('Film D');
    expect(out).not.toContain('1.');
  });

  it('detects resume-last-mail intents', () => {
    expect(isLastMailSummaryRequest('resume le dernier mail')).toBe(true);
    expect(isLastMailSummaryRequest('continue le resume s il te plait')).toBe(true);
    expect(isLastMailSummaryRequest('quelle meteo demain')).toBe(false);
  });
});
