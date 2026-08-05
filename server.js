// PS Store price backend — deploy on Render (or any Node 18+ host).
// Fetches PlayStation Store prices server-side (no browser CORS limits) and
// returns clean JSON. Zero dependencies (uses built-in http + global fetch).

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.env.PS_BASE || 'https://store.playstation.com';   // overridable for tests
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// region code -> store locale
const LOCALES = {
  US:'en-us', UA:'uk-ua', IN:'en-in', JP:'ja-jp', BR:'pt-br', TR:'tr-tr',
  ID:'en-id', MY:'en-my', TW:'zh-tw', HK:'en-hk', KR:'ko-kr', ZA:'en-za',
  PL:'pl-pl', NO:'en-no', CA:'en-ca', AU:'en-au', MX:'es-mx', GB:'en-gb',
  DE:'de-de', SG:'en-sg'
};
// each region's own currency
const EXPECT = {
  US:'USD', UA:'UAH', IN:'INR', JP:'JPY', BR:'BRL', TR:'TRY', ID:'IDR', MY:'MYR',
  TW:'TWD', HK:'HKD', KR:'KRW', ZA:'ZAR', PL:'PLN', NO:'NOK', CA:'CAD', AU:'AUD',
  MX:'MXN', GB:'GBP', DE:'EUR', SG:'SGD'
};

// Stores that legitimately list in a currency other than their region's own.
// The PS Store Mexico prices plenty of titles in USD; that is a real price a
// Mexican account pays, so it belongs in the ranking rather than set aside.
const ALSO_OK = { MX: ['USD'] };

// Ranked? A price counts if it is in the region's own currency or one of that
// region's accepted alternatives.
function isAccepted(rk, cur) {
  return cur === EXPECT[rk] || (ALSO_OK[rk] || []).includes(cur);
}

// Worth labelling in the UI, so a USD row is not mistaken for a peso one.
function isForeign(rk, cur) {
  return cur != null && cur !== EXPECT[rk];
}

// catalog.json (if present) maps game names to concept IDs, so a title can be
// resolved exactly instead of by scraping the store's search results and hoping
// the first hit is the right one. Absent file = fall back to live search.
let CATALOG = null;
function loadCatalog(file) {
  try {
    const rows = JSON.parse(fs.readFileSync(file || path.join(__dirname, 'catalog.json'), 'utf8'));
    const m = new Map();
    const names = new Map();                          // conceptId -> catalogue name
    for (const r of rows) {
      if (!r || !r.name || !r.conceptId) continue;
      const k = keyName(r.name);
      if (!m.has(k)) m.set(k, String(r.conceptId));   // first wins: rows are name-sorted
      names.set(String(r.conceptId), r.name);
    }
    m.names = names;
    return m.size ? m : null;
  } catch (e) { return null; }
}

const cache = new Map();               // title(lower) -> { ts, data }
const inflight = new Map();            // title(lower) -> Promise (dedupe concurrent lookups)
const TTL = 10 * 60 * 1000;            // 10 minutes
const MAX_CACHE = 200;                 // bound memory on the free tier
const CONCURRENCY = 6;                 // parallel store requests (avoids rate-limiting)
const TIMEOUT = 12000;                 // per-request timeout, ms

// Run fn over items with at most n in flight at once. Results keep input order.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// 'es-mx' -> 'es-MX,es;q=0.9'. Asking each storefront in its own language makes
// it less likely to fall back to a generic (usually US/English) response.
function acceptLang(loc) {
  const p = ('' + loc).split('-');
  if (p.length !== 2) return 'en-US,en;q=0.9';
  return p[0] + '-' + p[1].toUpperCase() + ',' + p[0] + ';q=0.9';
}

