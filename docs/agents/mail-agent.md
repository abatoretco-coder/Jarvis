# Mail Agent

## Scope
Email actions across Gmail and Outlook accounts (list, read, send, reply, flag, search, etc.).

## Detection
1. Key-based detection from HA_AGENT_MAP using isMailAgentKey.
2. Semantic E1 mail routes can dispatch directly through e1RouteDispatcher.
3. Router LLM can also return mail target.

## Routing Path
1. Direct specialized execution (bypass Home Assistant).
2. E1 accepted route -> dispatchAcceptedE1Route -> callMailAgent.

## Execution
1. callMailAgent validates account config and OpenAI key.
2. Optional deterministic preclassification handles obvious mail intents.
3. Planner maps user text to mail action.
4. Action executes against Gmail or Outlook APIs.
5. Some list/search actions aggregate across multiple accounts.

## Response Construction
1. Returns operation text and summaries.
2. Domain set to mail for voice formatting.
3. Mail state is persisted for voice follow-up summary behavior.

## Main References
- src/mail/mailAgent.ts
- src/routes/ingest.ts
- src/routing/e1RouteDispatcher.ts
- src/conversation/voiceUx.ts
