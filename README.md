# Cards

Your own payment cards, encrypted on your own device. Unlock with **Face ID**,
tap a field, paste it into a checkout form.

It is a convenience vault, not a payments product: **no server, no account, no
sync, no analytics, no third-party requests.** Everything is static files on
GitHub Pages plus your browser's own storage.

**Live:** https://dhanajitkapali.github.io/card-vault

## Security model

| | |
|---|---|
| Vault key | **random** 32 bytes (`crypto.getRandomValues`) — not derived from anything you type |
| Where it lives | only **wrapped** under a WebAuthn `prf` secret the authenticator emits after a successful Face ID check (`userVerification: 'required'`) |
| Encryption | AES-GCM-256, a **separate 12-byte IV per card** |
| What's on disk | `{ id, iv, ct }` per card, plus the wrapped key. The **label is inside the ciphertext**, so the list leaks nothing before unlock |
| Key lifetime | a JS variable only. Nulled on explicit lock, 3 minutes idle, and whenever the app is backgrounded |
| Recovery | **none.** No passphrase, no fallback, no export |

Requires PRF support — Safari 18 / iOS 18+. **Setup performs a real Face ID
enrolment before creating the vault**, so a device that can't do PRF never ends
up holding cards it cannot open. Do not weaken that into a capability check.

You will see **two Face ID prompts during first-time setup** (one to create the
passkey, one to read the PRF secret from it — most authenticators won't
evaluate PRF at creation time). Every unlock after that is a single prompt.

### What this trades away

Face ID is the only way in, so anyone who can pass Face ID on this phone can
read the cards — there is no second factor. And if the passkey is ever lost,
the cards are unreadable; the lock screen's **"start over"** erases them so the
app stays usable. The cards are in your wallet, so the cost is retyping them.

See `PLAN.md` §9 for the override of C3/C4 this represents.

## What is deliberately not here

- **No camera scanning yet** — phase 2. See `PLAN.md` §5 P0/P3.
- **No backup/export.** A home-screen install is exempt from Safari's 7-day
  eviction, but deleting the icon, storage pressure, or a new phone still lose
  the vault — and there is no recovery.
- **No passphrase.** Removed by owner decision; see `PLAN.md` §9.
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
js/crypto.js          AES-GCM + Luhn, plausible(), brand, formatting
js/db.js              IndexedDB (meta + cards)
js/faceid.js          WebAuthn PRF enrol / unwrap — the only way in
js/app.js             UI wiring and lock lifecycle
sw.js                 offline shell
tests.html            runnable validation tests
PLAN.md               the spec this was built from
```

CSS and JS are external files (not inlined) so the CSP can be
`default-src 'self'` with **no `unsafe-inline`**.

## Before committing

1. Set up with Face ID → add a card → lock → Face ID unlock → card intact
2. A failed/declined Face ID reveals nothing and leaves the vault closed
3. Exactly **one** Face ID prompt per unlock
4. Copy buttons put the right value on the clipboard, **digits only** for the number
5. Background the app → returns locked
6. Airplane mode → still loads and unlocks
7. `tests.html` all green
