/**
 * Content-based verification after upload (docs/09-security.md §15.6):
 * the declared `Content-Type` a client sends when requesting a
 * presigned URL is just a string it typed — nothing stops it from
 * requesting `image/jpeg` and then uploading an executable. This checks
 * what the file's first bytes actually are, independent of whatever was
 * declared, which is the only way to catch a `.exe` renamed to `.jpg`.
 *
 * Deliberately a short allowlist (JPEG/PNG/WEBP) — SVG is never in it:
 * SVG is XML and can embed `<script>`, so it is rejected outright at
 * the presign step (upload.service.ts) and never reaches this check at
 * all.
 */

export type DetectedImageType = 'image/jpeg' | 'image/png' | 'image/webp' | null;

export function detectImageType(bytes: Uint8Array): DetectedImageType {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50 // "WEBP"
  ) {
    return 'image/webp';
  }
  return null;
}

/** The declared type must match what the bytes actually are — not just "be some known image type." */
export function contentMatchesDeclaredType(
  bytes: Uint8Array,
  declaredContentType: string,
): boolean {
  return detectImageType(bytes) === declaredContentType;
}

/**
 * Phase 17: support attachments additionally allow PDF (BR-140,
 * "size- and type-validated") — a receipt or screenshot-as-PDF is a
 * realistic support attachment in a way it never was for a restaurant
 * branding image, so this checks image types OR PDF's `%PDF` magic
 * bytes, rather than the stricter image-only check branding uploads
 * use.
 */
export function contentMatchesDeclaredAttachmentType(
  bytes: Uint8Array,
  declaredContentType: string,
): boolean {
  if (declaredContentType === 'application/pdf') {
    return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]); // "%PDF"
  }
  return detectImageType(bytes) === declaredContentType;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, i) => bytes[i] === byte);
}
