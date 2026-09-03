# Zoom AI Studio Coach - Auto Filters

A [Tampermonkey](https://www.tampermonkey.net/) userscript that automatically reapplies your preferred filters on the Zoom AI Studio Knowledge Library **Coach** page (`https://zoom.us/ai-studio/kb/coach`) every time you load it, instead of clicking through them by hand each visit.

By default it sets:

- **Agent** = `Star ✦ 3.0`
- **Query matching** = `No match`
- **Page size** = `100 per page`

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open Tampermonkey's dashboard → **Create a new script**.
3. Delete the boilerplate and paste in the contents of [`coach-auto-filters.user.js`](./coach-auto-filters.user.js).
4. Save (Cmd/Ctrl+S).
5. Make sure Tampermonkey's site access (in your browser's extension settings) is set to allow it to run automatically on `zoom.us` — some browsers default extensions to "on click only," which prevents userscripts from running on page load.

## Customizing

Edit the constants at the top of the script:

```js
const DESIRED_FILTERS = [
  { idSuffix: 'bot-agent-filter-input', labels: ['Star ✦ 3.0'] },
  { idSuffix: 'match-type-input', labels: ['No match'] },
];
const DESIRED_PAGE_SIZE = '100 per page';
```

- `idSuffix` targets a specific filter control on the page (its DOM id can have a random prefix, so it's matched by suffix).
- `labels` is a list of option text to select in that filter's dropdown — add more strings to select multiple values in the same filter.
- It's additive: it only adds missing selections, it won't remove an option that's already selected for some other reason.

## How it works

The Coach page's filters are Zoom's internal "Prism" (MUI-based React) components. A plain `.click()` on their combobox doesn't open the dropdown, because the app listens for a fuller `pointerdown`/`mousedown`/`focus` sequence — so the script simulates that instead of a bare click. Each filter's own popover is looked up via its `aria-describedby` attribute (rather than "whichever popover happens to be open") to avoid racing against a previous dropdown that hasn't fully closed yet.

## Limitations

If Zoom changes this page's markup in a future release, the script may stop finding these elements. It's written to fail silently (log a console warning, do nothing) rather than click blindly, so a change should look like "nothing happens" rather than mis-clicking something else. Check the browser console for `[coach-auto-filters]` warnings if it stops working.
