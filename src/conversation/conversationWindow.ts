export type ActiveConversationThreadLike = {
  threadId: string;
};

export function detectEffectiveThreadId(
  clientThreadId: string,
  activeThread: ActiveConversationThreadLike | null | undefined,
): string {
  return activeThread?.threadId ?? clientThreadId;
}
