import { describe, expect, it } from '@jest/globals';

import { CAPABILITY_REGISTRY } from '../src/capabilities/capabilityRegistry';
import {
  buildAvailableRouterAgents,
  ROUTER_EXPOSURE_BY_AGENT,
} from '../src/conversation/routerAgentCatalog';

describe('canonical router agent catalog', () => {
  it('exposes only direct agents that are available for the current request', () => {
    const entries = buildAvailableRouterAgents({
      availability: { calendar: true, mail: true, search: true, todo: false },
      runtimeEntries: [],
      configuredEntries: [],
    });

    expect(entries.map((entry) => entry.routerId)).toEqual([
      'calendar',
      'mail',
      'search.news',
      'search.web',
      'search.deep',
    ]);
  });

  it('does not let HA_AGENT_MAP shadow or enable a canonical direct agent', () => {
    const entries = buildAvailableRouterAgents({
      availability: { calendar: false, mail: false, search: false, todo: false },
      runtimeEntries: [],
      configuredEntries: [
        { agentId: 'calendar', key: 'calendar', hint: 'stale calendar config' },
        { agentId: 'conversation.legacy_executor', key: 'executors', hint: 'legacy utilities' },
      ],
    });

    expect(entries).toEqual([
      { agentId: 'conversation.legacy_executor', key: 'executors', hint: 'legacy utilities' },
    ]);
  });

  it('declares an exposure strategy for every canonical capability family', () => {
    const families = new Set(CAPABILITY_REGISTRY.map((capability) => capability.agent));
    for (const family of families) expect(ROUTER_EXPOSURE_BY_AGENT[family]).toBeDefined();
  });
});