// Fetch with timeout + bounded retries. Retries only transient failures
// (network error, 429, 5xx); a 404 means "not in this store", so return null fast.
async function getText(url, tries = 2, lang = 'en-US,en;q=0.9') {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': lang },
        signal: AbortSignal.timeout(TIMEOUT)
      });
      if (r.status === 404 || r.status === 410) return null;
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) return null;
      return await r.text();
    } catch (e) {
      if (i === tries - 1) return null;
      await new Promise(res => setTimeout(res, 400 * (i + 1)));   // small backoff
    }
  }
  return null;
}

function parseNum(raw) {
  raw = ('' + raw).replace(/[^\d.,\s]/g, '').replace(/\s/g, '');
  if (!raw) return null;
  const d = raw.indexOf('.') >= 0, c = raw.indexOf(',') >= 0;
  if (d && c) {
    raw = raw.lastIndexOf('.') > raw.lastIndexOf(',')
      ? raw.replace(/,/g, '')
      : raw.replace(/\./g, '').replace(',', '.');
  } else if (c) {
    const p = raw.split(',');
    raw = (p.length === 2 && p[1].length <= 2) ? p[0] + '.' + p[1] : raw.replace(/,/g, '');
  } else if (d) {
    const p = raw.split('.');
    if (!(p.length === 2 && p[1].length <= 2)) raw = raw.replace(/\./g, '');
  }
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

// Every embedded price object on the page, not just the first. A concept page
// lists each edition, so taking the first meant the store's display order chose
// the price -- which is how a Deluxe Edition price ended up shown for the base
// game. Keys sit together in one small flat object, so read a window around
// each "basePrice" rather than trying to brace-match JSON.
function priceBlocks(h) {
  const at = [], clsAt = [];
  let m;
  const re = /"basePrice"/g;
  while ((m = re.exec(h)) && at.length < 40) at.push(m.index);
  const cre = /"storeDisplayClassification"/g;
  while ((m = cre.exec(h))) clsAt.push(m.index);

  return at.map((start, i) => {
    // Each entry runs from its own "basePrice" up to whichever comes first: the
    // next price or the next classification. A classification leads an entry,
    // so without that second bound the window swallows the following entry's
    // label and every price ends up wearing its neighbour's classification.
    const nextCls = clsAt.find(x => x > start);
    const end = Math.min(
      i + 1 < at.length ? at[i + 1] : h.length,
      nextCls == null ? h.length : nextCls,
      start + 800);
    const w = h.slice(start, end);

    // Fields written before "basePrice" belong to this entry only if they are
    // the nearest ones; a backward window reaches into the previous entry, so
    // take the LAST match rather than the first.
    const before = h.slice(i > 0 ? at[i - 1] : Math.max(0, start - 400), start);
    const pick = r => (w.match(r) || [])[1];
    const pickBack = r => {
      const all = [...before.matchAll(new RegExp(r.source, 'g'))];
      return all.length ? all[all.length - 1][1] : undefined;
    };
    return {
      at: start,
      base: pick(/"basePrice":"([^"]*)"/),
      disc: pick(/"discountedPrice":"([^"]*)"/),
      cur:  pick(/"currencyCode":"([A-Z]{3})"/) || pickBack(/"currencyCode":"([A-Z]{3})"/),
      text: pick(/"discountText":"([^"]*)"/),
      // What the store calls this entry. A concept page lists add-ons beside
      // the game, and an add-on is always cheaper, so without this the cheapest
      // entry on the page is a piece of DLC rather than the game.
      cls:  pickBack(/"storeDisplayClassification":"([A-Z_]+)"/) ||
            pick(/"storeDisplayClassification":"([A-Z_]+)"/) || null,
      name: pick(/"name":"([^"]{0,120})"/) || null
    };
  });
}

