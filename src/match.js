// Parse the currently-playing file's title into a structured query so we can
// auto-search and auto-pick the best subtitle without user input.
//
// IINA gives us `core.status.title`, which is usually the file name (often the
// release name, e.g. "The.Matrix.1999.1080p.BluRay.x264-GROUP").

const SEASON_EP = /\bs(\d{1,2})[\s._-]?e(\d{1,2})\b/i;        // S01E02
const SEASON_EP_ALT = /\b(\d{1,2})x(\d{1,2})\b/i;             // 1x02
const YEAR = /\b(19\d{2}|20\d{2})\b/;

// Tokens that mark where the real title ends and release metadata begins.
const STOP_TOKENS = new RegExp(
  "\\b(" +
    [
      "480p", "720p", "1080p", "2160p", "4k", "uhd",
      "bluray", "blu-ray", "brrip", "bdrip", "webrip", "web-dl", "webdl", "web",
      "hdrip", "dvdrip", "dvdscr", "hdtv", "hdcam", "cam", "ts", "telesync",
      "x264", "x265", "h264", "h265", "hevc", "xvid", "avc",
      "aac", "ac3", "dts", "dd5", "5\\.1", "7\\.1", "atmos",
      "remux", "proper", "repack", "extended", "uncut", "imax",
      "hdr", "hdr10", "dolby", "amzn", "nf", "dsnp", "hmax",
    ].join("|") +
    ")\\b",
  "i"
);

function cleanName(raw) {
  if (!raw) return "";
  let s = String(raw);
  // Strip extension if present.
  s = s.replace(/\.(mkv|mp4|avi|mov|m4v|webm|ts|wmv|flv)$/i, "");
  // Normalise separators to spaces.
  s = s.replace(/[._]+/g, " ");
  return s.trim();
}

// Returns { title, year, season, episode, isSeries, raw }
function parseTitle(raw) {
  const cleaned = cleanName(raw);
  const lower = cleaned.toLowerCase();

  let season = null;
  let episode = null;
  let m = lower.match(SEASON_EP) || lower.match(SEASON_EP_ALT);
  if (m) {
    season = parseInt(m[1], 10);
    episode = parseInt(m[2], 10);
  }

  const ym = cleaned.match(YEAR);
  const year = ym ? parseInt(ym[1], 10) : null;

  // The title is everything up to the first of: season marker, year, or a
  // release-metadata stop token.
  let cutIdx = cleaned.length;
  for (const re of [SEASON_EP, SEASON_EP_ALT, YEAR, STOP_TOKENS]) {
    const mm = cleaned.match(re);
    if (mm && mm.index != null && mm.index < cutIdx) cutIdx = mm.index;
  }
  let title = cleaned.slice(0, cutIdx).trim();
  // Drop trailing junk like dashes/brackets.
  title = title.replace(/[\s\-–—|({[]+$/g, "").trim();
  if (!title) title = cleaned; // fallback: use the whole thing

  return {
    title,
    year,
    season,
    episode,
    isSeries: season != null,
    raw: cleaned,
  };
}

// Words too common to indicate a real title match. Matching on these alone
// (e.g. "The ... of the ...") must NOT make two unrelated films look similar.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "at", "for", "with",
  "from", "by", "is", "it", "this", "that", "part", "vol", "season",
]);

function contentTokens(s) {
  return s
    .toLowerCase()
    .split(/[\s\-_:.]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// Score a candidate subtitle (by its display title) against the parsed query.
// Returns 0 when the candidate doesn't share enough *content* words with the
// query — so unrelated titles (and the site's permanent "popular" sidebar) are
// filtered out rather than ranked.
function scoreCandidate(parsed, candidateTitle, candidateMeta) {
  const cTokens = new Set(contentTokens(candidateTitle || ""));
  const qTokens = contentTokens(parsed.title || "");
  if (qTokens.length === 0 || cTokens.size === 0) return 0;

  // Count overlapping content words (word-level, not substring).
  let overlap = 0;
  for (const t of qTokens) if (cTokens.has(t)) overlap++;

  // Require a real overlap: at least half the query's content words, and at
  // least one. Otherwise it's not the same title.
  const ratio = overlap / qTokens.length;
  if (overlap === 0 || ratio < 0.5) return 0;

  let score = overlap * 3;
  // Bonus when the candidate is essentially the same set of content words.
  if (overlap === qTokens.length) score += 4;

  if (parsed.year && (candidateTitle || "").includes(String(parsed.year))) score += 4;

  if (parsed.isSeries && candidateMeta) {
    if (candidateMeta.season === parsed.season) score += 5;
    if (candidateMeta.episode === parsed.episode) score += 5;
  }

  // Prefer exact release-name match (best sync chance).
  if (parsed.raw && (candidateTitle || "").toLowerCase().includes(parsed.raw.toLowerCase())) {
    score += 6;
  }

  return score;
}

module.exports = { parseTitle, scoreCandidate, cleanName };
