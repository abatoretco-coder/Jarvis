/**
 * Simple circuit breaker pattern for external dependencies.
 * 
 * States:
 * - CLOSED: normal operation, requests go through
 * - OPEN: too many failures, all requests fail fast without calling the service
 * - HALF_OPEN: after cooldown, allow one test request to see if service recovered
 * 
 * Usage:
 * ```typescript
 * const breaker = new CircuitBreaker('jarvis', { failureThreshold: 3, cooldownMs: 30000 });
 * const result = await breaker.execute(async () => {
 *   // Your call to Jarvis
 *   return await fetch(...);
 * });
 * ```
 */

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold?: number;
  /** Time in ms to wait before attempting to close the circuit again */
  cooldownMs?: number;
  /** Optional callback when circuit state changes */
  onStateChange?: (name: string, oldState: CircuitBreakerState, newState: CircuitBreakerState) => void;
}

export interface CircuitBreakerResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  circuitOpen?: boolean;
}

export class CircuitBreaker {
  private name: string;
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private failureThreshold: number;
  private cooldownMs: number;
  private onStateChange?: (name: string, oldState: CircuitBreakerState, newState: CircuitBreakerState) => void;

  constructor(name: string, options?: CircuitBreakerOptions) {
    this.name = name;
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.cooldownMs = options?.cooldownMs ?? 30_000; // 30s default
    this.onStateChange = options?.onStateChange;
  }

  private setState(newState: CircuitBreakerState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    this.onStateChange?.(this.name, oldState, newState);
  }

  /**
   * Execute a function with circuit breaker protection.
   */
  async execute<T>(fn: () => Promise<T>): Promise<CircuitBreakerResult<T>> {
    // If circuit is open, check if cooldown has passed
    if (this.state === 'OPEN') {
      const elapsedMs = Date.now() - this.lastFailureTime;
      if (elapsedMs < this.cooldownMs) {
        // Still in cooldown, fail fast
        return {
          success: false,
          error: `circuit_breaker_open`,
          circuitOpen: true,
        };
      }
      // Cooldown passed, try a half-open state
      this.setState('HALF_OPEN');
    }

    // Attempt the call
    try {
      const data = await fn();
      // Success: reset failure count and close circuit
      this.failureCount = 0;
      if (this.state !== 'CLOSED') {
        this.setState('CLOSED');
      }
      return { success: true, data };
    } catch (err) {
      // Failure: increment counter
      this.failureCount++;
      this.lastFailureTime = Date.now();

      const error = err instanceof Error ? err.message : String(err);

      // If we hit the threshold, open the circuit
      if (this.failureCount >= this.failureThreshold) {
        this.setState('OPEN');
      }

      return {
        success: false,
        error,
        circuitOpen: this.state === 'OPEN',
      };
    }
  }

  /**
   * Get current circuit state (for monitoring/health checks).
   */
  getState(): { state: CircuitBreakerState; failureCount: number; lastFailureTime: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Manually reset the circuit breaker (useful for testing or admin actions).
   */
  reset(): void {
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.setState('CLOSED');
  }
}
