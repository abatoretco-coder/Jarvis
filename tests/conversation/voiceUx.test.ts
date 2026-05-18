import { describe, expect, it } from '@jest/globals';

import {
  buildLastMailSummaryFromState,
  extractMailStateFromReply,
  formatVoiceResponse,
  isLastMailSummaryRequest,
  resolveVoiceResponseMode,
} from '../../src/conversation/voiceUx';

describe('voiceUx', () => {
  it('detects detailed mode from user request', () => {
    const mode = resolveVoiceResponseMode({ text: 'detaille la reponse stp' });
    expect(mode).toBe('detailed');
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
      gracefulFallback: false,
    });
    expect(out).toContain('Actions proposees');
    expect(out).toContain('Tu as 5 non lus');
  });

  it('detects resume-last-mail intents', () => {
    expect(isLastMailSummaryRequest('resume le dernier mail')).toBe(true);
    expect(isLastMailSummaryRequest('continue le resume s il te plait')).toBe(true);
    expect(isLastMailSummaryRequest('quelle meteo demain')).toBe(false);
  });
});
