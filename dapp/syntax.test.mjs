// Every inline script in the shipping pages must parse. The other suites lift single functions out of
// index.html, so a syntax error anywhere else (an apostrophe closing a quoted HTML string, say) slips
// past them, and in the browser it stops the whole page script: no name lookup, no wallet, nothing.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const here = path.dirname(url.fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
for (const page of ['index.html', 'dao.html']) {
  const html = fs.readFileSync(path.join(here, page), 'utf8');
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) {
    if (/type="(?!text\/javascript)/.test(m[1])) continue; // JSON-LD, templates and the like
    n++;
    const line = html.slice(0, m.index).split('\n').length;
    try {
      new vm.Script(m[2], { filename: `${page}:${line}` });
      pass++;
      console.log('ok   ', `${page}: inline script ${n} (line ${line}) parses`);
    } catch (e) {
      fail++;
      console.log('FAIL ', `${page}: inline script ${n} (line ${line}):`, e.message);
    }
  }
}
for (const file of ['wallet.js', 'theme.js']) {
  try {
    new vm.Script(fs.readFileSync(path.join(here, file), 'utf8'), { filename: file });
    pass++;
    console.log('ok   ', `${file} parses`);
  } catch (e) {
    fail++;
    console.log('FAIL ', `${file}:`, e.message);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
