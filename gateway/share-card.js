// Ported from gwei-names (github.com/lucadonnoh/gwei-names, gateway/share-card.js and the avatar and
// PNG helpers from its profile-page.js, MIT), kept in its style so the two stay easy to diff. Ours
// draws the wei name service brand, a pixel W, on a darker palette, and has no profile cards.
//
// Link-preview cards: the 1200x630 PNG that X, Telegram, WhatsApp, Discord and the rest show for a
// post, a name's list of posts, or the posts host (posts-page.js says which card a page gets). They
// are drawn here with no dependencies, in the look of the dapp's share card and the generated avatar:
// a flat background in the name's avatar colour with faint dots, the avatar's pixel mark, and text in
// a pixel font (card-font.js, a Unifont subset with emoji and most scripts). A card is 8-bit indexed,
// so the work is a few fills into a byte per pixel plus one deflate, the same for every name.
//
// An owner's own avatar image is not drawn: decoding remote JPEG, WebP, GIF or SVG files would need
// decoders this Worker doesn't have, and a fetch of someone else's server on every new card. Such
// names get a card without the mark (it would contradict their avatar); the page itself still shows it.

// The font is 800 KB of data, imported on the first card rather than at start (see loadFont).
let CARD_FONT = null;
export async function loadCardFont() {
  CARD_FONT ||= (await import('./card-font.js')).CARD_FONT;
}
const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));

// --- generative avatar (from gwei-names' profile-page.js) -------------------------------------------
// A symmetric 9x9 pixel mark on a flat background colour, seeded by the name's token ID, so a name
// always gets the same one. Our palette is darker and quieter than gwei.domains', after the dapp.
const AVATAR_COLORS = ['#0a0a0a', '#1b2a44', '#163a2e', '#2d1f48', '#46212a']; // the dapp's dark ground, and four muted tones
const AVATAR_GRID = 9, AVATAR_HALF = 5, AVATAR_CELL = 16, AVATAR_SIZE = 180, AVATAR_OFFSET = (AVATAR_SIZE - AVATAR_GRID * AVATAR_CELL) / 2;
const AVATAR_MIN_CELLS = 16; // fewer (or more than 81 - 16) lit cells and the pattern is inverted
export function avatarModel(seedHex, accent) {
  const bytes = hexToBytes(String(seedHex).replace(/^0x/, '').padStart(64, '0').slice(-64));
  // The owner's accent colour, when set, replaces the seeded background.
  const color = /^#[0-9a-f]{6}$/i.test(accent || '') ? accent : AVATAR_COLORS[bytes[0] % AVATAR_COLORS.length];
  // One bit per cell of the left half and the middle column, from the bytes after the colour byte.
  const bit = (i) => (bytes[1 + (i >> 3)] >> (i & 7)) & 1;
  const cells = [];
  for (let y = 0; y < AVATAR_GRID; y++) {
    for (let x = 0; x < AVATAR_HALF; x++) {
      if (!bit(y * AVATAR_HALF + x)) continue;
      cells.push([x, y]);
      if (x < AVATAR_HALF - 1) cells.push([AVATAR_GRID - 1 - x, y]);
    }
  }
  // Hash outputs are almost never this sparse or dense, but a nearly blank or solid avatar shouldn't
  // happen at all; the inverse of a symmetric pattern is symmetric too.
  if (cells.length < AVATAR_MIN_CELLS || cells.length > AVATAR_GRID * AVATAR_GRID - AVATAR_MIN_CELLS) {
    const lit = new Set(cells.map(([x, y]) => `${x},${y}`));
    const inverse = [];
    for (let y = 0; y < AVATAR_GRID; y++) for (let x = 0; x < AVATAR_GRID; x++) if (!lit.has(`${x},${y}`)) inverse.push([x, y]);
    return { color, cells: inverse };
  }
  return { color, cells };
}

// --- PNG (from gwei-names' profile-page.js) -----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Unfiltered scanlines (a filter byte per row) → PNG, zlib via CompressionStream; no dependencies.
// RGB unless a palette (an array of [r, g, b]) is given, then 8-bit indexed.
export async function encodePng(width, height, raw, palette) {
  const idat = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, palette ? 3 : 2, 0, 0, 0], 8); // 8-bit, indexed or RGB, deflate, no filter, no interlace
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr)];
  if (palette) parts.push(pngChunk('PLTE', Uint8Array.from(palette.flat())));
  parts.push(pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0)));
  const png = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { png.set(part, at); at += part.length; }
  return png;
}

