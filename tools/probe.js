// Offline test harness — verifies the pure-logic modules (match, unzip/encoding,
// and the subkade adapter's HTML parsing) WITHOUT IINA, using Node.
//
//   node tools/probe.js                 # run unit checks on bundled fixtures
//   node tools/probe.js <query>         # live: search subkade + resolve + fetch + extract
//
// This stubs the `iina` global so src/ modules load unchanged.

const fs = require("fs");
const path = require("path");
const https = require("https");

// --- stub the iina global so require()'d modules work under Node ------------
const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "iina-probe-"));
function resolveTmp(p) {
  return p.startsWith("@tmp/") ? path.join(tmpDir, p.slice(5)) : p;
}
global.iina = {
  console: { log: (...a) => console.log("[iina]", ...a), error: (...a) => console.error("[iina:err]", ...a) },
  utils: { resolvePath: resolveTmp },
  file: {
    write: (p, text) => fs.writeFileSync(resolveTmp(p), text, "utf8"),
    read: (p) => fs.readFileSync(resolveTmp(p)).toString("utf8"),
    // Mirror IINA's FileHandle binary API (read/readToEnd -> Uint8Array).
    handle: (p, mode) => {
      const abs = resolveTmp(p);
      const buf = mode === "read" ? fs.readFileSync(abs) : Buffer.alloc(0);
      return {
        readToEnd: () => new Uint8Array(buf),
        read: (n) => new Uint8Array(buf.subarray(0, n)),
        close: () => {},
      };
    },
  },
};
global.TextDecoder = require("util").TextDecoder;

const ROOT = path.join(__dirname, "..");
const { parseTitle, scoreCandidate } = require(path.join(ROOT, "src/match.js"));
const { extractBestSubtitle, decodeSubtitleBytes, pickBestEntry } = require(path.join(ROOT, "src/unzip.js"));

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": UA, ...headers } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(get(res.headers.location, headers));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
}
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// http shim matching the subset of iina.http the adapter uses.
const httpShim = {
  get: async (url, opts = {}) => {
    const { buf } = await get(url, opts.headers);
    return { text: buf.toString("utf8") };
  },
};

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

function unitTests() {
  console.log("== parseTitle ==");
  const a = parseTitle("The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv");
  check("title stripped of release tags", a.title.toLowerCase() === "the matrix");
  check("year parsed", a.year === 1999);
  check("not a series", a.isSeries === false);

  const b = parseTitle("Breaking.Bad.S03E07.720p.HDTV.x264.mkv");
  check("series title", b.title.toLowerCase() === "breaking bad");
  check("season parsed", b.season === 3);
  check("episode parsed", b.episode === 7);

  console.log("== scoreCandidate ==");
  const s1 = scoreCandidate(a, "The Matrix (1999)");
  const s2 = scoreCandidate(a, "Some Unrelated Movie");
  check("relevant candidate scores higher", s1 > s2);

  console.log("== pickBestEntry ==");
  const names = [
    "The Matrix 1999/The Matrix (1999).srt",
    "The Matrix 1999/The.Matrix.1999.1080p.BrRip.x264.YIFY [UTF-8].srt",
    "The Matrix 1999/Downloaded from Subkade.ir.url",
  ];
  const best = pickBestEntry(names, "The.Matrix.1999.1080p.BrRip.x264.YIFY");
  check("picks YIFY-matching .srt", /YIFY/.test(best));

  console.log("== encoding detection ==");
  // Windows-1256 bytes for "اوضاع" -> should decode to Persian, not mojibake.
  const cp1256 = Uint8Array.from([0xc7, 0xe6, 0xd6, 0xc7, 0xda]);
  const decoded = decodeSubtitleBytes(cp1256);
  check("cp1256 decodes to Persian (starts with ا)", decoded.charCodeAt(0) === 0x627);
  // Valid UTF-8 Persian should pass through unchanged.
  const utf8 = new TextEncoder().encode("سلام");
  check("valid utf-8 preserved", decodeSubtitleBytes(utf8) === "سلام");
  // UTF-16 LE without BOM ("1\r\n" -> ascii in even slots, 0x00 in odd slots).
  const u16 = [];
  for (const ch of "1\r\n00:00:11,000 --> 00:00:20,500\r\nسلام") {
    const c = ch.charCodeAt(0);
    u16.push(c & 0xff, (c >> 8) & 0xff);
  }
  const u16dec = decodeSubtitleBytes(Uint8Array.from(u16));
  check("utf-16le (no BOM) decodes readable", u16dec.startsWith("1\r\n00:00:11") && u16dec.endsWith("سلام"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

async function liveTest(query) {
  const subkade = require(path.join(ROOT, "src/sites/subkade.js"));
  const parsed = parseTitle(query);
  console.log("parsed:", parsed);

  const results = await subkade.search(parsed, httpShim);
  console.log(`\nsubkade returned ${results.length} candidate(s):`);
  results.slice(0, 8).forEach((c) => console.log(`  - ${c.title}  ${c.pageUrl}`));
  if (!results.length) return;

  for (const c of results) c.score = scoreCandidate(parsed, c.title, c.meta);
  results.sort((a, b) => b.score - a.score);
  const top = results[0];
  console.log(`\nbest candidate: ${top.title} (score ${top.score})`);

  const zipUrl = await subkade.resolveDownloadUrl(top, httpShim);
  console.log("resolved zip:", zipUrl);
  if (!zipUrl) return;

  const { buf } = await get(zipUrl, subkade.downloadHeaders());
  console.log(`downloaded ${buf.length} bytes`);
  const outPath = extractBestSubtitle(new Uint8Array(buf), parsed.raw, parsed.title);
  console.log("extracted subtitle ->", outPath);
  if (outPath) {
    const head = fs.readFileSync(outPath, "utf8").slice(0, 200);
    console.log("\n--- first 200 chars (should be readable Persian) ---\n" + head);
  }
}

const arg = process.argv.slice(2).join(" ").trim();
(arg ? liveTest(arg) : Promise.resolve(unitTests())).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
