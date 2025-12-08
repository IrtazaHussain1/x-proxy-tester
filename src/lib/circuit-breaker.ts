/**
 * Circuit Breaker Module
 * Implements circuit breaker pattern for resilient API calls.
 */

import { logger } from './logger';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number; // Number of failures before opening circuit
  resetTimeout: number; // Time in ms before attempting to close circuit
  monitoringPeriod: number; // Time window for counting failures
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
}

/**
 * Circuit Breaker implementation
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures: number = 0;
  private successes: number = 0;
  private lastFailureTime?: number;
  private lastSuccessTime?: number;
  private failureWindowStart: number = Date.now();

  constructor(
    private name: string,
    private options: CircuitBreakerOptions = {
      failureThreshold: 5,
      resetTimeout: 60000, // 1 minute
      monitoringPeriod: 60000, // 1 minute
    }
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should be reset (transition from OPEN to HALF_OPEN after timeout)
    this.checkReset();

    // If circuit is open, reject immediately without calling the function
    if (this.state === 'OPEN') {
      throw new Error(`Circuit breaker ${this.name} is OPEN - too many failures`);
    }

    try {
      const result = await fn();
      this.onSuccess(); // Record success and potentially close circuit
      return result;
    } catch (error) {
      this.onFailure(); // Record failure and potentially open circuit
      throw error;
    }
  }

  private onSuccess(): void {
    this.successes++;
    this.lastSuccessTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      // If we succeed in half-open, close the circuit
      logger.info({ circuit: this.name }, 'Circuit breaker closed after successful call');
      this.state = 'CLOSED';
      this.failures = 0;
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(): void {
    const now = Date.now();

    // Reset failure window if it's expired
    if (now - this.failureWindowStart > this.options.monitoringPeriod) {
      this.failures = 0;
      this.failureWindowStart = now;
    }

    this.failures++;
    this.lastFailureTime = now;

    if (this.state === 'HALF_OPEN') {
      // If we fail in half-open, open the circuit again
      logger.warn({ circuit: this.name }, 'Circuit breaker opened after failure in half-open state');
      this.state = 'OPEN';
    } else if (this.failures >= this.options.failureThreshold) {
      // Open circuit if threshold reached
      logger.warn(
        {
          circuit: this.name,
          failures: this.failures,
          threshold: this.options.failureThreshold,
        },
        'Circuit breaker opened - failure threshold reached'
      );
      this.state = 'OPEN';
      this.lastFailureTime = now;
    }
  }

  /**
   * Check if circuit should be reset from OPEN to HALF_OPEN
   */
  private checkReset(): void {
    if (this.state === 'OPEN' && this.lastFailureTime) {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure >= this.options.resetTimeout) {
        logger.info(
          {
            circuit: this.name,
            timeSinceLastFailure,
            resetTimeout: this.options.resetTimeout,
          },
          'Circuit breaker entering half-open state'
        );
        this.state = 'HALF_OPEN';
      }
    }
  }

  /**
   * Get current circuit breaker stats
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
    };
  }

  /**
   * Reset circuit breaker (for testing or manual intervention)
   */
  reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = undefined;
    this.lastSuccessTime = undefined;
    this.failureWindowStart = Date.now();
  }
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffMultiplier?: number;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
  } = options;

  let lastError: Error | unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        const delay = Math.min(
          initialDelay * Math.pow(backoffMultiplier, attempt),
          maxDelay
        );
        logger.debug(
          {
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            delay,
            error: error instanceof Error ? error.message : String(error),
          },
          'Retrying after error with exponential backoff'
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