// Entries the store classifies as something other than a playable game --
// add-ons, currency packs, season passes. Anything not on this list is treated
// as a game, so an unfamiliar classification is included rather than dropped.
// Classifications seen so far: FULL_GAME, PREMIUM_EDITION and GAME_BUNDLE for
// the game and its editions; VIRTUAL_CURRENCY, ITEM and ADD_ON_PACK for the
// add-ons. Matched as substrings rather than exact values, because the list has
// been surprised three times now -- ITEM, then ADD_ON_PACK, which an anchored
// ^ADD_ON$ silently let through as a game. A variant like ADDON_ITEM_PACK is
// caught by any of these fragments; the game classifications contain none.
const NOT_A_GAME = /(ADD_?ON|CURRENCY|ITEM|SUBSCRIPTION|SEASON[_ ]?PASS|DLC|COSMETIC|BOOST|GAME_RELATED)/;
const isGame = b => !b.cls || !NOT_A_GAME.test(b.cls);

// Where the add-on carousel begins, as a character offset.
//
// Labels cannot be matched to prices by proximity: on a real page FULL_GAME sat
// 14,000 characters from the price it belongs to, and PREMIUM_EDITION came
// *after* its price. The carousel is different -- each add-on's label sits ~250
// characters before its price -- and, crucially, every game price appears
// before the first add-on label and every add-on price after it. So the split
// is positional, and needs no per-entry attribution at all.
function carouselStart(h) {
  const re = /"storeDisplayClassification":"([A-Z_]+)"/g;
  let m;
  while ((m = re.exec(h))) if (NOT_A_GAME.test(m[1])) return m.index;
  return -1;
}

// Of several editions, the cheapest to actually pay is the one worth showing --
// a discounted Deluxe can beat a full-price Standard. Zero-priced entries are
// skipped when anything paid exists, so a free demo or trial listed alongside
// the game does not win, unless the game really is free.
function cheapest(cands) {
  const usable = cands.filter(c => c.price != null);
  if (!usable.length) return null;
  const paid = usable.filter(c => c.price > 0);
  return (paid.length ? paid : usable).reduce((a, b) => (b.price < a.price ? b : a));
}

