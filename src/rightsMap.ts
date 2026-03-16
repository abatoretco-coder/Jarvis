import { z } from 'zod';

import type { Env } from './env';

type RightsDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'rights_map_missing' | 'rights_map_invalid' | 'not_allowed' | 'missing_entity_id_target';
      details?: Record<string, unknown>;
    };

const ruleSchema = z.object({
  domain: z.string().min(1),
  services: z.union([z.literal('*'), z.array(z.string().min(1)).min(1)]).optional(),
  entityIds: z.union([z.literal('*'), z.array(z.string().min(1)).min(1)]).optional(),
  allowNoTarget: z.boolean().optional(),
});

const rightsMapSchema = z.object({
  version: z.number().int().positive().default(1),
  default: z.enum(['deny', 'allow']).default('deny'),
  allow: z.array(ruleSchema).default([]),
});

export type RightsMap = z.infer<typeof rightsMapSchema>;

export type RightsContext = {
  enforced: boolean;
  map?: RightsMap;
  invalid?: string;
};

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = '^' + escaped.replace(/\*/g, '.*') + '$';
  return new RegExp(re, 'i');
}

function matches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.includes('*')) return globToRegExp(pattern).test(value);
  return pattern.toLowerCase() === value.toLowerCase();
}

function extractEntityIds(target?: Record<string, unknown>): string[] {
  if (!target) return [];
  const raw = (target as Record<string, unknown>).entity_id;
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  if (Array.isArray(raw)) {
    return raw
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function buildRightsContext(env: Env): RightsContext {
  const enforced = Boolean(env.ENFORCE_RIGHTS_MAP);
  if (!enforced) return { enforced: false };

  const raw = (env.RIGHTS_MAP_JSON ?? '').trim();
  if (!raw) return { enforced: true, invalid: 'RIGHTS_MAP_JSON is missing' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { enforced: true, invalid: 'RIGHTS_MAP_JSON is not valid JSON' };
  }

  const r = rightsMapSchema.safeParse(parsed);
  if (!r.success) {
    return {
      enforced: true,
      invalid: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  return { enforced: true, map: r.data };
}

export function checkHaServiceCallAllowed(
  rights: RightsContext,
  input: { domain: string; service: string; target?: Record<string, unknown> }
): RightsDecision {
  if (!rights.enforced) return { ok: true };

  if (rights.invalid) {
    return {
      ok: false,
      reason: rights.invalid.includes('missing') ? 'rights_map_missing' : 'rights_map_invalid',
      details: { error: rights.invalid },
    };
  }

  const map = rights.map;
  if (!map) return { ok: false, reason: 'rights_map_missing' };

  const entityIds = extractEntityIds(input.target);
  const hasEntityTarget = entityIds.length > 0;

  const allowNoTargetFallback = true;

  const allowMatch = map.allow.find((rule) => {
    if (!matches(rule.domain, input.domain)) return false;

    const services = rule.services ?? '*';
    const serviceAllowed = services === '*' || services.some((s) => matches(s, input.service));
    if (!serviceAllowed) return false;

    if (!hasEntityTarget) {
      const allowNoTarget = rule.allowNoTarget ?? (rule.entityIds ? false : allowNoTargetFallback);
      return allowNoTarget;
    }

    const entityPatterns = rule.entityIds;
    if (!entityPatterns || entityPatterns === '*') return true;
    return entityIds.every((id) => entityPatterns.some((p) => matches(p, id)));
  });

  if (allowMatch) return { ok: true };

  if (input.target && !hasEntityTarget) {
    return { ok: false, reason: 'missing_entity_id_target', details: { targetKeys: Object.keys(input.target) } };
  }

  return {
    ok: false,
    reason: 'not_allowed',
    details: { domain: input.domain, service: input.service, entityIds },
  };
}
