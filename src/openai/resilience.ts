import type { Env } from '../env';
import type { OpenAiCapability } from './capabilities';

export type OpenAiUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type OpenAiOperationResult<T> = {
  value: T;
  usage?: OpenAiUsage;
  status?: number;
  model?: string;
};

type ResilienceConfig = {
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  circuitFailureThreshold: number;
  circuitOpenMs: number;
  budgetWindowMs: number;
  budgetMaxRequests: number;
  budgetMaxTokens: number;
};

type CapabilityState = {
  requests: number;
  attempts: number;
  retries: number;
  successes: number;
  failures: number;
  rejectedByCircuit: number;
  rejectedByBudget: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  lastLatencyMs?: number;
  lastStatus?: number;
  lastModel?: string;
  lastErrorCode?: string;
  consecutiveFailures: number;
  circuit: 'closed' | 'open' | 'half_open';
  circuitOpenUntil?: number;
  halfOpenProbeInFlight: boolean;
};

type BudgetState = {
  windowStartedAt: number;
  requests: number;
  tokens: number;
};

const DEFAULT_CONFIG: ResilienceConfig = {
  maxRetries: 2,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 2_000,
  circuitFailureThreshold: 5,
  circuitOpenMs: 30_000,
  budgetWindowMs: 86_400_000,
  budgetMaxRequests: 2_000,
  budgetMaxTokens: 2_000_000,
};

let config: ResilienceConfig = { ...DEFAULT_CONFIG };
let budget: BudgetState = { windowStartedAt: Date.now(), requests: 0, tokens: 0 };
const states = new Map<OpenAiCapability, CapabilityState>();
let lifecycleController = new AbortController();

export class OpenAiHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs?: number,
    message = `openai_http_${status}`,
  ) {
    super(message);
    this.name = 'OpenAiHttpError';
  }
}

export class OpenAiResilienceError extends Error {
  constructor(public readonly code: 'openai_circuit_open' | 'openai_budget_exhausted') {
    super(code);
    this.name = 'OpenAiResilienceError';
  }
}

function newState(): CapabilityState {
  return {
    requests: 0,
    attempts: 0,
    retries: 0,
    successes: 0,
    failures: 0,
    rejectedByCircuit: 0,
    rejectedByBudget: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    consecutiveFailures: 0,
    circuit: 'closed',
    halfOpenProbeInFlight: false,
  };
}

function stateFor(capability: OpenAiCapability): CapabilityState {
  const current = states.get(capability);
  if (current) return current;
  const created = newState();
  states.set(capability, created);
  return created;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function refreshBudget(now: number): void {
  if (now - budget.windowStartedAt >= config.budgetWindowMs) {
    budget = { windowStartedAt: now, requests: 0, tokens: 0 };
  }
}

function errorCode(error: unknown): string {
  if (error instanceof OpenAiResilienceError) return error.code;
  if (error instanceof OpenAiHttpError) return `http_${error.status}`;
  if (error instanceof DOMException && error.name === 'AbortError') return 'timeout_or_aborted';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && /^(?:openai|embedding)_[a-z0-9_:.-]+$/iu.test(error.message)) {
    return error.message.slice(0, 96);
  }
  if (error instanceof Error) return error.name === 'TypeError' ? 'network_error' : 'operation_failed';
  return 'unknown_error';
}

function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAiHttpError) {
    return error.status === 408 || error.status === 409 || error.status === 429
      || (error.status >= 500 && error.status <= 599);
  }
  if (error instanceof OpenAiResilienceError) return false;
  return error instanceof TypeError
    || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof DOMException && error.name === 'TimeoutError')
    || (error instanceof Error && /(?:timeout|connection_failed|closed)$/u.test(error.message));
}

