import { describe, expect, it } from 'vitest';
import { CorrelationMiddleware } from '../src/platform/logging/correlation.middleware.js';
import { getCurrentRequestId } from '../src/platform/logging/request-context.js';

describe('CorrelationMiddleware', () => {
  it('generates a request ID when none is supplied and sets it on the response', () => {
    const middleware = new CorrelationMiddleware();
    const req = { headers: {} };
    const setHeaderCalls: Array<[string, string]> = [];
    const res = { setHeader: (name: string, value: string) => setHeaderCalls.push([name, value]) };

    let observedInsideNext: string | undefined;
    middleware.use(req, res, () => {
      observedInsideNext = getCurrentRequestId();
    });

    expect(observedInsideNext).toBeTruthy();
    expect(setHeaderCalls).toHaveLength(1);
    expect(setHeaderCalls[0]?.[0]).toBe('x-request-id');
    expect(setHeaderCalls[0]?.[1]).toBe(observedInsideNext);
  });

  it('trusts an inbound X-Request-Id header instead of generating a new one', () => {
    const middleware = new CorrelationMiddleware();
    const req = { headers: { 'x-request-id': 'client-supplied-id' } };
    const setHeaderCalls: Array<[string, string]> = [];
    const res = { setHeader: (name: string, value: string) => setHeaderCalls.push([name, value]) };

    let observedInsideNext: string | undefined;
    middleware.use(req, res, () => {
      observedInsideNext = getCurrentRequestId();
    });

    expect(observedInsideNext).toBe('client-supplied-id');
    expect(setHeaderCalls[0]?.[1]).toBe('client-supplied-id');
  });

  it('generates independent IDs for concurrent requests', async () => {
    const middleware = new CorrelationMiddleware();
    const seen: string[] = [];

    function simulateRequest(): Promise<void> {
      return new Promise((resolve) => {
        const req = { headers: {} };
        const res = { setHeader: () => undefined };
        middleware.use(req, res, () => {
          seen.push(getCurrentRequestId()!);
          resolve();
        });
      });
    }

    await Promise.all([simulateRequest(), simulateRequest(), simulateRequest()]);

    expect(new Set(seen).size).toBe(3);
  });

  it('does not leak requestId outside the middleware-wrapped call', () => {
    const middleware = new CorrelationMiddleware();
    const req = { headers: {} };
    const res = { setHeader: () => undefined };

    middleware.use(req, res, () => {
      /* no-op */
    });

    expect(getCurrentRequestId()).toBeUndefined();
  });
});
