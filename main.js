// Persian Subtitles for IINA
//
// Flow (driven by IINA's native "Find Online Subtitles", ⌘⇧D):
//   1. Read the playing file name from core.status.url and parse it (src/match.js).
//   2. Search each site adapter for matching movie/series pages; score by title.
//   3. For each match, download its .zip and list the subtitle variants inside.
//      Each variant becomes one row in IINA's result overlay, so the user can
//      pick the release that matches their file.
//   4. On pick, extract that entry from the (cached) zip, convert to UTF-8, and
//      return the path for IINA to load.

const { console, core, subtitle, http, utils } = iina;

const { parseTitle, scoreCandidate } = require("./src/match.js");
const { listSubtitleEntries, extractEntry } = require("./src/unzip.js");

const SITES = [
  require("./src/sites/subkade.js"),
  require("./src/sites/subzone.js"),
];

// --- core pipeline ----------------------------------------------------------

// Search every downloadable site, return scored candidates (best first).
// Candidates that don't plausibly match the playing file (score 0) are dropped
// so the list doesn't fill with unrelated titles when a site has no real hit.
async function searchAll(parsed) {
  const all = [];
  for (const site of SITES) {
    if (site.downloadable === false) continue; // skip sites we can't download from
    try {
      const results = await site.search(parsed, http);
      let kept = 0;
      for (const c of results) {
        c.score = scoreCandidate(parsed, c.title, c.meta);
        if (c.score <= 0) continue; // unrelated to the playing file
        all.push(c);
        kept++;
      }
      console.log(`${site.id}: ${results.length} result(s), ${kept} relevant`);
    } catch (e) {
      console.error(`${site.id} search failed: ${e}`);
    }
  }
  all.sort((a, b) => b.score - a.score);
  return all;
}

function siteById(id) {
  return SITES.find((s) => s.id === id);
}

// English-friendly label for a site id (shown in IINA's result list).
function siteLabel(id) {
  const s = siteById(id);
  return (s && (s.label || s.name)) || id;
}

