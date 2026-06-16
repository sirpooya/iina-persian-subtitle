// Unzip + encoding handling for downloaded subtitle archives.
//
// IINA's plugin API has NO native unzip, so we use a small self-contained
// pure-JS unzip (vendor/unzip.js) — no deps, no UMD globals (IINA's JSCore
// sandbox lacks worker_threads/self/window, which broke off-the-shelf libs).
// Persian subtitles are very frequently encoded as Windows-1256 (or UTF-8 with
// or without BOM). mpv/IINA generally renders UTF-8 reliably, so we decode the
// bytes with the best-guess encoding and re-write the file as UTF-8.

const { unzipSync } = require("../vendor/unzip.js");

const { console, file, utils } = iina;

const SUB_EXT = /\.(srt|ass|ssa|vtt|sub)$/i;

// --- encoding detection -----------------------------------------------------

// Returns true if the byte array is valid UTF-8.
function isValidUtf8(bytes) {
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    if (b <= 0x7f) {
      i += 1;
    } else if (b >= 0xc2 && b <= 0xdf) {
      if (i + 1 >= n || (bytes[i + 1] & 0xc0) !== 0x80) return false;
      i += 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      if (
        i + 2 >= n ||
        (bytes[i + 1] & 0xc0) !== 0x80 ||
        (bytes[i + 2] & 0xc0) !== 0x80
      )
        return false;
      i += 3;
    } else if (b >= 0xf0 && b <= 0xf4) {
      if (
        i + 3 >= n ||
        (bytes[i + 1] & 0xc0) !== 0x80 ||
        (bytes[i + 2] & 0xc0) !== 0x80 ||
        (bytes[i + 3] & 0xc0) !== 0x80
      )
        return false;
      i += 4;
    } else {
      return false;
    }
  }
  return true;
}

// Minimal Windows-1256 (Arabic/Persian) -> Unicode mapping for the high range
// (0x80-0xFF). Low range (0x00-0x7F) is identical to ASCII.
// Source: Microsoft cp1256 code page.
// prettier-ignore
const CP1256_HIGH = [
  0x20ac,0x067e,0x201a,0x0192,0x201e,0x2026,0x2020,0x2021,0x02c6,0x2030,0x0679,0x2039,0x0152,0x0686,0x0698,0x0688,
  0x06af,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,0x06a9,0x2122,0x0691,0x203a,0x0153,0x200c,0x200d,0x06ba,
  0x00a0,0x060c,0x00a2,0x00a3,0x00a4,0x00a5,0x00a6,0x00a7,0x00a8,0x00a9,0x06be,0x00ab,0x00ac,0x00ad,0x00ae,0x00af,
  0x00b0,0x00b1,0x00b2,0x00b3,0x00b4,0x00b5,0x00b6,0x00b7,0x00b8,0x00b9,0x061b,0x00bb,0x00bc,0x00bd,0x00be,0x061f,
  0x06c1,0x0621,0x0622,0x0623,0x0624,0x0625,0x0626,0x0627,0x0628,0x0629,0x062a,0x062b,0x062c,0x062d,0x062e,0x062f,
  0x0630,0x0631,0x0632,0x0633,0x0634,0x0635,0x0636,0x00d7,0x0637,0x0638,0x0639,0x063a,0x0640,0x0641,0x0642,0x0643,
  0x00e0,0x0644,0x00e2,0x0645,0x0646,0x0647,0x0648,0x00e7,0x00e8,0x00e9,0x00ea,0x00eb,0x0649,0x064a,0x00ee,0x00ef,
  0x064b,0x064c,0x064d,0x064e,0x00f4,0x064f,0x0650,0x00f7,0x0651,0x00f9,0x0652,0x00fb,0x00fc,0x200e,0x200f,0x06d2,
];

function decodeCp1256(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += String.fromCharCode(b < 0x80 ? b : CP1256_HIGH[b - 0x80]);
  }
  return out;
}

function decodeUtf8(bytes) {
  // Strip UTF-8 BOM if present.
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }
  // Use TextDecoder if the sandbox provides it; otherwise manual.
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes.subarray(start));
  }
  // Fallback manual UTF-8 decode.
  let out = "";
  let i = start;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b <= 0x7f) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b >= 0xc0 && b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      i += 4; // skip astral; rare in subs
    }
  }
  return out;
}

// Decode UTF-16 (LE or BE) to a JS string. `le` = little-endian.
function decodeUtf16(bytes, le, start) {
  let out = "";
  for (let i = start; i + 1 < bytes.length; i += 2) {
    const code = le ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
    out += String.fromCharCode(code);
  }
  return out;
}

// Heuristic: detect UTF-16 by looking for the BOM, or for the pattern of an
// ASCII byte alternating with a 0x00 byte (very common in Persian subs saved as
// "[Unicode]" by Windows tools). Returns {le} or null.
function detectUtf16(bytes) {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { le: true, bom: 2 };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { le: false, bom: 2 };
  }
  // No BOM: sample the first ~200 bytes. Count zero bytes in even vs odd slots.
  const n = Math.min(bytes.length & ~1, 400);
  if (n < 8) return null;
  let evenZero = 0, oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  // Many high-byte-zero positions => UTF-16. LE keeps ASCII in even slots
  // (odd slot is 0x00); BE is the reverse.
  if (oddZero > pairs * 0.3 && oddZero > evenZero) return { le: true, bom: 0 };
  if (evenZero > pairs * 0.3 && evenZero > oddZero) return { le: false, bom: 0 };
  return null;
}

