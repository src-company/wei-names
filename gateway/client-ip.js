// Node-only transport identity. Request headers have no authority unless the
// immediate socket peer belongs to an explicitly configured proxy network.
import { BlockList, isIP } from 'node:net'

function ip(value) {
  if (typeof value !== 'string') return null
  const address = value.trim()
  // Node represents IPv4 peers on dual-stack sockets as IPv4-mapped IPv6.
  if (/^::ffff:/i.test(address) && isIP(address.slice(7)) === 4) return address.slice(7)
  return isIP(address) ? address : null
}

// Cloudflare's published edge ranges (cloudflare.com/ips-v4, /ips-v6; checked
// 2026-10-17). `cloudflare` in TRUSTED_PROXY_CIDRS stands for all of them.
// Render's own edge is Cloudflare: a request reaches Node as peer 10.x with
// `X-Forwarded-For: <client>, <cloudflare edge>`, so without these the walk
// stops at the edge IP — which rotates per request, so no client's requests
// ever add up, while everyone behind the same edge IP shares one budget.
export const CLOUDFLARE_CIDRS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]

export function createClientIdentity(env = {}) {
  const proxies = new BlockList()
  const entries = String(env.TRUSTED_PROXY_CIDRS || '').split(',').map(s => s.trim()).filter(Boolean)
    .flatMap(entry => (entry.toLowerCase() === 'cloudflare' ? CLOUDFLARE_CIDRS : [entry]))
  for (const entry of entries) {
    const parts = entry.split('/')
    const address = ip(parts[0])
    if (!address || parts.length > 2) throw new Error('Invalid TRUSTED_PROXY_CIDRS entry')
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6'
    if (parts.length === 1) proxies.addAddress(address, family)
    else {
      if (!/^\d+$/.test(parts[1])) throw new Error('Invalid TRUSTED_PROXY_CIDRS prefix')
      proxies.addSubnet(address, Number(parts[1]), family)
    }
  }
  const trusted = address => proxies.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6')
  return req => {
    const peer = ip(req.socket?.remoteAddress)
    if (!peer) return 'unknown'
    if (!trusted(peer)) return peer
    const header = req.headers['x-forwarded-for']
    if (typeof header !== 'string') return peer
    const chain = header.split(',').map(ip)
    if (chain.some(address => !address)) return peer
    // Proxies append the peer they actually saw. Stop at the first untrusted
    // hop, so a client cannot prepend a different address to buy another bucket.
    let current = peer
    for (let i = chain.length - 1; i >= 0 && trusted(current); i--) current = chain[i]
    return current
  }
}
