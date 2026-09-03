// ==UserScript==
// @name         Zoom AI Studio Coach - Auto Filters
// @namespace    https://github.com/carlwalkerf1/zva-coach-auto-filters
// @version      1.0.0
// @description  Reapplies the Agent, Query matching, and page-size filters on the ZVA Knowledge Library Coach page every time you load it
// @author       carlwalkerf1
// @match        https://zoom.us/ai-studio/kb/coach*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/carlwalkerf1/zva-coach-auto-filters/main/coach-auto-filters.user.js
// @downloadURL  https://raw.githubusercontent.com/carlwalkerf1/zva-coach-auto-filters/main/coach-auto-filters.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---- Edit these to change what gets applied ----
  const DESIRED_FILTERS = [
    { idSuffix: 'bot-agent-filter-input', labels: ['Star ✦ 3.0'] },
    { idSuffix: 'match-type-input', labels: ['No match'] },
  ];
  const DESIRED_PAGE_SIZE = '100 per page';
  // --------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(check, timeoutMs = 15000, intervalMs = 200) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const result = check();
        if (result) return resolve(result);
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
        setTimeout(poll, intervalMs);
      })();
    });
  }

  // Filter box ids seem to get a random per-load prefix on some of them, so match by suffix.
  const findFilterRoot = (idSuffix) => document.querySelector(`[id$="${idSuffix}"]`);
  const currentTagLabels = (root) =>
    [...root.querySelectorAll('.prism-Tag-content')].map((el) => el.textContent.trim());

  // The page-size control carries no id at all, so it's located by its own rendered text
  // ("10 per page", "100 per page", ...) instead.
  const findPageSizeCombo = () =>
    [...document.querySelectorAll('[role="combobox"]')].find((el) =>
      /^\d+\s*per page$/i.test(el.textContent.trim())
    );

  // When a filter's dropdown is open, its wrapper carries aria-describedby="popover-XXXX-content"
  // pointing at ITS OWN popover element's id. Searching the whole document for "any open popover"
  // is ambiguous if a previous filter's popover hasn't fully unmounted yet - this scopes the lookup.
  function findOwnPopoverId(filterRoot) {
    const wrapper = filterRoot.querySelector('[aria-describedby^="popover-"]');
    return wrapper && wrapper.getAttribute('aria-describedby');
  }

  const OPTION_SELECTOR = '.prism-Checkbox-root, li[role="option"]';

  // Two known option shapes:
  //  - Agent filter: .prism-Checkbox-root wrapping an <input type="checkbox">, state via aria-checked.
  //  - Query-matching / page-size filters: plain <li role="option" aria-selected="...">, click the li itself.
  function findOption(popover, label) {
    const el = [...popover.querySelectorAll(OPTION_SELECTOR)].find(
      (n) => n.getAttribute('aria-label') === label
    );
    if (!el) return null;
    if (el.classList.contains('prism-Checkbox-root')) {
      const checkbox = el.querySelector('input[type="checkbox"]');
      return (
        checkbox && {
          kind: 'checkbox',
          el: checkbox,
          isSelected: () => checkbox.getAttribute('aria-checked') === 'true',
        }
      );
    }
    return { kind: 'option', el, isSelected: () => el.getAttribute('aria-selected') === 'true' };
  }

  // el.click() only fires a synthetic 'click' event - no mousedown/pointerdown/focus. This app's
  // combobox opens on mousedown/focus, so a bare .click() silently does nothing; this simulates
  // the fuller real-click event sequence instead.
  function simulateRealClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const common = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    const pointer = { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true };

    el.dispatchEvent(new PointerEvent('pointerover', pointer));
    el.dispatchEvent(new MouseEvent('mouseover', common));
    el.dispatchEvent(new PointerEvent('pointerdown', pointer));
    el.dispatchEvent(new MouseEvent('mousedown', common));
    if (typeof el.focus === 'function') el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', pointer));
    el.dispatchEvent(new MouseEvent('mouseup', common));
    el.dispatchEvent(new MouseEvent('click', common));
  }

  // filterRoot = the ancestor that carries aria-describedby when open (scopes the popover lookup).
  async function openPopoverFor(filterRoot, combo) {
    simulateRealClick(combo);

    let popoverId;
    try {
      popoverId = await waitFor(() => findOwnPopoverId(filterRoot), 3000);
    } catch {
      console.warn('[coach-auto-filters] dropdown never opened for', filterRoot);
      return null;
    }

    const popover = document.getElementById(popoverId);
    if (!popover) return null;

    try {
      await waitFor(() => popover.querySelectorAll(OPTION_SELECTOR).length > 0, 2000);
    } catch {
      console.warn('[coach-auto-filters] option rows never rendered inside popover for', filterRoot);
      return null;
    }

    return popover;
  }

  async function closePopover(filterRoot, combo) {
    combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    try {
      await waitFor(() => !findOwnPopoverId(filterRoot), 1500);
      return;
    } catch {
      // fall through to the click-toggle fallback below
    }
    simulateRealClick(combo);
    await waitFor(() => !findOwnPopoverId(filterRoot), 1500).catch(() => {});
  }

  async function ensureSelected(filterRoot, labels) {
    const already = currentTagLabels(filterRoot);
    const missing = labels.filter((l) => !already.includes(l));
    if (missing.length === 0) return;

    const combo = filterRoot.querySelector('[role="combobox"]');
    if (!combo) return;

    const popover = await openPopoverFor(filterRoot, combo);
    if (!popover) return;

    for (const label of missing) {
      const found = findOption(popover, label);
      if (!found) continue;
      if (!found.isSelected()) {
        if (found.kind === 'checkbox') {
          found.el.click();
        } else {
          simulateRealClick(found.el);
        }
        await sleep(150);
      }
    }

    await closePopover(filterRoot, combo);
  }

  async function ensurePageSize(desiredLabel) {
    const combo = findPageSizeCombo();
    if (!combo) return;

    const currentText = combo.textContent.trim();
    if (currentText.toLowerCase() === desiredLabel.toLowerCase()) return;

    const filterRoot = combo.closest('.prism-InputOutline-root') || combo.parentElement;
    const popover = await openPopoverFor(filterRoot, combo);
    if (!popover) return;

    const found = findOption(popover, desiredLabel);
    if (found && !found.isSelected()) {
      if (found.kind === 'checkbox') {
        found.el.click();
      } else {
        simulateRealClick(found.el);
      }
      await sleep(150);
    }

    await closePopover(filterRoot, combo);
  }

  async function applyAllFilters() {
    for (const { idSuffix, labels } of DESIRED_FILTERS) {
      const root = findFilterRoot(idSuffix);
      if (root) {
        await ensureSelected(root, labels);
        await sleep(200);
      }
    }

    try {
      await waitFor(findPageSizeCombo, 15000);
      await ensurePageSize(DESIRED_PAGE_SIZE);
    } catch {
      console.warn('[coach-auto-filters] page-size control never appeared');
    }
  }

  async function run() {
    try {
      await waitFor(() => DESIRED_FILTERS.every(({ idSuffix }) => findFilterRoot(idSuffix)), 15000);
      await applyAllFilters();
    } catch {
      console.warn('[coach-auto-filters] gave up waiting for filter UI to appear at all');
    }
  }

  run();

  // Re-run if the app navigates here via client-side routing instead of a full page load.
  let lastPath = location.pathname + location.search;
  const maybeRerun = () => {
    const path = location.pathname + location.search;
    if (path !== lastPath) {
      lastPath = path;
      if (location.pathname.includes('/ai-studio/kb/coach')) setTimeout(run, 500);
    }
  };
  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const ret = orig.apply(this, args);
      maybeRerun();
      return ret;
    };
  });
  window.addEventListener('popstate', maybeRerun);
})();
