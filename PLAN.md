# PLAN.md — Card Vault PWA

Handoff spec. Read this fully before changing code. Sections marked
**LOCKED** are decisions already made and tested; do not relitigate them
without asking.

---

## 1. What this is

A single-user PWA that stores the owner's own payment cards, encrypted, on
their own device. Scan a card with the camera, save it, then copy the number,
expiry or CVV in one tap when filling a checkout form elsewhere.

It is a convenience vault, not a payments product. No server, no account, no
sync, no analytics, no third-party calls at runtime.

**Target:** iPhone Safari, installed to the home screen. Android Chrome should
work but is not the priority.

**Host:** GitHub Pages, static only. There is no backend and there never will
be one — do not propose solutions that need server-side code.

---

## 2. Hard constraints — LOCKED

| # | Constraint | Why |
| --- | --- | --- |
| C1 | No backend, no build step. Plain HTML/CSS/JS served as static files. | GitHub Pages. Keeps the auditable surface small. |
| C2 | No Apple Wallet or Google Wallet integration. | Payment-card provisioning is issuer-only. Non-payment passes need server-side signing with a private key, impossible on static hosting. Already investigated and ruled out. |
| C3 | Card data is encrypted at rest with a key derived from a passphrase. Never stored in plaintext anywhere. | The whole point. |
| C4 | The derived key exists only in a JS variable while unlocked. Never persisted to IndexedDB, localStorage, sessionStorage or a cookie. | Persisting it defeats C3 entirely. |
| C5 | Zero network requests after the app shell is cached. | A vault that phones home is not a vault. |
| C6 | Single user, own cards only. No multi-user, no sharing, no export of decrypted data. | Storing someone else's CVV crosses into PCI DSS territory. Keep the app incapable of it. |

---

## 3. Current state

Working baseline, deployed-ready:

```
index.html              whole app — UI, crypto, IndexedDB, scanner
sw.js                   offline shell; caches Tesseract wasm after first use
manifest.webmanifest    home-screen install metadata
icon-192.png
icon-512.png
README.md
```

Implemented and working: passphrase create/unlock, AES-GCM vault, card
list with masked display, expand-to-reveal, per-field copy, add/edit/delete,
camera scan of the card number, auto-lock, encrypted backup export.

---

## 4. Architecture decisions — LOCKED

**Crypto.** PBKDF2-SHA256, 310,000 iterations, 16-byte random salt in the
`meta` store. Derives an AES-GCM 256 key. Each card is a separate ciphertext
with its own 12-byte IV. A `check` blob encrypting `{v:'ok'}` is what verifies
the passphrase — a failed decrypt means wrong passphrase.

Do not lower the iteration count for speed. Do not add a "remember me" that
persists the key. Do not add passphrase recovery; there is deliberately no way
back in.

**Storage.** IndexedDB, database `vault`, stores `meta` (key/value) and
`cards` (keyed by `id`). The entire card object is encrypted as one blob —
label included, so the card list leaks nothing before unlock.

**Lock lifecycle.** Key is nulled on: explicit lock, 3 minutes idle,
`visibilitychange` to hidden. The `visibilitychange` handler is deliberate —
backgrounding the app locks it. Do not soften this to a grace period.

**Scanner acceptance — the important one.** An OCR read is accepted only if it
clears all three:

1. Luhn checksum passes
2. Length and prefix form a real pair (`plausible()`): 15 → `3[47]`,
   14 → `36|38|30[0-5]`, 16 or 19 → `[2456]`, 13 → `4`
3. The identical number is read twice in consecutive frames

Gate 2 exists because gate 1 is not sufficient. Test case: `424242424242424`
is `4242424242424242` with a digit dropped by OCR, and it **passes Luhn**.
Without the length/prefix rule the app silently saves a wrong card number,
which is the worst failure this app can have. If you touch the scanner, keep
these tests green.

Manual form entry checks Luhn only, not `plausible()`. That split is
intentional — the user can see what they typed, and an unusual card shouldn't
be rejected.

**CVV is never scanned.** It is small, flat, unlit and on the back. Camera
reads of it are not trustworthy. Manual entry only.

---

## 5. Work queue

Ordered. Each task lists its acceptance criteria.

### P0 — Security gaps in the current build

- [ ] **Vendor Tesseract instead of loading it from a CDN.**
  `index.html` currently pulls `tesseract.min.js` from jsdelivr with no
  `integrity` attribute. A CDN compromise puts arbitrary JS on the page while
  the vault is decrypted. Download the library and its wasm/traineddata into
  `vendor/` and commit them. If vendoring the language data proves impractical,
  add SRI hashes as a fallback — but vendoring is the correct fix.
  *Done when:* devtools Network tab shows zero third-party requests on a cold
  load and during a scan.

- [ ] **Load the scanner lazily.** Tesseract is currently a `defer` script on
  every page load, so it is resident while the vault is open even when the user
  never scans. Move it to a dynamic `import()` / injected `<script>` inside
  `startCamera()`.
  *Done when:* the scanner code is absent from the page until the user taps
  "Scan the number with the camera".

- [ ] **Add a Content-Security-Policy meta tag.** After the two tasks above,
  `default-src 'self'` should be achievable except for the inline style/script,
  which need hashes or a move to external files. Prefer moving them out.
  *Done when:* CSP is present with no `unsafe-inline` and the app still works.

### P1 — Missing functionality

