// Adapter for subzone.ir (a subf2m / Subscene-style mirror).
//
// PARTIAL SUPPORT (as of 2026-06):
//   search:  GET https://subzone.ir/?s=<query>  -> WORKS statically.
//            Result links: /subtitles/<slug>            (title page)
//                          /subtitles/<slug>/<lang>/<id> (single subtitle)
//            Persian appears as the "farsi_persian" language segment.
//   resolve: The title/detail pages and the single-subtitle download button are
//            rendered client-side (the server returns a ~4KB JS shell to a plain
//            HTTP client and 404s some detail URLs). So the final .zip URL can NOT
//            be resolved with a simple GET yet.
//
// => Until the JS-rendered download flow is reverse-engineered, this adapter
//    surfaces search hits but resolveDownloadUrl returns null (the provider will
//    skip it and fall back to subkade). Search results are still useful for the
//    list/log so you can see coverage.

const SITE_ID = "subzone";
const SITE_NAME = "ساب‌زون (subzone.ir)";
const ORIGIN = "https://subzone.ir";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// /subtitles/<slug>/farsi_persian/<id>  (single Persian subtitle entry)
const PERSIAN_ENTRY = /\/subtitles\/[a-z0-9\-]+\/farsi_persian\/\d+/gi;
// /subtitles/<slug>  (title page, no language)
const TITLE_PAGE = /\/subtitles\/[a-z0-9\-]+(?=["'])/gi;

async function search(query, http) {
  const url = `${ORIGIN}/?s=${encodeURIComponent(query.title)}`;
  const res = await http.get(url, { headers: { "User-Agent": UA } });
  const html = res.text || "";

  const seen = new Set();
  const candidates = [];

  // Prefer direct Persian entries if the search page exposes them.
  for (const path of html.match(PERSIAN_ENTRY) || []) {
    if (seen.has(path)) continue;
    seen.add(path);
    candidates.push({
      site: SITE_ID,
      title: slugLabel(path),
      pageUrl: ORIGIN + path,
      lang: "fa",
    });
  }
  // Otherwise surface title pages (their Persian list is JS-rendered).
  for (const path of html.match(TITLE_PAGE) || []) {
    const full = ORIGIN + path;
    if (seen.has(path)) continue;
    seen.add(path);
    candidates.push({
      site: SITE_ID,
      title: slugLabel(path),
      pageUrl: full,
      lang: "fa",
    });
  }
  return candidates;
}

function slugLabel(path) {
  const slug = path.split("/subtitles/")[1] || path;
  return slug.split("/")[0].replace(/-/g, " ").trim();
}

// Not resolvable with a static GET yet — see header comment.
// TODO: reverse-engineer the JS download flow (likely an XHR to a /download or
// /api endpoint keyed by the numeric subtitle id) and return the resulting .zip.
async function resolveDownloadUrl(/* candidate, http */) {
  return null;
}

function downloadHeaders() {
  return { "User-Agent": UA, Referer: ORIGIN + "/" };
}

module.exports = {
  id: SITE_ID,
  name: SITE_NAME,
  label: "SubZone", // English label shown in IINA's result list
  // Download flow is JS-gated and not yet resolvable (see header comment), so
  // we exclude this site from results for now to avoid listing rows that fail
  // on click. Set true once resolveDownloadUrl works.
  downloadable: false,
  search,
  resolveDownloadUrl,
  downloadHeaders,
};
