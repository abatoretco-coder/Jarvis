import { describe, expect, it } from '@jest/globals';

import { buildOrchestratorUserPrompt } from '../src/conversation/prompts/orchestratorUserTemplate';

describe('orchestrator contextual prompt', () => {
  it('carries structured routing metadata from prior turns', () => {
    const prompt = buildOrchestratorUserPrompt({
      text: 'Et fais pareil le samedi d’avant.',
      agents: [{ agentId: 'calendar', routerId: 'calendar', key: 'calendar', hint: 'Agenda' }],
      recentMessages: [
        {
          threadId: 'thread',
          seq: 1,
          role: 'assistant',
          content: "C'est ajouté dans ton agenda.",
          createdAtMs: 1,
          decisionMetadata: {
            schemaVersion: 1,
            kind: 'calendar',
            routeKey: 'calendar.create_event',
            operationStatus: 'executed',
          },
        },
      ],
    });

    expect(prompt).toContain('domaine=calendar');
    expect(prompt).toContain('route=calendar.create_event');
    expect(prompt).toContain('statut=executed');
  });
});