// The best name to search by. core.status.title is a metadata "best guess" and
// is often wrong/empty, so prefer the actual file name from core.status.url
// (which keeps the release name, e.g. "The.Laws...2021.720p.YIFY.mkv").
function playingFileName() {
  const url = core.status.url || "";
  if (url) {
    // Strip query/fragment, take the last path segment, decode %xx.
    let base = url.split(/[?#]/)[0].replace(/\/+$/, "");
    base = base.substring(base.lastIndexOf("/") + 1);
    try {
      base = decodeURIComponent(base);
    } catch (e) {
      /* leave as-is */
    }
    if (base) return base;
  }
  return core.status.title || "";
}

// Cache of downloaded zip bytes, keyed by URL, so search() (which lists the
// variants) and download() (which extracts one) don't fetch the same zip twice.
const zipCache = new Map();
let zipSeq = 0;

// Download a zip and return its bytes (Uint8Array), caching by URL.
async function downloadZipBytes(zipUrl, headers) {
  if (zipCache.has(zipUrl)) return zipCache.get(zipUrl);
  const dest = `@tmp/persian-sub-${zipSeq++}.zip`;
  await http.download(zipUrl, dest, { headers });
  const bytes = readBytes(utils.resolvePath(dest));
  if (bytes) zipCache.set(zipUrl, bytes);
  return bytes;
}

// Read a file into a Uint8Array. IINA's file.read() returns a STRING (and
// corrupts binary like zips — "isn't in the correct format"). The correct
// binary API is file.handle(path, "read").readToEnd() -> Uint8Array.
function readBytes(absPath) {
  const { file } = iina;
  // Preferred: FileHandle binary read.
  if (file && typeof file.handle === "function") {
    let fh = null;
    try {
      fh = file.handle(absPath, "read");
      const data = fh.readToEnd();
      if (data instanceof Uint8Array) return data;
      if (data && data.buffer) return new Uint8Array(data.buffer);
    } catch (e) {
      console.error(`file.handle read failed: ${e}`);
    } finally {
      try {
        if (fh && typeof fh.close === "function") fh.close();
      } catch (e) {
        /* ignore */
      }
    }
  }
  // Last-resort fallback: text read reinterpreted as latin1 bytes (lossy for
  // some bytes, but better than nothing on builds lacking file.handle).
  try {
    if (file && typeof file.read === "function") {
      const s = file.read(absPath);
      if (typeof s === "string") return latin1ToBytes(s);
    }
  } catch (e) {
    console.error(`file.read fallback failed: ${e}`);
  }
  return null;
}

// If a string came back from a byte read, it's latin1-encoded bytes.
function latin1ToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// --- IINA integration -------------------------------------------------------
//
// Provider-only: this plugin is just a subtitle SOURCE. IINA's native
// "Find Online Subtitles" (⌘⇧D) drives the whole flow — it calls search(),
// renders the result list in its top-left panel, and calls download() for the
// row the user clicks. No custom menu, window, or OSD needed.

// Turn the file name inside a zip into a short, readable variant label, e.g.
// "The.Matrix.1999.1080p.BluRay.YIFY [UTF-8].srt" -> "1080p BluRay YIFY · UTF-8".
const SUB_EXT_RE = /\.(srt|ass|ssa|vtt|sub)$/i;
function variantLabel(entryName) {
  let base = entryName.split("/").pop().replace(SUB_EXT_RE, "");
  const enc = (base.match(/\[(utf-?8|unicode|ansi)\]/i) || [])[1];
  base = base.replace(/\[[^\]]*\]/g, "").replace(/[._]+/g, " ").trim();
  return enc ? `${base} · ${enc.toUpperCase()}` : base;
}

subtitle.registerProvider("persian-subs", {
  // IINA calls this on ⌘⇧D. We search by the playing file name, then for each
  // matching movie download its zip and list the subtitle variants inside, so
  // each variant is its own selectable row in the overlay.
  search: async () => {
    const name = playingFileName();
    const parsed = parseTitle(name);
    console.log(`Persian: url=${core.status.url} title=${core.status.title}`);
    console.log(`Persian: searching for "${parsed.title}" (from "${name}")`);

    const movies = await searchAll(parsed);
    console.log(`Persian: ${movies.length} matching title(s)`);

    const items = [];
    for (const movie of movies) {
      const site = siteById(movie.site);
      if (!site) continue;
      try {
        const zipUrl = movie.downloadUrl || (await site.resolveDownloadUrl(movie, http));
        if (!zipUrl) continue;
        const headers = site.downloadHeaders ? site.downloadHeaders() : {};
        const bytes = await downloadZipBytes(zipUrl, headers);
        if (!bytes) continue;
        const entries = listSubtitleEntries(bytes);
        console.log(`Persian: "${movie.title}" -> ${entries.length} variant(s)`);
        for (const entry of entries) {
          items.push(
            subtitle.item({
              site: movie.site,
              movieTitle: movie.title,
              zipUrl,
              entryName: entry,
              label: variantLabel(entry),
              outBase: parsed.title,
            })
          );
        }
      } catch (e) {
        console.error(`Persian: failed expanding "${movie.title}": ${e}`);
      }
    }
    console.log(`Persian: ${items.length} total variant(s)`);
    return items;
  },

  // One row in the overlay: the variant name, the movie + site, "Persian".
  description: (item) => {
    const d = item.data;
    return {
      name: d.label || d.movieTitle || "Persian subtitle",
      left: `${d.movieTitle} · ${siteLabel(d.site)}`,
      right: "Persian",
    };
  },

  // The user picked a variant: extract that exact entry from the cached zip,
  // convert to UTF-8, return its path for IINA to load.
  download: async (item) => {
    const d = item.data;
    let bytes = zipCache.get(d.zipUrl);
    if (!bytes) {
      const site = siteById(d.site);
      const headers = site && site.downloadHeaders ? site.downloadHeaders() : {};
      bytes = await downloadZipBytes(d.zipUrl, headers);
    }
    if (!bytes) return [];
    const path = extractEntry(bytes, d.entryName, d.outBase);
    return path ? [path] : [];
  },
});

console.log("Persian Subtitles plugin loaded");
