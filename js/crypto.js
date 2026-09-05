// Crypto + card-number validation. No network, no dependencies.
// PLAN.md §4 is LOCKED: do not lower the iteration count, do not add recovery.

export const PBKDF2_ITERATIONS = 310000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

// Passphrase -> 32 raw key bytes. Raw bytes (not just a CryptoKey) because
// Face ID enrolment has to wrap them; both live in the same nulled-on-lock slot.
export async function deriveKeyBytes(passphrase, salt) {
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, 256
  );
  return new Uint8Array(bits);
}

export function importAesKey(rawBytes) {
  return crypto.subtle.importKey(
    'raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
}

// Every record gets its own 12-byte IV.
export async function encryptJSON(key, obj) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))
  );
  return { iv, ct: new Uint8Array(ct) };
}

// Throws on a wrong key — that failure IS the passphrase check.
export async function decryptJSON(key, { iv, ct }) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(plain));
}

/* ---------------- card number rules ---------------- */

export const digitsOf = (s) => (s || '').replace(/\D/g, '');

export function luhn(numStr) {
  const n = digitsOf(numStr);
  if (n.length < 12) return false;
  let sum = 0, alt = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = +n[i];
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// PLAN.md §4 gate 2. Luhn alone is NOT enough: `424242424242424` is
// `4242424242424242` with a digit dropped and it still passes Luhn.
// Length and prefix must form a real pair.
export function plausible(numStr) {
  const n = digitsOf(numStr);
  if (n.length === 15) return /^3[47]/.test(n);
  if (n.length === 14) return /^(36|38|30[0-5])/.test(n);
  if (n.length === 16 || n.length === 19) return /^[2456]/.test(n);
  if (n.length === 13) return /^4/.test(n);
  return false;
}

// Display only. Never gates a save.
export function brandOf(numStr) {
  const n = digitsOf(numStr);
  if (/^4/.test(n)) return 'VISA';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'MASTERCARD';
  if (/^3[47]/.test(n)) return 'AMEX';
  if (/^(6011|65|64[4-9])/.test(n)) return 'DISCOVER';
  if (/^(60|65|81|82|508)/.test(n)) return 'RUPAY';
  if (/^(36|38|30[0-5])/.test(n)) return 'DINERS';
  if (/^35/.test(n)) return 'JCB';
  return 'CARD';
}

export function groupNumber(numStr) {
  const n = digitsOf(numStr);
  if (n.length === 15) return `${n.slice(0, 4)} ${n.slice(4, 10)} ${n.slice(10)}`.trim();
  return (n.match(/.{1,4}/g) || []).join(' ');
}

export const last4 = (numStr) => digitsOf(numStr).slice(-4);

export function maskNumber(numStr) {
  const l4 = last4(numStr);
  return l4 ? `•••• •••• •••• ${l4}` : '••••';
}

// MM/YY, month 01-12, year within current..+20.
export function validExpiry(v) {
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec((v || '').trim());
  if (!m) return false;
  const mm = +m[1], yy = +m[2];
  if (mm < 1 || mm > 12) return false;
  const nowYY = new Date().getFullYear() % 100;
  return yy >= nowYY && yy <= nowYY + 20;
}
