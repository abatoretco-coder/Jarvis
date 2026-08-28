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

## Mail Qualification
Jarvis qualifies each recent email before deciding whether to mention it in a briefing or conversational answer.

Categories:
1. `ignore`: keep visible in the dashboard, but do not mention in briefings or mail summaries.
2. `info`: useful information to share when relevant.
3. `action`: requires a reply, task, follow-up, validation, or security/developer attention.

Each qualification may include:
1. `urgency`: `low`, `medium`, or `high`.
2. `confidence`: numeric confidence from 0 to 1.
3. `recommendedAction`: `none`, `reply`, `create_task`, `remind_later`, `ask_user`, or `archive`.
4. `ruleId`: stable id of the personal rule that matched.
5. `groupKey`: aggregation key used to group repeated alerts, such as GitHub CI failures.

Dashboard behavior is intentionally different from briefing behavior:
1. Dashboard keeps showing all recent inbox messages so the user can quickly delete or archive noise.
2. Dashboard prefixes rows with `Action`, `Info`, or `Ignore`.
3. Briefing and conversational summaries suppress `ignore` messages.

## Personal Rules
Current rules live in `src/mail/mailQualification.ts` as `PERSONAL_RULES`.

Rules inferred from the mailbox scan:
1. `ignore.fnac.marketing`: `info@fnac.com` is recurring commercial content.
2. `ignore.booking.campaigns`: `email.campaign@sg.booking.com` is Booking marketing/Genius offers.
3. `ignore.sncf.marketing`: SNCF Connect newsletter subjects about summer/games/correspondences.
4. `ignore.uber.receipts`: Uber Eats receipts are not mentioned in briefings.
5. `ignore.retail.marketing`: King of Cotton and OpenAI marketing newsletters.
6. `ignore.booking.verification`: Booking verification codes are temporary noise after receipt.
7. `info.booking.reservations`: Booking hotel/car confirmations are travel info, grouped as `travel.booking`.
8. `info.airbnb.travel`: Airbnb reservations/receipts/travel messages are travel info, grouped as `travel.airbnb`.
9. `info.travel.orders`: ferry/travel order details are travel info, grouped as `travel.orders`.
10. `action.github.failed-runs`: GitHub CI/CodeQL/Secret Scan failures are action items, grouped as `dev.github.failures`.
11. `info.github.copilot-pr`: Copilot PR comments are useful info, grouped as `dev.github.pr-comments`.
12. `action.vercel.failed-deployments`: Vercel failed production deployments are high urgency actions.
13. `action.airbnb.security`: Airbnb account/payment activity is a high urgency security action.

When adding a rule:
1. Prefer exact sender fragments in `fromIncludes`.
2. Use `subjectAnyIncludes` for alternative subject markers.
3. Put more specific rules before broader rules if they can match the same sender.
4. Add or update tests in `tests/mailQualification.test.ts`.

## Proactive Context Cache
1. Keep unread count, latest message metadata, important/unread summary and last-read thread summary warm.
2. Use fresh snapshots for inbox count, latest-mail and "needs reply" questions.
3. Never send, reply, archive, delete or mark messages from a proactive refresh; cached context can only help resolve candidates before normal confirmation/execution.

## Main References
- src/mail/mailAgent.ts
- src/mail/mailQualification.ts
- src/routes/ingest.ts
- src/routing/e1RouteDispatcher.ts
- src/conversation/voiceUx.ts
- docs/PROACTIVE_CONTEXT_CACHE.md