// Decide encoding and return a UTF-8 JS string.
function decodeSubtitleBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8(bytes); // explicit UTF-8 BOM
  }
  const u16 = detectUtf16(bytes);
  if (u16) return decodeUtf16(bytes, u16.le, u16.bom);

  // Persian text in UTF-8 has lots of multi-byte sequences. If the whole thing
  // is valid UTF-8 AND contains non-ASCII, trust UTF-8. Otherwise assume 1256.
  const hasHighBytes = bytes.some((b) => b > 0x7f);
  if (!hasHighBytes) return decodeUtf8(bytes); // pure ASCII
  if (isValidUtf8(bytes)) return decodeUtf8(bytes);
  return decodeCp1256(bytes);
}

// --- archive handling -------------------------------------------------------

// Pick the best subtitle file from a list of names inside the archive.
// `preferName` (the playing file's release name) biases toward the closest sync.
function pickBestEntry(names, preferName) {
  const subs = names.filter((n) => SUB_EXT.test(n) && !n.startsWith("__MACOSX"));
  if (subs.length === 0) return null;
  if (subs.length === 1) return subs[0];

  const want = (preferName || "").toLowerCase().replace(/[._\-\s]+/g, "");
  let best = subs[0];
  let bestScore = -1;
  for (const n of subs) {
    const base = n.split("/").pop().toLowerCase();
    let score = 0;
    // Prefer .srt > .ass > others (most compatible).
    if (/\.srt$/i.test(base)) score += 3;
    else if (/\.(ass|ssa)$/i.test(base)) score += 2;
    // Persian packs often ship the same sub in several encodings. UTF-8 is the
    // safest for mpv; "[Unicode]" usually means UTF-16 (more fragile).
    if (/\[utf-?8\]/i.test(base)) score += 4;
    else if (/\[unicode\]/i.test(base)) score += 1;
    // Bias toward the file whose name resembles the playing file.
    if (want) {
      const norm = base.replace(/[._\-\s]+/g, "");
      if (norm.includes(want.slice(0, 12))) score += 5;
    }
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

// Given the bytes of a downloaded archive, extract the best subtitle, convert
// it to UTF-8, write it to `@tmp/`, and return its resolved absolute path.
//
// `zipBytes`    : Uint8Array of the downloaded .zip
// `preferName`  : playing file release name (for picking the right entry)
// `outBaseName` : base file name (without extension) for the written file
function extractBestSubtitle(zipBytes, preferName, outBaseName) {
  let entries;
  try {
    entries = unzipSync(zipBytes);
  } catch (e) {
    console.error(`unzip failed: ${e}`);
    return null;
  }

  const names = Object.keys(entries);
  const chosen = pickBestEntry(names, preferName);
  if (!chosen) {
    console.error(`no subtitle file found in archive (entries: ${names.join(", ")})`);
    return null;
  }

  const ext = (chosen.match(SUB_EXT) || [".srt"])[0].toLowerCase();
  const text = decodeSubtitleBytes(entries[chosen]);

  const safeBase = (outBaseName || "subtitle").replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const dest = `@tmp/${safeBase}${ext}`;
  // Write as UTF-8. iina.file.write writes a string as UTF-8.
  file.write(dest, text);
  const abs = utils.resolvePath(dest);
  console.log(`extracted "${chosen}" -> ${abs}`);
  return abs;
}

// List the subtitle entry names inside an archive (filtering junk/.url/__MACOSX).
// Returns [] on failure. Each name is the path inside the zip.
function listSubtitleEntries(zipBytes) {
  let entries;
  try {
    entries = unzipSync(zipBytes);
  } catch (e) {
    console.error(`unzip (list) failed: ${e}`);
    return [];
  }
  return Object.keys(entries).filter(
    (n) => SUB_EXT.test(n) && !n.startsWith("__MACOSX")
  );
}

// Extract ONE named entry from an archive, decode to UTF-8, write to @tmp/,
// return the resolved path. Used when the user picked a specific variant.
function extractEntry(zipBytes, entryName, outBaseName) {
  let entries;
  try {
    entries = unzipSync(zipBytes);
  } catch (e) {
    console.error(`unzip (extract) failed: ${e}`);
    return null;
  }
  const bytes = entries[entryName];
  if (!bytes) {
    console.error(`entry not found in archive: ${entryName}`);
    return null;
  }
  const ext = (entryName.match(SUB_EXT) || [".srt"])[0].toLowerCase();
  const text = decodeSubtitleBytes(bytes);
  const safeBase = (outBaseName || "subtitle").replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const dest = `@tmp/${safeBase}${ext}`;
  file.write(dest, text);
  const abs = utils.resolvePath(dest);
  console.log(`extracted "${entryName}" -> ${abs}`);
  return abs;
}

module.exports = {
  extractBestSubtitle,
  extractEntry,
  listSubtitleEntries,
  decodeSubtitleBytes,
  pickBestEntry,
};
