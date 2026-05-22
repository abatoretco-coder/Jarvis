# General Agent (HA Fallback)

## Scope
Last-resort general Home Assistant conversation agent.

## Detection
This is not a primary target. It is used only when:
1. Router is disabled or fails.
2. No valid specialized targets remain after threshold filtering.
3. Specialized tasks produce no usable result.

## Routing Path
1. Fallback to HA_AGENT_GENERAL only.
2. No parallel hidden fallback chain is used before specialized resolution.

## Execution
1. conversationService.callHomeAssistantConversation with generalAgentId.
2. OUT_OF_SCOPE is converted into deterministic guidance text.

## Response Construction
1. replyMeta.kind is general.
2. replyMeta.source is semantic_router, router_or_specialized, or ha_general depending on path.
3. fallbackReason is general_fallback when fallback was required.

## Main References
- src/routes/ingest.ts
- src/env.ts
- src/conversation/ConversationService.ts