// Returns the price a shopper actually pays today for the cheapest edition.
// When that edition is discounted, `price` is the sale price and `original` is
// what it was struck through from.
function grab(h) {
  const ld = [], name0 = [];
  let m;
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  while ((m = re.exec(h))) {
    try {
      for (const o of [].concat(JSON.parse(m[1]))) {
        if (o && o.name) name0.push(o.name);
        for (const f of (o && o.offers ? [].concat(o.offers) : [])) {
          if (f && f.price != null) {
            ld.push({ price: parseNum(f.price), cur: f.priceCurrency || null, original: null, discount: null });
          }
        }
      }
    } catch (e) {}
  }

  const raw = priceBlocks(h);
  const classified = /"storeDisplayClassification"/.test(h);

  // Everything from the first add-on label onwards is the carousel. This also
  // discards add-on classifications not yet in NOT_A_GAME, which matters
  // because that list only ever grows by being surprised.
  const cut = carouselStart(h);
  const upTo = cut >= 0 ? raw.filter(b => b.at < cut) : raw;

  // Without classifications an add-on cannot be told from an edition, so fall
  // back to the page's own primary entry rather than letting a cheap add-on win.
  let usable = classified ? upTo.filter(isGame) : raw.slice(0, 1);
  if (!usable.length) usable = raw.filter(isGame);

  const blocks = usable.map(b => {
    const base = parseNum(b.base), disc = parseNum(b.disc);
    return (disc != null && (base == null || disc < base))
      ? { price: disc, original: base, cur: b.cur || null, discount: b.text || null, name: b.name, cls: b.cls }
      : { price: base, original: null, cur: b.cur || null, discount: null, name: b.name, cls: b.cls };
  });

  // JSON-LD describes the product and its editions; the embedded blocks can
  // also cover add-ons, which would undercut the game itself. So prefer JSON-LD
  // when it carries prices, and fall back to the blocks otherwise.
  const fromLd = cheapest(ld);
  const source = fromLd ? ld : blocks;
  let pick = fromLd || cheapest(blocks);
  if (!pick) return { price: null, cur: null, name: name0[0] || null, original: null, discount: null, editions: 0 };

  // A JSON-LD offer carries no strikethrough. Tie it back to a block only when
  // the block is demonstrably the same edition: it quotes the same discounted
  // price, or the page has a single edition so there is nothing to confuse it
  // with. Never borrow a higher edition's base price as this one's original.
  if (pick.original == null) {
    const same = blocks.find(b => b.price === pick.price && b.original != null && b.original > b.price);
    if (same) {
      pick = { ...pick, original: same.original, discount: same.discount };
    } else if (blocks.length === 1 && blocks[0].price > pick.price) {
      pick = { ...pick, original: blocks[0].price, discount: blocks[0].discount };
    }
  }

  // An unrecognised add-on label fails open: it counts as a game, and being
  // cheap it wins. That has happened three times (ITEM, ADD_ON_PACK). Rather
  // than pretend the list is now complete, flag a price that sits far below the
  // rest -- an add-on is a fraction of a game, whereas editions cluster within
  // roughly 2x of each other. The price is still reported; it is just marked, so
  // a bad capture shows up instead of passing silently.
  const others = source.filter(c => c.price != null && c.price > 0 && c !== pick).map(c => c.price).sort((a, b) => a - b);
  const median = others.length ? others[Math.floor(others.length / 2)] : null;
  const suspect = !!(median && pick.price > 0 && pick.price < median * 0.4);

  const cur = pick.cur || (ld.find(c => c.cur) || {}).cur || (blocks.find(c => c.cur) || {}).cur || null;
  let discount = pick.discount;
  if (pick.original != null && pick.price > 0 && !discount) {
    discount = '-' + Math.round((1 - pick.price / pick.original) * 100) + '%';
  }
  // Every game entry, cheapest first, so the other editions can be shown too.
  // Names are deliberately omitted: on a real page a label can sit 14,000
  // characters from its price, so calling one of these "Deluxe" would be a
  // guess. The prices themselves are reliable; which edition each one is, is not.
  const editions = source
    .filter(c => c.price != null)
    .sort((a, b) => a.price - b.price)
    .filter((c, i, arr) => i === 0 || c.price !== arr[i - 1].price)
    .map(c => ({
      price: c.price,
      original: c.original != null && c.original > c.price ? c.original : null,
      discount: c.original != null && c.original > c.price
        ? (c.discount || '-' + Math.round((1 - c.price / c.original) * 100) + '%') : null
    }));

  return {
    price: pick.price, cur, name: name0[0] || null,
    original: pick.original != null && pick.original > pick.price ? pick.original : null,
    discount: pick.original != null && pick.original > pick.price ? discount : null,
    editions,                                        // all game entries, cheapest first
    onPage: raw.length,                              // every priced entry, add-ons included
    suspect                                          // far below the other entries: likely an add-on
  };
}

// Page text, one line per element boundary. The store renders the language
// spec as a label element followed by a value element, so flattening to lines
// lets the same reader handle "Voice: a, b" and "<dt>Voice</dt><dd>a, b</dd>".
function textLines(h) {
  return h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
          .replace(/<[^>]+>/g, '\n')
          .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
          .split('\n').map(s => s.trim()).filter(Boolean);
}

// Each storefront renders this spec in its own language: the Brazilian store
// says "Voz" / "Idiomas da tela" and lists "Inglês", not "English". Matching
// only the English wording would report "unknown" for 9 of the 20 regions.

// Strip accents so "Inglês", "Inglés" and Turkish "İngilizce" all reduce to
// plain ASCII and can be matched with one pattern. Recompose afterwards: NFD
// splits Hangul syllables into Jamo, so "화면 언어" would otherwise stop
// matching its own composed form.
// Some letters are not accented forms and so survive NFD untouched — Polish ł
// is its own letter, which is why "Głos" never matched a plain "glos" pattern.
const LETTERS = { 'ł':'l', 'ø':'o', 'đ':'d', 'ð':'d', 'þ':'th', 'ß':'ss', 'æ':'ae', 'œ':'oe', 'ı':'i' };
const norm = s => ('' + s).normalize('NFD').replace(/[̀-ͯ]/g, '')
                          .normalize('NFC').toLowerCase()
                          .replace(/[łøđðþßæœı]/g, c => LETTERS[c]).trim();

