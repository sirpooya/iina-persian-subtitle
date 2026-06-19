// Self-contained ZIP reader + DEFLATE inflate. No dependencies, no globals,
// no UMD wrapper — just `module.exports`, so it loads cleanly in IINA's
// JavaScriptCore plugin sandbox (which lacks worker_threads/self/window/global).
//
// Supports stored (method 0) and deflate (method 8) entries, which covers every
// real-world subtitle .zip. Exposes unzipSync(Uint8Array) -> { name: Uint8Array }.

// --- DEFLATE (RFC 1951) inflate ---------------------------------------------
// Compact, correct inflate based on the public-domain tinf algorithm.

function buildTree(lengths, off, num) {
  const tree = { table: new Uint16Array(16), trans: new Uint16Array(num) };
  const offs = new Uint16Array(16);
  let i;
  for (i = 0; i < 16; i++) tree.table[i] = 0;
  for (i = 0; i < num; i++) tree.table[lengths[off + i]]++;
  tree.table[0] = 0;
  let sum = 0;
  for (i = 0; i < 16; i++) {
    offs[i] = sum;
    sum += tree.table[i];
  }
  for (i = 0; i < num; i++) {
    if (lengths[off + i]) tree.trans[offs[lengths[off + i]]++] = i;
  }
  return tree;
}

function Inflator(source) {
  this.s = source;
  this.i = 0; // byte index
  this.tag = 0;
  this.bitcount = 0;
  this.dest = [];
  this.destLen = 0;
}

Inflator.prototype.getbit = function () {
  if (this.bitcount-- === 0) {
    this.tag = this.s[this.i++];
    this.bitcount = 7;
  }
  const bit = this.tag & 1;
  this.tag >>>= 1;
  return bit;
};

Inflator.prototype.getbits = function (num, base) {
  let val = 0;
  for (let i = 0; i < num; i++) val |= this.getbit() << i;
  return val + (base || 0);
};

Inflator.prototype.decodeSymbol = function (tree) {
  let sum = 0,
    cur = 0,
    len = 0;
  do {
    cur = 2 * cur + this.getbit();
    len++;
    sum += tree.table[len];
    cur -= tree.table[len];
  } while (cur >= 0);
  return tree.trans[sum + cur];
};

const LENGTH_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
];
const DIST_BITS = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
  13,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const CLCIDX = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Fixed Huffman trees (cached).
let SLTREE = null,
  SDTREE = null;
function buildFixedTrees() {
  const l = new Uint8Array(288);
  let i;
  for (i = 0; i < 144; i++) l[i] = 8;
  for (; i < 256; i++) l[i] = 9;
  for (; i < 280; i++) l[i] = 7;
  for (; i < 288; i++) l[i] = 8;
  SLTREE = buildTree(l, 0, 288);
  const d = new Uint8Array(30).fill(5);
  SDTREE = buildTree(d, 0, 30);
}

Inflator.prototype.inflateBlockData = function (lt, dt) {
  for (;;) {
    let sym = this.decodeSymbol(lt);
    if (sym === 256) return;
    if (sym < 256) {
      this.dest.push(sym);
      this.destLen++;
    } else {
      sym -= 257;
      const length = this.getbits(LENGTH_BITS[sym], LENGTH_BASE[sym]);
      const distSym = this.decodeSymbol(dt);
      const dist = this.getbits(DIST_BITS[distSym], DIST_BASE[distSym]);
      const offs = this.destLen - dist;
      for (let i = 0; i < length; i++) {
        this.dest.push(this.dest[offs + i]);
        this.destLen++;
      }
    }
  }
};

Inflator.prototype.inflateUncompressed = function () {
  // Skip to byte boundary.
  this.bitcount = 0;
  let len = this.s[this.i] | (this.s[this.i + 1] << 8);
  this.i += 4; // len + nlen
  for (let i = 0; i < len; i++) {
    this.dest.push(this.s[this.i++]);
    this.destLen++;
  }
};

Inflator.prototype.decodeTrees = function () {
  const hlit = this.getbits(5, 257);
  const hdist = this.getbits(5, 1);
  const hclen = this.getbits(4, 4);
  const lengths = new Uint8Array(288 + 32);
  let i;
  for (i = 0; i < 19; i++) lengths[i] = 0;
  for (i = 0; i < hclen; i++) lengths[CLCIDX[i]] = this.getbits(3, 0);
  const codeTree = buildTree(lengths, 0, 19);

  let num = 0;
  const total = hlit + hdist;
  const cl = new Uint8Array(total);
  while (num < total) {
    const sym = this.decodeSymbol(codeTree);
    if (sym === 16) {
      const prev = cl[num - 1];
      for (let n = this.getbits(2, 3); n; n--) cl[num++] = prev;
    } else if (sym === 17) {
      for (let n = this.getbits(3, 3); n; n--) cl[num++] = 0;
    } else if (sym === 18) {
      for (let n = this.getbits(7, 11); n; n--) cl[num++] = 0;
    } else {
      cl[num++] = sym;
    }
  }
  return {
    lt: buildTree(cl, 0, hlit),
    dt: buildTree(cl, hlit, hdist),
  };
};

