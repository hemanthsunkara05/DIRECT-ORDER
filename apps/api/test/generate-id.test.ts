import { describe, expect, it } from 'vitest';
import { generateId } from '../src/platform/ids/generate-id.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('generateId', () => {
  it('generates a syntactically valid UUID', () => {
    expect(generateId()).toMatch(UUID_PATTERN);
  });

  it('sets the version nibble to 7 (UUIDv7)', () => {
    const id = generateId();
    // xxxxxxxx-xxxx-Vxxx-... — the version nibble is the first
    // character of the third group.
    expect(id[14]).toBe('7');
  });

  it('generates unique values across many calls', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => generateId()));
    expect(ids.size).toBe(10_000);
  });

  it('is roughly monotonically sortable (embeds a millisecond timestamp)', async () => {
    const first = generateId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = generateId();

    // Lexicographic string comparison matches chronological order for
    // UUIDv7 because the timestamp occupies the leading bits/characters.
    expect(first < second).toBe(true);
  });
});