// Loose key for matching a typed title against a catalogue name: accent-free,
// punctuation-free, single-spaced. "Marvel's Spider-Man 2" -> "marvels spider man 2".
// Apostrophes are removed rather than turned into spaces, so a typed
// "Marvels Spider-Man" matches the catalogue's "Marvel's Spider-Man".
const keyName = s => norm(s).replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// "English" as each storefront writes it. `angl` covers anglais/angielski/
// anglictina, `англ` covers Англійська/Английский.
const ENGLISH_NAME = /^(english|ingles|inglese|anglais|englisch|angielski|ingilizce|engels|engelsk|angl|англ|英語|英文|영어|อังกฤษ|bahasa ingg?eris|bahasa inggris)/;

// Labels are matched against normalized text, so these are written accent-free.
const VOICE_LABELS = ['voice', 'voz', 'audio', 'ses', 'sprachausgabe', 'dzwiek', 'glos',
  'озвучення', 'голос', '音声', '語音', '语音', '음성', 'suara', 'เสียง'];
const SCREEN_LABELS = ['screen languages?', 'idiomas? da tela', 'idiomas? (?:de|en) pantalla',
  'ekran dilleri?', 'bildschirmsprachen?', 'wyswietlane jezyki', 'jezyki? ekranow[eiy]',
  'мов[аи] екрана', '画面表示言語', '螢幕語言', '屏幕语言', '화면 언어', 'bahasa layar',
  'ภาษาบนหน้าจอ'];

// Names of the languages these stores actually list, across the languages they
// list them in. Used only to confirm that a value really is a language list —
// so a spec row like "PS5" or "Acción" can never be read as "no English".
const LANG_STEMS = new RegExp('(' + [
  'english','ingl','angl','англ','英','영어',
  'japan','japon','giappon','日本','일본',
  'german','alem','allem','deutsch','niemieck','німец','ドイツ','독일','德',
  'french','franc','franz','francuski','フランス','프랑스','法',
  'spanish','espan','hiszpa','spanisch','スペイン','스페인','西班牙',
  'italian','italia','ital','wlos','イタリア','이탈리아','意大利',
  'portug','ポルトガル','포르투갈','葡萄牙',
  'korean','corean','korean','한국','韓','조선',
  'chinese','chin','chino','中文','中國','中国','繁體','简体','중국',
  'russian','rus','росій','русск','ロシア','러시아','俄',
  'polish','polski','polaco','polonais','ポーランド','폴란드',
  'turkish','turk','turec','トルコ','터키',
  'arabic','arab','アラビア','아랍','阿拉伯',
  'thai','タイ','태국','ไทย',
  'dutch','nederlands','holand','オランダ','네덜란드',
  'danish','dansk','danes','デンマーク',
  'finnish','suomi','finn','フィンランド',
  'swedish','svensk','sueco','szwedzki','スウェーデン',
  'norwegian','norsk','noruego','norwesk','ノルウェー',
  'greek','grieg','greck','grec','ギリシャ','그리스',
  'czech','cesk','checo','チェコ',
  'hungarian','magyar','hungar','wegier','ハンガリー',
  'croatian','hrvatski','croata','chorwacki'
].join('|') + ')');

// A value is only trusted as a language list if at least one entry names a
// language. This is what keeps "Voz:" followed by an unrelated cell from being
// reported as "no English" rather than simply unknown.
const looksLikeLanguages = parts => !!parts && parts.some(p => LANG_STEMS.test(norm(p)));

// Anything that reads like a language label, for wording not in the lists above.
const ANY_LANG_LABEL = /(language|idioma|lingua|langue|sprache|j[eę]zyk|jezyk|мов|dil|言語|語言|언어|ภาษา|bahasa)/;

