export type HassState = {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
};

export function isHassState(x: unknown): x is HassState {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  return typeof (x as Record<string, unknown>).entity_id === 'string' && typeof (x as Record<string, unknown>).state === 'string';
}
