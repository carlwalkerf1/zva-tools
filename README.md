# ZVA Tools

A [Tampermonkey](https://www.tampermonkey.net/) userscript for the Zoom AI Studio Knowledge Library **Coach** page (`https://zoom.us/ai-studio/kb/coach`):

- Reapplies your preferred filters every time you load the page, instead of clicking through them by hand each visit.
- Adds a **"Needs Coaching"** button that checks every row on the current page whose **Disposition** column is blank (`--`) — there's no native way to filter or bulk-select on that today.
- Adds a **"Show only blank disposition"** toggle to hide everything else so you can see just what needs attention.

By default it sets:

- **Agent** = `Star ✦ 3.0` (this subteam uses this agent 100% of the time — the other agents are neglected/older versions, so it's safe to force)
- **Page size** = `100 per page`

**Query matching is currently NOT auto-set.** It used to default to `No match`, but that assumed you'd only ever want to coach unmatched queries — not true in practice. It's commented out in the script rather than removed; the real fix is a proper "auto-select preferences" UI rather than guessing at one hardcoded value, which isn't built yet.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser (if you haven't already).
2. **[Click here to install the script](https://raw.githubusercontent.com/carlwalkerf1/zva-tools/main/coach-auto-filters.user.js)** — Tampermonkey will detect it and show an install prompt automatically.
3. Make sure Tampermonkey's site access (in your browser's extension settings) is set to allow it to run automatically on `zoom.us` — some browsers default extensions to "on click only," which prevents userscripts from running on page load.

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

## The "Needs Coaching" button

Located next to the **Reset** button in the filter bar. It reads the table's `Disposition` column (found dynamically by header text, not a hardcoded position) and clicks the row checkbox for every row where that column reads blank (`--`). This only affects rows currently loaded on the page — for large result sets you'd still page through and click it on each page.

## How it works

The filters are Zoom's internal "Prism" (MUI-based React) dropdown components. A plain `.click()` on their combobox doesn't open the dropdown, because the app listens for a fuller `pointerdown`/`mousedown`/`focus` sequence — so the script simulates that instead of a bare click. Each filter's own popover is looked up via its `aria-describedby` attribute (rather than "whichever popover happens to be open") to avoid racing against a previous dropdown that hasn't fully closed yet.

The results table, by contrast, is a plain semantic `<table>` (ARIA grid), so the coaching button just reads cell text and clicks real checkboxes — no simulated-event tricks needed there.

## Limitations

If Zoom changes this page's markup in a future release, the script may stop finding these elements. It's written to fail silently (log a console warning, do nothing) rather than click or select blindly, so a change should look like "nothing happens" rather than mis-clicking something else. Check the browser console for `[coach-auto-filters]` warnings if it stops working.
