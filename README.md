# Cards

Your own payment cards, encrypted on your own device. Unlock with a passphrase
(or Face ID), tap a field, paste it into a checkout form.

It is a convenience vault, not a payments product: **no server, no account, no
sync, no analytics, no third-party requests.** Everything is static files on
GitHub Pages plus your browser's own storage.

**Live:** https://dhanajitkapali.github.io/card-vault

## Security model

| | |
|---|---|
| Key derivation | PBKDF2-SHA256, **310,000 iterations**, 16-byte random salt |
| Encryption | AES-GCM-256, a **separate 12-byte IV per card** |
| Passphrase check | a `check` blob encrypting `{v:'ok'}` — a failed decrypt *is* the wrong-passphrase signal |
| What's on disk | only `{ id, iv, ct }`. The **label is inside the ciphertext**, so the list leaks nothing before unlock |
| Key lifetime | a JS variable only. Nulled on explicit lock, 3 minutes idle, and whenever the app is backgrounded |
| Recovery | **none, deliberately.** Forget the passphrase and the cards are unreadable |

### Face ID

Optional, and layered *on top of* the passphrase rather than replacing it.
A WebAuthn passkey with the **`prf` extension** yields a secret that only a
successful biometric check can produce; the vault key is stored **wrapped**
under it. Requires Safari 18 / iOS 18+ — if PRF is unavailable the option
never appears, rather than falling back to anything weaker.

The passphrase stays the enrolment secret and the permanent fallback.

## What is deliberately not here

- **No camera scanning yet** — phase 2. See `PLAN.md` §5 P0/P3.
- **No backup/export.** A home-screen install is exempt from Safari's 7-day
  eviction, but deleting the icon, storage pressure, or a new phone still lose
  the vault — and there is no recovery. The cards are in your wallet, so the
  cost is retyping them.
- **No wallet integration, no sharing, no plaintext export** — `PLAN.md` C2/C6.

## Card number validation

Manual entry checks **Luhn only** — you can see what you typed, and an unusual
card shouldn't be rejected. The scanner (phase 2) will additionally require
`plausible()` and two identical consecutive reads, because Luhn alone is not
enough: `424242424242424` is `4242424242424242` with a digit dropped and it
**passes Luhn**. Only the length/prefix rule catches it.

`tests.html` keeps that case, and 31 others, runnable.

## Run locally

No build step, no dependencies:

```bash
python3 -m http.server 4190
```

Open http://localhost:4190 — `localhost` counts as a secure context, which
WebCrypto and WebAuthn both require. Open `/tests.html` for the test suite.

## Deploy

Push to `main`; Settings → Pages → *Deploy from a branch* → `main` → `/ (root)`.
Nothing to build.

Bump `CACHE` in `sw.js` on every release or clients keep the cached shell.

## Files

```
index.html            markup only
styles.css            all styling
js/crypto.js          PBKDF2/AES-GCM + Luhn, plausible(), brand, formatting
js/db.js              IndexedDB (meta + cards)
js/faceid.js          WebAuthn PRF enrol / unwrap
js/app.js             UI wiring and lock lifecycle
sw.js                 offline shell
tests.html            runnable validation tests
PLAN.md               the spec this was built from
```

CSS and JS are external files (not inlined) so the CSP can be
`default-src 'self'` with **no `unsafe-inline`**.

## Before committing

1. Create vault → add a card → lock → unlock → card intact
2. Wrong passphrase rejected without revealing anything
3. Copy buttons put the right value on the clipboard, **digits only** for the number
4. Background the app → returns locked
5. Airplane mode → still loads and unlocks
6. `tests.html` all green
