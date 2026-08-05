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
      name: pick(/"name":"([^"]{0,120})"/) || null,
      // Two markers that say "this is not a purchase of the game". Both sit in
      // the entry's own window on a real page: displayUpsellText just after the
      // price, upSellService just before it. Read as present/absent rather than
      // by value, so they work on every storefront -- the text is localized
      // ("Trial", "Essai", ...) but null is null everywhere.
      upsell:  pick(/"displayUpsellText":"([^"]+)"/) || null,
      service: pickBack(/"upSellService":"([A-Z_]+)"/) ||
               pick(/"upSellService":"([A-Z_]+)"/) || null
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

// Not everything priced on a game's own page is a way to buy that game. The
// Ghost of Tsushima DIRECTOR'S CUT page carries five entries classified
// FULL_GAME or GAME_BUNDLE: the PS4 edition at $59.99, the PS5 edition at
// $69.99, two trial entries at $19.99, and a "Included with PS Plus" upsell.
// The trials are the cheapest, so they won, and no classification separates
// them -- the store labels a trial FULL_GAME exactly like the real thing.
//
// What does separate them is the offer itself. A real edition is an outright
// purchase: upSellService "NONE" and no displayUpsellText. A trial carries
// displayUpsellText ("Trial"); a subscription entry carries upSellService
// "PS_PLUS" and prices itself "Included". Presence is what is tested, never the
// wording, so this holds on storefronts that localize the label.
const isPurchase = b => !b.upsell && (!b.service || b.service === 'NONE');

// A priced entry that carries none of the offer machinery is not an offer. The
// Japanese page for the same game ends with two entries 90,000 characters after
// the real ones -- a bare price, classification OTHER, and no discountedPrice,
// upSellService or upsell text at all, where every genuine entry has them. That
// stray ¥2,200 outsold the ¥7,590 edition. Requiring discountedPrice is
// structural rather than a vocabulary check: OTHER is too vague to blanket-
// exclude, and the classification list has already surprised us four times.
const isOffer = b => b.disc != null;

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

  // Then drop trials and subscription upsells, which are priced like editions
  // but are not one. Only ever narrows: a page whose every entry looks like an
  // upsell keeps them all rather than reporting no price at all.
  const bought = usable.filter(b => isPurchase(b) && isOffer(b));
  if (bought.length) usable = bought;

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

// Release date, from the same page the price and languages come from.
//
// Concept pages carry an ISO timestamp -- "releaseDate":"2025-10-02T04:00:00Z"
// -- so the normal path is unambiguous and the storefront's date format never
// enters into it. The spec table is a fallback for pages that lack the field,
// and its numeric dates ARE ambiguous: "4/8/2026" is April 8 on the US store
// and 4 August on the Brazilian one. There the locale decides the order, and a
// date that cannot be read either way is left null rather than guessed -- a
// wrong release date is worse than a missing one.
const DATE_LABELS = ['release date', 'lancamento', 'lanzamiento', 'premiera', 'erscheinungsdatum',
  'cikis tarihi', 'дата виходу', 'дата выхода', '発売日', '発売予定日', '출시일', '上市日期', '發售日', '发售日'];

// The ISO field on its own. Split out because the catalogue backfill streams a
// page and stops reading the moment this matches, so both must look for exactly
// the same thing -- the longest of these patterns is ~40 characters, which sets
// the overlap the streaming reader keeps between chunks.
const ISO_DATE = /"release(?:Date|DateTime)"\s*:\s*"(\d{4}-\d{2}-\d{2})/;
const isoReleaseDate = h => (h.match(ISO_DATE) || [])[1] || null;

function releaseDate(h, loc = 'en-us') {
  // 1. an ISO timestamp in the embedded state
  const iso = isoReleaseDate(h);
  if (iso) return iso;

  // 2. the spec table, read like the language rows
  const lines = textLines(h);
  const alone = new RegExp('^(' + DATE_LABELS.join('|') + ')\\s*:?$', 'i');
  const inline = new RegExp('^(' + DATE_LABELS.join('|') + ')\\s*:\\s*(.+)$', 'i');
  for (let i = 0; i < lines.length; i++) {
    const n = norm(lines[i]);
    let v = null;
    if (inline.test(n)) v = lines[i].slice(lines[i].indexOf(':') + 1).trim();
    else if (alone.test(n)) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (!/:$/.test(lines[j])) { v = lines[j].trim(); break; }
      }
    }
    if (!v) continue;
    const d = parseDate(v, loc);
    if (d) return d;
  }
  return null;
}

