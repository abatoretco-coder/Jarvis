import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { InMemoryMessageRepository, InMemoryThreadRepository } from '../src/conversation/repositories/InMemoryRepositories';
import { SummarizationService } from '../src/conversation/SummarizationService';
import { completeOpenAiResponse } from '../src/openai/responsesClient';

jest.mock('../src/openai/responsesClient', () => ({
  completeOpenAiResponse: jest.fn(),
}));

const mockedComplete = completeOpenAiResponse as jest.MockedFunction<typeof completeOpenAiResponse>;

function service(llmApiKey?: string, warn = jest.fn()) {
  return {
    instance: new SummarizationService(
      new InMemoryThreadRepository(),
      new InMemoryMessageRepository(),
      {
        hotWindowK: 10,
        minDeltaM: 20,
        triggerEveryInteractions: 10,
        llmApiKey,
        llmBaseUrl: 'https://openai.test/v1',
        llmModel: 'test-model',
        llmTimeoutMs: 100,
        log: { warn },
      }
    ),
    warn,
  };
}

describe('conservative summary retention', () => {
  beforeEach(() => {
    mockedComplete.mockReset();
  });

  it.each([
    ['preference replacement', 'Préférence : café.', 'Utilisateur: correction, je préfère désormais le thé.'],
    ['date correction', 'Rendez-vous prévu lundi.', 'Utilisateur: correction, le rendez-vous est mardi.'],
    ['cancelled action', 'Action planifiée : envoyer le dossier.', "Utilisateur: annule l'envoi du dossier."],
  ])('keeps the latest %s when the summary is full', async (_name, oldFact, recentFact) => {
    const { instance } = service();
    const oldSummary = `${oldFact} ${'Contexte ancien. '.repeat(180)}`;

    const result = await instance.createIncrementalSummary(oldSummary, recentFact);

    expect(result.length).toBeLessThanOrEqual(2200);
    expect(result).toContain(recentFact);
    expect(result.endsWith(recentFact)).toBe(true);
  });

  it('retains several successive recent changes at the size limit', async () => {
    const { instance } = service();
    const changes = [
      'Utilisateur: la réunion est lundi.',
      'Utilisateur: correction, elle est mardi.',
      'Utilisateur: finalement elle est annulée.',
    ].join(' ');

    const result = await instance.createIncrementalSummary('Ancien contexte. '.repeat(200), changes);

    expect(result.length).toBeLessThanOrEqual(2200);
    expect(result).toContain('la réunion est lundi');
    expect(result).toContain('correction, elle est mardi');
    expect(result).toContain('finalement elle est annulée');
  });

  it('uses the same recent-first retention when the configured model is unavailable', async () => {
    const warn = jest.fn();
    const { instance } = service('configured-key', warn);
    mockedComplete.mockRejectedValue(new Error('summary_provider_unavailable'));
    const recent = 'Utilisateur: correction définitive, la date est le 20 octobre.';

    const result = await instance.createIncrementalSummary('Ancien contexte. '.repeat(200), recent);

    expect(result).toContain(recent);
    expect(result.endsWith(recent)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('uses the conservative merge when the configured model returns an empty summary', async () => {
    const { instance } = service('configured-key');
    mockedComplete.mockResolvedValue('');
    const recent = 'Utilisateur: correction définitive, la réunion est annulée.';

    const result = await instance.createIncrementalSummary('Ancien contexte. '.repeat(200), recent);

    expect(result).toContain(recent);
    expect(result.endsWith(recent)).toBe(true);
  });
});
