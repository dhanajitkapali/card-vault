// Face ID unlock via WebAuthn passkey + the `prf` extension (PLAN.md §P2).
//
// The vault key is never derivable from anything stored here on its own: we
// keep only the key WRAPPED under a secret that the authenticator will emit
// solely after a successful biometric check (userVerification: 'required').
// That is the guardrail §P2 asks for — nothing the OS hands back without a
// user gesture. The passphrase remains the enrolment secret and the fallback.
//
// Requires PRF support (Safari 18 / iOS 18+). If absent, enrolment refuses
// rather than falling back to anything weaker.

import { randomBytes } from './crypto.js';

const PRF_SALT = new TextEncoder().encode('cards-vault/prf/v1');
const RP_NAME = 'Cards';

export async function maybeAvailable() {
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

async function wrapKeyFrom(prfBytes) {
  return crypto.subtle.importKey(
    'raw', prfBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
}

function prfResult(cred) {
  const ext = cred.getClientExtensionResults();
  const first = ext && ext.prf && ext.prf.results && ext.prf.results.first;
  return first ? new Uint8Array(first) : null;
}

// Creates the passkey, then immediately asserts it to obtain the PRF secret
// (most authenticators will not evaluate PRF during creation).
export async function enrol(vaultKeyRaw) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: RP_NAME, id: location.hostname },
      user: { id: randomBytes(16), name: 'vault', displayName: RP_NAME },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
      timeout: 60000,
      attestation: 'none',
      extensions: { prf: {} },
    },
  });
  if (!cred) throw new Error('cancelled');

  const ext = cred.getClientExtensionResults();
  if (!ext || !ext.prf || ext.prf.enabled !== true) {
    throw new Error('unsupported');
  }

  const credentialId = new Uint8Array(cred.rawId);
  const prfBytes = await assertPrf(credentialId);
  if (!prfBytes) throw new Error('unsupported');

  const iv = randomBytes(12);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await wrapKeyFrom(prfBytes), vaultKeyRaw
  ));
  prfBytes.fill(0);

  return { credentialId, iv, wrapped };
}

async function assertPrf(credentialId) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  if (!assertion) throw new Error('cancelled');
  return prfResult(assertion);
}

// Face ID -> PRF secret -> unwrapped raw vault key.
export async function unwrap(record) {
  const prfBytes = await assertPrf(record.credentialId);
  if (!prfBytes) throw new Error('unsupported');
  const raw = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.iv }, await wrapKeyFrom(prfBytes), record.wrapped
  ));
  prfBytes.fill(0);
  return raw;
}
