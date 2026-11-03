// keccak-256 (the Ethereum one: original Keccak padding, not FIPS SHA3-256).
// Zero-dependency. Each 64-bit lane is a pair of 32-bit halves in an Int32Array:
// names hash a few short labels, but a post (posts.js) is up to 127 KB and is
// hashed on upload and when read out of a blob, so this must not stall the
// event loop the way a BigInt-lane version did (~370 ms for one max-size post).

// Round constants as [lo, hi] pairs.
const RC = new Int32Array([
  0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000, 0x80008000, 0x80000000,
  0x0000808b, 0x00000000, 0x80000001, 0x00000000, 0x80008081, 0x80000000, 0x00008009, 0x80000000,
  0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000,
  0x00008002, 0x80000000, 0x00000080, 0x80000000, 0x0000800a, 0x00000000, 0x8000000a, 0x80000000,
  0x80008081, 0x80000000, 0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
])
// Rotation offsets, indexed x + 5y.
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]
// pi: lane x + 5y moves to y + 5((2x + 3y) % 5).
const PI = new Array(25)
for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5)

const C = new Int32Array(10)
const B = new Int32Array(50)

// State `s`: lane i is s[2i] (low half), s[2i + 1] (high half).
function permute(s) {
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      C[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40]
      C[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41]
    }
    for (let x = 0; x < 5; x++) {
      const l = C[2 * ((x + 1) % 5)], h = C[2 * ((x + 1) % 5) + 1]
      const dl = C[2 * ((x + 4) % 5)] ^ ((l << 1) | (h >>> 31))
      const dh = C[2 * ((x + 4) % 5) + 1] ^ ((h << 1) | (l >>> 31))
      for (let y = 0; y < 25; y += 5) {
        s[2 * (x + y)] ^= dl
        s[2 * (x + y) + 1] ^= dh
      }
    }
    // rho + pi
    for (let i = 0; i < 25; i++) {
      const l = s[2 * i], h = s[2 * i + 1], r = ROT[i], j = PI[i]
      if (r === 0) {
        B[2 * j] = l
        B[2 * j + 1] = h
      } else if (r < 32) {
        B[2 * j] = (l << r) | (h >>> (32 - r))
        B[2 * j + 1] = (h << r) | (l >>> (32 - r))
      } else if (r === 32) {
        B[2 * j] = h
        B[2 * j + 1] = l
      } else {
        B[2 * j] = (h << (r - 32)) | (l >>> (64 - r))
        B[2 * j + 1] = (l << (r - 32)) | (h >>> (64 - r))
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const a = 2 * (x + y), b = 2 * (((x + 1) % 5) + y), c = 2 * (((x + 2) % 5) + y)
        s[a] = B[a] ^ (~B[b] & B[c])
        s[a + 1] = B[a + 1] ^ (~B[b + 1] & B[c + 1])
      }
    }
    // iota
    s[0] ^= RC[2 * round]
    s[1] ^= RC[2 * round + 1]
  }
}

// keccak256(bytes) -> Uint8Array(32)
export function keccak256(bytes) {
  const rate = 136
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate)
  padded.set(bytes)
  padded[bytes.length] ^= 0x01
  padded[padded.length - 1] ^= 0x80
  const state = new Int32Array(50)
  for (let off = 0; off < padded.length; off += rate) {
    // Lanes are little-endian: the low half is the first four bytes.
    for (let i = 0; i < rate / 4; i++) {
      const at = off + 4 * i
      state[i] ^= padded[at] | (padded[at + 1] << 8) | (padded[at + 2] << 16) | (padded[at + 3] << 24)
    }
    permute(state)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 8; i++) {
    const w = state[i]
    out[4 * i] = w & 0xff
    out[4 * i + 1] = (w >>> 8) & 0xff
    out[4 * i + 2] = (w >>> 16) & 0xff
    out[4 * i + 3] = (w >>> 24) & 0xff
  }
  return out
}
