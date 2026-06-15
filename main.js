// Persian Subtitles for IINA
//
// Flow:
//   1. Read the playing file name (core.status.title) and parse it (src/match.js).
//   2. Search each enabled site adapter (src/sites/*) for Persian subtitles.
//   3. Score candidates against the playing file; auto-pick the best.
//   4. Resolve the candidate's .zip URL, download it to @tmp/.
//   5. Unzip (fflate), pick the best .srt/.ass, convert to UTF-8 (src/unzip.js).
//   6. Load the resulting file as a subtitle track.
//
// Integrates with IINA two ways:
//   * subtitle.registerProvider("persian-subs", ...) -> shows up under
//     "Subtitles > Find Online Subtitles" and in the settings provider list.
//   * A menu item ("Fetch Persian Subtitle") for one-click auto-fetch.

const { console, core, menu, subtitle, http, utils } = iina;

const { parseTitle, scoreCandidate } = require("./src/match.js");
const { extractBestSubtitle } = require("./src/unzip.js");

const SITES = [
  require("./src/sites/subkade.js"),
  require("./src/sites/subzone.js"),
];

// --- core pipeline ----------------------------------------------------------

// Search every site, return a flat list of scored candidates (best first).
async function searchAll(parsed) {
  const all = [];
  for (const site of SITES) {
    try {
      const results = await site.search(parsed, http);
      for (const c of results) {
        c.score = scoreCandidate(parsed, c.title, c.meta);
        all.push(c);
      }
      console.log(`${site.id}: ${results.length} result(s)`);
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

  // Read the downloaded zip back as bytes for fflate.
  const absZip = utils.resolvePath(dest);
  const bytes = readBytes(absZip);
  if (!bytes) {
    console.error(`could not read downloaded archive at ${absZip}`);
    return null;
  }

  return extractBestSubtitle(bytes, parsed.raw, parsed.title);
}

// Read a file into a Uint8Array. Prefers iina.file; falls back to fetch on the
// local file URL if the binary read API differs across IINA versions.
function readBytes(absPath) {
  try {
    const { file } = iina;
    // Newer IINA exposes a binary read; some versions return a string.
    if (file && typeof file.read === "function") {
      const data = file.read(absPath, { binary: true });
      if (data instanceof Uint8Array) return data;
      if (data && data.buffer) return new Uint8Array(data.buffer);
      if (typeof data === "string") return latin1ToBytes(data);
    }
  } catch (e) {
    console.error(`file.read failed: ${e}`);
  }
  return null;
}

// If a string came back from a byte read, it's latin1-encoded bytes.
function latin1ToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// Top-level: auto-fetch the best Persian subtitle for the current file.
async function autoFetch() {
  const title = core.status.title;
  if (!title) {
    core.osd("هیچ فایلی در حال پخش نیست");
    return;
  }
  const parsed = parseTitle(title);
  console.log(`searching for: ${JSON.stringify(parsed)}`);
  core.osd(`جستجوی زیرنویس فارسی: ${parsed.title}…`);

  const candidates = await searchAll(parsed);
  if (candidates.length === 0) {
    core.osd("زیرنویسی پیدا نشد");
    return;
  }

  // Try candidates best-first until one yields a usable file.
  for (const candidate of candidates) {
    const path = await fetchSubtitleFile(candidate, parsed);
    if (path) {
      core.subtitle.loadTrack(path);
      core.osd("زیرنویس فارسی بارگذاری شد ✓");
      console.log(`loaded subtitle: ${path}`);
      return;
    }
  }
  core.osd("دانلود زیرنویس ناموفق بود");
}

// --- IINA integration -------------------------------------------------------

// Native "Find Online Subtitles" provider.
subtitle.registerProvider("persian-subs", {
  search: async () => {
    const title = core.status.title || "";
    const parsed = parseTitle(title);
    const candidates = await searchAll(parsed);
    // Wrap each candidate as a SubtitleItem carrying its data + parsed query.
    return candidates.map((c) => subtitle.item({ ...c, parsed }));
  },
  description: (item) => {
    const d = item.data;
    return {
      name: d.title,
      left: `${siteById(d.site)?.name ?? d.site}`,
      right: `فارسی${d.score ? ` · امتیاز ${d.score}` : ""}`,
    };
  },
  download: async (item) => {
    const d = item.data;
    const path = await fetchSubtitleFile(d, d.parsed);
    return path ? [path] : [];
  },
});

console.log("Persian Subtitles plugin loaded");

// Menu item for one-click auto-fetch.
menu.addItem(
  menu.item("دریافت خودکار زیرنویس فارسی (Fetch Persian Subtitle)", () => {
    autoFetch().catch((e) => {
      console.error(`autoFetch error: ${e}`);
      core.osd("خطا در دریافت زیرنویس");
    });
  })
);
