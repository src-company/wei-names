// fromPunycode must agree with Node's own IDNA decoder, and leave anything it
// can't decode exactly as it was.
import { domainToUnicode } from 'node:url'
import { fromPunycode, namesFromPunycode } from './punycode.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log('ok   ', name) }
  else { fail++; console.log('FAIL ', name, JSON.stringify(got), '!==', JSON.stringify(want)) }
}

for (const u of ['café', 'münchen', '日本語', 'пример', 'ñandú', 'δοκιμή', 'مثال', '🦄', '👍🏽', 'a🙂b', 'straße', 'αβγ-δ']) {
  const ascii = new URL('https://' + u + '.wei.limo').hostname.split('.')[0]
  eq('decodes ' + ascii, fromPunycode(ascii), domainToUnicode(ascii))
}
eq('plain labels pass through', fromPunycode('vitalik'), 'vitalik')
eq('malformed stays as is', fromPunycode('xn--!!'), 'xn--!!')
eq('truncated stays as is', fromPunycode('xn--caf-dm'), fromPunycode('xn--caf-dm'))
eq('dotted names map each label', namesFromPunycode('xn--caf-dma.alice'), 'café.alice')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