function parseDate(v, loc) {
  const m = v.match(/(\d{1,4})\s*[\/.\-年]\s*(\d{1,2})\s*[\/.\-月]\s*(\d{1,4})/);
  if (!m) return null;
  let [, a, b, c] = m.map(Number);
  let y, mo, da;
  if (a > 31) { y = a; mo = b; da = c; }                       // 2026-08-04 or 2026/8/4
  else if (c > 31) {
    y = c;
    // "4/8/2026" is April 8 on a US storefront and 4 August elsewhere. When one
    // of the numbers exceeds 12 the order is decided for us.
    if (a > 12) { da = a; mo = b; }
    else if (b > 12) { mo = a; da = b; }
    else if (/^en-us$/i.test(loc)) { mo = a; da = b; }
    else { da = a; mo = b; }
  } else return null;
  if (!(y > 1990 && y < 2100 && mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0');
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
// Which concept the page is actually about.
//
// Taking the first ID in the document is wrong, and quietly so: a search page
// leads with a promoted tile and a product page carries a recommendation strip,
// so the first /concept/ link belongs to some other game. A lookup for Ghost of
// Tsushima resolved that way to 10015299 -- Tyrion Cuthbert: Attorney of the
// Arcane -- and then priced that game in every region resolved concept-first.
//
// The page's own concept is referenced many times over (canonical URL, embedded
// state, telemetry); a neighbour's appears once or twice. So rank by how often
// each ID occurs rather than by where the first one sits.
function conceptIdsRanked(h) {
  const n = new Map();
  for (const re of [/"conceptId":"?(\d+)"?/g, /\/concept\/(\d+)/g]) {
    let m;
    while ((m = re.exec(h))) n.set(m[1], (n.get(m[1]) || 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
}

// Frequency is a good guess, not a guarantee, so the winner is checked against
// what was searched for: the concept page has to name the same game. Titles are
// compared by keyName, and containment counts either way -- "Ghost of Tsushima"
// and "Ghost of Tsushima DIRECTOR'S CUT" are the same game, "Tyrion Cuthbert"
// is not. Without a title there is nothing to check against, so the ranking
// stands on its own.
function sameGame(a, b) {
  const x = keyName(a || ''), y = keyName(b || '');
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

// The catalogue holds concepts, so it lists "Ghost of Tsushima" -- while the
// store's own title for the same game is "Ghost of Tsushima DIRECTOR'S CUT".
// An exact key miss then fell through to a live store search, which is both
// slow and the path that mis-resolved. A catalogue name that is a prefix of
// what was typed is the same game with an edition suffix, so take the longest
// such name. Only this direction is safe: typing more than the catalogue knows
// narrows, whereas typing less ("Horizon") would be a guess between games.
const PREFIX_MIN = 8;                    // shorter keys match far too much
function catalogPrefix(title) {
  const k = keyName(title);
  if (!CATALOG || k.length < PREFIX_MIN) return null;
  let best = null;
  for (const name of CATALOG.keys()) {
    if (name.length >= PREFIX_MIN && k.startsWith(name + ' ') &&
        (!best || name.length > best.length)) best = name;
  }
  return best ? CATALOG.get(best) : null;
}

async function resolveConcept(h, title, get) {
  const ranked = conceptIdsRanked(h);
  if (!ranked.length) return null;
  if (!title) return ranked[0];
  for (const cid of ranked.slice(0, 3)) {
    const page = await get(BASE + '/en-us/concept/' + cid);
    if (page && sameGame(grab(page).name, title)) return cid;
  }
  // Nothing verified: better no concept at all than a confident wrong one. The
  // product tier still prices the regions that carry the same SKU.
  return null;
}

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

// The store's own page does not parse HTML to price itself: it calls this
// persisted GraphQL query, which returns editions and offers as typed JSON.
// Everything the HTML path has to infer -- which price belongs to which entry,
// whether an entry is a trial, whether it is an offer at all -- is a field here.
//
// Two reasons this cannot be the only path. The sha256Hash identifies a
// persisted query and changes whenever the store redeploys its front end, and
// the endpoint answers per storefront rather than per URL: the locale comes
// from a header, so a wrong or missing one silently prices the caller's own
// region. Both failures are recoverable by falling back to the page.
const GQL = process.env.PS_GQL_OP || 'https://web.np.playstation.com/api/graphql/v1/op';
const GQL_OP = 'conceptRetrieveForCtasWithPrice';
const GQL_HASH = process.env.PS_GQL_HASH ||
  '19af6218e77e94bd8ccdf971a4be7e9397e27b63b761aeb0440d918689f585db';

// 'ja-jp' -> 'ja-JP': the header wants the region subtag capitalised, which is
// how the store sends it. Everything else in this file uses our lower-case form.
const storeLocale = loc => {
  const [lang, reg] = ('' + loc).split('-');
  return reg ? lang + '-' + reg.toUpperCase() : lang;
};

// Returns the parsed response, or null for anything that went wrong -- a
// rotated hash, a network failure, a shape we did not expect. Never throws:
// every caller has the HTML page to fall back to.
async function gqlCtas(conceptId, loc) {
  if (!conceptId) return null;
  const url = GQL + '?operationName=' + GQL_OP
    + '&variables=' + encodeURIComponent(JSON.stringify({ conceptId: String(conceptId) }))
    + '&extensions=' + encodeURIComponent(JSON.stringify(
        { persistedQuery: { version: 1, sha256Hash: GQL_HASH } }));
  try {
    const r = await fetch(url, {
      headers: {
        // Apollo rejects a request carrying neither as possible CSRF.
        'apollo-require-preflight': 'true',
        'x-apollo-operation-name': GQL_OP,
        // Without this the endpoint geolocates by caller IP, which is how the
        // catalogue collector once returned the GB storefront from a UK runner.
        'x-psn-store-locale-override': storeLocale(loc),
        'Accept-Language': storeLocale(loc) + ',' + ('' + loc).split('-')[0] + ';q=0.9',
        'User-Agent': UA
      },
      signal: AbortSignal.timeout(12000)
    });
    const j = await r.json().catch(() => null);
    if (!j || j.errors || !j.data) return null;
    return j.data;
  } catch (e) { return null; }
}

// Cross-region reconciliation: the twenty regions are twenty independent reads
// of the same game, so they can check each other without knowing a word of any
// storefront's language.
//
// Absolute prices cannot be compared -- India and Turkey are legitimately a
// fraction of the US -- and converting through FX would only move the problem.
// What does compare is the shape of each region's own edition list: the ratio
// of the chosen price to the most expensive edition on the same page. That
// ratio is FX-free and regional-pricing-free, because both terms come from the
// same storefront in the same currency. Every region should agree on it: the
// standard edition is ~0.86 of the deluxe everywhere. A region that picked up
// something that is not an edition at all lands far below that consensus.
//
// This is what catches a stray entry in a storefront nobody has dumped -- the
// Japanese ¥2,200 sat at 0.25 while every other region agreed on ~0.86.
//
// Two guards keep it from inventing wrong answers:
//   * A discounted pick is never adjusted. A region-only sale is a real reason
//     to sit below consensus, and the strikethrough says so.
//   * A replacement must already exist in that region's own edition list. This
//     only ever re-picks among prices the page actually published.
const MIN_AGREE = 4;      // regions needed before a consensus means anything
const OUTLIER   = 0.6;    // below this share of the consensus ratio, distrust the pick

function ratio(r) {
  const top = r.editions && r.editions.length ? r.editions[r.editions.length - 1].price : null;
  return top > 0 && r.price > 0 ? r.price / top : null;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

function reconcile(results) {
  const rs = results.map(ratio).filter(x => x != null);
  if (rs.length < MIN_AGREE) return results;
  const consensus = median(rs);
  if (!consensus) return results;

  return results.map(r => {
    const own = ratio(r);
    if (own == null || own >= consensus * OUTLIER) return r;
    if (r.original != null) return r;              // a sale explains itself
    const top = r.editions[r.editions.length - 1].price;
    // The published edition whose share of the top price is closest to what
    // every other region agrees on.
    const best = r.editions
      .filter(e => e.price > 0)
      .reduce((a, b) => Math.abs(b.price / top - consensus) < Math.abs(a.price / top - consensus) ? b : a);
    if (best.price === r.price) return r;
    return {
      ...r,
      price: best.price,
      original: best.original || null,
      discount: best.discount || null,
      editions: r.editions.filter(e => e.price >= best.price),
      suspect: false,
      adjusted: true            // re-picked against the other regions, not as read
    };
  });
}

async function lookup(query) {
  const started = Date.now();
  const q = parseQuery(query);
  let pid = q.productId, cid = q.conceptId, title = q.title;

  let resolvedBy = q.conceptId ? 'conceptId' : (q.productId ? 'productId' : null);

  // Exact catalogue hit: no search request at all.
  if (!pid && !cid && title && CATALOG) {
    const hit = CATALOG.get(keyName(title)) || catalogPrefix(title);
    if (hit) { cid = hit; resolvedBy = 'catalog'; }
  }

  if (!pid && !cid) {
    resolvedBy = 'search';
    // title -> conceptId / productId via the global store search
    const html = await getText(BASE + '/en-us/search/' + encodeURIComponent(title), 3);
    const candidates = html ? productIds(html) : [];
    pid = candidates[0] || null;
    cid = html ? await resolveConcept(html, title, getText) : null;

    // A concept ID resolves every region at once, so it is worth a couple of
    // extra page loads to find one.
    for (const c of candidates.slice(0, 2)) {
      if (cid) break;
      const p = await getText(BASE + '/en-us/product/' + c);
      if (p) cid = await resolveConcept(p, title, getText);
    }
  } else if (pid && !cid) {
    const p = await getText(BASE + '/en-us/product/' + pid);
    if (p) cid = await resolveConcept(p, title, getText);
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

  const reconciled = reconcile(results);

  // The page's own name can be an edition ("... Deluxe Edition"); the catalogue
  // knows the concept's name, which is what was actually asked for.
  const catName = cid && CATALOG && CATALOG.names && CATALOG.names.get(String(cid));

  return {
    title: catName || gameName || title || query,
    productId: pid,
    conceptId: cid || null,
    resolvedBy,                    // 'catalog' | 'search' | 'conceptId' | 'productId'
    priced: reconciled.filter(r => r.price != null).length,
    total: results.length,
    elapsedMs: Date.now() - started,
    priceAdjusted: reconciled.filter(r => r.adjusted).length,
    results: reconciled
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
  releaseDate, parseDate, isoReleaseDate, reconcile, gqlCtas, storeLocale,
  conceptIdsRanked, sameGame, resolveConcept, catalogPrefix,
  LOCALES, EXPECT, ALSO_OK, BASE
};
