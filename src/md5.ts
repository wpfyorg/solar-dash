// Compact, public-domain-style MD5 implementation for use in Cloudflare
// Workers, where WebCrypto has no MD5 digest. Ported from the well-known
// JS MD5 implementations (e.g. Joseph Myers' md5.js, public domain), kept
// minimal and dependency-free. Input/output: UTF-8 string in, lowercase hex
// digest out — matching Rust's `md5::Md5` + `format!("{:x}", ...)` used by
// solar-dash/src/client.rs's `md5_hex`.

function safeAdd(x: number, y: number): number {
  const lsw = (x & 0xffff) + (y & 0xffff);
  const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  return (msw << 16) | (lsw & 0xffff);
}

function bitRotateLeft(num: number, cnt: number): number {
  return (num << cnt) | (num >>> (32 - cnt));
}

function md5cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
  return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
}
function md5ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5cmn((b & c) | (~b & d), a, b, x, s, t);
}
function md5gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
}
function md5hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5cmn(b ^ c ^ d, a, b, x, s, t);
}
function md5ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5cmn(c ^ (b | ~d), a, b, x, s, t);
}

function md5blk(x: number[], offset: number): number[] {
  // 16 32-bit little-endian words from the block starting at `offset`.
  const out = new Array<number>(16);
  for (let i = 0; i < 16; i++) out[i] = x[offset + i]!;
  return out;
}

function md5cycle(a: [number, number, number, number], k: number[]): void {
  let [aa, bb, cc, dd] = a;

  aa = md5ff(aa, bb, cc, dd, k[0]!, 7, -680876936);
  dd = md5ff(dd, aa, bb, cc, k[1]!, 12, -389564586);
  cc = md5ff(cc, dd, aa, bb, k[2]!, 17, 606105819);
  bb = md5ff(bb, cc, dd, aa, k[3]!, 22, -1044525330);
  aa = md5ff(aa, bb, cc, dd, k[4]!, 7, -176418897);
  dd = md5ff(dd, aa, bb, cc, k[5]!, 12, 1200080426);
  cc = md5ff(cc, dd, aa, bb, k[6]!, 17, -1473231341);
  bb = md5ff(bb, cc, dd, aa, k[7]!, 22, -45705983);
  aa = md5ff(aa, bb, cc, dd, k[8]!, 7, 1770035416);
  dd = md5ff(dd, aa, bb, cc, k[9]!, 12, -1958414417);
  cc = md5ff(cc, dd, aa, bb, k[10]!, 17, -42063);
  bb = md5ff(bb, cc, dd, aa, k[11]!, 22, -1990404162);
  aa = md5ff(aa, bb, cc, dd, k[12]!, 7, 1804603682);
  dd = md5ff(dd, aa, bb, cc, k[13]!, 12, -40341101);
  cc = md5ff(cc, dd, aa, bb, k[14]!, 17, -1502002290);
  bb = md5ff(bb, cc, dd, aa, k[15]!, 22, 1236535329);

  aa = md5gg(aa, bb, cc, dd, k[1]!, 5, -165796510);
  dd = md5gg(dd, aa, bb, cc, k[6]!, 9, -1069501632);
  cc = md5gg(cc, dd, aa, bb, k[11]!, 14, 643717713);
  bb = md5gg(bb, cc, dd, aa, k[0]!, 20, -373897302);
  aa = md5gg(aa, bb, cc, dd, k[5]!, 5, -701558691);
  dd = md5gg(dd, aa, bb, cc, k[10]!, 9, 38016083);
  cc = md5gg(cc, dd, aa, bb, k[15]!, 14, -660478335);
  bb = md5gg(bb, cc, dd, aa, k[4]!, 20, -405537848);
  aa = md5gg(aa, bb, cc, dd, k[9]!, 5, 568446438);
  dd = md5gg(dd, aa, bb, cc, k[14]!, 9, -1019803690);
  cc = md5gg(cc, dd, aa, bb, k[3]!, 14, -187363961);
  bb = md5gg(bb, cc, dd, aa, k[8]!, 20, 1163531501);
  aa = md5gg(aa, bb, cc, dd, k[13]!, 5, -1444681467);
  dd = md5gg(dd, aa, bb, cc, k[2]!, 9, -51403784);
  cc = md5gg(cc, dd, aa, bb, k[7]!, 14, 1735328473);
  bb = md5gg(bb, cc, dd, aa, k[12]!, 20, -1926607734);

  aa = md5hh(aa, bb, cc, dd, k[5]!, 4, -378558);
  dd = md5hh(dd, aa, bb, cc, k[8]!, 11, -2022574463);
  cc = md5hh(cc, dd, aa, bb, k[11]!, 16, 1839030562);
  bb = md5hh(bb, cc, dd, aa, k[14]!, 23, -35309556);
  aa = md5hh(aa, bb, cc, dd, k[1]!, 4, -1530992060);
  dd = md5hh(dd, aa, bb, cc, k[4]!, 11, 1272893353);
  cc = md5hh(cc, dd, aa, bb, k[7]!, 16, -155497632);
  bb = md5hh(bb, cc, dd, aa, k[10]!, 23, -1094730640);
  aa = md5hh(aa, bb, cc, dd, k[13]!, 4, 681279174);
  dd = md5hh(dd, aa, bb, cc, k[0]!, 11, -358537222);
  cc = md5hh(cc, dd, aa, bb, k[3]!, 16, -722521979);
  bb = md5hh(bb, cc, dd, aa, k[6]!, 23, 76029189);
  aa = md5hh(aa, bb, cc, dd, k[9]!, 4, -640364487);
  dd = md5hh(dd, aa, bb, cc, k[12]!, 11, -421815835);
  cc = md5hh(cc, dd, aa, bb, k[15]!, 16, 530742520);
  bb = md5hh(bb, cc, dd, aa, k[2]!, 23, -995338651);

  aa = md5ii(aa, bb, cc, dd, k[0]!, 6, -198630844);
  dd = md5ii(dd, aa, bb, cc, k[7]!, 10, 1126891415);
  cc = md5ii(cc, dd, aa, bb, k[14]!, 15, -1416354905);
  bb = md5ii(bb, cc, dd, aa, k[5]!, 21, -57434055);
  aa = md5ii(aa, bb, cc, dd, k[12]!, 6, 1700485571);
  dd = md5ii(dd, aa, bb, cc, k[3]!, 10, -1894986606);
  cc = md5ii(cc, dd, aa, bb, k[10]!, 15, -1051523);
  bb = md5ii(bb, cc, dd, aa, k[1]!, 21, -2054922799);
  aa = md5ii(aa, bb, cc, dd, k[8]!, 6, 1873313359);
  dd = md5ii(dd, aa, bb, cc, k[15]!, 10, -30611744);
  cc = md5ii(cc, dd, aa, bb, k[6]!, 15, -1560198380);
  bb = md5ii(bb, cc, dd, aa, k[13]!, 21, 1309151649);
  aa = md5ii(aa, bb, cc, dd, k[4]!, 6, -145523070);
  dd = md5ii(dd, aa, bb, cc, k[11]!, 10, -1120210379);
  cc = md5ii(cc, dd, aa, bb, k[2]!, 15, 718787259);
  bb = md5ii(bb, cc, dd, aa, k[9]!, 21, -343485551);

  a[0] = safeAdd(aa, a[0]);
  a[1] = safeAdd(bb, a[1]);
  a[2] = safeAdd(cc, a[2]);
  a[3] = safeAdd(dd, a[3]);
}

