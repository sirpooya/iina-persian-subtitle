# Persian Subtitles for IINA

An [IINA](https://iina.io) plugin that finds Persian subtitles for whatever
you're watching. It registers as a native subtitle source, so you just press
**⌘⇧D** (*Subtitle → Find Online Subtitles*) and pick from the list — IINA
downloads, unzips, fixes the text encoding, and loads the subtitle for you.

## What it does

- Detects the playing file's release name (from its path) and searches Persian
  subtitle sites for a matching title.
- Opens each matching `.zip` and lists **every subtitle variant inside it** as a
  separate row (e.g. `1080p WEB-DL EaZy`, `Ru WEB Fa · UTF-8`, …), so you can
  pick the one that matches your release — not a blind auto-guess.
- Fixes encoding automatically: **Windows-1256 / UTF-8 / UTF-8-BOM / UTF-16
  (LE & BE)** are all decoded and re-saved as UTF-8 (mpv renders these reliably).
- Self-contained: no native dependencies and no build step. A small pure-JS
  unzip is bundled (IINA's JavaScriptCore sandbox can't load typical npm zip
  libraries, which probe for `worker_threads`/`window`/`global`).

## Status

| Capability | Status |
|---|---|
| `subkade.ir` — search → list variants → download → unzip → load | ✅ working |
| Encoding auto-detect/convert → UTF-8 | ✅ |
| Per-variant selection in IINA's overlay | ✅ |
| `subzone.ir` (subf2m mirror) | ⚠️ excluded — its download is JS-rendered, not yet resolvable |

This is **v0.1, experimental**. It scrapes third-party sites, so expect
occasional adapter maintenance when a site changes its markup. For personal use.

## Requirements

- **IINA 1.4.0 or newer.** The plugin system is hidden/compiled-out in 1.3.x;
  1.4+ enables it by default.

## Install (development)

No build step — plain JS. Symlink this folder into IINA's plugins directory with
the `.iinaplugin-dev` suffix and IINA loads it on launch:

```sh
ln -sfn "$(pwd)" \
  "$HOME/Library/Application Support/com.colliderli.iina/plugins/persian-subtitle.iinaplugin-dev"
```

Then launch IINA. The plugin appears under **Settings → Plugins** as
*Persian Subtitles*. Grant **Network**, **File System**, and **OSD** permissions.

## Use

1. **Settings → Subtitle → Online Subtitles → “Download subtitles from”** →
   choose **Persian** (so ⌘⇧D uses this source).
2. Play a video and press **⌘⇧D** (*Subtitle → Find Online Subtitles*).
3. Pick the variant matching your release. It loads automatically.

## How it works

```
core.status.url ── parse ──▶ { title, year, season, episode }
        │
        ▼  search site adapters (src/sites/*) → score by title (stopword-aware)
   matching movie pages
        │
        ▼  resolve .zip URL → download (cached) → list .srt/.ass entries
   one overlay row per subtitle variant   ◀── you pick here (⌘⇧D overlay)
        │
        ▼  extract chosen entry → detect encoding → write UTF-8 to @tmp/
   IINA loads the returned path
```

## Layout

```
Info.json             manifest (provider id "persian-subs", name "Persian", perms)
main.js               provider registration + search/download pipeline
src/match.js          filename → {title, year, season, episode}; title scoring
src/unzip.js          encoding detect/convert + entry listing/extraction
src/sites/subkade.js  working adapter (subkade.ir)
src/sites/subzone.js  partial adapter (subzone.ir) — search only, excluded
vendor/unzip.js       bundled pure-JS DEFLATE + ZIP reader (no deps, no globals)
tools/probe.js        offline + live test harness (runs under Node, no IINA)
```

## Testing without IINA

`tools/probe.js` stubs the `iina` global (including the FileHandle binary-read
API) so the logic runs under Node:

```sh
node tools/probe.js                                    # unit tests
node tools/probe.js "The.Matrix.1999.1080p-YIFY.mkv"   # live: search → download → show Persian
```

## Adding a site

Each adapter in `src/sites/` exports
`{ id, name, label, downloadable, search, resolveDownloadUrl, downloadHeaders }`.
See [src/sites/README.md](src/sites/README.md) for the contract. Add it to the
`SITES` array in `main.js`; nothing else changes.

## Known limitations

- **subzone.ir downloads** are client-side rendered; the zip URL isn't in the
  static HTML. Its adapter is `downloadable: false` until that flow is solved.
- Search downloads the matching zip up front to list variants — fine for
  subkade's small archives; could be lazy-loaded for larger sites later.
- Series episode selection within a season pack is best-effort by file name.
