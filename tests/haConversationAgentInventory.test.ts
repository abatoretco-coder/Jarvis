import { HaConversationAgentInventory } from '../src/conversation/HaConversationAgentInventory';

describe('HaConversationAgentInventory', () => {
  test('reports only conversation entities returned by Home Assistant', async () => {
    const getStates = jest
      .fn()
      .mockResolvedValue([
        { entity_id: 'conversation.home_assistant' },
        { entity_id: 'conversation.valid_agent' },
        { entity_id: 'light.salon' },
        { entity_id: '' },
      ]);
    const inventory = new HaConversationAgentInventory({ getStates });

    const snapshot = await inventory.getSnapshot();

    expect(snapshot.available).toBe(true);
    expect(snapshot.agentIds).toEqual(['conversation.home_assistant', 'conversation.valid_agent']);
    expect(inventory.isEntityStyleAgentAvailable('conversation.valid_agent', snapshot)).toBe(true);
    expect(inventory.isEntityStyleAgentAvailable('conversation.missing', snapshot)).toBe(false);
  });

  test('does not reject opaque Home Assistant agent identifiers', async () => {
    const inventory = new HaConversationAgentInventory({
      getStates: jest.fn().mockResolvedValue([{ entity_id: 'conversation.home_assistant' }]),
    });
    const snapshot = await inventory.getSnapshot();

    expect(
      inventory.isEntityStyleAgentAvailable('01M4C7GJF1T184B9VEEA0Q41MP', snapshot)
    ).toBeUndefined();
  });

  test('coalesces concurrent reads and uses a bounded cache', async () => {
    let resolveStates: ((value: unknown) => void) | undefined;
    const getStates = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStates = resolve;
        })
    );
    const inventory = new HaConversationAgentInventory({ getStates }, { ttlMs: 60_000 });

    const first = inventory.getSnapshot();
    const second = inventory.getSnapshot();
    resolveStates?.([{ entity_id: 'conversation.home_assistant' }]);

    await expect(first).resolves.toMatchObject({ available: true });
    await expect(second).resolves.toMatchObject({ available: true });
    await inventory.getSnapshot();
    expect(getStates).toHaveBeenCalledTimes(1);
  });

  test('fails closed for entity-style identifiers when inventory is unavailable', async () => {
    const inventory = new HaConversationAgentInventory({
      getStates: jest.fn().mockRejectedValue(new Error('ha unavailable')),
    });

    const snapshot = await inventory.getSnapshot();

    expect(snapshot).toMatchObject({ available: false, agentIds: [] });
    expect(inventory.isEntityStyleAgentAvailable('conversation.stale', snapshot)).toBe(false);
  });
});