// Readable text on an accent background: black or white, by relative luminance.
export function textOn(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#000' : '#fff';
}


export const CARD_WIDTH = 1200, CARD_HEIGHT = 630;
const W = CARD_WIDTH, H = CARD_HEIGHT, STRIDE = W + 1; // each scanline starts with its filter byte
const PAD = 72;
const INK_BG = '#0a0a0a'; // the dapp's dark background
// Palette slots: 0 is the background, then the text colour (black or white) mixed over it at these strengths.
const DOT = 1, INK = 2, MARK = 3, SOFT = 4, MUTED = 5, PILL = 6;
const MIXES = [0, 0.045, 1, 0.92, 0.78, 0.6, 0.14];

// --- the pixel font --------------------------------------------------------------------------------
// Decoded on first use (about a millisecond: the data isn't compressed) and then kept for the
// isolate's life.
let font = null;
function loadFont() {
  if (font) return font;
  if (!CARD_FONT) throw new Error('call loadCardFont() first');
  const text = atob(CARD_FONT);
  const bytes = new Uint8Array(text.length); // a plain loop: Uint8Array.from with a callback is ten times slower here
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const n = view.getUint32(0);
  const codes = new Uint32Array(n);
  let at = 4;
  for (let i = 0; i < n; i++, at += 3) codes[i] = bytes[at] << 16 | bytes[at + 1] << 8 | bytes[at + 2];
  const wide = bytes.subarray(at, at + Math.ceil(n / 8));
  at += wide.length;
  const marks = new Map();
  const m = view.getUint16(at);
  at += 2;
  for (let i = 0; i < m; i++, at += 4) marks.set(bytes[at] << 16 | bytes[at + 1] << 8 | bytes[at + 2], view.getInt8(at + 3));
  const offsets = new Uint32Array(n);
  for (let i = 0; i < n; i++) { offsets[i] = at; at += wide[i >> 3] & (0x80 >> (i & 7)) ? 32 : 16; }
  font = { codes, wide, marks, offsets, bytes };
  return font;
}
function glyphIndex(f, cp) {
  let lo = 0, hi = f.codes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (f.codes[mid] === cp) return mid;
    if (f.codes[mid] < cp) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}
const glyphWidth = (f, i) => (f.wide[i >> 3] & (0x80 >> (i & 7)) ? 16 : 8);

// --- text: graphemes → clusters of glyphs, in display order ---------------------------------------
// Invisible characters (joiners, variation selectors, tags, bidi controls) and emoji skin tones are not
// drawn; a ZWJ sequence (👩‍💻, 🏳️‍🌈) draws its first emoji, which is how a font without the sequence shows it.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u{1f3fb}-\u{1f3ff}\u{e0000}-\u{e0fff}]/u;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
const RTL = /[\u0590-\u05ff\u0600-\u065f\u066a-\u06ef\u06fa-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u;
const STRONG = /[\p{L}\p{N}]/u;

// Each cluster: { glyphs: [{ index, x }] in font pixels (index -1 is a missing glyph), advance, kind }.
function clusters(f, text) {
  const out = [];
  const segments = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
  for (const segment of segments) {
    const glyphs = [];
    let advance = 0;
    for (const ch of segment.split('\u200d')[0]) {
      if (INVISIBLE.test(ch)) continue;
      const cp = ch.codePointAt(0);
      const index = glyphIndex(f, cp);
      const shift = f.marks.get(cp);
      // Combining marks (accents, vowel signs) sit on what precedes them, as the font draws them.
      if (shift !== undefined && glyphs.length) { glyphs.push({ index, x: advance + shift }); continue; }
      const width = index >= 0 ? glyphWidth(f, index) : cp >= 0x1100 ? 16 : 8;
      glyphs.push({ index, x: advance, width });
      advance += width;
    }
    if (!glyphs.length) continue;
    out.push({ glyphs, advance, text: segment, kind: RTL.test(segment) ? 'R' : STRONG.test(segment) ? 'L' : 'N' });
  }
  // Right-to-left runs (Hebrew, Arabic) read in reverse, with what lies between their letters, as in
  // a left-to-right page. Arabic letters are drawn in their isolated forms.
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== 'R') continue;
    let end = i;
    for (let j = i + 1; j < out.length && out[j].kind !== 'L'; j++) if (out[j].kind === 'R') end = j;
    out.splice(i, end - i + 1, ...out.slice(i, end + 1).reverse());
    i = end;
  }
  return out;
}
const width = (line) => line.reduce((sum, c) => sum + c.advance, 0);
const ellipsis = (f) => clusters(f, '…')[0];

