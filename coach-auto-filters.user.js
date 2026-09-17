// ==UserScript==
// @name         ZVA Tools
// @namespace    https://github.com/carlwalkerf1/zva-tools
// @version      1.5.1
// @description  Reapplies filters/page size on the Coach page, adds a "Needs Coaching" button, hides noisy columns, and hides the Zoom top nav + sidebar - Coach page only for now
// @author       carlwalkerf1
// @match        https://zoom.us/ai-studio/kb/coach*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/carlwalkerf1/zva-tools/main/coach-auto-filters.user.js
// @downloadURL  https://raw.githubusercontent.com/carlwalkerf1/zva-tools/main/coach-auto-filters.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---- Edit these to change what gets applied ----
  // Agent is safe to force 100% of the time for this subteam (the other agent
  // options are neglected/older versions). Query matching is NOT forced anymore -
  // "No match" was too narrow an assumption (there are legitimate reasons to want
  // to coach matched queries too). Revisit with a real auto-select preferences UI
  // instead of re-enabling this blindly.
  const DESIRED_FILTERS = [
    { idSuffix: 'bot-agent-filter-input', labels: ['Star ✦ 3.0'] },
    // { idSuffix: 'match-type-input', labels: ['No match'] },
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

    // Clicking the page-size control (at the bottom of the table) leaves the
    // page scrolled down there - scroll back to the top once we're done with it.
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  async function run() {
    try {
      await waitFor(() => DESIRED_FILTERS.every(({ idSuffix }) => findFilterRoot(idSuffix)), 15000);
      await applyAllFilters();
    } catch {
      console.warn('[coach-auto-filters] gave up waiting for filter UI to appear at all');
    }
  }

  // Filters/buttons/column-hiding are Coach-page-specific; the navbar hiding
  // below applies to every /ai-studio/kb/* page.
  const isCoachPage = () => location.pathname.includes('/ai-studio/kb/coach');

  if (isCoachPage()) run();

  // ---- "Needs Coaching" button + "show only blank disposition" toggle ----
  // The table is a plain ARIA grid (<table role=...>), not a Prism popover-based
  // widget, so no click-simulation tricks are needed here - just reading cells
  // and clicking real checkboxes.

  // Most header cells' text lives in a `.ui-Table-cell-label` span, but "Query" has a
  // tooltip icon and renders without that class - read the whole header-wrapper's text
  // instead, since icons contribute no text content and this covers every column.
  function getColIndexByLabel(label) {
    const headerCells = document.querySelectorAll('thead th[role="columnheader"]');
    for (const th of headerCells) {
      const wrapper = th.querySelector('.ui-Table-header-wrapper');
      if (wrapper && wrapper.textContent.trim() === label) {
        return th.getAttribute('aria-colindex');
      }
    }
    return null;
  }
  const getDispositionColIndex = () => getColIndexByLabel('Disposition');

  const getBodyRows = () => document.querySelectorAll('tbody tr[role="row"]');

  function isRowBlankDisposition(row, colIndex) {
    const cell = row.querySelector(`td[aria-colindex="${colIndex}"] .ui-Table-cell-label`);
    if (!cell) return false;
    const text = cell.textContent.trim();
    return text === '' || text === '--';
  }

  const getRowCheckbox = (row) => row.querySelector('.ui-Table-selection-column input[type="checkbox"]');

  function selectNeedsCoachingRows() {
    const colIndex = getDispositionColIndex();
    if (!colIndex) {
      console.warn('[coach-auto-filters] could not find the Disposition column');
      return;
    }
    let count = 0;
    getBodyRows().forEach((row) => {
      if (!isRowBlankDisposition(row, colIndex)) return;
      const checkbox = getRowCheckbox(row);
      if (checkbox && !checkbox.checked) {
        checkbox.click();
        count++;
      }
    });
    console.log('[coach-auto-filters] selected', count, 'row(s) with blank Disposition');
  }

  let hideNonBlankActive = false;
  function toggleHideNonBlank(button) {
    const colIndex = getDispositionColIndex();
    if (!colIndex) {
      console.warn('[coach-auto-filters] could not find the Disposition column');
      return;
    }
    hideNonBlankActive = !hideNonBlankActive;
    getBodyRows().forEach((row) => {
      const blank = isRowBlankDisposition(row, colIndex);
      row.style.display = hideNonBlankActive && !blank ? 'none' : '';
    });
    button.textContent = hideNonBlankActive ? 'Show all rows' : 'Show only blank disposition';
  }

  const HELPER_BUTTON_STYLE =
    'margin-left: 8px; padding: 6px 12px; font-size: 14px; border-radius: 6px; ' +
    'border: 1px solid #c8ccd4; background: #fff; cursor: pointer;';

  function injectCoachHelperButtons() {
    const resetBtn = document.querySelector('button[aria-label="Reset"]');
    if (!resetBtn || !resetBtn.parentElement) return;
    if (resetBtn.parentElement.querySelector('[data-coach-helper]')) return; // already injected

    const needsCoachingBtn = document.createElement('button');
    needsCoachingBtn.type = 'button';
    needsCoachingBtn.textContent = 'Needs Coaching';
    needsCoachingBtn.dataset.coachHelper = 'needs-coaching';
    needsCoachingBtn.style.cssText = HELPER_BUTTON_STYLE;
    needsCoachingBtn.title = 'Check every row on this page whose Disposition is blank';
    needsCoachingBtn.addEventListener('click', selectNeedsCoachingRows);

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.textContent = 'Show only blank disposition';
    hideBtn.dataset.coachHelper = 'hide-non-blank';
    hideBtn.style.cssText = HELPER_BUTTON_STYLE;
    hideBtn.title = 'Hide rows that already have a Disposition set';
    hideBtn.addEventListener('click', () => toggleHideNonBlank(hideBtn));

    resetBtn.insertAdjacentElement('afterend', needsCoachingBtn);
    needsCoachingBtn.insertAdjacentElement('afterend', hideBtn);
  }

  // The filter bar can re-render (e.g. after our own filter clicks above), which can
  // wipe out manually-injected DOM nodes React doesn't know about - so keep re-checking
  // rather than injecting once and hoping it sticks.
  if (isCoachPage()) setInterval(injectCoachHelperButtons, 1500);

  // ---- Hidden columns ----
  // Edit this list to change which columns get hidden. Unlike the column-reordering
  // attempt that got reverted, this only toggles `display: none` on existing cells -
  // it never moves a node React owns, so there's no risk of it fighting a re-render
  // and putting the wrong data under the wrong header. Worst case if React resets the
  // style, the column just becomes visible again for a moment until the next interval tick.
  const HIDDEN_COLUMNS = ['Agent', 'Knowledge base', 'Language'];

  function hideUnwantedColumns() {
    HIDDEN_COLUMNS.forEach((label) => {
      const colIndex = getColIndexByLabel(label);
      if (!colIndex) return;
      const headerCell = document.querySelector(`thead th[aria-colindex="${colIndex}"]`);
      if (headerCell) headerCell.style.display = 'none';
      document.querySelectorAll(`tbody td[aria-colindex="${colIndex}"]`).forEach((td) => {
        td.style.display = 'none';
      });
    });
  }

  if (isCoachPage()) setInterval(hideUnwantedColumns, 1500);

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

  // ---- Hide navbars ----
  // Applies to every /ai-studio/kb/* page, not just Coach. #header_container is the
  // top nav (both its rows); #sidemenu is the left nav, which turns out to be its own
  // separate Vue app (data-v-app) that mounts later than header_container - so a single
  // fire-once apply missed it. Unlike the table, hiding is a plain style toggle with no
  // node-moving, so polling to catch late mounts / re-renders carries none of the
  // reorder's data-misalignment risk - worst case is a brief flash of the element.
  // Target the sticky wrapper column around #sidemenu, not the aside itself -
  // hiding just the aside left its parent's own box (and background) behind as
  // an empty gray rectangle still reserving the width.
  const NAVBAR_SELECTORS = ['#header_container', '.nav-menu.nav-menu-sticky-layout'];
  let navbarsHidden = true;

  function applyNavbarVisibility() {
    NAVBAR_SELECTORS.forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      // A plain `el.style.display = 'none'` loses to a stylesheet rule that uses
      // !important (confirmed on #sidemenu: computed style stayed "block" even
      // though el.style.display read back as "none") - setProperty is the only
      // way to set an inline !important override from JS.
      if (navbarsHidden) {
        el.style.setProperty('display', 'none', 'important');
      } else {
        el.style.removeProperty('display');
      }
    });
  }

  const NAVBAR_TOGGLE_STYLE =
    'position: fixed; top: 8px; left: 8px; z-index: 999999; padding: 4px 10px; ' +
    'font-size: 12px; border-radius: 6px; border: 1px solid #c8ccd4; background: #fff; ' +
    'cursor: pointer; opacity: 0.6;';

  function injectNavbarToggle() {
    if (document.querySelector('[data-coach-helper="navbar-toggle"]')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.coachHelper = 'navbar-toggle';
    btn.style.cssText = NAVBAR_TOGGLE_STYLE;
    btn.textContent = 'Show navbars';
    btn.title = 'Toggle the Zoom top nav and left sidebar on/off';
    btn.addEventListener('click', () => {
      navbarsHidden = !navbarsHidden;
      applyNavbarVisibility();
      btn.textContent = navbarsHidden ? 'Show navbars' : 'Hide navbars';
    });
    document.body.appendChild(btn);
  }

  injectNavbarToggle();
  setInterval(applyNavbarVisibility, 1000);
})();
