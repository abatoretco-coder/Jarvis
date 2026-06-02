# Render Policy - Execution-to-Response Contract

Statut: Draft v1 (ready for implementation)
Last update: May 2026
Owner: Jarvis routing layer

---

## 1) Purpose

Define one single policy system that decides how user-facing responses are built after action execution.

This policy separates:
- action execution (what happened, with structured facts)
- response rendering (how it is said to the user)

Goal:
- deterministic where possible
- AI only when complexity requires it
- consistent behavior across Spotify, Search, Weather, Todo, Mail, Calendar, Executors

---

## 2) Core Principles

1. No rendering without execution contract.
2. Deterministic first, AI last.
3. Never invent facts in render stage.
4. Multi-target synthesis is explicit and isolated.
5. Error and clarification messages are policy-driven, not ad hoc strings.
6. Voice formatting is post-render, not mixed with domain rendering.
7. Every action has an explicit RenderMode.

---

## 3) Render Modes

1. deterministic_static
- Pre-written short variants.
- No AI call.
- Example: spotify.pause, spotify.play.

2. deterministic_template
- String template filled with structured facts.
- No AI call.
- Example: now playing with track and artist.

3. service_text_passthrough
- Reuse service text as final response (optional normalization only).
- No AI call.
- Example: search answer already good enough.

4. llm_domain_rephrase
- Domain-specific rephrase prompt.
- Single domain only.
- Example: complex weather explanation from many metrics.

5. llm_multi_synthesis
- Aggregate multiple action outputs into one answer.
- Used only when multiple target results exist.

6. deterministic_error
- Standardized error/need_clarification/out_of_scope messages.
- No AI call.

---

## 4) Execution Result Contract (required)

Every action returns a structured result:

```ts
type ActionExecutionStatus =
  | 'success'
  | 'need_clarification'
  | 'out_of_scope'
  | 'error';

type ActionDomain =
  | 'spotify'
  | 'search'
  | 'weather'
  | 'todo'
  | 'mail'
  | 'calendar'
  | 'executors'
  | 'general';

type ActionExecutionResult = {
  status: ActionExecutionStatus;
  domain: ActionDomain;
  actionKey: string;
  facts: Record<string, unknown>;
  rawText?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
};
```

Rules:
- facts is the source of truth for templates.
- rawText is optional fallback input.
- render layer never changes facts.

---

## 5) Render Decision Order

1. If status is error, need_clarification, or out_of_scope -> deterministic_error.
2. If action policy says deterministic_static -> return local variant.
3. If action policy says deterministic_template and facts are complete -> render template.
4. If action policy says service_text_passthrough and rawText exists -> passthrough.
5. If action policy says llm_domain_rephrase -> run domain prompt.
6. If multiple successful action results -> llm_multi_synthesis.
7. Final fallback -> deterministic generic fallback.

---

## 6) Runtime Policy Matrix (v1 - exhaustive)

Source of truth:
- src/routing/render/policies.ts

The matrix is now filled for all current semantic route keys plus domain defaults.

### Spotify

- spotify.pause -> deterministic_static
- spotify.play -> deterministic_static
- spotify.next -> deterministic_static
- spotify.previous -> deterministic_static
- spotify.clear_queue -> deterministic_static
- spotify.now_playing -> deterministic_template (facts: track, artist)
- spotify.list_devices -> deterministic_template (facts: device list)
- spotify.search -> deterministic_template (facts: resolved query, type)
- spotify.search_and_play -> deterministic_template
- spotify.queue_add -> deterministic_template
- spotify.transfer -> deterministic_template
- spotify.add_to_playlist -> deterministic_template
- spotify.volume_set -> deterministic_template

### Search

- search.news.external_weather -> service_text_passthrough
- search.news.live_sport -> service_text_passthrough
- search.news.current_news -> service_text_passthrough
- search.web.definition -> service_text_passthrough
- search.web.quick_lookup -> service_text_passthrough
- search.deep.analysis -> llm_domain_rephrase
- search.deep.history -> llm_domain_rephrase
- search.deep.comparison -> llm_domain_rephrase

### Weather

- weather.current_temperature -> deterministic_template
- weather.current_humidity -> deterministic_template
- weather.current_precipitation -> deterministic_template
- weather.current_conditions -> deterministic_template

### Todo

- todo.list_tasks -> deterministic_template
- todo.list_tasks.today -> deterministic_template
- todo.list_tasks.tomorrow -> deterministic_template
- todo.list_tasks.this_week -> deterministic_template
- todo.list_tasks.overdue -> deterministic_template
- todo.list_lists -> deterministic_template
- todo.add_task -> llm_domain_rephrase
- todo.complete_task -> deterministic_template
- todo.delete_task -> deterministic_template
- todo.update_task -> llm_domain_rephrase
- todo.create_list -> deterministic_template
- todo.delete_list -> deterministic_template
- todo.add_checklist_item -> deterministic_template
- todo.complete_checklist_item -> deterministic_template
- todo.delete_checklist_item -> deterministic_template

