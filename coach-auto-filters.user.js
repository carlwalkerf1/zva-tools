// ==UserScript==
// @name         ZVA Tools
// @namespace    https://github.com/carlwalkerf1/zva-tools
// @version      1.10.0
// @description  Reapplies filters/page size on the Coach page, adds a "Needs Coaching" button, hides noisy columns, hides the Zoom top nav + sidebar, forces Knowledge base = FirstUp KB and shows Disposition/Engagement outcome on the individual query page, fixes Engagement ID links so the transcript loads and auto-opens past the standard bot greeting, and adds a Zendesk-search button on escalated transcripts
// @author       carlwalkerf1
// @match        https://zoom.us/ai-studio/kb/coach*
// @match        https://zoom.us/ai-studio/report*
// @match        https://firstup.zendesk.com/agent/*
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
  // On the individual query page (/ai-studio/kb/coach/selected), always force this KB.
  const DESIRED_KNOWLEDGE_BASE = 'FirstUp KB';
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

  // ---- Individual query page (/ai-studio/kb/coach/selected) ----
  // Its "Knowledge base" dropdown is the same Prism component as everything above
  // (just a different CSS build hash), so this reuses openPopoverFor/findOption/
  // closePopover directly. Unlike the list page's filters, this one has no stable
  // id at all - it's found by the combobox's aria-label, which the list page's own
  // "Knowledge base" filter does NOT carry (that one only has a placeholder), so
  // this selector doesn't collide with it.
  async function ensureKnowledgeBaseSelected(desiredLabel) {
    const combos = document.querySelectorAll('input[aria-label="Knowledge base"]');
    console.log('[coach-auto-filters] KB: matching combos found =', combos.length);
    const combo = combos[0];
    if (!combo) return;
    const filterRoot = combo.closest('.prism-InputOutline-root');
    console.log('[coach-auto-filters] KB: filterRoot found?', !!filterRoot);
    if (!filterRoot) return;

    const popover = await openPopoverFor(filterRoot, combo);
    console.log('[coach-auto-filters] KB: popover opened?', !!popover);
    if (!popover) return;

    const allLabels = [...popover.querySelectorAll(OPTION_SELECTOR)].map((el) => el.getAttribute('aria-label'));
    console.log('[coach-auto-filters] KB: options visible =', allLabels);

    const found = findOption(popover, desiredLabel);
    console.log('[coach-auto-filters] KB: found target option?', !!found, found && found.kind);
    if (!found) {
      console.warn('[coach-auto-filters] knowledge base option not found:', desiredLabel);
    } else if (!found.isSelected()) {
      if (found.kind === 'checkbox') {
        found.el.click();
      } else {
        simulateRealClick(found.el);
      }
      await sleep(150);
      console.log('[coach-auto-filters] KB: clicked, now selected?', found.isSelected());
    } else {
      console.log('[coach-auto-filters] KB: already selected, skipping click');
    }

    await closePopover(filterRoot, combo);
    console.log('[coach-auto-filters] KB: done');
  }

  async function runSelectedPage() {
    console.log('[coach-auto-filters] runSelectedPage: waiting for KB control...');
    try {
      await waitFor(() => document.querySelector('input[aria-label="Knowledge base"]'), 15000);
      console.log('[coach-auto-filters] runSelectedPage: KB control found, proceeding');
      await ensureKnowledgeBaseSelected(DESIRED_KNOWLEDGE_BASE);
    } catch (e) {
      console.warn('[coach-auto-filters] knowledge base control never appeared on /selected page', e);
    }
  }

  // Expands the "More filters (N)" row (Topic/Product type/Engagement outcome/
  // Language) so it's visible by default instead of collapsed. Matched by
  // aria-label prefix rather than the full "(4)" text, since that count could
  // change; once expanded the button's label changes away from "More filters"
  // (it becomes "Hide"), so this is naturally a no-op if already expanded -
  // it won't fight you if you collapse it back down yourself.
  function ensureMoreFiltersExpanded() {
    const btn = [...document.querySelectorAll('button[aria-label]')].find((b) =>
      b.getAttribute('aria-label').trim().startsWith('More filters')
    );
    if (btn) simulateRealClick(btn);
  }

  async function applyAllFilters() {
    ensureMoreFiltersExpanded();

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
    // window.scrollTo alone isn't reliable here: the actual scrolled container
    // may be a nested div rather than the window/document itself, and the table
    // re-rendering with more rows after the page-size change can re-trigger a
    // scroll-into-view on whatever still has focus. So this resets every
    // scrolled-down element it can find, both now and again shortly after to
    // catch that late re-render.
    scrollEverythingToTop();
    setTimeout(scrollEverythingToTop, 500);
  }

  function scrollEverythingToTop() {
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    document.querySelectorAll('*').forEach((el) => {
      if (el.scrollTop > 0) el.scrollTop = 0;
    });
  }

  async function run() {
    try {
      await waitFor(() => DESIRED_FILTERS.every(({ idSuffix }) => findFilterRoot(idSuffix)), 15000);
      await applyAllFilters();
    } catch {
      console.warn('[coach-auto-filters] gave up waiting for filter UI to appear at all');
    }
  }

  // The list page (filters/buttons/column-hiding/navbar) vs. the individual query
  // page (/coach/selected, its own Knowledge base dropdown) need separate gating -
  // isCoachPage() explicitly excludes /selected so the two don't run into each other.
  const isCoachPage = () =>
    location.pathname.includes('/ai-studio/kb/coach') && !isCoachSelectedPage();
  const isCoachSelectedPage = () => location.pathname.includes('/ai-studio/kb/coach/selected');

  if (isCoachPage()) run();
  if (isCoachSelectedPage()) runSelectedPage();

  // ---- "Needs Coaching" button + "show only blank disposition" toggle ----
  // The table is a plain ARIA grid (<table role=...>), not a Prism popover-based
  // widget, so no click-simulation tricks are needed here - just reading cells
  // and clicking real checkboxes.
  //
  // Zoom rebuilt this table on the Prism design system at some point after 2026-09
  // (`ui-Table-*` classes -> `prism-Table-*`), which silently broke every column-label
  // lookup below - this is the SECOND time this table's markup has changed under us
  // (see also the sidebar wrapper class change noted further down), so expect a third.
  // The label text now lives directly on `.prism-Table-headerCellWrapper` (even for a
  // header with an info-tooltip icon button, like "Query" - the icon is a plain SVG
  // with no text nodes, so it doesn't contaminate textContent), and a body cell's value
  // is the `<td>`'s own textContent directly - no inner label span anymore.
  function getColIndexByLabel(label) {
    const headerCells = document.querySelectorAll('thead th[role="columnheader"]');
    for (const th of headerCells) {
      const wrapper = th.querySelector('.prism-Table-headerCellWrapper');
      if (wrapper && wrapper.textContent.trim() === label) {
        return th.getAttribute('aria-colindex');
      }
    }
    return null;
  }
  const getDispositionColIndex = () => getColIndexByLabel('Disposition');

  const getBodyRows = () => document.querySelectorAll('tbody tr[role="row"]');

  function isRowBlankDisposition(row, colIndex) {
    const cell = row.querySelector(`td[aria-colindex="${colIndex}"]`);
    if (!cell) return false;
    const text = cell.textContent.trim();
    return text === '' || text === '--';
  }

  const getRowCheckbox = (row) => row.querySelector('.prism-Table-selectionColumn input[type="checkbox"]');

  function getCellText(row, colIndex) {
    if (!colIndex) return null;
    const cell = row.querySelector(`td[aria-colindex="${colIndex}"]`);
    const text = cell && cell.textContent.trim();
    return text || null;
  }

  // ---- Carry Disposition / Engagement outcome across navigation ----
  // The individual query page (/coach/selected) doesn't show either value itself, even
  // though the list page's table does - capture them off the row at the moment it's
  // clicked (before React unmounts it navigating away) and stash them for the next page
  // to pick up. This is same-tab client-side routing, so sessionStorage survives it.
  const ROW_DATA_STORAGE_KEY = 'zva-tools:lastClickedRow';
  const ROW_DATA_MAX_AGE_MS = 30000; // ignore stale leftovers from a much earlier click

  function captureRowDataOnClick(e) {
    const row = e.target.closest('tbody tr[role="row"]');
    if (!row) return;
    const data = {
      disposition: getCellText(row, getColIndexByLabel('Disposition')),
      outcome: getCellText(row, getColIndexByLabel('Engagement outcome')),
      ts: Date.now(),
    };
    try {
      sessionStorage.setItem(ROW_DATA_STORAGE_KEY, JSON.stringify(data));
    } catch {
      // sessionStorage unavailable (e.g. private mode) - the receiving page just won't
      // have anything to show, which is a silent no-op there too.
    }
  }

  // Capture phase, not bubble - so this reads the row before any click-triggered
  // re-render/navigation can unmount it, regardless of what the click actually did.
  if (isCoachPage()) document.addEventListener('click', captureRowDataOnClick, true);

  function readCarriedRowData() {
    try {
      const raw = sessionStorage.getItem(ROW_DATA_STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.ts > ROW_DATA_MAX_AGE_MS) return null;
      return data;
    } catch {
      return null;
    }
  }

  function makeLabeledSpan(label, value) {
    const span = document.createElement('span');
    span.dataset.coachHelper = 'disposition-outcome';
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    span.appendChild(strong);
    span.appendChild(document.createTextNode(value));
    return span;
  }

  // ---- Individual query page: display Disposition / Engagement outcome ----
  // Query match type is already shown in `.query-footer` - this adds the other two so
  // you don't have to go back to the list to remember what you're looking at.
  function injectDispositionAndOutcome() {
    const footer = document.querySelector('.query-footer');
    if (!footer || footer.querySelector('[data-coach-helper="disposition-outcome"]')) return;

    const data = readCarriedRowData();
    if (!data || (!data.disposition && !data.outcome)) return;

    if (data.disposition) footer.appendChild(makeLabeledSpan('Disposition', data.disposition));
    if (data.outcome) footer.appendChild(makeLabeledSpan('Engagement outcome', data.outcome));
  }

  // Unconditional, not gated by isCoachSelectedPage() - that page is always reached via
  // a same-tab client-side navigation from the list (never a fresh page load), so a
  // check made once at script-load time would always see the list page's URL and never
  // re-evaluate. `.query-footer` only exists on that page anyway, so it's the real gate.
  setInterval(injectDispositionAndOutcome, 1000);

  async function selectNeedsCoachingRows(button) {
    const colIndex = getDispositionColIndex();
    if (!colIndex) {
      console.warn('[coach-auto-filters] could not find the Disposition column');
      return;
    }

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Working...';
    // Yield once so the browser actually paints that label change before the
    // click loop below starts - otherwise the update and the (possibly slow,
    // fully synchronous) loop happen in the same frame and it never renders.
    await new Promise((resolve) => setTimeout(resolve, 0));

    let count = 0;
    const rows = [...getBodyRows()];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (isRowBlankDisposition(row, colIndex)) {
        const checkbox = getRowCheckbox(row);
        if (checkbox && !checkbox.checked) {
          checkbox.click();
          count++;
        }
      }
      // Yield periodically so the tab stays responsive and checkboxes visibly
      // tick as it goes, rather than the page freezing until it's all done.
      if (i % 10 === 9) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    console.log('[coach-auto-filters] selected', count, 'row(s) with blank Disposition');
    if (count === 0) {
      // Otherwise clicking this with nothing left to coach looks identical to it
      // being broken - nothing visibly happens either way.
      button.textContent = 'Nothing to select!';
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    button.disabled = false;
    button.textContent = originalLabel;
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
    needsCoachingBtn.addEventListener('click', () => selectNeedsCoachingRows(needsCoachingBtn));

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

  // ---- Fix Engagement ID transcript links ----
  // Clicking an Engagement ID often lands on a blank transcript page (zva-tools#1).
  // Root cause: the link's own `start`/`end` params are either a single day (the
  // query's own date, on the list page) or missing entirely (on the individual
  // /coach/selected page) - either way, too narrow/absent a window for the report
  // page to reliably resolve, apparently due to some timezone rounding on exactly
  // that day. A wide window reliably works instead (confirmed by hand), so this
  // overwrites start/end on every such link to [Star 3.0 rollout date -> today],
  // which comfortably covers any engagement without needing per-link guesswork.
  const ENGAGEMENT_LINK_START_DATE = '2026-08-17'; // Star 3.0 rollout
  const todayDateString = () => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  };

  // Also tucks the engagement's outcome into a `zvaOutcome` param, carried along so the
  // report page (a new tab - no shared sessionStorage, see below) knows whether to show
  // the Zendesk-search button in the transcript. On the list page that's read straight off
  // the link's own row; on /coach/selected (no table row there) it falls back to whatever
  // was carried over from the list-page click, same as the Disposition/outcome display above.
  //
  // The href is a hash-route URL - its query string lives after the `#`, not in the
  // real URL search part, so it can't be read via `new URL(href).searchParams`.
  function patchEngagementLink(a, outcomeColIndex, carriedRowData) {
    const href = a.getAttribute('href');
    if (!href) return;
    const hashIdx = href.indexOf('#');
    if (hashIdx === -1) return;
    const beforeHash = href.slice(0, hashIdx + 1);
    const afterHash = href.slice(hashIdx + 1);
    const qIdx = afterHash.indexOf('?');
    if (qIdx === -1) return;
    const routePath = afterHash.slice(0, qIdx);
    const params = new URLSearchParams(afterHash.slice(qIdx + 1));
    if (!params.has('engagementId')) return;
    params.set('start', ENGAGEMENT_LINK_START_DATE);
    params.set('end', todayDateString());

    const row = a.closest('tbody tr[role="row"]');
    const outcome = row ? getCellText(row, outcomeColIndex) : carriedRowData && carriedRowData.outcome;
    if (outcome) params.set('zvaOutcome', outcome);

    const newHref = `${beforeHash}${routePath}?${params.toString()}`;
    if (href !== newHref) a.setAttribute('href', newHref);
  }

  function patchAllEngagementLinks() {
    // Computed once per tick rather than once per link - these don't vary per-link.
    const outcomeColIndex = getColIndexByLabel('Engagement outcome'); // null off the list page
    const carriedRowData = outcomeColIndex ? null : readCarriedRowData();
    document
      .querySelectorAll('a[href*="/ai-studio/report#/analytics/reports/conversation-details"]')
      .forEach((a) => patchEngagementLink(a, outcomeColIndex, carriedRowData));
  }

  // Runs on both the list and /selected pages (the link shows up on both), and on an
  // interval rather than once since the table/page re-renders fresh anchors as it loads.
  setInterval(patchAllEngagementLinks, 1000);

  // ---- Report page: auto-open the transcript drawer ----
  // After the corrected Engagement ID link lands here, opening the transcript still
  // took manually scrolling to the engagement log row's "More actions" menu and
  // clicking "View transcript" (zva-tools#1). That menu is teleported into the DOM
  // without a stable id linking it back to its trigger button, so it's found generically
  // (any open `ul[role="menu"]`) rather than via the trigger's aria-controls value.
  //
  // Scoped to conversation-details pages that actually carry an engagementId - NOT
  // every /ai-studio/report* page - so this never fires on some other analytics
  // table elsewhere in the wider report product that happens to have its own
  // unrelated "More actions" menu.
  const isReportPage = () => location.pathname.includes('/ai-studio/report');
  const isSingleEngagementPage = () =>
    location.hash.includes('conversation-details') && location.hash.includes('engagementId=');

  async function openTranscriptForLoadedEngagement() {
    if (document.querySelector('.chat-transcript-drawer')) return; // already open

    const moreBtns = document.querySelectorAll('button[aria-label="More actions"]');
    if (moreBtns.length === 0) return; // engagement log row hasn't rendered yet
    const moreBtn = moreBtns[0];
    if (moreBtn.dataset.zvaAutoClicked) return; // already tried this element once
    moreBtn.dataset.zvaAutoClicked = '1';

    if (moreBtns.length > 1) {
      console.warn(
        '[coach-auto-filters] expected one engagement log row but found',
        moreBtns.length,
        '- using the first (newest) one'
      );
    }

    simulateRealClick(moreBtn);

    let viewTranscriptItem;
    try {
      viewTranscriptItem = await waitFor(
        () =>
          [...document.querySelectorAll('ul[role="menu"] li[role="menuitem"]')].find(
            (li) => li.textContent.trim() === 'View transcript'
          ),
        3000
      );
    } catch {
      console.warn('[coach-auto-filters] "View transcript" menu item never appeared');
      return;
    }

    simulateRealClick(viewTranscriptItem);
  }

  if (isReportPage()) {
    setInterval(() => {
      if (isSingleEngagementPage()) openTranscriptForLoadedEngagement();
    }, 1000);
  }

  // ---- Report page: skip the transcript's standard bot greeting ----
  // Every transcript opens on the same fixed "Hi! I'm Star..." boilerplate greeting
  // (zva-tools#1) - once the drawer is open and rendered, jump straight to the second
  // message instead of making you scroll past the greeting by hand every time.
  const GREETING_MARKER_TEXT = 'Firstup Self-Service bot';

  function maybeScrollPastGreeting() {
    const drawer = document.querySelector('.chat-transcript-drawer');
    if (!drawer || drawer.dataset.zvaScrolledPastGreeting) return;

    const messages = drawer.querySelectorAll('.zm-chatsdk__message');
    if (messages.length < 2) return; // transcript hasn't finished rendering yet

    if (!messages[0].textContent.includes(GREETING_MARKER_TEXT)) return;

    messages[1].scrollIntoView({ block: 'start' });
    // Mark it handled so this doesn't keep yanking the scroll position back down
    // if you manually scroll back up to re-read the greeting.
    drawer.dataset.zvaScrolledPastGreeting = '1';
  }

  if (isReportPage()) setInterval(maybeScrollPastGreeting, 500);

  // ---- Report page: "Search Zendesk" button on escalated transcripts ----
  // Only worth offering when the original query escalated - that's when the Zendesk
  // ticket (and its resolution) actually exists to search for. The outcome value travels
  // here via the `zvaOutcome` param added above, since this report page is a new tab with
  // no shared sessionStorage with the Coach page tab that linked here.
  //
  // There's no shared identifier between an engagement and its Zendesk ticket, and the
  // customer's wording in the ticket is often reworded slightly from the transcript - so
  // this adds the button to every Consumer message rather than guessing which one, and
  // you pick whichever one you were actually looking at.
  function engagementOutcomeFromUrl() {
    const qIdx = location.hash.indexOf('?');
    if (qIdx === -1) return null;
    return new URLSearchParams(location.hash.slice(qIdx + 1)).get('zvaOutcome');
  }

  const ZENDESK_SEARCH_BUTTON_STYLE =
    'display: inline-block; margin-top: 4px; padding: 2px 8px; font-size: 12px; ' +
    'border-radius: 6px; border: 1px solid #c8ccd4; background: #fff; cursor: pointer;';

  function injectZendeskSearchButtons() {
    if (engagementOutcomeFromUrl() !== 'Escalation') return;

    const consumerMessages = document.querySelectorAll(
      '.chat-transcript-drawer .zm-chatsdk__message[aria-label="Message from Consumer"]'
    );
    consumerMessages.forEach((message) => {
      if (message.querySelector('[data-coach-helper="zendesk-search"]')) return;
      const bubble = message.querySelector('.zm-chatsdk__text-block, .zm-chatsdk__html-block');
      if (!bubble) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.coachHelper = 'zendesk-search';
      btn.textContent = 'Search Zendesk';
      btn.style.cssText = ZENDESK_SEARCH_BUTTON_STYLE;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const query = bubble.textContent.trim();
        const url = `https://firstup.zendesk.com/agent/search/1?zvaQuery=${encodeURIComponent(query)}`;
        window.open(url, '_blank', 'noopener,noreferrer');
      });

      message.appendChild(btn);
    });
  }

  if (isReportPage()) setInterval(injectZendeskSearchButtons, 1000);

  // Re-run if the app navigates here via client-side routing instead of a full page load.
  let lastPath = location.pathname + location.search;
  const maybeRerun = () => {
    const path = location.pathname + location.search;
    if (path !== lastPath) {
      lastPath = path;
      if (isCoachPage()) setTimeout(run, 500);
      if (isCoachSelectedPage()) setTimeout(runSelectedPage, 500);
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
  // Target the wrapper column around #sidemenu, not the aside itself - hiding
  // just the aside left its parent's own box (and background) behind as an
  // empty gray rectangle still reserving the width. Class name has changed
  // once already (was .nav-menu.nav-menu-sticky-layout, now plain .nav-menu)
  // after a Zoom redesign - if the sidebar reappears again, check this first.
  const NAVBAR_SELECTORS = ['#header_container', '.nav-menu'];
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

  // Targets only the Zoom Coach page's own navbars - scope the toggle button and the
  // interval that applies it to Coach pages too, now that the script also runs on the
  // report page and Zendesk (added above), neither of which has anything for this to hide.
  if (isCoachPage() || isCoachSelectedPage()) {
    injectNavbarToggle();
    setInterval(applyNavbarVisibility, 1000);
  }

  // ---- Zendesk: run the search carried over from the "Search Zendesk" button ----
  // Picks up the `zvaQuery` param from the URL (see injectZendeskSearchButtons above),
  // types it into the advanced search box, and submits it - so the new tab lands
  // straight on results instead of an empty search page.
  function zvaQueryFromUrl() {
    return new URLSearchParams(location.search).get('zvaQuery');
  }

  // A plain `input.value = ...` doesn't notify React's controlled-input tracking (it
  // patches the native setter to detect real typing) - going through the native setter
  // directly, then dispatching `input`, is what makes React's own state actually update.
  function setNativeInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const ZENDESK_SEARCH_INPUT_SELECTOR =
    'input[data-test-id="search_advanced-search-box_input-field_media-input"]';

  async function runZendeskAutoSearch() {
    const query = zvaQueryFromUrl();
    if (!query) return;

    let input;
    try {
      input = await waitFor(() => document.querySelector(ZENDESK_SEARCH_INPUT_SELECTOR), 10000);
    } catch {
      console.warn('[coach-auto-filters] Zendesk search input never appeared');
      return;
    }

    setNativeInputValue(input, query);
    await sleep(200);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
    );
  }

  if (location.hostname === 'firstup.zendesk.com') runZendeskAutoSearch();
})();
