// Cards — UI wiring. See PLAN.md; §2 constraints and §4 decisions are LOCKED.
// Never console.log a decrypted card (PLAN.md §6).

import {
  randomKeyBytes, importAesKey, encryptJSON, decryptJSON,
  luhn, digitsOf, brandOf, groupNumber, maskNumber, validExpiry,
} from './crypto.js';
import {
  metaGet, metaSet, metaDel, cardsAll, cardPut, cardDel, requestPersistence,
} from './db.js';
import * as faceid from './faceid.js';

const IDLE_MS = 3 * 60 * 1000;

/* ---- in-memory only; nulled on every lock (PLAN.md C4) ---- */
let vaultKey = null;
let vaultKeyRaw = null;
let cards = [];
let editingId = null;
let idleTimer = null;

const $ = (id) => document.getElementById(id);
const el = {
  setup: $('setupScreen'), lock: $('lockScreen'), vault: $('vaultScreen'),
  setupBtn: $('setupBtn'), setupError: $('setupError'),
  faceIdBtn: $('faceIdBtn'), lockError: $('lockError'),
  resetVaultBtn: $('resetVaultBtn'),
  list: $('cardList'), empty: $('emptyState'), count: $('countLine'),
  addBtn: $('addBtn'), lockNowBtn: $('lockNowBtn'),
  scrim: $('sheetScrim'), sheet: $('editSheet'), sheetTitle: $('sheetTitle'),
  form: $('cardForm'), fLabel: $('fLabel'), fNumber: $('fNumber'), fExpiry: $('fExpiry'),
  fCvv: $('fCvv'), fHolder: $('fHolder'), fNote: $('fNote'), formError: $('formError'),
  cancelBtn: $('cancelBtn'),
  confirm: $('confirmSheet'), confirmTitle: $('confirmTitle'), confirmBody: $('confirmBody'),
  confirmYes: $('confirmYes'), confirmNo: $('confirmNo'),
  toast: $('toast'),
};

const ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>';
const ICON_TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2000);
}

function showError(node, msg) {
  node.textContent = msg;
  node.hidden = false;
}
const clearError = (node) => { node.hidden = true; };

/* ---------------- screens ---------------- */
function show(screen) {
  el.setup.hidden = screen !== 'setup';
  el.lock.hidden = screen !== 'lock';
  el.vault.hidden = screen !== 'vault';
}

/* ---------------- lock lifecycle (PLAN.md §4) ---------------- */
function lock() {
  vaultKey = null;
  vaultKeyRaw = null;
  cards = [];
  el.list.innerHTML = '';
  editingId = null;
  closeSheet();
  clearTimeout(idleTimer);
  clearError(el.lockError);
  show('lock');
}

function touchIdle() {
  if (!vaultKey) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(lock, IDLE_MS);
}

// Backgrounding the app locks it. Deliberate — do not soften (PLAN.md §6).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && vaultKey) lock();
});
['pointerdown', 'keydown'].forEach((e) => document.addEventListener(e, touchIdle, { passive: true }));

/* ---------------- unlock paths ---------------- */
// The vault key never leaves memory in unwrapped form; Face ID is the only
// thing that can produce it (PLAN.md §9).
async function openVaultWith(rawBytes) {
  const key = await importAesKey(rawBytes);
  vaultKeyRaw = rawBytes;
  vaultKey = key;
  await loadCards();
  show('vault');
  touchIdle();
  requestPersistence();
}

// Setup proves Face ID works BEFORE any vault exists, so an unsupported
// device can never end up holding cards it cannot open.
el.setupBtn.addEventListener('click', async () => {
  clearError(el.setupError);
  el.setupBtn.disabled = true;
  try {
    if (!(await faceid.maybeAvailable())) throw new Error('unsupported');
    const raw = randomKeyBytes();
    const enrolled = await faceid.enrol(raw);   // throws if PRF is missing
    await metaSet('faceid', enrolled);
    await openVaultWith(raw);
  } catch (err) {
    if (err && err.name === 'NotAllowedError') { /* cancelled — say nothing */ }
    else if (err && err.message === 'unsupported') {
      showError(el.setupError,
        'This device cannot do Face ID unlock (it needs iOS 18 or later). ' +
        'Nothing was saved.');
    } else {
      showError(el.setupError, 'Could not set up Face ID. Nothing was saved.');
    }
  } finally {
    el.setupBtn.disabled = false;
  }
});

el.faceIdBtn.addEventListener('click', async () => {
  clearError(el.lockError);
  el.faceIdBtn.disabled = true;
  try {
    const rec = await metaGet('faceid');
    if (!rec) return show('setup');
    await openVaultWith(await faceid.unwrap(rec));
  } catch (err) {
    if (err && err.name === 'NotAllowedError') { /* cancelled */ }
    else showError(el.lockError, 'Face ID did not unlock the vault.');
  } finally {
    el.faceIdBtn.disabled = false;
  }
});