// A value line is a language list, not prose: comma-separated shortish names.
function asList(v) {
  if (!v || v.length > 400 || /[.!?]$/.test(v)) return null;
  const parts = v.split(/[,、，]\s*/).map(s => s.trim()).filter(Boolean);
  if (!parts.length || parts.some(p => p.length > 40)) return null;
  return parts;
}

// The label must stand alone on its line or precede a colon — never merely be a
// prefix, so "Voice Chat Supported" cannot be read as the voice language list.
function labelledList(lines, labels) {
  const alone = new RegExp('^(' + labels.join('|') + ')\\s*:?$');
  const inline = new RegExp('^(' + labels.join('|') + ')\\s*:\\s*(.+)$');
  for (let i = 0; i < lines.length; i++) {
    const n = norm(lines[i]);
    let v = null;
    // Take the value from the original line after its colon; slicing by the
    // normalized length would drift whenever normalization changes it.
    if (inline.test(n)) v = lines[i].slice(lines[i].indexOf(':') + 1).trim();
    else if (alone.test(n)) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (!/:$/.test(lines[j])) { v = lines[j]; break; }   // skip a following label
      }
    }
    const list = asList(v);
    // Keep looking if what followed the label was not a language list — the
    // label may appear more than once, or its value may sit elsewhere.
    if (looksLikeLanguages(list)) return list;
  }
  return null;
}

// Last resort: a label we do not have wording for, but which clearly names a
// language field, followed by something that parses as a language list.
function anyLangList(lines) {
  for (let i = 0; i < lines.length; i++) {
    const n = norm(lines[i]);
    if (n.length > 40 || !ANY_LANG_LABEL.test(n)) continue;
    const inline = n.includes(':') ? lines[i].slice(lines[i].indexOf(':') + 1) : null;
    let list = asList(inline);
    if (!list) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        if (/:$/.test(lines[j])) continue;
        list = asList(lines[j]);
        if (list) break;
      }
    }
    if (list && list.some(s => ENGLISH_NAME.test(norm(s)))) return { list, label: lines[i] };
  }
  return null;
}

// Screen languages cover subtitles and UI, which is what makes a foreign-region
// copy playable; voice is a bonus. `english` is null when the page says nothing
// — that is "unknown", and must not be shown as "no English".
function languages(h) {
  const lines = textLines(h);
  const screen = labelledList(lines, SCREEN_LABELS);
  const voice = labelledList(lines, VOICE_LABELS);
  const has = a => a ? a.some(s => ENGLISH_NAME.test(norm(s))) : null;
  const s = has(screen), v = has(voice);

  let english = s != null ? s : v;
  let source = screen ? 'screen' : (voice ? 'voice' : null);
  if (english == null) {
    const g = anyLangList(lines);
    if (g) { english = true; source = 'label:' + g.label; }
  }
  return { screen, voice, english, source };
}

