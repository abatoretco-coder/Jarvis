import { describe, expect, it } from '@jest/globals';

import { evaluateHighRiskE1Activation } from '../../src/routing/highRiskE1Activation';

describe('evaluateHighRiskE1Activation', () => {
  it('blocks when high-risk activation is disabled', () => {
    const result = evaluateHighRiskE1Activation({
      enabled: false,
      activatedRoutes: new Set(['mail.send_email']),
      routeKey: 'mail.send_email',
      top1Score: 0.98,
      margin: 0.25,
      acceptScore: 0.9,
      minMargin: 0.12,
    });

    expect(result).toEqual({ allowed: false, decision: 'blocked_activation_disabled' });
  });

  it('blocks when route is not allowlisted', () => {
    const result = evaluateHighRiskE1Activation({
      enabled: true,
      activatedRoutes: new Set(['mail.reply_email']),
      routeKey: 'mail.send_email',
      top1Score: 0.98,
      margin: 0.25,
      acceptScore: 0.9,
      minMargin: 0.12,
    });

    expect(result).toEqual({ allowed: false, decision: 'blocked_not_allowlisted' });
  });

  it('blocks when score is below threshold', () => {
    const result = evaluateHighRiskE1Activation({
      enabled: true,
      activatedRoutes: new Set(['mail.send_email']),
      routeKey: 'mail.send_email',
      top1Score: 0.89,
      margin: 0.25,
      acceptScore: 0.9,
      minMargin: 0.12,
    });

    expect(result).toEqual({ allowed: false, decision: 'blocked_thresholds' });
  });

  it('blocks when margin is below threshold', () => {
    const result = evaluateHighRiskE1Activation({
      enabled: true,
      activatedRoutes: new Set(['mail.send_email']),
      routeKey: 'mail.send_email',
      top1Score: 0.95,
      margin: 0.11,
      acceptScore: 0.9,
      minMargin: 0.12,
    });

    expect(result).toEqual({ allowed: false, decision: 'blocked_thresholds' });
  });

  it('allows when all constraints are satisfied', () => {
    const result = evaluateHighRiskE1Activation({
      enabled: true,
      activatedRoutes: new Set(['mail.send_email']),
      routeKey: 'mail.send_email',
      top1Score: 0.96,
      margin: 0.2,
      acceptScore: 0.9,
      minMargin: 0.12,
    });

    expect(result).toEqual({ allowed: true, decision: 'allowed' });
  });
});