// Greedy line breaking within `max` font pixels, after a cluster matching `breakAfter` where possible.
// Spaces at a break are dropped. Returns every line; the caller decides what fits.
const CLOSING = /^[、。，．：；！？）」』】〕〉》]$/u; // CJK punctuation that can't start a line
function wrap(list, max, breakAfter) {
  const lines = [];
  let line = [];
  let used = 0;
  for (const c of list) {
    if (used + c.advance > max && line.length) {
      let cut = line.length;
      if (c.text !== ' ') { // a space that overflows is itself the break
        for (let i = line.length - 1; i > 0; i--) if (breakAfter.test(line[i].text)) { cut = i + 1; break; }
        // A break point near the start would waste the line; break mid-word instead.
        if (width(line.slice(0, cut)) < max * 0.4) cut = line.length;
        if (cut === line.length && CLOSING.test(c.text) && line.length > 1) cut--; // takes a character along
      }
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
      while (line.length && line[0].text === ' ') line.shift();
      used = width(line);
    }
    if (!line.length && c.text === ' ') continue;
    line.push(c);
    used += c.advance;
  }
  if (line.length) lines.push(line);
  return lines.map((l) => { while (l.length && l.at(-1).text === ' ') l.pop(); return l; });
}

// Text in at most `maxLines` lines, ending in "…" when it doesn't all fit.
function fitText(f, list, max, maxLines, breakAfter = / /) {
  const lines = wrap(list, max, breakAfter);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  const dots = ellipsis(f);
  while (last.length && (width(last) + dots.advance > max || last.at(-1).text === ' ')) last.pop();
  last.push(dots);
  return kept;
}

// A name as large as fits: one line if possible, else broken after its dots, and as a last resort cut
// in the middle so its end (".gwei", the parent name) stays readable.
const NAME_FITS = [[10, 1], [9, 1], [8, 1], [7, 1], [6, 1], [5, 1], [5, 2], [4, 2], [3, 2], [3, 3]];
function fitName(f, name, maxPx, maxScale = 10) {
  const list = clusters(f, name);
  for (const [scale, maxLines] of NAME_FITS.filter(([sc]) => sc <= maxScale)) {
    const lines = wrap(list, Math.floor(maxPx / scale), /\./);
    if (lines.length <= maxLines) return { scale, lines };
  }
  const [scale, maxLines] = NAME_FITS.at(-1);
  const max = Math.floor(maxPx / scale);
  const tail = list.slice(-Math.min(list.length, 14));
  for (let head = list.length - tail.length; head >= 0; head--) {
    const lines = wrap([...list.slice(0, head), ellipsis(f), ...tail], max, /^$/);
    if (lines.length <= maxLines) return { scale, lines };
  }
  return { scale, lines: wrap(tail, max, /^$/).slice(0, maxLines) };
}

// --- drawing -----------------------------------------------------------------------------------------
function fill(raw, x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x)), x1 = Math.min(W, Math.round(x + w));
  const y0 = Math.max(0, Math.round(y)), y1 = Math.min(H, Math.round(y + h));
  if (x0 >= x1) return;
  for (let row = y0; row < y1; row++) raw.fill(color, row * STRIDE + 1 + x0, row * STRIDE + 1 + x1);
}

// Glyph pixels become scale x scale squares; `bold` widens each one to the right (classic pixel bold).
function drawGlyph(raw, f, glyph, x, y, scale, color, bold) {
  if (glyph.index < 0) { // no glyph in the font: an empty box, as fonts draw a missing character
    const w = glyph.width;
    fill(raw, x + scale, y + 2 * scale, (w - 2) * scale, scale, color);
    fill(raw, x + scale, y + 13 * scale, (w - 2) * scale, scale, color);
    fill(raw, x + scale, y + 2 * scale, scale, 12 * scale, color);
    fill(raw, x + (w - 2) * scale, y + 2 * scale, scale, 12 * scale, color);
    return;
  }
  const bytesPerRow = glyphWidth(f, glyph.index) / 8;
  const at = f.offsets[glyph.index];
  for (let row = 0; row < 16; row++) {
    let bits = 0;
    for (let b = 0; b < bytesPerRow; b++) bits = bits << 8 | f.bytes[at + row * bytesPerRow + b];
    const cols = bytesPerRow * 8;
    // Runs of lit pixels are filled at once.
    for (let col = 0; col < cols; col++) {
      if (!(bits & (1 << (cols - 1 - col)))) continue;
      let end = col;
      while (end + 1 < cols && bits & (1 << (cols - 2 - end))) end++;
      fill(raw, x + col * scale, y + row * scale, (end - col + 1) * scale + bold, scale, color);
      col = end;
    }
  }
}
function drawLine(raw, f, line, x, y, scale, color, bold = 0) {
  for (const c of line) {
    for (const g of c.glyphs) drawGlyph(raw, f, g, x + g.x * scale, y, scale, color, bold);
    x += c.advance * scale;
  }
  return x;
}
const boldFor = (scale) => (scale >= 4 ? Math.round(scale / 2) : scale >= 2 ? 1 : 0);

