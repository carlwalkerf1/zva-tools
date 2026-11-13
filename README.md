# ZVA Tools

A [Tampermonkey](https://www.tampermonkey.net/) userscript for the Zoom AI Studio Knowledge Library, mainly the **Coach** page (`https://zoom.us/ai-studio/kb/coach`):

- Reapplies your preferred filters and page size every time you load the Coach page, instead of clicking through them by hand each visit.
- Adds a **"Needs Coaching"** button that checks every row on the current page whose **Disposition** column is blank (`--`) — there's no native way to filter or bulk-select on that today.
- Adds a **"Show only blank disposition"** toggle to hide everything else so you can see just what needs attention.
- Hides the **Agent**, **Knowledge base**, and **Language** columns on the Coach table — with them gone, there's enough width to see checkboxes and Disposition on screen at once, which is otherwise impossible without horizontal scrolling.
- Hides Zoom's top nav bar and left sidebar, reclaiming space for the actual app. A small **"Show navbars" / "Hide navbars"** toggle stays pinned to the top-left corner for the rare case you need to navigate elsewhere.
- On the individual query page (`https://zoom.us/ai-studio/kb/coach/selected`), always forces **Knowledge base = FirstUp KB**.
- Fixes **Engagement ID** links (on both the list and individual query page) so clicking one reliably loads the transcript instead of landing on a blank report page, opens the transcript drawer automatically, and skips its standard bot greeting.
- On the individual query page, displays **Disposition** and **Engagement outcome** alongside the already-shown Query match type, so you don't have to go back to the list to remember what you're looking at.
- On an escalated transcript, adds a **"Search Zendesk"** button to every customer message, which opens a Zendesk search for that message's text in a new tab.

By default it sets:

- **Agent** = `Star ✦ 3.0` (this subteam uses this agent 100% of the time — the other agents are neglected/older versions, so it's safe to force)
- **Page size** = `100 per page`
- **Knowledge base (on the individual query page only)** = `FirstUp KB`

**Query matching is currently NOT auto-set.** It used to default to `No match`, but that assumed you'd only ever want to coach unmatched queries — not true in practice. It's commented out in the script rather than removed; the real fix is a proper "auto-select preferences" UI rather than guessing at one hardcoded value, which isn't built yet.

## Install

1. Install Tampermonkey extension https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo?hl=en
2. Go to chrome://extensions/
3. Enable Developer mode in upper-left corner if necessary.
4. Scroll to Tampermonkey and click Details 
5. Enable Allow User Scripts.
6. **[Click here to install the script](https://raw.githubusercontent.com/carlwalkerf1/zva-tools/main/coach-auto-filters.user.js)** — Tampermonkey will detect it and show an install prompt automatically.

### Updates: don't rely on auto-update actually happening

This script's `@updateURL` is wired up so Tampermonkey *should* pick up new versions on its own. In practice, on at least one real install (Tampermonkey v5.5.0, Chrome, Manifest V3), it silently stopped checking entirely and stayed on an old version for 12+ days despite correct settings (interval set, "Automatic installation" checked). This wasn't specific to this script or repo — a second, unrelated userscript on the same machine had the exact same problem.

Investigation pointed at Tampermonkey's own background process, not anything on our end:

- Chrome policy (`chrome://policy`) showed **no** organization-pushed policies affecting Tampermonkey at all - ruled out IT/enterprise restriction as the cause.
- Tampermonkey's own service-worker console (`chrome://extensions` → Tampermonkey card → "service worker" link) showed hundreds of repeated `Cannot create item with duplicate id` errors - a documented, currently-open Tampermonkey bug ([#2893](https://github.com/Tampermonkey/tampermonkey/issues/2893)) where a Chrome back/forward-cache restore causes menu commands to re-register without cleaning up the old ones, eventually wedging the background process until the browser is fully restarted.
- After restarting the browser, that specific error went away, but a *different* warning appeared instead - `alarm: no data for alarm ...` - consistent with Tampermonkey's periodic update-check alarm firing after its own state (which the update logic needs) had already been wiped by Chrome recycling the idle service worker, a routine occurrence under Manifest V3.

Net effect: this looks like a genuine reliability problem in how this Tampermonkey version manages its own background state under Manifest V3, not a one-off fluke and not fixable from the userscript side. **Treat manual reinstall as the standing update process**, not something to set-and-forget:

1. Open Tampermonkey's Dashboard → **Utilities** tab → **Import from URL**.
2. Paste `https://raw.githubusercontent.com/carlwalkerf1/zva-tools/main/coach-auto-filters.user.js` → **Install**.
3. Confirm the version shown afterward on the **Installed Userscripts** tab actually matches what's in this repo.

If a future Tampermonkey release fixes #2893 (or the underlying alarm/state-persistence issue) and auto-update starts working reliably again, this section should be revisited rather than assumed fixed.

## Customizing

Edit the constants at the top of the script:

```js
const DESIRED_FILTERS = [
  { idSuffix: 'bot-agent-filter-input', labels: ['Star ✦ 3.0'] },
  // { idSuffix: 'match-type-input', labels: ['No match'] },
];
const DESIRED_PAGE_SIZE = '100 per page';
const DESIRED_KNOWLEDGE_BASE = 'FirstUp KB'; // used on the /coach/selected page only
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

If there's nothing left to coach on the page, it briefly shows **"Nothing to select!"** instead of just silently doing nothing - otherwise "it worked but there was nothing to do" and "it's broken" look identical from the outside.

The other two buttons ("Show only blank disposition" and the navbar show/hide toggle) don't get a "Working..." treatment - they're just instant style toggles on elements already on the page, not a loop of expensive re-render-triggering clicks, so there's nothing slow to mask.

## Hiding the top nav and sidebar

A tiny toggle button sits pinned to the top-left corner of the Coach page. It starts as **"Show navbars"** (meaning: navbars are currently hidden, click to bring them back) and flips to **"Hide navbars"** once shown. This is a pure `display: none` toggle — it never moves or restructures anything, so it can't scramble page content the way DOM reordering could (see below).

**Scope is deliberately limited to just the Coach page (`@match https://zoom.us/ai-studio/kb/coach*`) for now.** This used to run across every `/ai-studio/kb/*` page, but other pages in the wider AI Studio product (e.g. `/ai-studio/virtual-agent/agents`) have their own layouts and column needs that this hasn't been checked against — hiding a column or navbar element there could break something we haven't seen yet. Revisit broadening this once each page's actual needs are understood, rather than assuming what worked for Coach is safe everywhere.

One known cosmetic issue: hiding the top nav currently leaves a bit of dead blank space at the very top of the page (there's a separate, not-yet-found CSS rule reserving that height to compensate for the nav normally being fixed-position). It's harmless — you just scroll past it — not yet fixed.

## Fixing Engagement ID transcript links

Clicking an Engagement ID (on either the list page or the individual query page) often landed on a blank report page instead of the transcript ([zva-tools#1](https://github.com/carlwalkerf1/zva-tools/issues/1)). The link itself carries the date window the report page loads, and that window was the problem: on the list page it's a single day (the query's own date), on the individual query page it's missing entirely — either way too narrow (or absent) for the report page to reliably resolve, apparently due to timezone rounding right at that single day's edge. A wide window doesn't have that edge case, so this script rewrites every such link's `start`/`end` params to run from the Star 3.0 rollout date through today before you ever click it — the transcript just loads.

```js
const ENGAGEMENT_LINK_START_DATE = '2026-08-17'; // Star 3.0 rollout
```

Edit that constant if the window ever needs to start earlier (e.g. to cover older engagements from before Star 3.0).

Once on the report page, the script also opens the transcript drawer itself — it clicks the engagement log row's "More actions" menu and then "View transcript" for you. This is scoped to conversation-detail pages that carry an `engagementId` in the URL (i.e. pages reached via one of the fixed links above), so it never fires on some unrelated table elsewhere in the wider report product that happens to have its own "More actions" menu. If the engagement log ever shows more than one row at that point, it uses the first (newest) one and logs a console warning rather than guessing wrong silently.

Every transcript then opens on the same fixed bot greeting ("Hi! I'm Star..."). The script auto-scrolls the drawer past it, straight to the first real message, once per time the drawer opens.

## Disposition / Engagement outcome on the individual query page

That page doesn't show either value natively, even though the list page's table does. The script captures them off the table row at the moment you click it to navigate there (before React unmounts the row) and stashes them in `sessionStorage` for the query page to pick up and display next to Query match type. If you open that page some other way (a refresh, a direct link) there's nothing to carry over, so it just won't show anything — a silent no-op rather than a guess.

## Zendesk search button on escalated transcripts (zva-tools#1)

The other half of zva-tools#1. Only shown when the original query's **Engagement outcome was Escalation** — that's the only time a corresponding Zendesk ticket actually exists to search for. There's no shared identifier between an engagement and its Zendesk ticket, and the customer's wording is often reworded slightly between the chat and the ticket, so rather than guess which message to search, the button is added to **every** customer message in the transcript — you pick whichever one you were actually looking at.

The outcome value has to travel from the Coach page to the report page (a separate tab opened with `noopener`, so no shared `sessionStorage`) — it rides along as a `zvaOutcome` param on the same Engagement ID link that already carries the corrected date window. Clicking "Search Zendesk" opens `https://firstup.zendesk.com/agent/search/1?zvaQuery=<the message text>` in a new tab; a matching script section on the Zendesk side reads that `zvaQuery` param, types it into the advanced search box (via React's native input setter, since a plain `.value =` doesn't register with a controlled input), and submits it so the tab lands straight on results.

## How it works

The filters are Zoom's internal "Prism" (MUI-based React) dropdown components. A plain `.click()` on their combobox doesn't open the dropdown, because the app listens for a fuller `pointerdown`/`mousedown`/`focus` sequence — so the script simulates that instead of a bare click. Each filter's own popover is looked up via its `aria-describedby` attribute (rather than "whichever popover happens to be open") to avoid racing against a previous dropdown that hasn't fully closed yet.

The results table, by contrast, is a plain semantic `<table>` (ARIA grid), so the coaching button and column-hiding just read cell text and toggle styles / click real checkboxes — no simulated-event tricks needed there.

The nav-hiding target elements belong to an older, separate page shell (not the React app), and one of them (the sidebar) is overridden by a stylesheet rule using `!important` — a plain `el.style.display = 'none'` silently loses to that, so it's set via `el.style.setProperty('display', 'none', 'important')` instead.

The individual query page's Knowledge base dropdown is the exact same Prism component, just a different CSS build hash, so it reuses the same open/select/close logic. It's found via `input[aria-label="Knowledge base"]` rather than a stable id (it has none) — the list page's own "Knowledge base (All)" filter only carries a placeholder, not that `aria-label`, so the two don't collide. This is gated to `/ai-studio/kb/coach/selected` specifically, separate from the list page's own logic, so a change to one can't accidentally start touching the other.

The Engagement ID link is a hash-route URL — its query string (`tab`, `engagementId`, `start`, `end`) lives after the `#`, not in the real URL search part, so it can't be read via `new URL(href).searchParams`; the fix parses that part of the string by hand instead.

**Column reordering was attempted and reverted.** An earlier version physically moved `<td>`/`<th>` DOM nodes to reorder columns. That table is actively managed by React, and moving nodes it owns turned out to risk real data ending up under the wrong header on re-render (confirmed while testing — not hypothetical). Column *hiding* avoids this entirely since it only toggles an existing node's visibility rather than relocating it.

## Limitations

If Zoom changes this page's markup in a future release, the script may stop finding these elements. It's written to fail silently (log a console warning, do nothing) rather than click or select blindly, so a change should look like "nothing happens" rather than mis-clicking something else. Check the browser console for `[coach-auto-filters]` warnings if it stops working.

**TODO: hidden-column phantom scroll space.** Since the Prism table rebuild (below), hiding the Agent/Knowledge base/Language columns via `display: none` no longer shrinks the table's scrollable width — it scrolls past the visible columns into blank space equal to what the hidden ones would have taken up. Root cause: the table sizes itself via a `--scroller-width` CSS custom property that Prism computes from all columns, with no awareness that 3 are hidden. Fixable by measuring their widths before hiding and subtracting from that variable, but deferred for now since it's cosmetic and touches an internal variable Prism manages itself (risk of fighting a later recompute, or interacting oddly with the fixed-column shadow/scroll behavior).

**This has already happened once.** Sometime between 2026-09 and 2026-11-13, Zoom rebuilt the Coach table on its Prism design system (`ui-Table-*` classes → `prism-Table-*`), which silently broke every column-by-label lookup (`getColIndexByLabel`) — and with it, the "Needs Coaching" button, "Show only blank disposition", column-hiding, and the Disposition/Engagement outcome carry-over, all at once, with no console errors (the lookups just returned `null` everywhere rather than throwing). If several unrelated-looking features stop working at the same time, suspect a table markup change before debugging each one separately.
