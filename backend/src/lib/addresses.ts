import addressparser from 'nodemailer/lib/addressparser';

// Deliberately simple: a dot-atom local part and a domain with at least one dot.
const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export interface Recipient {
  name: string;
  address: string;
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function isValidAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS_RE.test(address);
}

export function isOnDomain(address: string, domain: string): boolean {
  const normalized = normalizeAddress(address);
  return isValidAddress(normalized) && normalized.endsWith(`@${domain.toLowerCase()}`);
}

/**
 * Parses recipients given either as an array of strings or a single comma separated string.
 * Each entry may be a bare address or `Name <address>`. Throws on any invalid address.
 */
export function parseRecipients(input: unknown, field: string): Recipient[] {
  if (input === undefined || input === null || input === '') return [];
  const entries = Array.isArray(input) ? input : [input];
  const recipients: Recipient[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new RecipientError(field, String(entry));
    for (const parsed of addressparser(entry, { flatten: true })) {
      const address = normalizeAddress(parsed.address);
      if (!isValidAddress(address)) throw new RecipientError(field, parsed.address || entry);
      recipients.push({ name: parsed.name, address });
    }
  }
  return recipients;
}

export class RecipientError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(`Invalid address in "${field}": ${value}`);
  }
}
