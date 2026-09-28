// Base64 and small binary helpers that behave the same in browsers and Node.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function bytesToBase64(bytes) {
  let out = '';
  const chunk = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk.push(ALPHABET[n >> 18], ALPHABET[(n >> 12) & 63], ALPHABET[(n >> 6) & 63], ALPHABET[n & 63]);
    if (chunk.length >= 8192) {
      out += chunk.join('');
      chunk.length = 0;
    }
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    chunk.push(ALPHABET[n >> 18], ALPHABET[(n >> 12) & 63], '==');
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    chunk.push(ALPHABET[n >> 18], ALPHABET[(n >> 12) & 63], ALPHABET[(n >> 6) & 63], '=');
  }
  return out + chunk.join('');
}

/** Decodes base64 into bytes. Throws on malformed input. */
export function base64ToBytes(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0) throw new Error('bad base64');
  let pad = 0;
  if (text.endsWith('==')) pad = 2;
  else if (text.endsWith('=')) pad = 1;
  const length = (text.length / 4) * 3 - pad;
  const out = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = LOOKUP[text.charCodeAt(i)] ?? -1;
    const b = LOOKUP[text.charCodeAt(i + 1)] ?? -1;
    const c = text[i + 2] === '=' ? 0 : LOOKUP[text.charCodeAt(i + 2)] ?? -1;
    const d = text[i + 3] === '=' ? 0 : LOOKUP[text.charCodeAt(i + 3)] ?? -1;
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('bad base64');
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < length) out[o++] = (n >> 16) & 255;
    if (o < length) out[o++] = (n >> 8) & 255;
    if (o < length) out[o++] = n & 255;
  }
  return out;
}

/** Int16 values as little-endian bytes, base64-encoded. */
export function int16ToBase64(values) {
  const bytes = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] & 0xffff;
    bytes[i * 2] = v & 255;
    bytes[i * 2 + 1] = v >> 8;
  }
  return bytesToBase64(bytes);
}

export function base64ToInt16(text) {
  const bytes = base64ToBytes(text);
  if (bytes.length % 2 !== 0) throw new Error('bad int16 data');
  const out = new Int16Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

/** Run-length encodes zero runs (the rest is copied as-is). Good for sparse diffs. */
export function zeroRunEncode(bytes) {
  let out = new Uint8Array(Math.max(64, bytes.length >> 3));
  let o = 0;
  const ensure = (extra) => {
    if (o + extra <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, o + extra));
    bigger.set(out.subarray(0, o));
    out = bigger;
  };
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0) {
      ensure(1);
      out[o++] = bytes[i++];
      continue;
    }
    let j = i;
    while (j < bytes.length && bytes[j] === 0) j++;
    let run = j - i;
    ensure(6);
    out[o++] = 0;
    while (run >= 128) {
      out[o++] = (run & 127) | 128;
      run >>>= 7;
    }
    out[o++] = run;
    i = j;
  }
  return out.slice(0, o);
}

export function zeroRunDecode(bytes, length) {
  const out = new Uint8Array(length);
  let o = 0;
  let i = 0;
  while (i < bytes.length) {
    const v = bytes[i++];
    if (v !== 0) {
      if (o >= length) throw new Error('bad run data');
      out[o++] = v;
      continue;
    }
    let run = 0;
    let scale = 1;
    for (;;) {
      if (i >= bytes.length || scale > 268435456) throw new Error('bad run data');
      const b = bytes[i++];
      run += (b & 127) * scale;
      scale *= 128;
      if (b < 128) break;
    }
    if (o + run > length) throw new Error('bad run data');
    o += run;
  }
  if (o !== length) throw new Error('bad run data');
  return out;
}
