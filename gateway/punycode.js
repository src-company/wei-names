// RFC 3492 punycode decoding for one DNS label, zero-dependency so it runs
// unchanged under worker.js and server.js.
//
// Browsers send a Unicode name as its ASCII form (`café` -> `xn--caf-dma`),
// but NameNFT hashes the UTF-8 label as registered, so the gateway has to turn
// it back before computing the tokenId. Malformed input is returned unchanged.
export function fromPunycode(label) {
  if (!label.startsWith('xn--')) return label
  const input = label.slice(4)
  const cut = input.lastIndexOf('-')
  const out = cut > 0 ? [...input.slice(0, cut)].map((c) => c.codePointAt(0)) : []
  let n = 128
  let i = 0
  let bias = 72
  for (let p = cut > 0 ? cut + 1 : 0; p < input.length; ) {
    const oldi = i
    for (let w = 1, k = 36; ; k += 36) {
      if (p >= input.length) return label
      const c = input.charCodeAt(p++)
      const d = c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : -1
      if (d < 0) return label
      i += d * w
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias
      if (d < t) break
      w *= 36 - t
    }
    const len = out.length + 1
    let delta = Math.floor((i - oldi) / (oldi === 0 ? 700 : 2))
    delta += Math.floor(delta / len)
    let k = 0
    for (; delta > 455; k += 36) delta = Math.floor(delta / 35)
    bias = k + Math.floor((36 * delta) / (delta + 38))
    n += Math.floor(i / len)
    i %= len
    if (n > 0x10ffff) return label
    out.splice(i++, 0, n)
  }
  return out.length ? String.fromCodePoint(...out) : label
}

// Every label of a dotted name.
export function namesFromPunycode(name) {
  return name.split('.').map(fromPunycode).join('.')
}
