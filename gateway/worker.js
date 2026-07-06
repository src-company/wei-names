// Cloudflare Worker entrypoint for the wei.limo wildcard gateway.
//
// Deploy:  cd gateway && wrangler deploy
// Requires wei.limo to be a Cloudflare zone with a `*.wei.limo` worker route
// (see wrangler.toml). Env vars are set as Worker vars/secrets.

import { handleRequest } from './handler.js'

export default {
  fetch(request, env) {
    return handleRequest(request, env)
  },
}
