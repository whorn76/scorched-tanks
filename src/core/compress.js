// Compression helpers built on the standard CompressionStream API (browsers and Node 18+).
// When it isn't available the data is sent uncompressed.

export async function deflateBytes(bytes) {
  if (typeof CompressionStream === 'undefined') return { method: 'none', data: bytes };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return { method: 'deflate', data: new Uint8Array(await new Response(stream).arrayBuffer()) };
}

/** Inflates data, refusing to produce more than `maxLength` bytes. */
export async function inflateBytes(bytes, method, maxLength) {
  if (method === 'none') {
    if (bytes.length > maxLength) throw new Error('data too large');
    return bytes;
  }
  if (method !== 'deflate' || typeof DecompressionStream === 'undefined') throw new Error('unsupported compression');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxLength) {
      await reader.cancel();
      throw new Error('data too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
