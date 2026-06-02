export type RenderMode =
  | 'deterministic_static'
  | 'deterministic_template'
  | 'service_text_passthrough'
  | 'llm_domain_rephrase'
  | 'llm_multi_synthesis'
  | 'deterministic_error';

export type ActionExecutionStatus =
  | 'success'
  | 'need_clarification'
  | 'out_of_scope'
  | 'error';

export type ActionDomain =
  | 'spotify'
  | 'search'
  | 'weather'
  | 'todo'
  | 'mail'
  | 'calendar'
  | 'executors'
  | 'general';

export type ActionExecutionResult = {
  status: ActionExecutionStatus;
  domain: ActionDomain;
  actionKey: string;
  facts: Record<string, unknown>;
  rawText?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
};

export type RenderPolicy = {
  mode: RenderMode;
  templateKey?: string;
  promptKey?: string;
  maxChars?: number;
  allowVoiceCompression?: boolean;
};

export type RenderPolicyMap = Record<string, RenderPolicy>;
