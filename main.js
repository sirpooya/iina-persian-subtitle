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

// Resolve -> download -> unzip -> convert -> return absolute path of a UTF-8
// subtitle file ready to load. Returns null on failure.
async function fetchSubtitleFile(candidate, parsed) {
  const site = siteById(candidate.site);
  if (!site) return null;

  let zipUrl = candidate.downloadUrl;
  if (!zipUrl) {
    zipUrl = await site.resolveDownloadUrl(candidate, http);
  }
  if (!zipUrl) {
    console.log(`${candidate.site}: no download URL for "${candidate.title}"`);
    return null;
  }
  console.log(`downloading ${zipUrl}`);

  const dest = "@tmp/persian-sub-archive.zip";
  const headers = site.downloadHeaders ? site.downloadHeaders() : {};
  await http.download(zipUrl, dest, { headers });

  // Read the downloaded zip back as bytes for the unzip step.
  const absZip = utils.resolvePath(dest);
  const bytes = readBytes(absZip);
  if (!bytes) {
    console.error(`could not read downloaded archive at ${absZip}`);
    return null;
  }

  return extractBestSubtitle(bytes, parsed.raw, parsed.title);
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

subtitle.registerProvider("persian-subs", {
  // IINA calls this when the user triggers Find Online Subtitles. We search by
  // the currently-playing file's name. The returned items populate the list.
  search: async () => {
    const name = playingFileName();
    const parsed = parseTitle(name);
    console.log(
      `Persian Subtitles: url=${core.status.url} title=${core.status.title}`
    );
    console.log(`Persian Subtitles: searching for "${parsed.title}" (from "${name}")`);
    const candidates = await searchAll(parsed);
    console.log(`Persian Subtitles: ${candidates.length} result(s)`);
    // Each item carries its candidate data + the parsed query for download().
    return candidates.map((c) => subtitle.item({ ...c, parsed }));
  },

  // One row in the result list. English only.
  description: (item) => {
    const d = item.data;
    return {
      name: d.title || "Persian subtitle",
      left: siteLabel(d.site),
      right: "Persian",
    };
  },

  // IINA calls this for the row the user clicks. Resolve -> download -> unzip ->
  // encoding-fix; return the path(s) for IINA to load.
  download: async (item) => {
    const d = item.data;
    const path = await fetchSubtitleFile(d, d.parsed);
    return path ? [path] : [];
  },
});

console.log("Persian Subtitles plugin loaded");
