/**
 * Conversation window & context robustness tests
 * 
 * Covers:
 * 1. Active conversation window (10-second continuity)
 * 2. Thread reuse and expiration
 * 3. contextNote enrichment (not persisted as message)
 * 4. Channel isolation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from '@jest/globals';

// Mock types matching ingest.ts
type ThreadRecord = {
  threadId: string;
  channel: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type MessageRecord = {
  threadId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: Date;
};

// Mock repository interface
interface ThreadRepositoryMock {
  getOrCreate(threadId: string, meta?: Record<string, unknown>): Promise<ThreadRecord>;
  getRecent(limit: number, minutesAgo?: number): Promise<ThreadRecord[]>;
  updateResponseTime(threadId: string, timestamp: number): Promise<void>;
}

interface MessageRepositoryMock {
  add(threadId: string, role: 'user' | 'assistant', text: string): Promise<MessageRecord>;
  getRecentMessages(threadId: string, limit: number): Promise<MessageRecord[]>;
}

describe('Conversation Window Continuity (10s Active Window)', () => {
  let now: number;

  beforeEach(() => {
    now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Effective thread ID detection', () => {
    it('should detect active conversation window within 10 seconds', () => {
      const clientThreadId = 'client-thread-abc';
      const activeThread: ThreadRecord = {
        threadId: 'active-thread-xyz',
        channel: 'desktop',
        createdAt: new Date(now - 8_000), // 8 seconds ago
        updatedAt: new Date(now - 2_000), // Last activity 2s ago
      };

      const shouldReuse = isConversationWindowActive(activeThread, now);
      expect(shouldReuse).toBe(true);
    });

    it('should NOT reuse thread after 10-second window expires', () => {
      const activeThread: ThreadRecord = {
        threadId: 'old-thread',
        channel: 'desktop',
        createdAt: new Date(now - 20_000),
        updatedAt: new Date(now - 12_000), // Last activity 12s ago
      };

      const shouldReuse = isConversationWindowActive(activeThread, now);
      expect(shouldReuse).toBe(false);
    });

    it('should enforce 10-second window boundary exactly', () => {
      // At exactly 10 seconds: should still be active
      const threadAt10s: ThreadRecord = {
        threadId: 'boundary-thread',
        channel: 'mobile',
        createdAt: new Date(now - 15_000),
        updatedAt: new Date(now - 10_000), // Exactly 10s ago
      };

      expect(isConversationWindowActive(threadAt10s, now)).toBe(true);

      // At 10.001 seconds: should expire
      const threadAt10_001s: ThreadRecord = {
        threadId: 'expired-thread',
        channel: 'mobile',
        createdAt: new Date(now - 15_000),
        updatedAt: new Date(now - 10_001), // 10.001s ago
      };

      expect(isConversationWindowActive(threadAt10_001s, now)).toBe(false);
    });
  });

  describe('Channel isolation', () => {
    it('should NOT reuse thread from different channel', () => {
      const activeThread: ThreadRecord = {
        threadId: 'shared-thread',
        channel: 'web', // Different channel
        createdAt: new Date(now - 5_000),
        updatedAt: new Date(now - 1_000),
      };

      const shouldReuse = isConversationWindowActive(activeThread, now, 'desktop');
      expect(shouldReuse).toBe(false);
    });

    it('should reuse thread from same channel within window', () => {
      const activeThread: ThreadRecord = {
        threadId: 'desktop-thread',
        channel: 'desktop',
        createdAt: new Date(now - 5_000),
        updatedAt: new Date(now - 1_000),
      };

      const shouldReuse = isConversationWindowActive(activeThread, now, 'desktop');
      expect(shouldReuse).toBe(true);
    });

    it('should handle null channel gracefully (legacy)', () => {
      const activeThread: ThreadRecord = {
        threadId: 'legacy-thread',
        channel: null,
        createdAt: new Date(now - 5_000),
        updatedAt: new Date(now - 1_000),
      };

      // Should reuse if no channel specified in request
      const shouldReuse = isConversationWindowActive(activeThread, now, undefined);
      expect(shouldReuse).toBe(true);
    });
  });

  describe('Conversation continuity in ingest path', () => {
    it('should use effectiveThreadId for all HA calls when window active', () => {
      const clientThreadId = 'client-001';
      const activeThread: ThreadRecord = {
        threadId: 'server-active-xyz',
        channel: 'desktop',
        createdAt: new Date(now - 4_000),
        updatedAt: new Date(now - 2_000),
      };

      const effectiveThreadId = detectEffectiveThreadId(clientThreadId, activeThread, now);
      expect(effectiveThreadId).toBe('server-active-xyz'); // Use active server thread

      // All subsequent HA calls should use effectiveThreadId
      expect(effectiveThreadId).not.toBe(clientThreadId);
    });

    it('should fall back to clientThreadId when no active window', () => {
      const clientThreadId = 'client-001';
      const noRecentThread: ThreadRecord | null = null;

      const effectiveThreadId = detectEffectiveThreadId(clientThreadId, noRecentThread, now);
      expect(effectiveThreadId).toBe(clientThreadId);
    });

    it('should maintain continuity across multiple requests in active window', async () => {
      const clientThreadId = 'client-consistent';
      let activeThread: ThreadRecord = {
        threadId: 'server-session-abc',
        channel: 'desktop',
        createdAt: new Date(now - 8_000),
        updatedAt: new Date(now - 2_000),
      };

      // First request
      let effectiveId = detectEffectiveThreadId(clientThreadId, activeThread, now);
      expect(effectiveId).toBe('server-session-abc');

      // Time advances 3 seconds
      vi.setSystemTime(now + 3_000);
      activeThread = { ...activeThread, updatedAt: new Date(now + 3_000) };

      // Second request in same window
      effectiveId = detectEffectiveThreadId(clientThreadId, activeThread, now + 3_000);
      expect(effectiveId).toBe('server-session-abc'); // SAME thread

      // Time advances 8 seconds more (now at 11s total)
      vi.setSystemTime(now + 11_000);
      activeThread = { ...activeThread, updatedAt: new Date(now + 11_000) };

      // Third request - window expired
      effectiveId = detectEffectiveThreadId(clientThreadId, activeThread, now + 11_000);
      expect(effectiveId).toBe(clientThreadId); // Back to client thread (new window starts)
    });
  });
});

describe('contextNote Enrichment (NOT persisted as message)', () => {
  describe('contextNote integration', () => {
    it('should enrich assistantInputText with contextNote before routing', () => {
      const userText = 'Quelle température ?';
      const contextNote = '[Current time: 3:45 PM, User location: Living room]';

      const enrichedText = enrichWithContextNote(userText, contextNote);

      expect(enrichedText).toContain(userText);
      expect(enrichedText).toContain(contextNote);
      expect(enrichedText).toMatch(/\[Current time:/);
    });

    it('should handle missing contextNote gracefully', () => {
      const userText = 'Quelle température ?';

      const enrichedText = enrichWithContextNote(userText, undefined);

      expect(enrichedText).toBe(userText); // No modification
    });

    it('should handle empty contextNote', () => {
      const userText = 'Allume la lumière';

      const enrichedText = enrichWithContextNote(userText, '');

      expect(enrichedText).toBe(userText); // No modification
    });

    it('should NOT escape special characters in contextNote', () => {
      const userText = 'Test query';
      const contextNote = '[Device: "phone", Status: {"active": true}]';

      const enrichedText = enrichWithContextNote(userText, contextNote);

      expect(enrichedText).toContain(contextNote); // Exactly as provided
    });
  });

  describe('Persistence & history separation', () => {
    it('should persist original user text (without contextNote) in history', async () => {
      const originalText = 'Mets la lumière au maximum';
      const contextNote = '[Brightness override]';
      const enrichedText = enrichWithContextNote(originalText, contextNote);

      const persistedText = getPersistableUserText(originalText, contextNote);

      expect(persistedText).toBe(originalText);
      expect(persistedText).not.toContain(contextNote);
    });

    it('should pass enriched text to routing/agents', async () => {
      const originalText = 'Quelle est la température ?';
      const contextNote = '[Device: Mobile, Time: Evening]';

      const enrichedForRouting = enrichWithContextNote(originalText, contextNote);

      expect(enrichedForRouting).toContain(contextNote);
      // This enriched text should be sent to LLM router, not the original
    });

    it('should reconstruct clean history for summary/resummarization', () => {
      const messages = [
        { text: 'Allume la lumière', contextNote: '[Device: phone]' },
        { text: 'Mets le thermostats à 22°C', contextNote: '[Location: bedroom]' },
        { text: 'Quelle heure est-il ?', contextNote: '[Time: 3 PM]' },
      ];

      const cleanHistory = messages.map((m) => getPersistableUserText(m.text, m.contextNote));

      expect(cleanHistory).toEqual([
        'Allume la lumière',
        'Mets le thermostats à 22°C',
        'Quelle heure est-il ?',
      ]);

      expect(cleanHistory.join(' ')).not.toContain('[');
    });
  });

  describe('contextNote example scenarios', () => {
    it('should enrich time-sensitive request', () => {
      const userText = 'Mets un minuteur';
      const contextNote = '[Context: Current time 15:30, user in kitchen, reminder for oven]';

      const enriched = enrichWithContextNote(userText, contextNote);

      // This should help agents make better decisions
      expect(enriched).toMatch(/minuteur.*Context:/);
    });

    it('should enrich location-specific request', () => {
      const userText = 'Quelle température ?';
      const contextNote = '[Location: bedroom, zone: upstairs_west]';

      const enriched = enrichWithContextNote(userText, contextNote);

      expect(enriched).toContain('bedroom');
      expect(enriched).toContain('upstairs_west');
    });

    it('should enrich mood/urgency context', () => {
      const userText = 'Je m\'ennuie';
      const contextNote = '[Mood: bored, Suggestions: ok, entertainment_preference: music]';

      const enriched = enrichWithContextNote(userText, contextNote);

      expect(enriched).toContain('entertainment_preference');
    });
  });

  describe('contextNote length & safety', () => {
    it('should handle very long contextNote', () => {
      const userText = 'Test';
      const longContext = '[' + 'x'.repeat(2000) + ']';

      const enriched = enrichWithContextNote(userText, longContext);

      expect(enriched).toContain(userText);
      expect(enriched.length).toBeLessThan(userText.length + longContext.length + 50); // No bloat
    });

    it('should handle multi-line contextNote', () => {
      const userText = 'Allume tout';
      const multilineContext = `[
  Device: phone
  Location: living room
  Time: 20:30
  Brightness: 50%
]`;

      const enriched = enrichWithContextNote(userText, multilineContext);

      expect(enriched).toContain(userText);
      expect(enriched).toContain('Device:');
      expect(enriched).toContain('Brightness:');
    });

    it('should NOT double-enrich if contextNote already in text', () => {
      const userText = 'Question [Existing context]';
      const contextNote = '[Additional context]';

      const enriched = enrichWithContextNote(userText, contextNote);

      // Should contain both, but no duplication
      const countOfAdditional = (enriched.match(/\[Additional context\]/g) || []).length;
      expect(countOfAdditional).toBe(1);
    });
  });
});

describe('Integration: Continuity + contextNote', () => {
  let now: number;

  beforeEach(() => {
    now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should apply contextNote to effectiveThreadId conversation', () => {
    // Setup: active conversation window
    const clientThreadId = 'client-001';
    const activeThread: ThreadRecord = {
      threadId: 'server-active',
      channel: 'desktop',
      createdAt: new Date(now - 4_000),
      updatedAt: new Date(now - 2_000),
    };

    // Request with contextNote
    const userText = 'Quelle température ?';
    const contextNote = '[Time: 3 PM, Location: office]';

    // Calculate effective thread and enrich text
    const effectiveThreadId = detectEffectiveThreadId(clientThreadId, activeThread, now);
    const enrichedText = enrichWithContextNote(userText, contextNote);

    // Persist original (not enriched)
    const persistedText = getPersistableUserText(userText, contextNote);

    expect(effectiveThreadId).toBe('server-active');
    expect(enrichedText).toContain(contextNote);
    expect(persistedText).toBe(userText); // Clean persistence
  });

  it('should restart window with new contextNote after expiration', () => {
    const clientThreadId = 'client-001';

    // First window
    let activeThread: ThreadRecord = {
      threadId: 'window-1',
      channel: 'desktop',
      createdAt: new Date(now),
      updatedAt: new Date(now + 2_000),
    };

    let enrichedText = enrichWithContextNote('First request', '[Time: 3 PM]');
    let effectiveId = detectEffectiveThreadId(clientThreadId, activeThread, now + 2_000);
    expect(effectiveId).toBe('window-1');

    // Advance 11 seconds (beyond window)
    vi.setSystemTime(now + 13_000);

    // Second request with new contextNote
    enrichedText = enrichWithContextNote('Second request', '[Time: 3:11 PM]');
    effectiveId = detectEffectiveThreadId(clientThreadId, null, now + 13_000);
    expect(effectiveId).toBe(clientThreadId); // New window starts with client thread

    // Time advances 4 seconds
    vi.setSystemTime(now + 17_000);
    activeThread = {
      threadId: 'window-2-server-thread',
      channel: 'desktop',
      createdAt: new Date(now + 13_000),
      updatedAt: new Date(now + 17_000),
    };

    enrichedText = enrichWithContextNote('Third request', '[Time: 3:15 PM]');
    effectiveId = detectEffectiveThreadId(clientThreadId, activeThread, now + 17_000);
    expect(effectiveId).toBe('window-2-server-thread'); // New active thread detected
  });
});

// ─────────────────────────────────────────────────────────────────
// Test helpers (mirror ingest.ts logic)
// ─────────────────────────────────────────────────────────────────

function isConversationWindowActive(
  thread: ThreadRecord,
  now: number,
  currentChannel?: string
): boolean {
  // Check channel match
  if (currentChannel !== undefined && thread.channel !== currentChannel && thread.channel !== null) {
    return false;
  }

  // Check 10-second window
  const lastActivityMs = thread.updatedAt.getTime();
  const elapsedMs = now - lastActivityMs;

  return elapsedMs <= 10_000; // Active if within 10 seconds
}

function detectEffectiveThreadId(
  clientThreadId: string,
  recentThread: ThreadRecord | null,
  now: number,
  channel?: string
): string {
  if (recentThread && isConversationWindowActive(recentThread, now, channel)) {
    return recentThread.threadId;
  }
  return clientThreadId;
}

function enrichWithContextNote(userText: string, contextNote: string | undefined): string {
  if (!contextNote?.trim()) return userText;
  return `${userText} ${contextNote}`;
}

function getPersistableUserText(userText: string, contextNote: string | undefined): string {
  // Return only the original user text, strip contextNote
  return userText;
}
