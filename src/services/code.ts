/**
 * JAV Code Normalization and Extraction Service
 * Normalizes formats like ADN-001, ADN_001, ADN 001, ADN001, #ADN-001, [ADN-001]
 * into standard uppercase 'ADN-001'.
 * Prevents arbitrary numbers from matching as JAV codes.
 */

// Regex matching typical JAV codes: 2-6 letters followed by optional delimiter and 2-5 digits
// e.g. ADN-001, ABP_978, STAR765, FC2-PPV-1234567, S2M-001, 1Pondo (some special prefixes)
const CODE_REGEX = /(?:#|\[|\b)([A-Za-z]{2,8}|[A-Za-z0-9]{2,4}-[A-Za-z0-9]{2,4})[-_\s]?(\d{2,6})(?:\]|\b)/gi;

export function normalizeCode(input: string): string | null {
  if (!input || typeof input !== 'string') return null;

  const cleaned = input.trim().toUpperCase();

  // Remove surrounding brackets or hashtags
  const stripped = cleaned.replace(/^[#\[(]+/, '').replace(/[\])]+$/, '');

  // Match pattern: Letters (or prefix with hyphen) + optional separator + digits
  const match = stripped.match(/^([A-Z]{2,8}|[A-Z0-9]{2,4}-[A-Z0-9]{2,4})[-_\s]?(\d{2,6})$/);
  if (!match) {
    return null;
  }

  const prefix = match[1].replace(/[-_]/g, '-');
  let numPart = match[2];

  // Standardize 3-digit padding if 2 digits (e.g. ADN-1 -> ADN-001, ADN-01 -> ADN-001)
  if (numPart.length < 3 && !prefix.includes('PPV')) {
    numPart = numPart.padStart(3, '0');
  }

  return `${prefix}-${numPart}`;
}

export function extractCodes(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  const foundCodes = new Set<string>();
  const matches = text.matchAll(CODE_REGEX);

  for (const match of matches) {
    const rawCandidate = match[0];
    const normalized = normalizeCode(rawCandidate);
    if (normalized) {
      foundCodes.add(normalized);
    }
  }

  // Also check if entire caption/text is a single code without boundaries
  if (foundCodes.size === 0) {
    const singleNorm = normalizeCode(text);
    if (singleNorm) {
      foundCodes.add(singleNorm);
    }
  }

  return Array.from(foundCodes);
}

export function isValidCode(code: string): boolean {
  return normalizeCode(code) !== null;
}
