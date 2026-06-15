# Persian Subtitles for IINA

An IINA plugin that searches Persian subtitle sites for the currently-playing
file, downloads the `.zip`, unzips it, fixes the text encoding, and loads the
best-matching `.srt` as a subtitle track — automatically, matched by file name.

## Status

| Capability | Status |
|---|---|
| Auto-match by playing file name (title / year / SxxExx) | ✅ |
| `subkade.ir` search → resolve → download → unzip → load | ✅ working, verified end-to-end |
| `subzone.ir` (subf2m mirror) search | ⚠️ search works; download is JS-rendered, not yet resolvable |
| Unzip without native deps (bundled `fflate`) | ✅ |
| Encoding: UTF-8 / UTF-8-BOM / **Windows-1256** / **UTF-16 LE-BE** → UTF-8 | ✅ |
| Picks best entry in multi-file zips (release-name + UTF-8 preference) | ✅ |
| Native "Find Online Subtitles" provider + menu item | ✅ |

This is **v0.1, experimental** (IINA's plugin system itself is experimental).

## Install (development)

IINA loads unpacked plugins from a folder. No build step is required — this is
plain JS with a vendored unzip lib.

1. In IINA: **Settings → Plugins → Install from folder…** (or use the dev
   install) and point it at this directory.
2. Enable **network**, **file system**, and **OSD** permissions when prompted.
3. Play a video, then either:
   - run **Plugins menu → "دریافت خودکار زیرنویس فارسی (Fetch Persian Subtitle)"**, or
   - use **Subtitles → Find Online Subtitles → Persian Subtitles**.

## How it works

```
core.status.title  ──parse──▶  { title, year, season, episode }
        │
        ▼  search each site adapter (src/sites/*.js)
   candidates ──score vs playing file──▶ best first
        │
        ▼  resolveDownloadUrl → .zip URL
   http.download(zip, @tmp/)  →  fflate unzipSync
        │
        ▼  pickBestEntry (release-name + prefer [UTF-8])
   decodeSubtitleBytes  (auto-detect 1256 / utf-8 / utf-16)  → write UTF-8 to @tmp/
        │
        ▼  core.subtitle.loadTrack(path)
```

## Layout

```
Info.json            plugin manifest (provider id, permissions, allowedDomains)
main.js              entry: provider registration + menu + pipeline
src/match.js         filename → {title, year, season, episode}; candidate scoring
src/unzip.js         fflate wrapper + encoding detection/conversion + entry picking
src/sites/subkade.js working adapter (subkade.ir)
src/sites/subzone.js partial adapter (subzone.ir) — search only
vendor/fflate.js     bundled pure-JS unzip (no native deps)
tools/probe.js       offline+live test harness (runs under Node, no IINA)
```

## Testing without IINA

`tools/probe.js` stubs the `iina` global so the logic modules run under Node:

```bash
node tools/probe.js                                    # unit tests (parsing, scoring, encoding, entry-picking)
node tools/probe.js "The.Matrix.1999.1080p-YIFY.mkv"   # live: search subkade → download → unzip → show Persian text
```

## Adding / fixing a site

Each adapter in `src/sites/` exports `{ id, name, search, resolveDownloadUrl, downloadHeaders }`.
See `src/sites/README.md` for the contract and how to capture live HTML to fill
in selectors. The rest of the plugin needs no changes when you add one — just
push it onto the `SITES` array in `main.js`.

## Known limitations / TODO

- **subzone.ir downloads**: the title/single-subtitle pages are client-side
  rendered; the zip URL isn't in the static HTML. Need to reverse-engineer its
  XHR/download endpoint (keyed by the numeric subtitle id).
- **Series episode matching**: parsing handles `SxxExx`; per-episode zip
  selection inside a season pack is best-effort via file-name scoring.
- **`iina.file.read` binary mode** varies across IINA builds; `main.js` has a
  fallback, but verify on your IINA version (check the plugin console log).
- Legal/ToS: scrapes third-party sites; for personal use. Sites change markup —
  expect occasional adapter maintenance.
```