### Mail

- mail.list_inbox -> deterministic_template
- mail.list_inbox.unread -> deterministic_template
- mail.search_emails -> service_text_passthrough
- mail.send_email -> llm_domain_rephrase
- mail.reply_email -> llm_domain_rephrase
- mail.forward_email -> llm_domain_rephrase
- mail.mark_read -> deterministic_template
- mail.mark_unread -> deterministic_template
- mail.trash_email -> deterministic_template
- mail.flag_email -> deterministic_template

### Executors

- executor.greeting -> deterministic_template
- executor.help -> service_text_passthrough
- executor.status -> service_text_passthrough
- executor.timer -> deterministic_template
- executor.note -> deterministic_template
- executor.scene_set -> deterministic_template
- executor.media_play_pause -> deterministic_template
- executor.media_next -> deterministic_template
- executor.media_previous -> deterministic_template
- executor.volume_up -> deterministic_template
- executor.volume_down -> deterministic_template
- executor.mute -> deterministic_template
- executor.unmute -> deterministic_template
- executor.climate_set -> deterministic_template
- executor.lock -> deterministic_template
- executor.unlock -> deterministic_template
- executor.vacuum_start -> deterministic_template
- executor.vacuum_stop -> deterministic_template
- executor.cover_open -> deterministic_template
- executor.cover_close -> deterministic_template

### Calendar

- calendar domain default -> llm_domain_rephrase

### Domain defaults

- spotify -> deterministic_template
- search -> llm_domain_rephrase
- weather -> deterministic_template
- todo -> llm_domain_rephrase
- mail -> llm_domain_rephrase
- calendar -> llm_domain_rephrase
- executors -> deterministic_template
- general -> service_text_passthrough

---

## 7) Prompt Design Rules (for AI render only)

Use prompts only for:
- llm_domain_rephrase
- llm_multi_synthesis

Prompt constraints:
1. Do not invent facts.
2. Use only provided facts/rawText.
3. Keep response short unless user asked details.
4. Preserve status semantics (success/error/clarification).
5. Keep tone consistent with assistant persona.

Current prompt/config files:
- src/routing/render/prompts/domainRephraseSystemPrompt.ts
- src/routing/render/prompts/domainRephraseUserPrompt.ts
- src/routing/render/openAiConfig.ts

---

## 8) Suggested Runtime Structure

```ts
type RenderMode =
  | 'deterministic_static'
  | 'deterministic_template'
  | 'service_text_passthrough'
  | 'llm_domain_rephrase'
  | 'llm_multi_synthesis'
  | 'deterministic_error';

type RenderPolicy = {
  mode: RenderMode;
  templateKey?: string;
  promptKey?: string;
  maxChars?: number;
  allowVoiceCompression?: boolean;
};
```

Policy map shape:

```ts
type RenderPolicyMap = Record<string, RenderPolicy>;
// key example: "spotify.pause", "weather.current_conditions", "search.web.definition"
```

---

## 9) Ultra-Long Deployment Todo (implementation plan)

### Phase A - Design Lock

1. Freeze naming: RenderMode enum names.
2. Freeze ActionExecutionResult type shape.
3. Freeze status semantics for error/clarification.
4. Freeze domain list and action key format.
5. Freeze fallback order.
6. Freeze max response size policy.
7. Freeze voice-specific post-processing position.
8. Decide if passthrough allows trimming only.
9. Decide if domain rephrase is opt-in per action.
10. Validate matrix with product owner.

### Phase B - Type System + Config

11. Add render types file.
12. Add render policy config file.
13. Add strict parser for policy map.
14. Add default policy map for all current actions.
15. Add unknown-action fallback policy.
16. Add startup validation for missing action policies.
17. Add startup validation for invalid mode/prompt/template keys.
18. Add tests for policy parser.
19. Add tests for unknown action fallback.
20. Add tests for policy completeness.

### Phase C - Execution Contract Normalization

21. Define adapter for Spotify executor result -> ActionExecutionResult.
22. Define adapter for Search result -> ActionExecutionResult.
23. Define adapter for Weather result -> ActionExecutionResult.
24. Define adapter for Todo result -> ActionExecutionResult.
25. Define adapter for Mail result -> ActionExecutionResult.
26. Define adapter for Calendar result -> ActionExecutionResult.
27. Define adapter for HA executor result -> ActionExecutionResult.
28. Remove direct string shortcuts in orchestration path.
29. Keep temporary compatibility adapter for legacy paths.
30. Add tests for each adapter.

### Phase D - Deterministic Render Engine

