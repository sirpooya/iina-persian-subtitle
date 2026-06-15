// Adapter for subkade.ir (WordPress-based Persian subtitle site).
//
// VERIFIED FLOW (captured from live HTML, 2026-06):
//   search:   GET https://subkade.ir/?s=<query>
//             -> result links are detail pages: https://subkade.ir/<percent-encoded-slug-with-english-title>/
//   resolve:  GET the detail page
//             -> direct zip link(s): https://dl<N>.subkade.ir/wp-content/uploads/<yyyy>/<mm>/<Name>-<id>.zip
//             (download requires Referer: https://subkade.ir/)
//
// The zip typically contains many Persian .srt variants whose file names encode
// the release group (YIFY, AMIABLE, Tigole, ...) and the encoding ([UTF-8],
// [Unicode], .parsi). src/unzip.js picks the best one against the playing file.

const SITE_ID = "subkade";
const SITE_NAME = "ساب‌کده (subkade.ir)";
const ORIGIN = "https://subkade.ir";

const ZIP_LINK = /https:\/\/dl[0-9]*\.subkade\.ir\/[^"'\s>]+\.zip/gi;

// Genuine search results are anchors inside "sk-loop" cards. Each such <a> wraps
// the result's detail URL, a `sk-loop-text` marker span, and an
// `<h3 dir="ltr">English Title</h3>`. The site's permanent sidebar links
// (friends, from, money-heist, ...) are NOT inside this structure, so matching
// the full anchor block excludes them — fixing the "results regardless of query"
// bug where sidebar links leaked into the list.
const RESULT_ANCHOR = /<a\s+[^>]*href="(https:\/\/subkade\.ir\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
const H3_TITLE = /<h3[^>]*>\s*([^<]+?)\s*<\/h3>/i;

async function search(query, http) {
  const url = `${ORIGIN}/?s=${encodeURIComponent(query.title)}`;
  const res = await http.get(url, { headers: { "User-Agent": UA } });
  const html = res.text || "";

  const seen = new Set();
  const candidates = [];
  let m;
  RESULT_ANCHOR.lastIndex = 0;
  while ((m = RESULT_ANCHOR.exec(html)) !== null) {
    const href = m[1];
    const inner = m[2];
    // Must be an actual result card, not nav/sidebar/footer markup.
    if (!/sk-loop/i.test(inner)) continue;
    if (seen.has(href)) continue;
    const titleMatch = inner.match(H3_TITLE);
    if (!titleMatch) continue; // result cards always carry an <h3> title
    seen.add(href);
    candidates.push({
      site: SITE_ID,
      title: decodeEntities(titleMatch[1]),
      pageUrl: href,
      lang: "fa",
    });
  }
  return candidates;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#8211;/g, "–")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

async function resolveDownloadUrl(candidate, http) {
  const res = await http.get(candidate.pageUrl, {
    headers: { "User-Agent": UA, Referer: ORIGIN + "/" },
  });
  const html = res.text || "";
  const zips = html.match(ZIP_LINK) || [];
  return zips.length ? zips[0] : null;
}

// Download headers needed by the CDN (it checks Referer).
function downloadHeaders() {
  return { "User-Agent": UA, Referer: ORIGIN + "/" };
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

module.exports = {
  id: SITE_ID,
  name: SITE_NAME,
  label: "Subkade", // English label shown in IINA's result list
  search,
  resolveDownloadUrl,
  downloadHeaders,
};
