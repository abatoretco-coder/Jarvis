import { describe, expect, it } from '@jest/globals';

import {
  buildLastMailSummaryFromState,
  extractMailStateFromReply,
  formatVoiceResponse,
  isLastMailSummaryRequest,
  isLikelyTruncatedVoiceUtterance,
  isVoiceRequest,
  resolveVoiceResponseMode,
  sanitizeResponseAttribution,
} from '../../src/conversation/voiceUx';

describe('voiceUx', () => {
  it('detects detailed mode from user request', () => {
    const mode = resolveVoiceResponseMode({ text: 'detaille la reponse stp' });
    expect(mode).toBe('detailed');
  });

  it('lets an explicit detail request override the voice-hub short profile', () => {
    const mode = resolveVoiceResponseMode({
      text: 'Détaille la réponse',
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
    expect(isLikelyTruncatedVoiceUtterance('Démar...')).toBe(true);
    expect(isLikelyTruncatedVoiceUtterance('Démar…')).toBe(true);
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

  it('formats mail response with action-oriented structure', () => {
    const out = formatVoiceResponse({
      text: 'Tu as 5 emails non lu : Alice : Sujet A ; Bob : Sujet B ; Carol : Sujet C.',
      domain: 'mail',
      mode: 'normal',
    });
    expect(out).toContain('Actions proposees');
    expect(out).toContain('Tu as 5 non lus');
  });

  it('removes web source labels outside the search agent', () => {
    const out = formatVoiceResponse({
      text: 'La tâche est créée. Source : web.',
      domain: 'todo',
      mode: 'short',
    });
    expect(out).toBe('La tâche est créée.');
  });

  it('keeps web source labels for search-agent responses', () => {
    const out = formatVoiceResponse({
      text: 'La réponse est confirmée. Source : web.',
      domain: 'search',
      mode: 'normal',
    });
    expect(out).toContain('Source : web.');
    expect(out.match(/Source\s*:\s*web/giu)).toHaveLength(1);
  });

  it('applies the attribution rule to non-voice responses too', () => {
    expect(sanitizeResponseAttribution('Action terminée. Source : web.', 'executor')).toBe('Action terminée.');
    expect(sanitizeResponseAttribution('Résultat trouvé. Source : web.', 'search')).toContain('Source : web.');
  });

  it('detects resume-last-mail intents', () => {
    expect(isLastMailSummaryRequest('resume le dernier mail')).toBe(true);
    expect(isLastMailSummaryRequest('continue le resume s il te plait')).toBe(true);
    expect(isLastMailSummaryRequest('quelle meteo demain')).toBe(false);
  });
});
