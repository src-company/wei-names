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

export function createClientIdentity(env = {}) {
  const proxies = new BlockList()
  for (const entry of String(env.TRUSTED_PROXY_CIDRS || '').split(',').map(s => s.trim()).filter(Boolean)) {
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