// The generated avatar's 9x9 mark, or the wei name service logo (wns-icon.svg), at `cell` pixels per cell.
function drawMark(raw, cells, x, y, cell) {
  for (const [cx, cy] of cells) fill(raw, x + cx * cell, y + cy * cell, cell, cell, MARK);
}
// wns-icon.svg's rects in its 16x16 grid, in order: lit ones, then the eyes cut back out (0).
const LOGO_RECTS = [[3, 1, 1, 1, 1], [5, 2, 1, 1, 1], [10, 2, 1, 1, 1], [12, 1, 1, 1, 1], [4, 4, 8, 1, 1], [3, 5, 10, 1, 1], [2, 6, 12, 3, 1], [3, 9, 10, 1, 1], [4, 10, 8, 1, 1], [3, 6, 3, 2, 0], [10, 6, 3, 2, 0], [5, 11, 2, 1, 1], [9, 11, 2, 1, 1], [2, 12, 3, 1, 1], [7, 12, 2, 1, 1], [11, 12, 3, 1, 1], [1, 13, 2, 1, 1], [13, 13, 2, 1, 1]];
function drawLogo(raw, x, y, cell, color) {
  for (const [rx, ry, rw, rh, on] of LOGO_RECTS) fill(raw, x + rx * cell, y + ry * cell, rw * cell, rh * cell, on ? color : 0);
}

// Small uppercase labels in filled pills, like the profile page's badges, right-aligned at `right`.
// Returns where the leftmost one starts.
function drawPills(raw, f, labels, right, y) {
  let x = right;
  for (const label of [...labels].reverse()) {
    const line = clusters(f, label.toUpperCase());
    const w = width(line) * 2 + 32;
    x -= w;
    fill(raw, x, y, w, 44, PILL);
    drawLine(raw, f, line, x + 16, y + 6, 2, SOFT, 1);
    x -= 12;
  }
  return x;
}

// --- layouts -------------------------------------------------------------------------------------------
// Every card: the brand top left, the main block centred in the space left, the page's address and any
// badges at the bottom. `card` comes from posts-page.js: a post card ({ kind: 'post', name, title,
// date, seed, mark, host }), a name card ({ kind: 'name', name, bio, seed, mark, host }) or a site card
// ({ kind: 'site', title, lead, footer }).
const lineHeight = (scale) => 16 * scale + (scale >= 5 ? 8 : 6);
const TITLE_FITS = [[8, 1], [7, 1], [6, 2], [5, 3], [4, 4], [3, 5]];

