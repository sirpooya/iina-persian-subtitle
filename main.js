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
const { listSubtitleEntries, extractEntry, extractBestSubtitle } = require("./src/unzip.js");

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

// Turn the path of a subtitle file inside a zip into a short, readable variant
// label. Two shapes occur in Persian packs:
//   - Movies / single releases carry the release name in the file itself, e.g.
//     "The.Matrix.1999.1080p.BluRay.YIFY [UTF-8].srt" -> "1080p BluRay YIFY · UTF-8".
//   - Series packs name episodes generically ("01en.srt", "10.srt") but put the
//     real info in the FOLDER path, e.g.
//     "Show - Complete/English/Show - E01/01en.srt" -> "E01".
// So when the file name is just an episode number, fall back to the episode
// marker mined from the folder path.
const SUB_EXT_RE = /\.(srt|ass|ssa|vtt|sub)$/i;
const EP_IN_PATH = /\b(?:e|ep|episode)[ ._-]?(\d{1,3})\b/i;
const SEASON_IN_PATH = /\bs(\d{1,2})\b/i;
// A file name that carries no release info — just an episode/sequence number
// (optionally with a language tag like "en"/"fa"), e.g. "01en", "10", "e03".
const PLAIN_EP_NAME = /^(?:e|ep)?\d{1,3}(?:en|fa|fr|persian|farsi)?$/i;

function variantLabel(entryName) {
  let base = entryName.split("/").pop().replace(SUB_EXT_RE, "");
  const enc = (base.match(/\[(utf-?8|unicode|ansi)\]/i) || [])[1];
  const cleaned = base
    .replace(/\[[^\]]*\]/g, "") // drop [YTS.MX], [UTF-8], etc.
    .replace(/[._]+/g, " ")
    .replace(/\s*[-–]\s*(?=\s|$)/g, " ") // tidy separators left dangling by the above
    .replace(/\s+/g, " ")
    .trim();

  // Generic episode file name -> derive a label from the folder path instead.
  if (PLAIN_EP_NAME.test(base.replace(/\s+/g, ""))) {
    const ep = (entryName.match(EP_IN_PATH) || base.match(/(\d{1,3})/) || [])[1];
    const se = (entryName.match(SEASON_IN_PATH) || [])[1];
    if (ep) {
      const epNum = String(parseInt(ep, 10)).padStart(2, "0");
      return se ? `S${se.padStart(2, "0")}E${epNum}` : `E${epNum}`;
    }
  }

  return enc ? `${cleaned} · ${enc.toUpperCase()}` : cleaned;
}

// Format a "YYYY-MM-DD" date into a compact label for the right-hand column,
// e.g. "2023-07-30" -> "Jul 30, 2023". Returns "" for missing/invalid input.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDate(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  const mon = MONTHS[parseInt(m[2], 10) - 1];
  if (!mon) return "";
  return `${mon} ${parseInt(m[3], 10)}, ${m[1]}`;
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
        if (typeof site.expand === "function") {
          // Adapter-driven rows (e.g. subzone): each Persian entry is already a
          // self-describing release, so we don't download any zip during search.
          const rows = await site.expand(movie, http);
          console.log(`Persian: "${movie.title}" -> ${rows.length} release(s) [${site.id}]`);
          for (const row of rows) {
            items.push(
              subtitle.item({
                site: movie.site,
                movieTitle: movie.title,
                zipUrl: row.downloadUrl,
                entryName: null, // single-srt zip; pick the only entry on download
                label: row.label,
                date: row.date || null,
                uploader: row.uploader || "",
                outBase: parsed.title,
              })
            );
          }
        } else {
          // Default path (e.g. subkade): one zip per title, many variants inside.
          const zipUrl = movie.downloadUrl || (await site.resolveDownloadUrl(movie, http));
          if (!zipUrl) continue;
          const headers = site.downloadHeaders ? site.downloadHeaders() : {};
          const bytes = await downloadZipBytes(zipUrl, headers);
          if (!bytes) continue;
          const entries = listSubtitleEntries(bytes);
          console.log(`Persian: "${movie.title}" -> ${entries.length} variant(s) [${site.id}]`);
          for (const entry of entries) {
            items.push(
              subtitle.item({
                site: movie.site,
                movieTitle: movie.title,
                zipUrl,
                entryName: entry.name,
                label: variantLabel(entry.name),
                date: entry.date || null,
                uploader: "",
                outBase: parsed.title,
              })
            );
          }
        }
      } catch (e) {
        console.error(`Persian: failed expanding "${movie.title}": ${e}`);
      }
    }
    console.log(`Persian: ${items.length} total variant(s)`);
    return items;
  },

  // One row in the overlay. IINA renders three strings:
  //   name  : the release/episode label (the meaningful title)
  //   left  : the overline — "fa · <Movie> · <Source>" (fa first, source kept)
  //   right : the entry date when known, else the uploader (subzone), else "".
  // fps / download-count are intentionally absent: Persian sites don't expose
  // them per file, so we don't fabricate them.
  description: (item) => {
    const d = item.data;
    const overline = ["fa", d.movieTitle, siteLabel(d.site)].filter(Boolean).join(" · ");
    return {
      name: d.label || d.movieTitle || "Persian subtitle",
      left: overline,
      right: formatDate(d.date) || d.uploader || "",
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
    // Named entry (subkade's multi-variant pack) vs. single-srt zip (subzone).
    const path = d.entryName
      ? extractEntry(bytes, d.entryName, d.outBase)
      : extractBestSubtitle(bytes, d.label || d.outBase, d.outBase);
    return path ? [path] : [];
  },
});

console.log("Persian Subtitles plugin loaded");
