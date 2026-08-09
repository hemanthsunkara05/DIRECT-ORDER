/**
 * Compile-time-only assertions, checked by `tsc --noEmit` (the
 * `typecheck` script), never executed at runtime.
 *
 * Phase 1 acceptance criterion: "passing a float to any money function
 * is a type error." This file fails the TypeScript build — not a test
 * run — if that ever stops being true, because an unused
 * `@ts-expect-error` directive is itself a compile error.
 */
import { percentageOf, sum, toMinor } from '../src/index.js';

// @ts-expect-error — toMinor requires a string; a number literal must not compile.
toMinor(250.5);

// @ts-expect-error — a bare JS number is not assignable to `Minor` (bigint).
sum(100);

// @ts-expect-error — percentageOf's first argument is Minor (bigint), not number.
percentageOf(100, 12.5);
