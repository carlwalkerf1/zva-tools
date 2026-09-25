# ZVA Tools

A [Tampermonkey](https://www.tampermonkey.net/) userscript for the Zoom AI Studio Knowledge Library, mainly the **Coach** page (`https://zoom.us/ai-studio/kb/coach`):

- Reapplies your preferred filters and page size every time you load the Coach page, instead of clicking through them by hand each visit.
- Adds a **"Needs Coaching"** button that checks every row on the current page whose **Disposition** column is blank (`--`) — there's no native way to filter or bulk-select on that today.
- Adds a **"Show only blank disposition"** toggle to hide everything else so you can see just what needs attention.
- Hides the **Agent**, **Knowledge base**, and **Language** columns on the Coach table — with them gone, there's enough width to see checkboxes and Disposition on screen at once, which is otherwise impossible without horizontal scrolling.
- Hides Zoom's top nav bar and left sidebar, reclaiming space for the actual app. A small **"Show navbars" / "Hide navbars"** toggle stays pinned to the top-left corner for the rare case you need to navigate elsewhere.

By default it sets:

- **Agent** = `Star ✦ 3.0` (this subteam uses this agent 100% of the time — the other agents are neglected/older versions, so it's safe to force)
- **Page size** = `100 per page`

**Query matching is currently NOT auto-set.** It used to default to `No match`, but that assumed you'd only ever want to coach unmatched queries — not true in practice. It's commented out in the script rather than removed; the real fix is a proper "auto-select preferences" UI rather than guessing at one hardcoded value, which isn't built yet.

## Install

1. Install Tampermonkey extension https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo?hl=en
2. Go to chrome://extensions/
3. Enable Developer mode in upper-left corner if necessary.
4. Scroll to Tampermonkey and click Details 
5. Enable Allow User Scripts.
6. **[Click here to install the script](https://raw.githubusercontent.com/carlwalkerf1/zva-tools/main/coach-auto-filters.user.js)** — Tampermonkey will detect it and show an install prompt automatically.

Updates: since this script's `@updateURL` points back at this repo, Tampermonkey will pick up future changes automatically — no need to reinstall.

## Customizing

Edit the constants at the top of the script:

```js
const DESIRED_FILTERS = [
  { idSuffix: 'bot-agent-filter-input', labels: ['Star ✦ 3.0'] },
  // { idSuffix: 'match-type-input', labels: ['No match'] },
];
const DESIRED_PAGE_SIZE = '100 per page';
```

- `idSuffix` targets a specific filter control on the page (its DOM id can have a random prefix, so it's matched by suffix).
- `labels` is a list of option text to select in that filter's dropdown — add more strings to select multiple values in the same filter.
- It's additive: it only adds missing selections, it won't remove an option that's already selected for some other reason.
- Uncomment the `match-type-input` line (and adjust its `labels`) if you want Query matching auto-set again.

Further down, `HIDDEN_COLUMNS` controls which Coach table columns get hidden:

```js
const HIDDEN_COLUMNS = ['Agent', 'Knowledge base', 'Language'];
```

Remove an entry (or add another column's exact header text) to change what's hidden.

## The "Needs Coaching" button

Located next to the **Reset** button in the filter bar. It reads the table's `Disposition` column (found dynamically by header text, not a hardcoded position) and clicks the row checkbox for every row where that column reads blank (`--`). This only affects rows currently loaded on the page — for large result sets you'd still page through and click it on each page.

Clicking a lot of checkboxes at once (up to 100 on a full page) is genuinely slow, since each one triggers the app's own re-render - the button shows **"Working..."** and disables itself while that runs so it doesn't look stuck, and yields periodically so the checkboxes visibly tick one by one instead of the tab freezing until it's all done.

## Hiding the top nav and sidebar

A tiny toggle button sits pinned to the top-left corner of the Coach page. It starts as **"Show navbars"** (meaning: navbars are currently hidden, click to bring them back) and flips to **"Hide navbars"** once shown. This is a pure `display: none` toggle — it never moves or restructures anything, so it can't scramble page content the way DOM reordering could (see below).

**Scope is deliberately limited to just the Coach page (`@match https://zoom.us/ai-studio/kb/coach*`) for now.** This used to run across every `/ai-studio/kb/*` page, but other pages in the wider AI Studio product (e.g. `/ai-studio/virtual-agent/agents`) have their own layouts and column needs that this hasn't been checked against — hiding a column or navbar element there could break something we haven't seen yet. Revisit broadening this once each page's actual needs are understood, rather than assuming what worked for Coach is safe everywhere.

One known cosmetic issue: hiding the top nav currently leaves a bit of dead blank space at the very top of the page (there's a separate, not-yet-found CSS rule reserving that height to compensate for the nav normally being fixed-position). It's harmless — you just scroll past it — not yet fixed.

## How it works

The filters are Zoom's internal "Prism" (MUI-based React) dropdown components. A plain `.click()` on their combobox doesn't open the dropdown, because the app listens for a fuller `pointerdown`/`mousedown`/`focus` sequence — so the script simulates that instead of a bare click. Each filter's own popover is looked up via its `aria-describedby` attribute (rather than "whichever popover happens to be open") to avoid racing against a previous dropdown that hasn't fully closed yet.

The results table, by contrast, is a plain semantic `<table>` (ARIA grid), so the coaching button and column-hiding just read cell text and toggle styles / click real checkboxes — no simulated-event tricks needed there.

The nav-hiding target elements belong to an older, separate page shell (not the React app), and one of them (the sidebar) is overridden by a stylesheet rule using `!important` — a plain `el.style.display = 'none'` silently loses to that, so it's set via `el.style.setProperty('display', 'none', 'important')` instead.

**Column reordering was attempted and reverted.** An earlier version physically moved `<td>`/`<th>` DOM nodes to reorder columns. That table is actively managed by React, and moving nodes it owns turned out to risk real data ending up under the wrong header on re-render (confirmed while testing — not hypothetical). Column *hiding* avoids this entirely since it only toggles an existing node's visibility rather than relocating it.

## Limitations

If Zoom changes this page's markup in a future release, the script may stop finding these elements. It's written to fail silently (log a console warning, do nothing) rather than click or select blindly, so a change should look like "nothing happens" rather than mis-clicking something else. Check the browser console for `[coach-auto-filters]` warnings if it stops working.
