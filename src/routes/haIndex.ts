import type { FastifyInstance } from 'fastify';

import { isHassState } from '../hass';
import type { AppDeps } from '../server';

export function registerHaIndexRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/ha/index', async (req, reply) => {
    if (!deps.env.EXPOSE_HA_INDEX) {
      return reply.code(404).send({ error: 'not_found' });
    }

    if (!deps.ha) {
      return reply.code(503).send({ error: 'ha_not_configured' });
    }

    const q = req.query as unknown;
    const domainFilter = (() => {
      if (!q || typeof q !== 'object' || Array.isArray(q)) return '';
      const v = (q as Record<string, unknown>).domain;
      return typeof v === 'string' ? v.trim() : '';
    })();

    const statesRaw = await deps.ha.getStates();
    const states = Array.isArray(statesRaw) ? statesRaw : [];

    const items = states
      .filter((s) => isHassState(s))
      .filter((s) => {
        if (!domainFilter) return true;
        return s.entity_id.split('.')[0] === domainFilter;
      })
      .map((s) => {
        const attrs = typeof s.attributes === 'object' && s.attributes ? (s.attributes as Record<string, unknown>) : {};
        const name = typeof attrs.friendly_name === 'string' ? attrs.friendly_name : undefined;
        const domain = s.entity_id.split('.')[0];
        return { entity_id: s.entity_id, domain, name, state: s.state };
      })
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));

    return reply.code(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      count: items.length,
      items,
    });
  });
}