// All product IDs on a page, in document order, deduped.
function productIds(h) {
  const out = [], seen = new Set(), re = /\/product\/([A-Z0-9][\w-]{6,})/gi;
  let m;
  while ((m = re.exec(h))) {
    const id = m[1];
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

// Concept IDs, in document order, deduped. Read from both the embedded JSON
// key and any /concept/<id> link on the page — search results often link
// straight to the concept even when the JSON key is absent or renamed.
function conceptIds(h) {
  const out = [], seen = new Set();
  for (const re of [/"conceptId":"?(\d+)"?/g, /\/concept\/(\d+)/g]) {
    let m;
    while ((m = re.exec(h))) {
      if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    }
  }
  return out;
}

function conceptId(h) {
  return conceptIds(h)[0] || null;
}

// Accept a pasted store URL or a bare concept ID instead of a title, so a
// known-good concept (e.g. .../en-in/concept/10014719) skips search entirely.
function parseQuery(q) {
  const s = ('' + q).trim();
  const cm = s.match(/\/concept\/(\d+)/);
  if (cm) return { conceptId: cm[1], productId: null, title: null };
  const pm = s.match(/\/product\/([A-Z0-9][\w-]{6,})/i);
  if (pm) return { conceptId: null, productId: pm[1], title: null };
  if (/^\d{5,}$/.test(s)) return { conceptId: s, productId: null, title: null };
  return { conceptId: null, productId: null, title: s };
}

// A page only counts as a hit if it actually carries a price.
async function priceAt(path, lang) {
  const h = await getText(BASE + path, 2, lang);
  if (!h) return null;
  const r = grab(h);
  if (r.price == null) return null;
  const L = languages(h);
  return { ...r, english: L.english, screenLanguages: L.screen, voiceLanguages: L.voice };
}

// Concept pages are the hub for a title and often carry no language spec, so a
// concept-tier win may know the price but not the languages. One product-page
// read fills that in; if the shared ID is not sold in this region, we simply
// leave `english` unknown rather than guessing.
async function withLangs(r, loc, lang, pid) {
  if (r.english != null || !pid) return r;
  const h = await getText(BASE + '/' + loc + '/product/' + pid, 1, lang);
  if (!h) return r;
  const L = languages(h);
  return L.english == null ? r : { ...r, english: L.english, screenLanguages: L.screen, voiceLanguages: L.voice };
}

// 3-tier resolve for one region, cheapest-and-most-reliable first:
//   1. the conceptId — global, so the same ID works in every storefront
//   2. the productId found via the global (en-us) search — often region-specific
//   3. that region's own store search, to find its local SKU
// Product IDs vary per region on region-locked titles (Beast of Reincarnation
// is ...PPSA29343... in the US but ...PPSA29344... in India), which is why the
// concept goes first and per-region search is the last resort.
async function region(pid, cid, loc, title) {
  const lang = acceptLang(loc);
  if (cid) {
    const p = '/' + loc + '/concept/' + cid;
    const r = await priceAt(p, lang);
    if (r) return { ...(await withLangs(r, loc, lang, pid)), via: 'concept', productId: null, url: BASE + p };
  }
  if (pid) {
    const p = '/' + loc + '/product/' + pid;
    const r = await priceAt(p, lang);
    if (r) return { ...r, via: 'product', productId: pid, url: BASE + p };
  }
  if (title) {
    const h = await getText(BASE + '/' + loc + '/search/' + encodeURIComponent(title), 2, lang);
    if (h) {
      for (const lid of productIds(h).slice(0, 3)) {
        if (lid === pid) continue;                      // already tried in tier 2
        const p = '/' + loc + '/product/' + lid;
        const r = await priceAt(p, lang);
        if (r) return { ...r, via: 'search', productId: lid, url: BASE + p };
      }
    }
  }
  return { price: null, cur: null, name: null, original: null, discount: null, english: null,
           screenLanguages: null, voiceLanguages: null, editions: [], via: null, productId: null, url: null };
}

async function lookup(query) {
  const started = Date.now();
  const q = parseQuery(query);
  let pid = q.productId, cid = q.conceptId, title = q.title;

  let resolvedBy = q.conceptId ? 'conceptId' : (q.productId ? 'productId' : null);

  // Exact catalogue hit: no search request at all.
  if (!pid && !cid && title && CATALOG) {
    const hit = CATALOG.get(keyName(title));
    if (hit) { cid = hit; resolvedBy = 'catalog'; }
  }

  if (!pid && !cid) {
    resolvedBy = 'search';
    // title -> conceptId / productId via the global store search
    const html = await getText(BASE + '/en-us/search/' + encodeURIComponent(title), 3);
    const candidates = html ? productIds(html) : [];
    pid = candidates[0] || null;
    cid = html ? conceptId(html) : null;

    // A concept ID resolves every region at once, so it is worth a couple of
    // extra page loads to find one.
    for (const c of candidates.slice(0, 2)) {
      if (cid) break;
      const p = await getText(BASE + '/en-us/product/' + c);
      if (p) cid = conceptId(p);
    }
  } else if (pid && !cid) {
    const p = await getText(BASE + '/en-us/product/' + pid);
    if (p) cid = conceptId(p);
  }

  // With no productId AND no conceptId there is nothing to resolve against,
  // and per-region search alone is too loose to trust.
  if (!pid && !cid) return { error: 'No match for "' + query + '"' };

  // Given a bare URL/ID we have no title yet; recover one from the concept
  // page so the per-region search tier still has something to search for.
  if (!title && cid) {
    const p = await getText(BASE + '/en-us/concept/' + cid);
    if (p) title = grab(p).name || null;
  }

  const keys = Object.keys(LOCALES);
  const found = await pool(keys, CONCURRENCY, rk => region(pid, cid, LOCALES[rk], title));

  let gameName = null;
  const results = keys.map((rk, i) => {
    const r = found[i];
    if (r.name && !gameName) gameName = r.name;
    return {
      region: rk,
      currency: r.cur,
      price: r.price,
      original: r.original || null,   // pre-discount price, when on sale
      discount: r.discount || null,   // e.g. '-50%'
      english: r.english == null ? null : r.english,   // true / false / null = unknown
      screenLanguages: r.screenLanguages || null,
      voiceLanguages: r.voiceLanguages || null,
      redirected: r.cur != null && !isAccepted(rk, r.cur),   // excluded from ranking
      foreign: isForeign(rk, r.cur),                         // ranked, but not the local currency
      editions: r.editions || [],    // every edition of the game, cheapest first
      suspect: !!r.suspect,          // price far below the page's other entries
      via: r.via,                    // 'concept' | 'product' | 'search' | null
      productId: r.productId,
      url: r.url || null             // the exact store page this price came from
    };
  });

  // The page's own name can be an edition ("... Deluxe Edition"); the catalogue
  // knows the concept's name, which is what was actually asked for.
  const catName = cid && CATALOG && CATALOG.names && CATALOG.names.get(String(cid));

  return {
    title: catName || gameName || title || query,
    productId: pid,
    conceptId: cid || null,
    resolvedBy,                    // 'catalog' | 'search' | 'conceptId' | 'productId'
    priced: results.filter(r => r.price != null).length,
    total: results.length,
    elapsedMs: Date.now() - started,
    results
  };
}

// Cached + de-duplicated wrapper: two users searching the same title while a
// lookup is in flight share one set of store requests.
function lookupCached(title) {
  const key = title.toLowerCase().trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return Promise.resolve({ ...hit.data, cached: true });
  if (inflight.has(key)) return inflight.get(key);

  const p = lookup(title)
    .then(data => {
      if (!data.error && data.priced > 0) {
        cache.set(key, { ts: Date.now(), data });
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      }
      return data;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const url = new URL(req.url, 'http://localhost');

  // Cheap endpoint the frontend pings on page load to wake the free-tier dyno.
  if (url.pathname === '/health') return json(res, 200, {
    ok: true, uptime: Math.round(process.uptime()),
    catalog: CATALOG ? CATALOG.size : 0
  });

  if (url.pathname === '/prices') {
    const title = (url.searchParams.get('title') || '').trim();
    if (!title) return json(res, 400, { error: 'Missing ?title=' });
    if (title.length > 120) return json(res, 400, { error: 'Title too long' });
    try {
      json(res, 200, await lookupCached(title));
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  res.setHeader('Content-Type', 'text/plain');
  res.end('PS-SGD backend is running. Try /prices?title=007%20First%20Light');
});

if (require.main === module) {
  CATALOG = loadCatalog();
  console.log(CATALOG ? 'catalogue: ' + CATALOG.size + ' games' : 'catalogue: none (falling back to store search)');
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('PS-SGD backend on :' + PORT));
}

module.exports = {
  parseNum, grab, region, lookup, pool, productIds, conceptId, conceptIds,
  parseQuery, acceptLang, getText, priceAt, isAccepted, isForeign, languages, textLines,
  keyName, loadCatalog, setCatalog: m => { CATALOG = m; }, priceBlocks, cheapest,
  LOCALES, EXPECT, ALSO_OK, BASE
};