function bytesToWords(bytes: Uint8Array): number[] {
  // Little-endian 32-bit words, MD5 padding per RFC 1321, message length in
  // bits as a 64-bit little-endian value (we only need the low 32 bits for
  // any realistic input size here).
  const bitLen = bytes.length * 8;
  const numWords = (((bytes.length + 8) >> 6) + 1) * 16;
  const words = new Array<number>(numWords).fill(0);
  for (let i = 0; i < bytes.length; i++) {
    words[i >> 2] = (words[i >> 2] ?? 0) | (bytes[i]! << ((i % 4) * 8));
  }
  words[bytes.length >> 2] = (words[bytes.length >> 2] ?? 0) | (0x80 << ((bytes.length % 4) * 8));
  words[numWords - 2] = bitLen;
  return words;
}

export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const words = bytesToWords(bytes);
  const state: [number, number, number, number] = [1732584193, -271733879, -1732584194, 271733878];
  for (let i = 0; i < words.length; i += 16) {
    md5cycle(state, md5blk(words, i));
  }
  const bytesOut = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    const v = state[i]!;
    bytesOut[i * 4] = v & 0xff;
    bytesOut[i * 4 + 1] = (v >> 8) & 0xff;
    bytesOut[i * 4 + 2] = (v >> 16) & 0xff;
    bytesOut[i * 4 + 3] = (v >> 24) & 0xff;
  }
  return Array.from(bytesOut)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
