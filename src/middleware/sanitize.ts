/**
 * Removes Unicode format controls and C0/C1 controls from a string.
 *
 * \p{Cf} covers zero-width characters, bidi controls, BOM/word joiners,
 * soft hyphens, and the U+E0000-U+E007F tag-character block.
 */
const INVISIBLE_UNICODE_PATTERN =
  /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sanitizeString(value: string): string {
  return value
    .replace(INVISIBLE_UNICODE_PATTERN, "")
    .normalize("NFC")
    .trim();
}

/**
 * Recursively sanitizes JSON-compatible payloads without mutating the input.
 * Object keys are sanitized as well as values.
 */
export function sanitizePayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    return sanitizeString(payload);
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizePayload(item));
  }

  if (isPlainRecord(payload)) {
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        sanitizeString(key),
        sanitizePayload(value),
      ]),
    );
  }

  return payload;
}