- [ ] **Backup import.** Export exists; import does not, so the backup is
  currently unusable. Add a file picker that reads a `vault-1` JSON export and
  restores `salt`, `check` and `cards`.
  Decide and document the merge rule — recommend refusing to import into a
  non-empty vault with a different salt, since two salts means two passphrases
  and the records are mutually undecryptable.
  *Done when:* export → clear site data → import → unlock with the original
  passphrase returns every card intact.

- [ ] **Expiry OCR.** The scanner captures the number only. Run a second
  recognise pass over the band below the number with whitelist `0123456789/`,
  match `\b(0[1-9]|1[0-2])\s*/\s*(\d{2})\b`, and require the year to be
  plausible (current year to +10). Populate the field but leave it editable and
  do not block on it.
  *Done when:* a successful scan pre-fills expiry on at least one real card,
  and a failed expiry read still lets the number save.

- [ ] **Duplicate detection.** Warn on save if a card with the same number
  already exists.

### P2 — UX

- [ ] **Biometric unlock.** Wrap the AES key with a WebAuthn/passkey-derived
  secret using the `prf` extension, so Face ID can unlock without retyping the
  passphrase. Keep the passphrase as the always-available fallback and require
  it after a reboot.
  *Investigate first:* `prf` extension support on the target iOS version. If it
  is not available, drop this task rather than substituting a weaker scheme —
  do not store the key wrapped under something the OS will hand back without a
  user gesture.

- [ ] **Search/filter** once the list exceeds roughly eight cards.
- [ ] **Replace `window.confirm`** on delete with an in-app confirmation.
- [ ] **Card brand detection** from IIN for a small label in the list row.

### P3 — Scanner accuracy

Only after P0/P1. The crop window in `loop()` is tuned for standard horizontal
cards:

```js
const sy = vh * 0.48, sh = vh * 0.19;
```

- [ ] Tune `sy`/`sh` against the owner's actual cards, then raise `scale`.
- [ ] Handle vertical-layout cards (different crop, or detect orientation).
- [ ] If accuracy is still poor after tuning, stop optimising Tesseract. It is
  trained on printed document text, not embossed digits under glare. The
  correct escalation is a commercial WASM SDK — Microblink BlinkCard or Veryfi
  Lens — both of which run fully client-side and so do not violate C1. Flag
  this to the owner as a licensing decision rather than deciding it.

---

## 6. Regression traps

Things that look like improvements and are not:

- **Do not** persist the derived key "to avoid re-entering the passphrase".
- **Do not** remove the `visibilitychange` lock because it is annoying during
  testing. Use a longer idle timeout locally instead, and revert it.
- **Do not** relax the scanner to Luhn-only. See §4.
- **Do not** move card data to localStorage because IndexedDB is verbose.
  localStorage is synchronous, string-only, and more aggressively evicted.
- **Do not** add a "share card" or "export as CSV/plaintext" feature. See C6.
- **Do not** add error reporting, telemetry or a crash reporter. See C5.
- **Do not** log card data. No `console.log` of decrypted objects, even
  temporarily — it survives in the debug console.

---

## 7. Verification before any commit

```bash
node --check <extracted inline script>    # or lint the external file
```

Manual pass on a real iPhone, installed to the home screen:

1. Create vault → add a card manually → lock → unlock → card is intact
2. Wrong passphrase is rejected without revealing anything
3. Copy buttons put the right value on the clipboard, digits only for the number
4. Background the app → returns locked
5. Scan a real card → number is correct, or the scan fails cleanly
6. Export → clear site data → import → unlock → cards intact *(after P1)*
7. Airplane mode → app still loads and unlocks

Keep the Luhn/`plausible()` test cases from §4 as a runnable test file rather
than an ad-hoc script.

---

## 8. Known environment facts

- **iOS evicts IndexedDB** for non-installed sites after ~7 days of no
  interaction. Home-screen installation is the storage guarantee. This is why
  backup/restore is P1 and not a nice-to-have.
- **GitHub Pages serves the code fresh on every load**, so repo write access is
  equivalent to vault access. This is an accepted, documented risk — it is the
  structural reason native password managers ship signed binaries. Do not
  attempt to "fix" it in-app; nothing served from the origin can defend against
  the origin.
- `getUserMedia` needs HTTPS. Pages provides it. For local dev use
  `localhost`, which is treated as secure.

---

## 9. Owner override — Face ID only (supersedes C3/C4 and §P2)

Decided by the owner after the v1 build. **The passphrase is removed.**

- The vault key is **random** (`crypto.getRandomValues`, 32 bytes), not derived
  from a passphrase. PBKDF2 is gone.
- It is stored only **wrapped** under the WebAuthn `prf` secret, which the
  authenticator emits solely after a successful biometric check
  (`userVerification: 'required'`). Nothing in `meta` or `cards` is readable
  without Face ID.
- `salt` and the `check` blob no longer exist. The `faceid` record is what
  marks an initialised vault; AES-GCM authentication on the wrapped key is
  the correctness check.

**Consequences, accepted:**

- Face ID is the *only* way in. A lost passkey means the cards are
  unreadable — the lock screen offers "start over", which erases them.
- Security is now equivalent to the device: anyone who can pass Face ID on
  this phone can read the cards. There is no second factor.

**Safety rule that must not be removed:** setup performs a real PRF enrolment
*before* creating the vault. If PRF is unavailable the vault is never created,
so a device can never end up holding cards it cannot open. Do not "optimise"
this into a capability check alone.
