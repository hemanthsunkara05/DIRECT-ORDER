import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, slugify, validateSlugFormat } from '../src/modules/restaurants/slug.js';

describe('validateSlugFormat (docs/01-domain-model.md §5.2)', () => {
  it('accepts a well-formed slug', () => {
    expect(validateSlugFormat('spice-route')).toEqual([]);
  });

  it('rejects a slug shorter than 3 characters', () => {
    expect(validateSlugFormat('ab')).toContain('TOO_SHORT');
  });

  it('rejects a slug longer than 63 characters', () => {
    expect(validateSlugFormat('a'.repeat(64))).toContain('TOO_LONG');
  });

  it('rejects uppercase letters', () => {
    expect(validateSlugFormat('Spice-Route')).toContain('INVALID_FORMAT');
  });

  it('rejects underscores, spaces, and other non-hyphen separators', () => {
    expect(validateSlugFormat('spice_route')).toContain('INVALID_FORMAT');
    expect(validateSlugFormat('spice route')).toContain('INVALID_FORMAT');
  });

  it('rejects leading, trailing, or doubled hyphens', () => {
    expect(validateSlugFormat('-spice')).toContain('INVALID_FORMAT');
    expect(validateSlugFormat('spice-')).toContain('INVALID_FORMAT');
    expect(validateSlugFormat('spice--route')).toContain('INVALID_FORMAT');
  });

  it.each([...RESERVED_SLUGS])('rejects the reserved word "%s"', (word) => {
    expect(validateSlugFormat(word)).toContain('RESERVED');
  });

  it('can report multiple issues at once', () => {
    const issues = validateSlugFormat('AB');
    expect(issues).toContain('TOO_SHORT');
    expect(issues).toContain('INVALID_FORMAT');
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates a normal restaurant name', () => {
    expect(slugify('Spice Route')).toBe('spice-route');
  });

  it('collapses punctuation and repeated separators into single hyphens', () => {
    expect(slugify("Priya's  Kitchen & Grill!!!")).toBe('priya-s-kitchen-grill');
  });

  it('strips accents', () => {
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
  });

  it('trims leading/trailing hyphens produced by leading/trailing punctuation', () => {
    expect(slugify('--Spice Route--')).toBe('spice-route');
  });

  it('the result always passes format validation on its own (ignoring reserved words and collisions)', () => {
    const result = slugify('A!!!');
    expect(validateSlugFormat(result)).not.toContain('INVALID_FORMAT');
    expect(validateSlugFormat(result)).not.toContain('TOO_SHORT');
  });
});