// Without a passphrase there is no other way back in, so the only honest
// escape from a lost passkey is to wipe and start again.
el.resetVaultBtn.addEventListener('click', async () => {
  const ok = await confirmAsk('Start over?',
    'Every saved card is erased and a new Face ID key is created. This cannot be undone.',
    'Erase everything');
  if (!ok) return;
  for (const c of await cardsAll()) await cardDel(c.id);
  await metaDel('faceid');
  cards = [];
  el.list.innerHTML = '';
  clearError(el.lockError);
  show('setup');
});

el.lockNowBtn.addEventListener('click', lock);

/* ---------------- cards ---------------- */
async function loadCards() {
  const recs = await cardsAll();
  const out = [];
  for (const r of recs) {
    try {
      out.push({ id: r.id, ...(await decryptJSON(vaultKey, r)) });
    } catch { /* skip anything this key cannot open */ }
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  cards = out;
  render();
}

function detailRow(k, value, copyValue, mono = true) {
  if (!value) return '';
  const safe = escapeHtml(value);
  return `<div class="detail">
    <div>
      <div class="detail__k">${k}</div>
      <div class="detail__v${mono ? '' : ' detail__v--note'}">${safe}</div>
    </div>
    ${copyValue !== null
      ? `<button class="copy" type="button" data-copy="${escapeHtml(copyValue)}" aria-label="Copy ${k}">${ICON_COPY}</button>`
      : ''}
  </div>`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function render() {
  el.list.innerHTML = '';
  cards.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'card';
    li.dataset.id = c.id;
    li.style.setProperty('--i', i);
    li.innerHTML = `
      <div class="card__face">
        <div class="card__top">
          <span class="card__label">${escapeHtml(c.label)}</span>
          <span class="card__brand">${brandOf(c.number)}</span>
        </div>
        <div class="card__num" data-num>${maskNumber(c.number)}</div>
      </div>
      <div class="card__body"><div class="card__inner">
        ${detailRow('Number', groupNumber(c.number), digitsOf(c.number))}
        ${detailRow('Expiry', c.expiry, c.expiry)}
        ${detailRow('CVV', c.cvv, c.cvv)}
        ${detailRow('Cardholder', c.holder, c.holder)}
        ${detailRow('Note', c.note, null, false)}
        <div class="card__tools">
          <button class="btn btn--ghost" type="button" data-edit>Edit</button>
          <button class="btn btn--ghost" type="button" data-delete>Delete</button>
        </div>
      </div></div>`;
    el.list.appendChild(li);
  });
  el.empty.hidden = cards.length > 0;
  el.count.textContent = cards.length
    ? `${cards.length} card${cards.length > 1 ? 's' : ''}, encrypted`
    : '';
}

el.list.addEventListener('click', async (e) => {
  const li = e.target.closest('.card');
  if (!li) return;
  const card = cards.find((c) => c.id === li.dataset.id);
  if (!card) return;

  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.copy);
      copyBtn.innerHTML = ICON_TICK;
      copyBtn.classList.add('is-done');
      setTimeout(() => { copyBtn.innerHTML = ICON_COPY; copyBtn.classList.remove('is-done'); }, 1400);
    } catch {
      toast('Could not reach the clipboard');
    }
    return;
  }

  if (e.target.closest('[data-edit]')) return openSheet(card);
  if (e.target.closest('[data-delete]')) {
    const ok = await confirmAsk('Delete this card?',
      `“${card.label}” will be removed from this device.`, 'Delete');
    if (!ok) return;
    await cardDel(card.id);
    cards = cards.filter((c) => c.id !== card.id);
    render();
    toast('Card deleted');
    return;
  }

  // tapping the face toggles reveal
  if (e.target.closest('.card__face')) {
    const open = li.classList.toggle('is-open');
    li.querySelector('[data-num]').textContent =
      open ? groupNumber(card.number) : maskNumber(card.number);
  }
});

/* ---------------- add / edit ---------------- */
function openSheet(card) {
  editingId = card ? card.id : null;
  el.sheetTitle.textContent = card ? 'Edit card' : 'Add a card';
  el.fLabel.value = card ? card.label : '';
  el.fNumber.value = card ? groupNumber(card.number) : '';
  el.fExpiry.value = card ? (card.expiry || '') : '';
  el.fCvv.value = card ? (card.cvv || '') : '';
  el.fHolder.value = card ? (card.holder || '') : '';
  el.fNote.value = card ? (card.note || '') : '';
  clearError(el.formError);
  reveal(el.sheet);
}

