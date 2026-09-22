import { SocialError } from "./errors.js";

export interface ConcurrencyLimiterOptions {
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly backend?: string;
}

type Release = () => void;

type Work<T> = () => Promise<T>;

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
  settled: boolean;
}

/** A client-owned FIFO budget for one backend instance. */
export function createConcurrencyLimiter(options: ConcurrencyLimiterOptions) {
  let active = 0;
  const waiting: Waiter[] = [];

  async function acquire(signal: AbortSignal | undefined, operation: string): Promise<Release> {
    if (signal?.aborted) throw cancelled(operation);

    if (active < options.maxActive) {
      active += 1;

      return release;
    }

    if (waiting.length >= options.maxQueued) {
      throw saturated(operation, options.backend);
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = waiting.indexOf(waiter);

          if (index !== -1) waiting.splice(index, 1);
          signal?.removeEventListener("abort", waiter.abort);
          reject(cancelled(operation));
        },
        settled: false,
      };

      waiting.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
    });

    return release;

    function release(): void {
      const next = waiting.shift();

      if (next === undefined) {
        active -= 1;

        return;
      }

      next.settled = true;
      next.signal?.removeEventListener("abort", next.abort);
      // Keep the slot reserved while the queued continuation resumes.
      next.resolve();
    }
  }

  return async function run<T>(
    signal: AbortSignal | undefined,
    operation: string,
    work: Work<T>,
  ): Promise<T> {
    const release = await acquire(signal, operation);

    try {
      if (signal?.aborted) throw cancelled(operation);

      return await work();
    } finally {
      release();
    }
  };
}

function cancelled(operation: string): SocialError {
  return new SocialError({
    code: "cancelled",
    operation,
    message: "The operation was cancelled while waiting for backend capacity",
    retryDisposition: { kind: "never" },
  });
}

function saturated(operation: string, backend: string | undefined): SocialError {
  const options: ConstructorParameters<typeof SocialError>[0] = {
    code: "rate_limited",
    operation,
    message: "Backend concurrency queue is full",
    retryDisposition: { kind: "after-delay", delayMs: 1000 },
  };

  if (backend !== undefined) Object.assign(options, { backend: backend });

  return new SocialError(options);
}
