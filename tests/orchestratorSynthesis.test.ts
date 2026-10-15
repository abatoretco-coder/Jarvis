import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ConversationService } from '../src/conversation/ConversationService';
import { synthesizeAgentResponses } from '../src/conversation/orchestratorRouter';
import { InMemoryMessageRepository, InMemoryThreadRepository } from '../src/conversation/repositories/InMemoryRepositories';
import { formatVoiceResponse } from '../src/conversation/voiceUx';
import { completeOpenAiResponse } from '../src/openai/responsesClient';

jest.mock('../src/openai/responsesClient', () => ({
  completeOpenAiResponse: jest.fn(),
}));

const mockedComplete = completeOpenAiResponse as jest.MockedFunction<typeof completeOpenAiResponse>;

function synthesize(parts: { agentId: string; text: string }[]) {
  return synthesizeAgentResponses({
    userText: 'Traite toutes les demandes.',
    parts,
    options: {
      openAiApiKey: 'test-key',
      openAiBaseUrl: 'https://openai.test/v1',
      model: 'test-model',
      timeoutMs: 100,
    },
  });
}

describe('multi-agent synthesis fidelity', () => {
  beforeEach(() => {
    mockedComplete.mockRejectedValue(new Error('synthesis_unavailable'));
  });

  it.each([
    {
      name: 'one success and one unavailable agent',
      parts: [
        { agentId: 'calendar', text: 'Le rendez-vous est créé. Il aura lieu mardi à 9 heures.' },
        { agentId: 'mail', text: "Le service mail est indisponible. Aucun email n'a été envoyé." },
      ],
      expected: ['mardi à 9 heures', 'Aucun email'],
    },
    {
      name: 'partial results',
      parts: [
        { agentId: 'home', text: 'Résultat partiel : la lampe est éteinte. Le chauffage n’a pas répondu.' },
        { agentId: 'weather', text: 'Il fera 18 degrés. Attention, pluie après 16 heures.' },
      ],
      expected: ['Résultat partiel', 'chauffage n’a pas répondu', 'pluie après 16 heures'],
    },
    {
      name: 'accepted mutation without confirmation',
      parts: [
        { agentId: 'home', text: 'Commande acceptée. Elle a été envoyée sans confirmation.' },
        { agentId: 'calendar', text: 'Le calendrier est accessible.' },
      ],
      expected: ['Commande acceptée', 'sans confirmation', 'calendrier est accessible'],
    },
    {
      name: 'failure after a positive result',
      parts: [
        { agentId: 'home', text: 'La lampe du salon est éteinte. Impossible de couper la télévision.' },
        { agentId: 'todo', text: 'La tâche a été ajoutée.' },
      ],
      expected: ['lampe du salon est éteinte', 'Impossible de couper', 'tâche a été ajoutée'],
    },
    {
      name: 'condition in the final sentence',
      parts: [
        { agentId: 'calendar', text: 'Le créneau est libre. La réservation reste possible uniquement avant 18 heures.' },
        { agentId: 'weather', text: 'La météo sera calme.' },
      ],
      expected: ['créneau est libre', 'uniquement avant 18 heures', 'météo sera calme'],
    },
    {
      name: 'contradictory results',
      parts: [
        { agentId: 'home-a', text: 'La porte est verrouillée.' },
        { agentId: 'home-b', text: 'La porte n’est pas verrouillée. Vérification nécessaire.' },
      ],
      expected: ['porte est verrouillée', 'porte n’est pas verrouillée', 'Vérification nécessaire'],
    },
  ])('keeps every critical fact for $name', async ({ parts, expected }) => {
    const result = await synthesize(parts);

    for (const fact of expected) expect(result).toContain(fact);
  });

  it('rejects an optimistic model synthesis when a risky source fact would be lost', async () => {
    mockedComplete.mockResolvedValue('Tout est terminé avec succès.');

    const result = await synthesize([
      { agentId: 'home', text: 'La lumière est éteinte. La télévision reste dans un état incertain.' },
      { agentId: 'todo', text: 'La tâche est créée.' },
    ]);

    expect(result).toContain('état incertain');
    expect(result).not.toBe('Tout est terminé avec succès.');
    expect(mockedComplete).not.toHaveBeenCalled();
  });

  it('keeps the same business facts in display, speech, and persisted memory', async () => {
    const displayText = await synthesize([
      { agentId: 'home', text: 'La lumière est éteinte. La télévision reste dans un état incertain.' },
      { agentId: 'calendar', text: 'Le rendez-vous est créé mardi. Attention, il reste à confirmer.' },
    ]);
    const spokenText = formatVoiceResponse({ text: displayText, domain: 'general', mode: 'normal' });
    const threads = new InMemoryThreadRepository();
    const messages = new InMemoryMessageRepository();
    const conversation = new ConversationService(threads, messages, {
      haBaseUrl: '',
      haToken: '',
      requestTimeoutMs: 100,
      minIntervalMs: 0,
      retryCount: 0,
      retryDelayMs: 0,
    });

    await conversation.persistMessages('thread-fidelity', 'Éteins la lumière et crée le rendez-vous.', displayText, {
      spokenText,
      rawText: displayText,
      decisionMetadata: { schemaVersion: 1, operationStatus: 'uncertain' },
    });
    const persisted = await messages.getRecentMessages('thread-fidelity', 2);
    const assistant = persisted[1];

    for (const fact of [
      'lumière est éteinte',
      'état incertain',
      'rendez-vous est créé mardi',
      'reste à confirmer',
    ]) {
      expect(displayText).toContain(fact);
      expect(spokenText).toContain(fact);
      expect(assistant?.content).toContain(fact);
      expect(assistant?.spokenContent).toContain(fact);
    }
    expect(assistant?.decisionMetadata?.operationStatus).toBe('uncertain');
  });
});
