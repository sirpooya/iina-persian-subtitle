// Adapter for subzone.ir (a subf2m / Subscene-style mirror).
//
// VERIFIED FLOW (captured from live HTML, 2026-06):
//   search:  GET https://subzone.ir/?s=<query>
//            -> title pages:  /subtitles/<slug>
//            -> direct links: /subtitles/<slug>/farsi_persian/<id>
//   expand:  GET the title page (server-rendered, NOT a JS shell as the old
//            comment claimed) -> each Persian row carries one or more RELEASE
//            NAMES (`<li>From.S04E01.1080p.WEB-DL...-GROUP</li>`) plus the
//            uploader and the entry's /farsi_persian/<id> download link.
//   resolve: GET /subtitles/<slug>/farsi_persian/<id>/download
//            -> 302 to https://media.sub-api.ir/.../<name>.zip (one .srt inside,
//            named after the release).
//
// So unlike subkade (one big zip per title), subzone gives one well-named
// release per row. We surface each Persian entry as its own row, using the
// release name as the title — exactly the "1080p BluRay / WEB-DL / 720p" labels
// the user wants.

const SITE_ID = "subzone";
const SITE_NAME = "ساب‌زون (subzone.ir)";
const ORIGIN = "https://subzone.ir";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// /subtitles/<slug>/farsi_persian/<id>  (single Persian subtitle entry)
const PERSIAN_ENTRY = /\/subtitles\/[a-z0-9\-]+\/farsi_persian\/\d+/gi;
// /subtitles/<slug>  (title page, no language segment)
const TITLE_PAGE = /\/subtitles\/[a-z0-9\-]+(?=["'])/gi;

// One Persian result row on a title page: the leading markup holds the release
// name <li>s and uploader, ending at the row's download anchor.
const PERSIAN_ROW =
  /<li class=["']item[^>]*>([\s\S]*?)<a class=["']download icon-download["']\s+href=["'](\/subtitles\/[a-z0-9\-]+\/farsi_persian\/\d+)["']/gi;
const RELEASE_LI = /<li>\s*([^<]+?)\s*<\/li>/gi;
const UPLOADER = /\/u\/\d+["'][^>]*>\s*([^<]+?)\s*</i;

async function search(query, http) {
  const url = `${ORIGIN}/?s=${encodeURIComponent(query.title)}`;
  const res = await http.get(url, { headers: { "User-Agent": UA } });
  const html = res.text || "";

  const seen = new Set();
  const candidates = [];

  // The search page lists title pages (one per show/movie). We expand each into
  // its Persian entries later (in expand()), so here we just collect the slugs.
  for (const path of (html.match(TITLE_PAGE) || [])) {
    if (seen.has(path)) continue;
    seen.add(path);
    candidates.push({
      site: SITE_ID,
      title: slugLabel(path),
      pageUrl: ORIGIN + path,
      lang: "fa",
    });
  }
  // Some queries surface direct Persian entries on the search page itself; fold
  // their slugs in too so we don't miss a title that only appears that way.
  for (const path of (html.match(PERSIAN_ENTRY) || [])) {
    const slug = "/subtitles/" + (path.split("/subtitles/")[1] || "").split("/")[0];
    if (seen.has(slug)) continue;
    seen.add(slug);
    candidates.push({
      site: SITE_ID,
      title: slugLabel(slug),
      pageUrl: ORIGIN + slug,
      lang: "fa",
    });
  }
  return candidates;
}

// Expand a matched title page into one row per Persian subtitle entry. Each row
// is self-describing (title = release name, date unknown until download, its own
// download URL), so main.js does NOT need to fetch any zip during search.
async function expand(candidate, http) {
  const res = await http.get(candidate.pageUrl, {
    headers: { "User-Agent": UA, Referer: ORIGIN + "/" },
  });
  const html = res.text || "";

  const rows = [];
  const seen = new Set();
  let m;
  PERSIAN_ROW.lastIndex = 0;
  while ((m = PERSIAN_ROW.exec(html)) !== null) {
    const block = m[1];
    const entryPath = m[2];
    if (seen.has(entryPath)) continue;
    seen.add(entryPath);

    // First <li> is the canonical release name; keep it for the title.
    RELEASE_LI.lastIndex = 0;
    const relMatch = RELEASE_LI.exec(block);
    const release = relMatch ? cleanRelease(relMatch[1]) : "";
    const up = (block.match(UPLOADER) || [])[1] || "";

    rows.push({
      label: release || slugLabel(candidate.pageUrl),
      uploader: up.trim(),
      // Download is a normal route on the entry page; build it directly.
      downloadUrl: ORIGIN + entryPath + "/download",
      date: null, // subzone doesn't expose a per-row date in the list
    });
  }
  return rows;
}

function cleanRelease(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugLabel(path) {
  const slug = path.split("/subtitles/")[1] || path;
  return slug.split("/")[0].replace(/-/g, " ").trim();
}

// The /download route 302-redirects to the real zip on media.sub-api.ir. IINA's
// http.download follows redirects, so returning the route URL is enough; rows
// already carry it as downloadUrl, but keep this for the generic code path.
async function resolveDownloadUrl(candidate /*, http */) {
  return candidate.downloadUrl || null;
}

function downloadHeaders() {
  return { "User-Agent": UA, Referer: ORIGIN + "/" };
}

module.exports = {
  id: SITE_ID,
  name: SITE_NAME,
  label: "SubZone", // English label shown in IINA's result list
  downloadable: true,
  search,
  expand, // adapter-driven row expansion (no zip download needed during search)
  resolveDownloadUrl,
  downloadHeaders,
};