// The main block: rows of wrapped text, top to bottom, fitted between the brand and the bottom row.
// Exported for tests.
const TEXT_TOP = PAD + 40, TEXT_BOTTOM = H - PAD - 56;
export function textRows(card, textWidth) {
  const f = loadFont();
  const rows = [];
  const text = (value, scale, color, maxLines, gap, extra) => {
    const list = clusters(f, String(value).replace(/\s+/g, ' ').trim());
    if (list.length) rows.push({ list, lines: fitText(f, list, Math.floor(textWidth / scale), maxLines), scale, color, gap, ...extra });
  };
  // A title as large as fits in a few lines (`fits`: sizes and line counts, largest first).
  const fitsAll = (list, [scale, maxLines]) => wrap(list, Math.floor(textWidth / scale), / /).length <= maxLines;
  const title = (value, fits, gap) => {
    const list = clusters(f, String(value).replace(/\s+/g, ' ').trim());
    const found = fits.findIndex((fit) => fitsAll(list, fit));
    const at = found >= 0 ? found : fits.length - 1;
    const [scale, maxLines] = fits[at];
    rows.push({ list, lines: fitText(f, list, Math.floor(textWidth / scale), maxLines), scale, color: INK, gap, fits, at });
  };
  if (card.kind === 'post') {
    text(card.name, 3, SOFT, 1, 0, { byline: true });
    title(card.title, TITLE_FITS, 28);
    if (card.date) text(card.date, 2, MUTED, 1, 24);
  } else if (card.kind === 'site') {
    title(card.title, [[10, 1], ...TITLE_FITS], 0);
    if (card.lead) text(card.lead, 3, SOFT, 3, 28);
  } else { // a name card: the name as large as fits, then a line about it
    rows.push({ ...fitName(f, card.name, textWidth, 10), color: INK, gap: 0 });
    if (card.display) text(card.display, 4, SOFT, 1, 24);
    if (card.bio) text(card.bio, 3, MUTED, 3, card.display ? 10 : 24);
  }
  // Whatever doesn't fit first takes a title down to a smaller size that still shows all of it; then
  // loses lines from the bottom up (they end in "…"), then whole rows.
  const height = () => rows.reduce((sum, r) => sum + r.gap + r.lines.length * lineHeight(r.scale), 0);
  while (height() > TEXT_BOTTOM - TEXT_TOP) {
    const t = rows.find((row) => row.fits);
    const smaller = t ? t.fits.findIndex((fit, i) => i > t.at && fitsAll(t.list, fit)) : -1;
    if (smaller >= 0) {
      t.at = smaller;
      [t.scale] = t.fits[smaller];
      t.lines = fitText(f, t.list, Math.floor(textWidth / t.scale), t.fits[smaller][1]);
      continue;
    }
    const r = rows.findLast((row) => row.list && row.lines.length > 1);
    if (r) r.lines = fitText(f, r.list, Math.floor(textWidth / r.scale), r.lines.length - 1);
    else if (rows.length > 1) rows.pop();
    else break;
  }
  return rows;
}

export async function renderCard(card) {
  await loadCardFont();
  const f = loadFont();
  const model = card.seed ? avatarModel(card.seed, card.accent) : { color: card.accent || INK_BG, cells: [] };
  const base = rgb(model.color);
  const ink = rgb(textOn(model.color) === '#000' ? '#000000' : '#ffffff');
  const palette = MIXES.map((a) => base.map((v, i) => Math.round(v + (ink[i] - v) * a)));
  // The mark is white whatever the text colour, as in the generated avatar the page shows.
  palette[MARK] = base.map((v) => Math.round(v + (255 - v) * 0.92));
  const raw = new Uint8Array(STRIDE * H); // zero: filter "none" and the background colour
  for (let y = 30; y < H; y += 20) for (let x = 30; x < W; x += 20) fill(raw, x, y, 2, 2, DOT);

  // The brand, as on the dapp's share card; then the bottom row: badges at the right, the address.
  drawLogo(raw, PAD - 2, PAD - 12, 2.5, MUTED);
  drawLine(raw, f, clusters(f, 'wei name service'), PAD + 50, PAD - 12, 2, MUTED, 1);
  const pillsLeft = card.badges?.length ? drawPills(raw, f, card.badges, W - PAD, H - PAD - 40) : W - PAD;
  const footer = clusters(f, card.footer || card.host || '');
  if (footer.length) drawLine(raw, f, fitText(f, footer, Math.floor((pillsLeft - 24 - PAD) / 2), 1)[0], PAD, H - PAD - 34, 2, MUTED, 1);

  // The mark (or the logo) takes the right side; text gets what is left.
  const side = 288;
  const showMark = card.kind === 'site' || (card.mark && model.cells.length);
  const textWidth = (showMark ? W - PAD - side - 64 : W - PAD) - PAD;
  if (card.kind === 'site') drawLogo(raw, W - PAD - side, (H - side) / 2, side / 16, MARK);
  else if (showMark) drawMark(raw, model.cells, W - PAD - side, (H - side) / 2, side / 9);

  const rows = textRows(card, textWidth);
  const height = rows.reduce((sum, r) => sum + r.gap + r.lines.length * lineHeight(r.scale), 0);
  let y = Math.round(TEXT_TOP + Math.max(0, (TEXT_BOTTOM - TEXT_TOP - height) / 2));
  for (const r of rows) {
    y += r.gap;
    let x = PAD;
    if (r.byline && card.mark && model.cells.length) { // a small mark before the author's name
      drawMark(raw, model.cells, x, y + 4, 4.5);
      x += 56;
    }
    for (const line of r.lines) {
      drawLine(raw, f, line, x, y, r.scale, r.color, r.color === INK || r.byline ? boldFor(r.scale) : Math.min(1, boldFor(r.scale)));
      y += lineHeight(r.scale);
    }
  }
  return encodePng(W, H, raw, palette);
}
