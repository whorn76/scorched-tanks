// Random seeds for the authority. Outside src/core on purpose: the simulation never sees
// non-deterministic randomness, only the seeds that come out of here inside commands.
export function freshSeed() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) return cryptoApi.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * 4294967296) >>> 0;
}
