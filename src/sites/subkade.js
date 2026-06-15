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

// Detail-page links on subkade include the English title transliterated into
// the slug, so we can both detect them and read a rough label from them.
const DETAIL_LINK = /https:\/\/subkade\.ir\/(%[0-9a-fA-F]{2}|[a-z0-9\-])+\//g;
const ZIP_LINK = /https:\/\/dl[0-9]*\.subkade\.ir\/[^"'\s>]+\.zip/gi;

// Pull a human-ish label out of a subkade detail URL (the English part of the slug).
function labelFromUrl(url) {
  try {
    const decoded = decodeURIComponent(url);
    // Strip the Persian prefix words; keep the latin tail (title + year).
    const slug = decoded.replace(ORIGIN + "/", "").replace(/\/$/, "");
    const latin = slug.match(/[a-z0-9][a-z0-9\-]*$/i);
    return (latin ? latin[0] : slug).replace(/-/g, " ").trim();
  } catch (e) {
    return url;
  }
}

// Keep only detail links that look like a film/series subtitle page, not nav.
function isSubtitleDetail(url) {
  const u = url.toLowerCase();
  if (!u.startsWith("https://subkade.ir/")) return false;
  // Subtitle detail slugs contain these Persian words ("زیرنویس فیلم/سریال"),
  // which percent-encode to these byte sequences.
  return (
    u.includes("%d8%b2%db%8c%d8%b1%d9%86%d9%88%db%8c%d8%b3") || // زیرنویس
    u.includes("zirnevis")
  );
}

async function search(query, http) {
  const url = `${ORIGIN}/?s=${encodeURIComponent(query.title)}`;
  const res = await http.get(url, { headers: { "User-Agent": UA } });
  const html = res.text || "";

  const seen = new Set();
  const candidates = [];
  const matches = html.match(DETAIL_LINK) || [];
  for (const link of matches) {
    if (!isSubtitleDetail(link) || seen.has(link)) continue;
    seen.add(link);
    candidates.push({
      site: SITE_ID,
      title: labelFromUrl(link),
      pageUrl: link,
      lang: "fa",
    });
  }
  return candidates;
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
  search,
  resolveDownloadUrl,
  downloadHeaders,
};
