import { describe, expect, it } from 'vitest';
import {
  contentMatchesDeclaredType,
  detectImageType,
} from '../src/modules/restaurants/uploads/magic-bytes.js';

const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP_HEADER = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
// The MZ header every Windows PE executable (.exe) starts with.
const EXE_HEADER = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);

describe('detectImageType', () => {
  it('detects a real JPEG', () => {
    expect(detectImageType(JPEG_HEADER)).toBe('image/jpeg');
  });

  it('detects a real PNG', () => {
    expect(detectImageType(PNG_HEADER)).toBe('image/png');
  });

  it('detects a real WEBP', () => {
    expect(detectImageType(WEBP_HEADER)).toBe('image/webp');
  });

  it('returns null for an .exe (the "renamed to .jpg" attack, Phase 5 acceptance criteria)', () => {
    expect(detectImageType(EXE_HEADER)).toBeNull();
  });

  it('returns null for empty or too-short input rather than throwing', () => {
    expect(detectImageType(new Uint8Array([]))).toBeNull();
    expect(detectImageType(new Uint8Array([0xff]))).toBeNull();
  });

  it('returns null for plain text (e.g. an SVG, which is XML)', () => {
    const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectImageType(svgBytes)).toBeNull();
  });
});

describe('contentMatchesDeclaredType', () => {
  it('matches when the declared type is honest', () => {
    expect(contentMatchesDeclaredType(JPEG_HEADER, 'image/jpeg')).toBe(true);
  });

  it('rejects an .exe declared as image/jpeg', () => {
    expect(contentMatchesDeclaredType(EXE_HEADER, 'image/jpeg')).toBe(false);
  });

  it('rejects a real PNG declared as image/jpeg (mismatched but still an image)', () => {
    expect(contentMatchesDeclaredType(PNG_HEADER, 'image/jpeg')).toBe(false);
  });
});
