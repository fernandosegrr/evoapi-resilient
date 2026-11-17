// Phone numbers for the self-service link. Strict on purpose: the number ends up in a pairing request that makes
// WhatsApp notify that phone, so anything ambiguous is rejected instead of guessed.

export type MxPrefix = '52' | '521';

export type ParsedPhone = { ok: true; digits: string } | { ok: false; reason: 'invalid_number' };

const MAX_RAW_LENGTH = 32;
// Digits, plus the separators people actually type. A single leading "+" is allowed; letters, extensions
// ("ext", "x", "#"), dots and anything else are not.
const ALLOWED_RAW = /^\+?[\d ()-]+$/;

export function parseLinkPhone(input: unknown): ParsedPhone {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_RAW_LENGTH) {
    return { ok: false, reason: 'invalid_number' };
  }
  const trimmed = input.trim();
  if (!ALLOWED_RAW.test(trimmed)) return { ok: false, reason: 'invalid_number' };

  const digits = trimmed.replace(/\D/g, '');
  // E.164: 8 to 15 digits including the country code, which never starts with 0.
  if (!/^[1-9]\d{7,14}$/.test(digits)) return { ok: false, reason: 'invalid_number' };
  return { ok: true, digits };
}

// Mexican national numbers have 10 digits. WhatsApp has used both 52+10 and the legacy 521+10 for mobiles.
// Returns the 10-digit national number, or null when the digits start with 52 but are not a valid Mexican number.
function mexicanNational(digits: string): string | null {
  if (!digits.startsWith('52')) return null;
  const rest = digits.slice(2);
  if (rest.length === 10) return rest;
  if (rest.length === 11 && rest.startsWith('1')) return rest.slice(1);
  return null;
}

// The number sent to WhatsApp for a pairing code. Mexican numbers are normalised to ONE form chosen by
// LINK_PAIRING_MX_PREFIX (52 or the legacy 521); every other country is passed through unchanged.
export function toPairingNumber(digits: string, mxPrefix: MxPrefix): ParsedPhone {
  if (!digits.startsWith('52')) return { ok: true, digits };
  const national = mexicanNational(digits);
  if (!national) return { ok: false, reason: 'invalid_number' };
  return { ok: true, digits: `${mxPrefix}${national}` };
}

// 52 and 521 are the same Mexican line; everything else must match exactly.
export function canonicalNumber(digits: string): string {
  const national = mexicanNational(digits);
  return national ? `52${national}` : digits;
}

export function equivalentNumbers(a: string, b: string): boolean {
  const left = canonicalNumber(a);
  const right = canonicalNumber(b);
  return left.length > 0 && left === right;
}

// "5214623974213:12@s.whatsapp.net" -> "5214623974213". Returns '' for anything that is not a phone JID.
export function jidToDigits(jid: unknown): string {
  if (typeof jid !== 'string') return '';
  const match = /^(\d{5,20})(?::\d+)?@s\.whatsapp\.net$/.exec(jid.trim());
  return match ? match[1] : '';
}

export function lastFour(digits: string): string {
  return digits.slice(-4);
}

// "+52 ••• ••• 4567": enough for the customer to recognise the number, not enough to leak it.
export function maskNumber(digits: string): string {
  if (!digits) return '';
  // Only Mexico's code is shown: other country codes vary in length and would leak a digit of the number.
  return `+${digits.startsWith('52') ? '52' : '••'} ••• ••• ${lastFour(digits)}`;
}