function inflate(source) {
  if (!SLTREE) buildFixedTrees();
  const d = new Inflator(source);
  let bfinal;
  do {
    bfinal = d.getbit();
    const btype = d.getbits(2, 0);
    if (btype === 0) d.inflateUncompressed();
    else if (btype === 1) d.inflateBlockData(SLTREE, SDTREE);
    else if (btype === 2) {
      const t = d.decodeTrees();
      d.inflateBlockData(t.lt, t.dt);
    } else {
      throw new Error("invalid deflate block type " + btype);
    }
  } while (!bfinal);
  return Uint8Array.from(d.dest);
}

// --- ZIP container ----------------------------------------------------------

function rd16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function rd32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

// Decode a ZIP DOS date+time pair into an ISO-ish "YYYY-MM-DD" string, or null.
// dosTime is the 16-bit time field, dosDate the 16-bit date field (both little-
// endian, already read). Subtitle rows only need the day, so we drop the clock.
function dosDate(dosDate) {
  if (!dosDate) return null; // 0 = no timestamp set
  const day = dosDate & 0x1f;
  const month = (dosDate >> 5) & 0x0f;
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  if (!day || !month || month > 12 || day > 31) return null;
  const mm = month < 10 ? `0${month}` : `${month}`;
  const dd = day < 10 ? `0${day}` : `${day}`;
  return `${year}-${mm}-${dd}`;
}

// Attach a name->date ("YYYY-MM-DD") map as a NON-ENUMERABLE property so that
// existing `Object.keys(entries)` callers keep seeing only the file names.
function attachDate(out, name, dateStr) {
  if (!dateStr) return;
  let map = out.__dates;
  if (!map) {
    map = {};
    Object.defineProperty(out, "__dates", { value: map, enumerable: false });
  }
  map[name] = dateStr;
}

// Parse local file headers sequentially (works for the vast majority of zips,
// including all subtitle packs). Returns { name: Uint8Array } with a hidden
// `__dates` map ({ name: "YYYY-MM-DD" }) for entries that carry a timestamp.
function unzipSync(buf) {
  const out = {};
  let i = 0;
  const n = buf.length;
  while (i + 4 <= n) {
    const sig = rd32(buf, i);
    if (sig !== 0x04034b50) break; // not a local file header -> reached central dir
    const method = rd16(buf, i + 8);
    let compSize = rd32(buf, i + 18);
    let uncompSize = rd32(buf, i + 22);
    const nameLen = rd16(buf, i + 26);
    const extraLen = rd16(buf, i + 28);
    const flags = rd16(buf, i + 6);
    const nameBytes = buf.subarray(i + 30, i + 30 + nameLen);
    const name = utf8Name(nameBytes);
    let dataStart = i + 30 + nameLen + extraLen;

    // Bit 3: sizes are in a data descriptor AFTER the data. Fall back to the
    // central directory in that case (rare for subtitle packs).
    if (flags & 0x08 && compSize === 0) {
      return unzipViaCentralDir(buf);
    }

    const data = buf.subarray(dataStart, dataStart + compSize);
    try {
      out[name] = method === 0 ? data.slice() : inflate(data);
      attachDate(out, name, dosDate(rd16(buf, i + 12))); // i+10 time, i+12 date
    } catch (e) {
      // skip a bad entry, keep going
    }
    i = dataStart + compSize;
  }
  if (Object.keys(out).length === 0) return unzipViaCentralDir(buf);
  return out;
}

// Robust path: read the central directory at the end of the file.
function unzipViaCentralDir(buf) {
  const out = {};
  const n = buf.length;
  // Find End Of Central Directory record (signature 0x06054b50), scanning back.
  let eocd = -1;
  for (let i = n - 22; i >= 0 && i > n - 22 - 65536; i--) {
    if (rd32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  let cd = rd32(buf, eocd + 16); // offset of central dir
  const count = rd16(buf, eocd + 10);
  for (let e = 0; e < count && cd + 46 <= n; e++) {
    if (rd32(buf, cd) !== 0x02014b50) break;
    const method = rd16(buf, cd + 10);
    const compSize = rd32(buf, cd + 20);
    const nameLen = rd16(buf, cd + 28);
    const extraLen = rd16(buf, cd + 30);
    const commentLen = rd16(buf, cd + 32);
    const localOff = rd32(buf, cd + 42);
    const name = utf8Name(buf.subarray(cd + 46, cd + 46 + nameLen));
    // Read the local header to find the real data start.
    const lNameLen = rd16(buf, localOff + 26);
    const lExtraLen = rd16(buf, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    try {
      out[name] = method === 0 ? data.slice() : inflate(data);
      attachDate(out, name, dosDate(rd16(buf, cd + 14))); // cd+12 time, cd+14 date
    } catch (err) {
      /* skip */
    }
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// File names in zips are usually UTF-8 (or ASCII). Decode minimally.
function utf8Name(bytes) {
  if (typeof TextDecoder !== "undefined") {
    try {
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      /* fall through */
    }
  }
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

module.exports = { unzipSync, inflate };
