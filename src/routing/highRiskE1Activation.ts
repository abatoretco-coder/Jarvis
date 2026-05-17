type HighRiskE1ActivationInput = {
  enabled: boolean;
  activatedRoutes: Set<string>;
  routeKey: string;
  top1Score: number;
  margin: number;
  acceptScore: number;
  minMargin: number;
};

export type HighRiskE1ActivationDecision =
  | 'allowed'
  | 'blocked_activation_disabled'
  | 'blocked_not_allowlisted'
  | 'blocked_thresholds';

export function evaluateHighRiskE1Activation(input: HighRiskE1ActivationInput): {
  allowed: boolean;
  decision: HighRiskE1ActivationDecision;
} {
  if (!input.enabled) {
    return { allowed: false, decision: 'blocked_activation_disabled' };
  }
  if (!input.activatedRoutes.has(input.routeKey)) {
    return { allowed: false, decision: 'blocked_not_allowlisted' };
  }
  if (input.top1Score < input.acceptScore || input.margin < input.minMargin) {
    return { allowed: false, decision: 'blocked_thresholds' };
  }
  return { allowed: true, decision: 'allowed' };
}