31. Create deterministic_static renderer.
32. Create deterministic_template renderer.
33. Create deterministic_error renderer.
34. Add template registry with required fields per template.
35. Add template guard for missing facts.
36. Add localization hooks (fr default).
37. Add character length guard.
38. Add punctuation normalizer.
39. Add tests for every template key.
40. Add tests for missing facts fallback.

### Phase E - AI Render Engine

41. Create llm_domain_rephrase renderer.
42. Create llm_multi_synthesis renderer.
43. Add prompt registry + strict prompt keys.
44. Add guardrails: no fact invention.
45. Add timeout policy for render LLM calls.
46. Add deterministic fallback if render LLM fails.
47. Add tests with mocked OpenAI responses.
48. Add tests for timeout and failure behavior.
49. Add tests for no-invention constraints.
50. Add token/cost telemetry fields.

### Phase F - Integrate in ingest.ts

51. Introduce render stage after execution stage.
52. Replace ad hoc text assembly with render service.
53. Route single-result flow through render policy.
54. Route multi-result flow through llm_multi_synthesis policy.
55. Keep Spotify rich payload while replacing text rendering path.
56. Apply voice formatting after render output.
57. Preserve existing replyMeta semantics.
58. Preserve SSE behavior.
59. Preserve persistence behavior.
60. Add integration tests for ingest route.

### Phase G - Deterministic Coverage Expansion

61. Fill deterministic templates for all Spotify actions.
62. Fill deterministic templates for weather actions.
63. Fill deterministic templates for todo core actions.
64. Fill deterministic templates for mail core actions.
65. Fill deterministic templates for calendar core actions.
66. Fill deterministic templates for executors core actions.
67. Mark actions that still require llm_domain_rephrase.
68. Add checklist to keep deterministic-first discipline.
69. Add regression tests for each mapped action.
70. Add benchmark tests for response latency.

### Phase H - Observability

71. Log render_mode per request.
72. Log render_fallback_reason when fallback occurs.
73. Log render_latency_ms.
74. Log render_llm_tokens_input/output if LLM used.
75. Add metrics counters by mode.
76. Add dashboard panels for mode distribution.
77. Alert if llm_domain_rephrase usage spikes unexpectedly.
78. Alert if deterministic_error rate spikes.
79. Add sampling for rendered output audits.
80. Add PII-safe log redaction checks.

### Phase I - Feature Flags + Rollout

81. Add RENDER_POLICY_ENABLED flag.
82. Add RENDER_POLICY_SHADOW_MODE flag.
83. Add RENDER_POLICY_ACTION_ALLOWLIST.
84. Add RENDER_POLICY_DISABLE_LLM_REPHRASE flag.
85. Deploy shadow mode first.
86. Compare outputs legacy vs policy in logs.
87. Validate top 20 user intents manually.
88. Enable deterministic modes in live.
89. Enable llm_domain_rephrase for one domain at a time.
90. Enable llm_multi_synthesis last.

### Phase J - Production Validation

91. Smoke test Spotify deterministic actions.
92. Smoke test now_playing/list_devices templates.
93. Smoke test weather deterministic and complex weather.
94. Smoke test search passthrough quality.
95. Smoke test todo/mail/calendar responses.
96. Smoke test multi-target synthesis.
97. Validate SSE, persistence, and thread continuity.
98. Validate voice rendering quality.
99. Validate health endpoint and logs after restart.
100. Run canary period and review incidents.

### Phase K - Cleanup

101. Remove dead legacy response branches.
102. Remove duplicate ad hoc formatters.
103. Consolidate deterministic response files.
104. Update architecture review docs (step 4/5/6).
105. Update agent docs by domain.
106. Add contributor guide for adding new action policy.
107. Lock CI check for policy completeness.
108. Lock CI check for forbidden ad hoc string responses.
109. Archive rollout report.
110. Mark Render Policy v1 as production baseline.

---

## 10) Definition of Done

1. Every action key has a RenderPolicy.
2. Every execution path returns ActionExecutionResult.
3. Deterministic-first behavior is measurable in metrics.
4. AI render is used only by explicit policy mode.
5. No ad hoc response strings remain in orchestration.
6. Latency regression is within agreed budget.
7. Production logs show stable fallback/error rates.

---

## 11) Risks and Mitigations

Risk: policy drift across domains.
- Mitigation: startup validation + CI completeness test.

Risk: LLM rephrase invents details.
- Mitigation: fact-only prompt contract + deterministic fallback.

Risk: migration breaks Spotify payload contract.
- Mitigation: keep payload shape untouched, replace only response text stage.

Risk: hidden legacy branches bypass render policy.
- Mitigation: telemetry for policy hit rate and non-policy path detection.

---

## 12) Immediate Next Actions

1. Approve this spec.
2. Create render type + policy map skeleton.
3. Wire Spotify and Weather first.
4. Run shadow mode in prod.
5. Expand to Todo/Mail/Calendar after metrics validation.