// `hidden` and `.is-open` are two pieces of state that must not desync: a
// stale `.is-open` left on a hidden sheet makes it snap open with no
// slide-up next time. Always clear it, and force a reflow after un-hiding
// so the transition has a starting frame to animate from.
let hideTimer = null;

function reveal(sheet) {
  clearTimeout(hideTimer);          // a pending hide must not clobber this open
  hideTimer = null;
  el.scrim.hidden = false;
  sheet.hidden = false;
  el.scrim.classList.remove('is-open');
  sheet.classList.remove('is-open');
  void sheet.offsetWidth;
  el.scrim.classList.add('is-open');
  sheet.classList.add('is-open');
}

function closeSheet() {
  el.sheet.classList.remove('is-open');
  el.confirm.classList.remove('is-open');
  el.scrim.classList.remove('is-open');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    for (const node of [el.sheet, el.confirm, el.scrim]) {
      node.hidden = true;
      node.classList.remove('is-open');
    }
    hideTimer = null;
  }, 320);
}

el.addBtn.addEventListener('click', () => openSheet(null));
el.cancelBtn.addEventListener('click', closeSheet);
el.scrim.addEventListener('click', () => { if (el.confirm.hidden) closeSheet(); });

el.fNumber.addEventListener('input', () => {
  const pos = el.fNumber.selectionStart === el.fNumber.value.length;
  el.fNumber.value = groupNumber(el.fNumber.value).slice(0, 24);
  if (pos) el.fNumber.setSelectionRange(el.fNumber.value.length, el.fNumber.value.length);
});
el.fExpiry.addEventListener('input', () => {
  const d = digitsOf(el.fExpiry.value).slice(0, 4);
  el.fExpiry.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
});
el.fCvv.addEventListener('input', () => { el.fCvv.value = digitsOf(el.fCvv.value).slice(0, 4); });

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError(el.formError);

  const label = el.fLabel.value.trim();
  const number = digitsOf(el.fNumber.value);
  const expiry = el.fExpiry.value.trim();
  const cvv = digitsOf(el.fCvv.value);

  if (!label) return showError(el.formError, 'Give the card a name.');
  // Manual entry checks Luhn only, never plausible() — PLAN.md §4.
  if (!luhn(number)) return showError(el.formError, 'That card number fails its checksum.');
  if (expiry && !validExpiry(expiry)) return showError(el.formError, 'Expiry should be MM/YY and not in the past.');

  // PLAN.md P1 — duplicate detection.
  const dupe = cards.find((c) => c.id !== editingId && digitsOf(c.number) === number);
  if (dupe) {
    const go = await confirmAsk('Already saved',
      `“${dupe.label}” has this same number. Save this as a second copy?`, 'Save anyway');
    if (!go) return;
  }

  const record = {
    label,
    number,
    expiry,
    cvv,
    holder: el.fHolder.value.trim(),
    note: el.fNote.value.trim(),
  };
  const id = editingId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  const blob = await encryptJSON(vaultKey, record);
  await cardPut({ id, iv: blob.iv, ct: blob.ct });

  const idx = cards.findIndex((c) => c.id === id);
  if (idx >= 0) cards[idx] = { id, ...record }; else cards.push({ id, ...record });
  cards.sort((a, b) => a.label.localeCompare(b.label));

  render();
  closeSheet();
  toast(editingId ? 'Card updated' : 'Card saved');
  editingId = null;
});

/* ---------------- in-app confirm (replaces window.confirm) ---------------- */
let confirmResolve = null;
function confirmAsk(title, body, yesText) {
  el.confirmTitle.textContent = title;
  el.confirmBody.textContent = body;
  el.confirmYes.textContent = yesText;
  reveal(el.confirm);
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function confirmClose(answer) {
  // The edit sheet may still be underneath (duplicate warning) — keep its scrim.
  const sheetStillOpen = el.sheet.classList.contains('is-open');
  el.confirm.classList.remove('is-open');
  if (!sheetStillOpen) el.scrim.classList.remove('is-open');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el.confirm.hidden = true;
    el.confirm.classList.remove('is-open');
    if (!sheetStillOpen) {
      el.scrim.hidden = true;
      el.scrim.classList.remove('is-open');
    }
    hideTimer = null;
  }, 320);
  if (confirmResolve) { confirmResolve(answer); confirmResolve = null; }
}
el.confirmYes.addEventListener('click', () => confirmClose(true));
el.confirmNo.addEventListener('click', () => confirmClose(false));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.confirm.hidden) confirmClose(false);
  else if (!el.sheet.hidden) closeSheet();
});

/* ---------------- boot ---------------- */
(async function boot() {
  show(await metaGet('faceid') ? 'lock' : 'setup');
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
