# Site adapters

Each adapter exports:

```js
module.exports = {
  id: "subzone",        // stable id
  name: "SubZone",      // display name
  // async search(query, http) -> Array<Candidate>
  //   query: { title, year, season, episode, isSeries, raw } (from src/match.js)
  //   Candidate: {
  //     site: "subzone",
  //     title: string,        // human label shown / scored
  //     pageUrl: string,      // detail page (used to resolve the zip)
  //     downloadUrl?: string, // direct .zip if already known (skips resolve)
  //     lang: "fa",
  //     meta?: { season, episode },
  //   }
  search,
  // async resolveDownloadUrl(candidate, http) -> string  (a .zip URL)
  resolveDownloadUrl,
};
```

## Status: selectors are PLACEHOLDERS

`subzone.ir` (a subf2m mirror) and `subkade.ir` (WordPress) both render their
search results and download buttons behind detail pages, and may sit behind
Cloudflare. The exact CSS selectors / URL patterns below are marked `TODO` and
must be confirmed against live HTML.

### How to capture live HTML to fill in the selectors

From inside IINA's plugin console (or via `node tools/probe.js` — see repo root),
fetch a real search page and a real detail page and inspect the markup:

```js
const { http } = iina;
const res = await http.get("https://subzone.ir/?s=The+Matrix");
console.log(res.text.slice(0, 4000)); // copy the <a href> patterns for results
```

Then update `SEARCH_URL`, the result-link regex, and the download-link regex in
each adapter. They are isolated so the rest of the plugin needs no changes.
