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

// The site does NOT wrap rows in a stable container class (the only <li class>
// on the page is "visited"), so we can't anchor on a row opener. What IS stable
// is the per-entry download anchor that CLOSES each Persian row:
//   <a class='download icon-download' href='/subtitles/<slug>/farsi_persian/<id>'></a>
// (attributes are single-quoted on the live site; allow either quote.)
//
// We locate every such anchor, then take each row's content as the slice of
// HTML between the PREVIOUS download anchor and this one — which holds exactly
// this entry's release-name <li>s (in <ul class='scrolllist'>) and uploader.
// Slicing this way (rather than a lazy regex spanning to the next anchor) keeps
// release names and uploaders bound to the correct entry even when the page has
// stray <ul>/<a> markup between rows.
const DOWNLOAD_ANCHOR =
  /<a class=["']download icon-download["']\s+href=["'](\/subtitles\/[a-z0-9\-]+\/farsi_persian\/\d+)["']/gi;
const RELEASE_LI = /<li>\s*([^<]+?)\s*<\/li>/gi;
const UPLOADER = /\/u\/\d+["'][^>]*>\s*([^<]+?)\s*</gi;

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

  // Pass 1: find every download anchor (the row CLOSER) with its position.
  const anchors = [];
  let a;
  DOWNLOAD_ANCHOR.lastIndex = 0;
  while ((a = DOWNLOAD_ANCHOR.exec(html)) !== null) {
    anchors.push({ entryPath: a[1], end: a.index });
  }

  // Pass 2: each row is the HTML between the previous anchor and this one.
  let prevEnd = 0;
  for (const anchor of anchors) {
    const block = html.slice(prevEnd, anchor.end);
    prevEnd = anchor.end;

    if (seen.has(anchor.entryPath)) continue;
    seen.add(anchor.entryPath);

    // First <li> is the canonical release name; keep it for the title.
    RELEASE_LI.lastIndex = 0;
    const relMatch = RELEASE_LI.exec(block);
    const release = relMatch ? cleanRelease(relMatch[1]) : "";
    // Last /u/<id> link in the block is this row's uploader (nearest the anchor).
    let up = "";
    let u;
    UPLOADER.lastIndex = 0;
    while ((u = UPLOADER.exec(block)) !== null) up = u[1];

    rows.push({
      label: release || slugLabel(candidate.pageUrl),
      uploader: up.trim(),
      // Download is a normal route on the entry page; build it directly.
      downloadUrl: ORIGIN + anchor.entryPath + "/download",
      date: null, // subzone doesn't expose a per-row date in the list
    });
  }
  return rows;
}

function cleanRelease(s) {
  return decodeEntities(s)
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Release names carry a few HTML entities (e.g. "It&#39;s", "Tom &amp; Jerry").
// Decode the handful that actually occur, plus numeric character references.
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
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