function retryDelay(error: unknown, retryIndex: number): number {
  const exponential = Math.min(config.retryMaxDelayMs, config.retryBaseDelayMs * (2 ** retryIndex));
  const retryAfter = error instanceof OpenAiHttpError ? error.retryAfterMs : undefined;
  return Math.min(config.retryMaxDelayMs, Math.max(exponential, retryAfter ?? 0));
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const abortSignal = signal;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(abortSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

function enterCircuit(state: CapabilityState, now: number): void {
  if (state.circuit === 'open' && (state.circuitOpenUntil ?? 0) > now) {
    state.rejectedByCircuit += 1;
    throw new OpenAiResilienceError('openai_circuit_open');
  }
  if (state.circuit === 'open') {
    if (state.halfOpenProbeInFlight) {
      state.rejectedByCircuit += 1;
      throw new OpenAiResilienceError('openai_circuit_open');
    }
    state.circuit = 'half_open';
    state.halfOpenProbeInFlight = true;
  } else if (state.circuit === 'half_open' && state.halfOpenProbeInFlight) {
    state.rejectedByCircuit += 1;
    throw new OpenAiResilienceError('openai_circuit_open');
  }
}

function assertBudget(state: CapabilityState, now: number): void {
  refreshBudget(now);
  if (budget.requests >= config.budgetMaxRequests || budget.tokens >= config.budgetMaxTokens) {
    state.rejectedByBudget += 1;
    throw new OpenAiResilienceError('openai_budget_exhausted');
  }
}

export async function executeOpenAiOperation<T>(params: {
  capability: OpenAiCapability;
  model?: string;
  signal?: AbortSignal;
  operation: (attempt: number, signal: AbortSignal) => Promise<OpenAiOperationResult<T>>;
}): Promise<T> {
  const state = stateFor(params.capability);
  const startedAt = Date.now();
  const lifecycleSignal = lifecycleController.signal;
  const operationSignal = params.signal
    ? AbortSignal.any([params.signal, lifecycleSignal])
    : lifecycleSignal;
  assertBudget(state, startedAt);
  enterCircuit(state, startedAt);
  budget.requests += 1;
  state.requests += 1;
  state.lastModel = params.model;

  let lastStatus: number | undefined;
  try {
    for (let attempt = 0; ; attempt += 1) {
      if (operationSignal.aborted) throw operationSignal.reason ?? new DOMException('Aborted', 'AbortError');
      state.attempts += 1;
      try {
        const result = await params.operation(attempt, operationSignal);
        lastStatus = result.status;
        const inputTokens = finiteNonNegative(result.usage?.inputTokens);
        const outputTokens = finiteNonNegative(result.usage?.outputTokens);
        const totalTokens = finiteNonNegative(result.usage?.totalTokens) || inputTokens + outputTokens;
        state.inputTokens += inputTokens;
        state.outputTokens += outputTokens;
        state.totalTokens += totalTokens;
        budget.tokens += totalTokens;
        state.successes += 1;
        state.consecutiveFailures = 0;
        state.circuit = 'closed';
        state.circuitOpenUntil = undefined;
        state.halfOpenProbeInFlight = false;
        state.lastErrorCode = undefined;
        state.lastModel = result.model ?? params.model;
        return result.value;
      } catch (error) {
        if (error instanceof OpenAiHttpError) lastStatus = error.status;
        const retryAfterTooLong = error instanceof OpenAiHttpError
          && (error.retryAfterMs ?? 0) > config.retryMaxDelayMs;
        if (attempt >= config.maxRetries || !isRetryable(error) || retryAfterTooLong || operationSignal.aborted) {
          throw error;
        }
        state.retries += 1;
        await wait(retryDelay(error, attempt), operationSignal);
      }
    }
  } catch (error) {
    state.failures += 1;
    const callerAborted = Boolean(params.signal?.aborted);
    state.lastErrorCode = callerAborted ? 'aborted' : errorCode(error);
    state.halfOpenProbeInFlight = false;
    if (!callerAborted) state.consecutiveFailures += 1;
    if (state.circuit === 'half_open' || (!callerAborted && state.consecutiveFailures >= config.circuitFailureThreshold)) {
      state.circuit = 'open';
      state.circuitOpenUntil = Date.now() + config.circuitOpenMs;
    }
    throw error;
  } finally {
    const latencyMs = Date.now() - startedAt;
    state.totalLatencyMs += latencyMs;
    state.lastLatencyMs = latencyMs;
    state.lastStatus = lastStatus;
  }
}

export function retryAfterMsFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function configureOpenAiResilience(env: Env): void {
  lifecycleController.abort(new DOMException('OpenAI runtime reconfigured', 'AbortError'));
  lifecycleController = new AbortController();
  config = {
    maxRetries: env.OPENAI_RETRY_MAX,
    retryBaseDelayMs: env.OPENAI_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: env.OPENAI_RETRY_MAX_DELAY_MS,
    circuitFailureThreshold: env.OPENAI_CIRCUIT_FAILURE_THRESHOLD,
    circuitOpenMs: env.OPENAI_CIRCUIT_OPEN_MS,
    budgetWindowMs: env.OPENAI_BUDGET_WINDOW_MS,
    budgetMaxRequests: env.OPENAI_BUDGET_MAX_REQUESTS,
    budgetMaxTokens: env.OPENAI_BUDGET_MAX_TOKENS,
  };
  budget = { windowStartedAt: Date.now(), requests: 0, tokens: 0 };
  states.clear();
}

export function shutdownOpenAiResilience(): void {
  lifecycleController.abort(new DOMException('OpenAI runtime stopped', 'AbortError'));
}

export function getOpenAiResilienceSnapshot(now = Date.now()): Record<string, unknown> {
  refreshBudget(now);
  const capabilities = Object.fromEntries([...states.entries()].map(([capability, state]) => {
    const circuit = state.circuit === 'open' && (state.circuitOpenUntil ?? 0) <= now ? 'half_open' : state.circuit;
    const degradedReasons = [
      circuit !== 'closed' ? `circuit_${circuit}` : undefined,
      state.lastErrorCode ? `last_error:${state.lastErrorCode}` : undefined,
    ].filter(Boolean);
    return [capability, {
      requests: state.requests,
      attempts: state.attempts,
      retries: state.retries,
      successes: state.successes,
      failures: state.failures,
      rejectedByCircuit: state.rejectedByCircuit,
      rejectedByBudget: state.rejectedByBudget,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      totalTokens: state.totalTokens,
      averageLatencyMs: state.requests > 0 ? Math.round(state.totalLatencyMs / state.requests) : 0,
      lastLatencyMs: state.lastLatencyMs,
      lastStatus: state.lastStatus,
      lastModel: state.lastModel,
      status: degradedReasons.length > 0 ? 'degraded' : 'ok',
      degradedReasons,
      circuit,
      circuitOpenUntil: state.circuitOpenUntil ? new Date(state.circuitOpenUntil).toISOString() : undefined,
    }];
  }));
  const values = [...states.values()];
  const budgetExhausted = budget.requests >= config.budgetMaxRequests || budget.tokens >= config.budgetMaxTokens;
  return {
    status: budgetExhausted || values.some((state) => state.circuit !== 'closed' || state.lastErrorCode)
      ? 'degraded'
      : 'ok',
    requests: values.reduce((sum, state) => sum + state.requests, 0),
    attempts: values.reduce((sum, state) => sum + state.attempts, 0),
    retries: values.reduce((sum, state) => sum + state.retries, 0),
    successes: values.reduce((sum, state) => sum + state.successes, 0),
    failures: values.reduce((sum, state) => sum + state.failures, 0),
    inputTokens: values.reduce((sum, state) => sum + state.inputTokens, 0),
    outputTokens: values.reduce((sum, state) => sum + state.outputTokens, 0),
    totalTokens: values.reduce((sum, state) => sum + state.totalTokens, 0),
    budget: {
      windowStartedAt: new Date(budget.windowStartedAt).toISOString(),
      windowEndsAt: new Date(budget.windowStartedAt + config.budgetWindowMs).toISOString(),
      requests: budget.requests,
      maxRequests: config.budgetMaxRequests,
      tokens: budget.tokens,
      maxTokens: config.budgetMaxTokens,
      exhausted: budgetExhausted,
    },
    capabilities,
  };
}

export function resetOpenAiResilienceForTests(overrides: Partial<ResilienceConfig> = {}): void {
  lifecycleController.abort(new DOMException('OpenAI test runtime reset', 'AbortError'));
  lifecycleController = new AbortController();
  config = { ...DEFAULT_CONFIG, ...overrides };
  budget = { windowStartedAt: Date.now(), requests: 0, tokens: 0 };
  states.clear();
}
