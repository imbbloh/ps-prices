// Offline unit tests for the price parser + resolver helpers (no network needed).
// Run: node test.js
//
// A fake store on localhost stands in for store.playstation.com, so the 3-tier
// resolver is exercised for real without touching the network.
const PORT = 39217;
process.env.PS_BASE = 'http://localhost:' + PORT;

const { parseNum, grab, pool, productIds, conceptId, conceptIds, parseQuery, acceptLang,
        isAccepted, isForeign, region, languages, keyName, loadCatalog,
        releaseDate, parseDate, reconcile, setCatalog, coverImage } = require('./server.js');
const http = require('http');

let fails = 0;
function check(ok, label, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fails++;
}

const cases = [
  ['Rs 3,999', 3999],      // INR — comma thousands
  ['3.999', 3999],         // dot thousands (the bug we fixed)
  ['¥8,910', 8910],        // JPY
  ['NT$2,090', 2090],      // TWD
  ['R 1,299.00', 1299],    // ZAR — both separators
  ['UAH 2 299,00', 2299],  // space thousands + comma decimal
  ['R$299,90', 299.9],     // BRL comma decimal
  ['$69.99', 69.99],       // USD
  ['RM 304.65', 304.65],   // MYR
  ['₩77,800', 77800],      // KRW
  ['Rp 1.108.890', 1108890], // IDR — dotted thousands
  ['kr 769,00', 769],      // NOK
  ['SGD99.74', 99.74],     // SGD
  ['0', 0],                // free / included title
  ['', null],              // empty string -> null, not NaN
  ['Free', null],          // no digits at all
];

for (const [inp, exp] of cases) {
  const got = parseNum(inp);
  const ok = exp === null ? got === null : (got != null && Math.abs(got - exp) < 0.01);
  check(ok, 'parseNum ' + JSON.stringify(inp).padEnd(16), '-> ' + got + ' (expect ' + exp + ')');
}

// grab() against a store-style JSON-LD block
const sample = '<html><head>' +
  '<script type="application/ld+json">{"@type":"Product","name":"007 First Light","offers":{"@type":"Offer","price":"3,999","priceCurrency":"INR"}}</script>' +
  '</head></html>';
const g = grab(sample);
check(g.price === 3999 && g.cur === 'INR' && g.name === '007 First Light',
  'grab() JSON-LD', '-> ' + JSON.stringify(g));

// grab() falls back to the embedded basePrice blob when JSON-LD carries no offer
const noLd = '<html>{"basePrice":"S$74.90","currencyCode":"SGD"}</html>';
const g2 = grab(noLd);
check(g2.price === 74.9 && g2.cur === 'SGD', 'grab() basePrice fallback', '-> ' + JSON.stringify(g2));

// grab() on a page with no price at all must not invent one
check(grab('<html><body>nothing here</body></html>').price === null, 'grab() no price -> null');

// Sale pricing: a discounted title must report what a shopper pays today,
// keeping the pre-discount figure for the strikethrough.
const onSale = '<html>{"price":{"basePrice":"S$79.90","currencyCode":"SGD",' +
  '"discountText":"-50%","discountedPrice":"S$39.95"}}</html>';
const s1 = grab(onSale);
check(s1.price === 39.95 && s1.original === 79.9 && s1.cur === 'SGD' && s1.discount === '-50%',
  'grab() prefers the sale price', '-> ' + JSON.stringify(s1));

// No discount: discountedPrice mirrors basePrice, so nothing is struck through.
const notOnSale = '<html>{"price":{"basePrice":"S$79.90","currencyCode":"SGD",' +
  '"discountedPrice":"S$79.90"}}</html>';
const s2 = grab(notOnSale);
check(s2.price === 79.9 && s2.original === null && s2.discount === null,
  'grab() no discount -> no original', '-> ' + JSON.stringify(s2));

// The percentage is derived when the store gives no discountText.
const noText = '<html>{"price":{"basePrice":"$59.99","currencyCode":"USD","discountedPrice":"$44.99"}}</html>';
const s3 = grab(noText);
check(s3.price === 44.99 && s3.original === 59.99 && s3.discount === '-25%',
  'grab() derives the discount percent', '-> ' + JSON.stringify(s3));

// JSON-LD already carrying the sale price, with basePrice as the original.
const ldSale = '<html><script type="application/ld+json">' +
  '{"@type":"Product","name":"X","offers":{"price":"39.95","priceCurrency":"SGD"}}</script>' +
  '{"basePrice":"S$79.90","currencyCode":"SGD"}</html>';
const s4 = grab(ldSale);
check(s4.price === 39.95 && s4.original === 79.9 && s4.discount === '-50%',
  'grab() JSON-LD sale price keeps basePrice as original', '-> ' + JSON.stringify(s4));

// A free title must stay 0 rather than being read as "no price".
const free = '<html>{"price":{"basePrice":"Free","currencyCode":"SGD","discountedPrice":"Free"}}</html>';
check(grab(free).price === null, 'grab() unparseable "Free" -> null, not 0');

// Multi-edition concept pages. Searching "LEGO Batman: Legacy of the Dark
// Knight" returned the Deluxe Edition price, because the extractor took the
// first price it found and the store listed Deluxe first. The base game is the
// only price comparable across regions.
const ed = (base, disc, cls) => '{"storeDisplayClassification":"' + cls +
  '","price":{"basePrice":"' + base + '","currencyCode":"USD","discountedPrice":"' + disc + '"}}';
const editions = '<html>' +
  ed('$99.99', '$99.99', 'FULL_GAME') +      // Deluxe, listed first
  ed('$69.99', '$69.99', 'FULL_GAME') +      // Standard
  ed('$129.99', '$129.99', 'FULL_GAME') +    // Ultimate
  '</html>';
const ED = grab(editions);
check(ED.price === 69.99, 'grab() picks the base edition, not the first listed', '-> ' + ED.price);
check(ED.editions.length === 3, 'grab() returns every edition, cheapest first',
  '-> ' + ED.editions.map(e => e.price).join(', '));

// Same, expressed as JSON-LD offers on one product.
const ldEditions = '<html><script type="application/ld+json">' +
  JSON.stringify({ '@type':'Product', name:'LEGO Batman', offers:[
    { price:'99.99', priceCurrency:'USD' }, { price:'69.99', priceCurrency:'USD' }] }) +
  '</script></html>';
const LE = grab(ldEditions);
check(LE.price === 69.99 && LE.cur === 'USD', 'grab() picks the cheapest JSON-LD offer', '-> ' + LE.price);

// A free demo alongside a paid game must not win.
const demo = '<html>' + ed('Free', '$0.00', 'FULL_GAME') + ed('$59.99', '$59.99', 'FULL_GAME') + '</html>';
check(grab(demo).price === 59.99, 'grab() ignores a free demo when a paid edition exists', '-> ' + grab(demo).price);

// ...but a genuinely free game still reports 0.
const reallyFree = '<html>{"price":{"basePrice":"$0.00","currencyCode":"USD","discountedPrice":"$0.00"}}</html>';
check(grab(reallyFree).price === 0, 'grab() keeps 0 for a genuinely free game', '-> ' + grab(reallyFree).price);

// The cheapest edition on sale keeps its own original, not a pricier edition's.
const mixed = '<html>' + ed('$99.99', '$79.99', 'FULL_GAME') + ed('$69.99', '$49.99', 'FULL_GAME') + '</html>';
const MX2 = grab(mixed);
check(MX2.price === 49.99 && MX2.original === 69.99,
  'grab() pairs the sale price with its own original', '-> ' + MX2.price + ' was ' + MX2.original);
check(MX2.discount === '-29%', 'grab() derives the discount from the same edition', '-> ' + MX2.discount);

// Cheapest means cheapest to actually pay, not cheapest list price: a Deluxe
// edition on deep discount can undercut a full-price Standard, and that is the
// price worth buying.
const deluxeOnSale = '<html>' +
  '{"storeDisplayClassification":"FULL_GAME","price":{"basePrice":"$99.99","currencyCode":"USD","discountText":"-60%","discountedPrice":"$39.99"}}' +
  ed('$69.99', '$69.99', 'FULL_GAME') + '</html>';
const DS = grab(deluxeOnSale);
check(DS.price === 39.99, 'grab() a discounted Deluxe beats a full-price Standard', '-> ' + DS.price);
check(DS.original === 99.99 && DS.discount === '-60%',
  'grab() strikes through the chosen edition\'s own list price', '-> was ' + DS.original + ' ' + DS.discount);

// ...and the reverse: no discount deep enough, so the base edition wins.
const shallow = '<html>' + ed('$99.99', '$89.99', 'FULL_GAME') + ed('$69.99', '$69.99', 'FULL_GAME') + '</html>';
check(grab(shallow).price === 69.99, 'grab() base edition wins when the Deluxe discount is shallow', '-> ' + grab(shallow).price);

// Add-ons sit on the same concept page and are always cheaper than the game,
// so picking the cheapest entry outright returned a piece of DLC.
// Ordering matches the real page: the game and its editions first, then the
// add-on carousel. Nothing playable is listed after the carousel begins.
const withAddons = '<html>' +
  ed('$69.99', '$69.99', 'FULL_GAME') +         // Standard
  ed('$99.99', '$59.99', 'FULL_GAME') +         // Deluxe, on sale
  ed('$9.99',  '$9.99',  'GAME_RELATED') +      // character pack
  ed('$4.99',  '$4.99',  'ADD_ON') +            // skin
  '</html>';
const WA = grab(withAddons);
check(WA.price === 59.99, 'grab() ignores add-ons and takes the cheapest game', '-> ' + WA.price);
check(WA.editions.length === 2 && WA.onPage === 4, 'grab() lists games separately from everything priced',
  '-> ' + WA.editions.length + ' games of ' + WA.onPage + ' entries');

// An unfamiliar classification must be treated as a game, not silently dropped.
const oddCls = '<html>' + ed('$69.99', '$69.99', 'SOMETHING_NEW') + ed('$9.99', '$9.99', 'GAME_RELATED') + '</html>';
check(grab(oddCls).price === 69.99, 'grab() treats an unknown classification as a game', '-> ' + grab(oddCls).price);

// With no classification anywhere, editions and add-ons are indistinguishable,
// so fall back to the page's first entry rather than letting an add-on win.
const noCls = '<html>' +
  '{"price":{"basePrice":"$69.99","currencyCode":"USD","discountedPrice":"$69.99"}}' +
  '{"price":{"basePrice":"$4.99","currencyCode":"USD","discountedPrice":"$4.99"}}' +
  '</html>';
check(grab(noCls).price === 69.99, 'grab() unclassified page falls back to the first entry', '-> ' + grab(noCls).price);

// The real MLB The Show 26 page, transcribed from its markup: the game and its
// editions first (carrying no classification), then an add-on carousel of Stubs
// packs. "ITEM" labels add-ons just as "VIRTUAL_CURRENCY" does, and a $19.99
// pack was winning over the game.
const blk = (base, disc, cls) => (cls ? '{"storeDisplayClassification":"' + cls + '",' : '{') +
  '"price":{"basePrice":"' + base + '","currencyCode":"USD","discountedPrice":"' + disc + '"}}';
const mlb = '<html>' +
  blk('Game Trial', 'Game Trial', null) +
  blk('$69.99', '$69.99', null) +            // Standard
  blk('$79.99', '$49.59', null) +            // Deluxe, on sale
  blk('Game Trial', 'Game Trial', 'PREMIUM_EDITION') +
  blk('$69.99', '$69.99', null) +
  blk('$99.99', '$99.99', 'VIRTUAL_CURRENCY') +   // Stubs, carousel starts here
  blk('$49.99', '$49.99', 'VIRTUAL_CURRENCY') +
  blk('$30.00', '$30.00', 'ITEM') +
  blk('$19.99', '$19.99', 'ITEM') +
  blk('$0.99',  '$0.99',  'VIRTUAL_CURRENCY') +
  '</html>';
const ML = grab(mlb);
check(ML.price === 49.59, 'grab() MLB page: the discounted edition, not a Stubs pack', '-> ' + ML.price);
check(ML.original === 79.99, 'grab() MLB page: strikethrough is that edition\'s own price', '-> ' + ML.original);
check(ML.onPage === 10, 'grab() MLB page: counts every priced entry', '-> ' + ML.onPage);

// The real page's layout, with its actual distances. FULL_GAME sits 14,000
// characters from the price it belongs to and PREMIUM_EDITION comes *after*
// its price, so labels cannot be matched to prices by proximity. Every game
// price does appear before the first add-on label, which is what the split
// actually relies on.
const pad = n => ' '.repeat(n);
const CLS = c => '"storeDisplayClassification":"' + c + '",';
const P = (base, disc) => '{"price":{"basePrice":"' + base + '","currencyCode":"USD","discountedPrice":"' + disc + '"}}';
const realLayout = '<html>' +
  CLS('FULL_GAME') + pad(14000) +               // label, then a long way to its price
  P('Game Trial', 'Game Trial') + pad(2000) +
  P('$69.99', '$69.99') + pad(120000) +         // Standard
  P('$79.99', '$49.59') + pad(600) +            // Deluxe on sale...
  CLS('PREMIUM_EDITION') + pad(9000) +          // ...whose label follows it
  P('Game Trial', 'Game Trial') + pad(2000) +
  P('$69.99', '$69.99') + pad(500) +
  CLS('FULL_GAME') + pad(42000) +
  CLS('VIRTUAL_CURRENCY') + pad(250) + P('$99.99', '$99.99') + pad(900) +   // carousel
  CLS('ITEM') + pad(240) + P('$19.99', '$19.99') + pad(900) +
  CLS('VIRTUAL_CURRENCY') + pad(250) + P('$0.99', '$0.99') +
  '</html>';
const RL = grab(realLayout);
check(RL.price === 49.59, 'grab() real layout: the discounted edition wins', '-> ' + RL.price);
check(RL.original === 79.99, 'grab() real layout: its own strikethrough', '-> ' + RL.original);
// Two distinct prices: the two $69.99 entries collapse, and the Game Trials
// carry no parseable price at all.
check(RL.editions.length === 2 && RL.onPage === 8,
  'grab() real layout: two distinct game prices, eight priced in all',
  '-> ' + RL.editions.map(e => e.price).join(', ') + ' of ' + RL.onPage);
check(RL.editions[0].price === 49.59 && RL.editions[0].original === 79.99,
  'grab() editions carry their own strikethrough', '-> ' + JSON.stringify(RL.editions[0]));

// Ghost of Yotei: the add-on carried ADD_ON_PACK, which an anchored ^ADD_ON$
// let through as a game, so a $10 pack won. Classifications are matched as
// substrings now -- the list has been surprised three times.
const yotei = '<html>' +
  pad(68000) + CLS('FULL_GAME') + pad(10600) + P('$69.99', '$69.99') +
  pad(127000) + P('$69.99', '$69.99') + pad(600) + CLS('FULL_GAME') +
  pad(10000) + P('$79.99', '$79.99') + pad(500) + CLS('PREMIUM_EDITION') +
  pad(38000) + CLS('ADD_ON_PACK') + pad(240) + P('$10.00', '$10.00') +
  '</html>';
const GY = grab(yotei);
check(GY.price === 69.99, 'grab() Ghost of Yotei: the game, not the $10 add-on pack', '-> ' + GY.price);
check(GY.editions.length === 2 && GY.editions[1].price === 79.99,
  'grab() Ghost of Yotei: two game editions', '-> ' + GY.editions.map(e => e.price).join(', '));

// Variants of the same idea must all read as add-ons, whatever the store calls them.
['ADD_ON_PACK', 'ADDON_ITEM_PACK', 'GAME_RELATED', 'VIRTUAL_CURRENCY', 'ITEM', 'SEASON_PASS'].forEach(c => {
  const h = '<html>' + P('$69.99', '$69.99') + pad(300) + CLS(c) + pad(240) + P('$4.99', '$4.99') + '</html>';
  check(grab(h).price === 69.99, 'grab() "' + c + '" reads as an add-on', '-> ' + grab(h).price);
});

// "ITEM" alone must not be mistaken for a game.
const itemOnly = '<html>' + blk('$69.99', '$69.99', null) + blk('$19.99', '$19.99', 'ITEM') + '</html>';
check(grab(itemOnly).price === 69.99, 'grab() ITEM is an add-on, not a game', '-> ' + grab(itemOnly).price);

// An add-on class we have never seen still gets dropped, because everything
// after the carousel begins is discarded.
const unknownAddon = '<html>' + blk('$69.99', '$69.99', null) +
  blk('$9.99', '$9.99', 'VIRTUAL_CURRENCY') + blk('$1.99', '$1.99', 'SOMETHING_ELSE') + '</html>';
check(grab(unknownAddon).price === 69.99, 'grab() drops everything after the add-on carousel starts',
  '-> ' + grab(unknownAddon).price);

// Release dates. An embedded ISO timestamp is unambiguous and preferred; the
// spec table is the fallback and its numeric dates are not, so the storefront
// decides the order and anything unreadable stays null.
// The exact shape a live concept page carries. Being ISO, it sidesteps the
// month/day ambiguity entirely -- the spec table below is only a safety net.
check(releaseDate('...,"releaseDate":"2025-10-02T04:00:00Z",...') === '2025-10-02',
  'releaseDate() reads the ISO field a real page carries');
check(releaseDate('x{"releaseDate":"2026-08-04T00:00:00Z"}y') === '2026-08-04',
  'releaseDate() prefers an embedded ISO date');
check(releaseDate('<dl><dt>Release Date</dt><dd>4/8/2026</dd></dl>', 'en-us') === '2026-04-08',
  'releaseDate() reads a US spec table as month/day');
check(releaseDate('<dl><dt>Lançamento</dt><dd>4/8/2026</dd></dl>', 'pt-br') === '2026-08-04',
  'releaseDate() reads a Brazilian spec table as day/month');
check(releaseDate('<dl><dt>発売日</dt><dd>2026年8月4日</dd></dl>', 'ja-jp') === '2026-08-04',
  'releaseDate() reads a Japanese spec table');
check(parseDate('25/8/2026', 'en-us') === '2026-08-25',
  'parseDate() a day above 12 settles the order whatever the locale');
check(releaseDate('<html><p>Coming soon</p></html>') === null,
  'releaseDate() absent -> null, never a guess');
check(parseDate('99/99/2026', 'en-us') === null, 'parseDate() rejects an impossible date');
check(parseDate('4/8/1200', 'en-us') === null, 'parseDate() rejects an implausible year');

// Language support. Screen languages (subtitles/UI) decide whether a
// foreign-region copy is playable; "unknown" must stay distinct from "no".
const VOICE = 'English, French (France), German, Italian, Japanese, Polish, Portuguese (Brazil), ' +
  'Portuguese (Portugal), Russian, Spanish, Spanish (Mexico)';
const SCREEN = 'Arabic, Chinese (Simplified), Chinese (Traditional), Croatian, Czech, Danish, Dutch, ' +
  'English, Finnish, French (France), German, Greek, Hungarian, Italian, Japanese, Korean, Norwegian, ' +
  'Polish, Portuguese (Brazil), Portuguese (Portugal), Russian, Spanish, Spanish (Mexico), Swedish, Thai, Turkish';

// Label and value in separate elements, as the store renders it.
const dl = '<dl><dt>Voice</dt><dd>' + VOICE + '</dd>' +
           '<dt>Screen Languages</dt><dd>' + SCREEN + '</dd></dl>';
const L1 = languages(dl);
check(L1.english === true, 'languages(): English detected', '-> ' + L1.english);
check(L1.screen && L1.screen.length === 26 && L1.screen[0] === 'Arabic', 'languages(): screen list parsed', '-> ' + (L1.screen||[]).length + ' entries');
check(L1.voice && L1.voice.length === 11 && L1.voice[0] === 'English', 'languages(): voice list parsed', '-> ' + (L1.voice||[]).length + ' entries');
check(L1.screen.includes('French (France)'), 'languages(): parenthesised names survive splitting');

// Same idea, but label and value on one line.
const inline = '<div>Voice: ' + VOICE + '</div><div>Screen Languages: ' + SCREEN + '</div>';
check(languages(inline).english === true, 'languages(): inline "Label: values" form');

// A title with no English at all must report false, not unknown.
const jp = '<dl><dt>Voice</dt><dd>Japanese</dd><dt>Screen Languages</dt><dd>Japanese, Korean</dd></dl>';
const L2 = languages(jp);
check(L2.english === false, 'languages(): no English -> false', '-> ' + L2.english);

// Japanese voice but English subtitles is still playable -> true.
const subs = '<dl><dt>Voice</dt><dd>Japanese</dd><dt>Screen Languages</dt><dd>Japanese, English</dd></dl>';
check(languages(subs).english === true, 'languages(): English subtitles count');

// Nothing on the page -> unknown, which must never render as "no English".
const none = '<html><body><p>Buy now</p></body></html>';
const L3 = languages(none);
check(L3.english === null && L3.screen === null, 'languages(): absent -> null (unknown)', '-> ' + JSON.stringify(L3));

// "Voice Chat" must not be mistaken for the Voice language list.
const decoy = '<div>Voice Chat Supported</div><div>Screen Languages: English, Thai</div>';
const L4 = languages(decoy);
check(L4.english === true && L4.voice === null, 'languages(): "Voice Chat" is not the voice list', '-> voice=' + JSON.stringify(L4.voice));

// Only voice data present -> fall back to it rather than reporting unknown.
check(languages('<div>Voice: English, German</div>').english === true, 'languages(): falls back to voice list');

// Localized storefronts: each store writes both the label and the language
// names in its own language. Matching only English wording would report
// "unknown" for 9 of the 20 regions even when the game does support English.
const LOCALIZED = [
  ['pt-br BR', 'Voz', 'Inglês, Japonês', 'Idiomas da tela', 'Inglês, Português (Brasil)'],
  ['es-mx MX', 'Voz', 'Inglés, Japonés', 'Idiomas en pantalla', 'Inglés, Español (México)'],
  ['de-de DE', 'Sprachausgabe', 'Englisch, Japanisch', 'Bildschirmsprachen', 'Englisch, Deutsch'],
  ['pl-pl PL', 'Głos', 'Angielski, Japoński', 'Języki ekranowe', 'Angielski, Polski'],
  ['tr-tr TR', 'Ses', 'İngilizce, Japonca', 'Ekran dilleri', 'İngilizce, Türkçe'],
  ['ja-jp JP', '音声', '英語, 日本語', '画面表示言語', '英語, 日本語'],
  ['ko-kr KR', '음성', '영어, 일본어', '화면 언어', '영어, 한국어'],
  ['zh-tw TW', '語音', '英語, 日語', '螢幕語言', '英文, 繁體中文'],
  ['uk-ua UA', 'Голос', 'Англійська, Японська', 'Мови екрана', 'Англійська, Українська']
];
for (const [tag, vl, vv, sl, sv] of LOCALIZED) {
  const html = '<dl><dt>' + vl + '</dt><dd>' + vv + '</dd><dt>' + sl + '</dt><dd>' + sv + '</dd></dl>';
  const L = languages(html);
  check(L.english === true, 'languages(): ' + tag + ' English detected', '-> ' + L.english + ' via ' + L.source);
}

// The same localized stores must still report false when English is absent.
const brNoEn = '<dl><dt>Voz</dt><dd>Japonês</dd><dt>Idiomas da tela</dt><dd>Japonês, Português (Brasil)</dd></dl>';
check(languages(brNoEn).english === false, 'languages(): pt-br without English -> false');
const jpNoEn = '<dl><dt>音声</dt><dd>日本語</dd><dt>画面表示言語</dt><dd>日本語, 韓国語</dd></dl>';
check(languages(jpNoEn).english === false, 'languages(): ja-jp without English -> false');

// Wording we do not have in the table, but clearly a language field.
const unknownLabel = '<dl><dt>Sprachen</dt><dd>Englisch, Deutsch</dd></dl>';
const LU = languages(unknownLabel);
check(LU.english === true, 'languages(): unknown label falls back to a language-ish field', '-> ' + LU.source);

// That fallback must not fire on prose that merely mentions a language.
const prose = '<p>Language support may vary by region. Please check before buying.</p>';
check(languages(prose).english === null, 'languages(): prose does not trigger the fallback');

// The Brazilian store's real spec table, transcribed from the live page. The
// labels carry trailing colons, the rows sit among unrelated spec rows, and
// "Inglês" is 7th of 11 rather than first.
const BR_SCREEN = 'Alemão, Chinês (simplificado), Chinês (tradicional), Coreano, Espanhol, ' +
  'Espanhol (México), Francês (França), Inglês, Italiano, Japonês, Português (Brasil)';
const brReal =
  '<dl>' +
  '<dt>Plataforma:</dt><dd>PS5</dd>' +
  '<dt>Lançamento:</dt><dd>4/8/2026</dd>' +
  '<dt>Distribuidora:</dt><dd>Fictions</dd>' +
  '<dt>Gêneros:</dt><dd>Ação</dd>' +
  '<dt>Voz:</dt><dd>Inglês, Japonês</dd>' +
  '<dt>Idiomas da tela:</dt><dd>' + BR_SCREEN + '</dd>' +
  '</dl>';
const BR = languages(brReal);
check(BR.english === true, 'languages(): real pt-br spec table -> English', '-> ' + BR.english + ' via ' + BR.source);
check(BR.screen && BR.screen.length === 11, 'languages(): pt-br screen list is 11 entries', '-> ' + (BR.screen||[]).length);
check(BR.screen && BR.screen[7] === 'Inglês', 'languages(): English found mid-list, not just first', '-> ' + (BR.screen||[])[7]);
check(BR.voice && BR.voice.join(', ') === 'Inglês, Japonês', 'languages(): pt-br voice list', '-> ' + (BR.voice||[]).join(', '));
check(BR.screen && !BR.screen.some(s => /Fictions|Ação|PS5/.test(s)), 'languages(): neighbouring spec rows do not leak in');

// Same table, inline "Label: value" rather than separate elements.
const brInline = '<p>Gêneros: Ação</p><p>Voz: Inglês, Japonês</p><p>Idiomas da tela: ' + BR_SCREEN + '</p>';
const BRI = languages(brInline);
check(BRI.english === true && BRI.screen.length === 11, 'languages(): pt-br inline form', '-> ' + BRI.english + '/' + BRI.screen.length);

// Mexico and Poland, transcribed from the live pages. Both label the fields
// differently from Brazil, and Polish "Głos" contains ł — not an accented l, so
// NFD leaves it alone and a plain "glos" pattern never matched it.
const MX_SCREEN = 'Alemán, Chino - Simplificado, Chino - Tradicional, Coreano, Español, ' +
  'Español (México), Francés (Francia), Inglés, Italiano, Japonés, Portugués (Brasil)';
const mxReal = '<dl><dt>Plataforma:</dt><dd>PS5</dd><dt>Lanzamiento:</dt><dd>4/8/2026</dd>' +
  '<dt>Editor:</dt><dd>Fictions</dd><dt>Géneros:</dt><dd>Acción</dd>' +
  '<dt>Voz:</dt><dd>Inglés, Japonés</dd>' +
  '<dt>Idiomas de pantalla:</dt><dd>' + MX_SCREEN + '</dd></dl>';
const MXL = languages(mxReal);
check(MXL.english === true, 'languages(): real es-mx spec -> English', '-> ' + MXL.english + ' via ' + MXL.source);
check(MXL.screen && MXL.screen.length === 11, 'languages(): es-mx screen list is 11 entries', '-> ' + (MXL.screen||[]).length);

const PL_SCREEN = 'Angielski, Chiński (tradycyjny), Chiński (uproszczony), Francuski (Francja), ' +
  'Hiszpański, Hiszpański (Meksyk), Japoński, Koreański, Niemiecki, Portugalski (Brazylia), Włoski';
const plReal = '<dl><dt>Platforma:</dt><dd>PS5</dd><dt>Premiera:</dt><dd>4.8.2026</dd>' +
  '<dt>Wydawca:</dt><dd>Fictions</dd><dt>Gatunki:</dt><dd>Akcja</dd>' +
  '<dt>Głos:</dt><dd>Angielski, Japoński</dd>' +
  '<dt>Wyświetlane języki:</dt><dd>' + PL_SCREEN + '</dd></dl>';
const PLL = languages(plReal);
check(PLL.english === true, 'languages(): real pl-pl spec -> English', '-> ' + PLL.english + ' via ' + PLL.source);
check(PLL.screen && PLL.screen.length === 11, 'languages(): pl-pl screen list is 11 entries', '-> ' + (PLL.screen||[]).length);
check(PLL.voice && PLL.voice.join(', ') === 'Angielski, Japoński', 'languages(): pl-pl "Głos" label matches despite ł', '-> ' + (PLL.voice||[]).join(', '));

// A wrong "NO EN" is worse than no badge: if the value after a language label
// is not a language list, the answer must be unknown, never false.
const twoCol = '<div><span>Plataforma:</span><span>Lanzamiento:</span><span>Editor:</span>' +
  '<span>Géneros:</span><span>Voz:</span><span>Idiomas de pantalla:</span></div>' +
  '<div><span>PS5</span><span>4/8/2026</span><span>Fictions</span><span>Acción</span></div>';
const TC = languages(twoCol);
check(TC.english === null, 'languages(): detached values -> unknown, not "no English"', '-> ' + TC.english);
check(languages('<dl><dt>Voz:</dt><dd>PS5</dd></dl>').english === null,
  'languages(): a non-language value is not treated as "no English"');
check(languages('<dl><dt>Géneros:</dt><dd>Acción, Aventura</dd></dl>').english === null,
  'languages(): a genre list is not a language list');

// The guard must not suppress a genuine "no English" answer.
const reallyNoEn = '<dl><dt>Voz:</dt><dd>Japonés</dd><dt>Idiomas de pantalla:</dt><dd>Japonés, Coreano</dd></dl>';
check(languages(reallyNoEn).english === false, 'languages(): genuine no-English still reports false');

// keyName(): the loose key used to match a typed title against the catalogue.
check(keyName("Marvel's Spider-Man 2") === 'marvels spider man 2', 'keyName strips punctuation', '-> ' + keyName("Marvel's Spider-Man 2"));
check(keyName('  GHOST of Yōtei ') === 'ghost of yotei', 'keyName lowercases and drops accents', '-> ' + keyName('  GHOST of Yōtei '));
check(keyName('Gran Turismo 7') === keyName('gran  turismo   7'), 'keyName collapses whitespace');
check(keyName('NieR:Automata') === 'nier automata', 'keyName handles a colon without spaces');

// loadCatalog(): missing file must yield null, not throw — the backend then
// falls back to live store search.
check(loadCatalog('/nonexistent/catalog.json') === null, 'loadCatalog missing file -> null');
{
  const f = require('os').tmpdir() + '/cat-test-' + process.pid + '.json';
  require('fs').writeFileSync(f, JSON.stringify([
    { conceptId: '10014719', name: 'Ghost of Yōtei', releaseDate: '2026-08-04' },
    { conceptId: '228748', name: 'Fortnite', releaseDate: '2017-07-25' },
    { conceptId: '999', name: null }                       // malformed row is skipped
  ]));
  const m = loadCatalog(f);
  check(m && m.size === 2, 'loadCatalog skips rows without a name', '-> ' + (m && m.size));
  check(m.get(keyName('ghost of yotei')) === '10014719', 'loadCatalog matches accent-free', '-> ' + m.get(keyName('ghost of yotei')));
  check(m.get('fortnite') === '228748', 'loadCatalog exact name');
  require('fs').unlinkSync(f);
}

// productIds(): document order, deduped, region-specific SKUs kept distinct
const searchHtml = [
  '<a href="/en-us/product/UB1599-PPSA29343_00-BEASTOFREINCARN">a</a>',
  '<a href="/en-us/product/UB1599-PPSA29343_00-BEASTOFREINCARN">dup</a>',
  '<a href="/en-in/product/UB1599-PPSA29344_00-BEASTOFREINCARN">b</a>'
].join('');
const ids = productIds(searchHtml);
check(ids.length === 2 && ids[0].endsWith('29343_00-BEASTOFREINCARN') && ids[1].endsWith('29344_00-BEASTOFREINCARN'),
  'productIds() order + dedupe', '-> ' + JSON.stringify(ids));
check(productIds('<html>no products</html>').length === 0, 'productIds() empty page -> []');

check(conceptId('{"conceptId":"10010739"}') === '10010739', 'conceptId() quoted');
check(conceptId('{"conceptId":10010739}') === '10010739', 'conceptId() unquoted');
check(conceptId('<html>none</html>') === null, 'conceptId() missing -> null');

// conceptIds() must also pick concepts up from plain /concept/<id> links,
// which is how they appear on search results when the JSON key is absent.
check(conceptId('<a href="/en-in/concept/10014719">Beast of Reincarnation</a>') === '10014719',
  'conceptId() from a /concept/ link');
const cids = conceptIds('<a href="/en-in/concept/10014719">x</a><a href="/en-us/concept/10014719">dup</a><a href="/en-us/concept/10010739">y</a>');
check(cids.length === 2 && cids[0] === '10014719' && cids[1] === '10010739',
  'conceptIds() dedupe across locales', '-> ' + JSON.stringify(cids));
check(conceptIds('<html>none</html>').length === 0, 'conceptIds() none -> []');

// parseQuery(): a pasted store URL or bare ID must skip search entirely.
const pq = [
  ['https://store.playstation.com/en-in/concept/10014719', { conceptId:'10014719', productId:null, title:null }],
  ['https://store.playstation.com/en-us/product/UB1599-PPSA29343_00-BEAST', { conceptId:null, productId:'UB1599-PPSA29343_00-BEAST', title:null }],
  ['10014719',                { conceptId:'10014719', productId:null, title:null }],
  ['Beast of Reincarnation',  { conceptId:null, productId:null, title:'Beast of Reincarnation' }],
  ['007 First Light',         { conceptId:null, productId:null, title:'007 First Light' }],
  ['  Elden Ring  ',          { conceptId:null, productId:null, title:'Elden Ring' }]
];
for (const [inp, exp] of pq) {
  const got = parseQuery(inp);
  check(got.conceptId === exp.conceptId && got.productId === exp.productId && got.title === exp.title,
    'parseQuery ' + JSON.stringify(inp).padEnd(58), '-> ' + JSON.stringify(got));
}

// acceptLang(): each storefront should be asked in its own language, so it is
// less likely to serve a generic US/English (and USD-priced) response.
check(acceptLang('es-mx') === 'es-MX,es;q=0.9', 'acceptLang es-mx', '-> ' + acceptLang('es-mx'));
check(acceptLang('ja-jp') === 'ja-JP,ja;q=0.9', 'acceptLang ja-jp', '-> ' + acceptLang('ja-jp'));
check(acceptLang('pt-br') === 'pt-BR,pt;q=0.9', 'acceptLang pt-br', '-> ' + acceptLang('pt-br'));
check(acceptLang('en-us') === 'en-US,en;q=0.9', 'acceptLang en-us', '-> ' + acceptLang('en-us'));
check(acceptLang('garbage') === 'en-US,en;q=0.9', 'acceptLang malformed -> default');

// Currency policy: Mexico lists many titles in USD, which is a real price a
// Mexican account pays, so it is ranked — but still labelled as USD.
check(isAccepted('MX', 'USD') === true,  'MX in USD is ranked');
check(isForeign('MX', 'USD') === true,   'MX in USD is labelled foreign');
check(isAccepted('MX', 'MXN') === true,  'MX in MXN is ranked');
check(isForeign('MX', 'MXN') === false,  'MX in MXN is not labelled');
check(isAccepted('MX', 'EUR') === false, 'MX in EUR is still set aside');
// no other region gets the exemption
check(isAccepted('DE', 'USD') === false, 'DE in USD is set aside');
check(isAccepted('SG', 'SGD') === true,  'SG in SGD is ranked');
check(isForeign('SG', 'SGD') === false,  'SG in SGD is not labelled');
check(isForeign('US', null) === false,   'missing currency is not labelled foreign');

// pool(): preserves input order and never exceeds the concurrency cap
(async () => {
  let live = 0, peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const out = await pool(items, 3, async (x) => {
    live++; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 5 + (x % 3) * 5));
    live--;
    return x * 2;
  });
  check(JSON.stringify(out) === JSON.stringify(items.map(x => x * 2)), 'pool() preserves order', '-> ' + JSON.stringify(out));
  check(peak <= 3, 'pool() respects concurrency cap', '-> peak ' + peak);
  check(JSON.stringify(await pool([], 3, async x => x)) === '[]', 'pool() empty input -> []');

  // --- 3-tier resolver against a fake store -------------------------------
  // Each locale below is wired to fall through to a different tier, so the
  // chosen tier and the reported URL are both checked end to end.
  const CID = '10014719', PID = 'UB1599-PPSA29343_00-BEAST', LOCAL = 'UB1599-PPSA29344_00-BEAST';
  const page = (price, cur) => '<html><script type="application/ld+json">' +
    JSON.stringify({ '@type':'Product', name:'Beast of Reincarnation', offers:{ price, priceCurrency:cur } }) +
    '</script></html>';

  const routes = {
    // SG resolves on tier 1
    ['/en-sg/concept/' + CID]: page('S$70.00', 'SGD'),
    // IN has no concept page, so it must fall through to tier 2
    ['/en-in/product/' + PID]: page('Rs 4,578', 'INR'),
    // JP has neither, and must find its own SKU via tier 3
    ['/ja-jp/search/Beast%20of%20Reincarnation']: '<a href="/ja-jp/product/' + LOCAL + '">x</a>',
    ['/ja-jp/product/' + LOCAL]: page('¥7,982', 'JPY')
    // DE is absent entirely -> no price
  };

  const srv = http.createServer((rq, rs) => {
    const body = routes[rq.url];
    if (body == null) { rs.statusCode = 404; return rs.end('nope'); }
    rs.end(body);
  });
  await new Promise(r => srv.listen(PORT, r));

  const base = 'http://localhost:' + PORT;
  const sg = await region(PID, CID, 'en-sg', 'Beast of Reincarnation');
  check(sg.via === 'concept' && sg.price === 70 && sg.cur === 'SGD' && sg.url === base + '/en-sg/concept/' + CID,
    'resolver: concept tier wins when available', '-> ' + sg.via + ' ' + sg.url);

  const inr = await region(PID, CID, 'en-in', 'Beast of Reincarnation');
  check(inr.via === 'product' && inr.price === 4578 && inr.url === base + '/en-in/product/' + PID,
    'resolver: falls back to product', '-> ' + inr.via + ' ' + inr.url);

  const jp = await region(PID, CID, 'ja-jp', 'Beast of Reincarnation');
  check(jp.via === 'search' && jp.price === 7982 && jp.url === base + '/ja-jp/product/' + LOCAL,
    'resolver: finds the local SKU via region search', '-> ' + jp.via + ' ' + jp.url);

  const de = await region(PID, CID, 'de-de', 'Beast of Reincarnation');
  check(de.via === null && de.price === null && de.url === null,
    'resolver: unavailable region yields no price or url', '-> ' + JSON.stringify(de));

  srv.close();

  // catalog.js: the free date pickup off a grid node. The live API returns no
  // such field, so the "no date" case is the one that runs today; the others
  // pin what happens if it ever appears.
  const { nodeDate } = require('./catalog.js');
  check(nodeDate({ id: '10014719', name: 'Beast of Reincarnation' }) === null,
    'nodeDate: a grid node without a date yields null (todays real shape)');
  check(nodeDate({ id: '1', releaseDate: '2025-10-02T04:00:00Z' }) === '2025-10-02',
    'nodeDate: reads an ISO timestamp down to the day');
  check(nodeDate({ id: '1', conceptReleaseDate: '2026-04-08' }) === '2026-04-08',
    'nodeDate: accepts the facet-named field too');
  check(nodeDate({ id: '1', releaseDate: 'last_thirty_days' }) === null,
    'nodeDate: a non-date value is ignored, not guessed at');
  check(nodeDate({ id: '1', releaseDate: 1759377600000 }) === null,
    'nodeDate: a non-string value is ignored');

  // catalog.csv: the same rows as catalog.json, in a form a spreadsheet opens.
  const { csvRow, csvPath, CSV_COLUMNS } = require('./catalog.js');
  check(CSV_COLUMNS.join(',') === 'conceptId,name,releaseDate,firstSeen,url',
    'csv: column order is stable');
  check(csvRow({ conceptId: '10014719', name: 'Beast of Reincarnation', releaseDate: '2025-10-02', firstSeen: '2026-08-04' })
      === '"10014719","Beast of Reincarnation","2025-10-02","2026-08-04","https://store.playstation.com/en-us/concept/10014719"',
    'csv: a plain row carries a working store link');
  check(csvRow({ conceptId: '1', name: '"Buy The Game, I Have a Gun" -Sheesh-Man' })
      === '"1","""Buy The Game, I Have a Gun"" -Sheesh-Man","","","https://store.playstation.com/en-us/concept/1"',
    'csv: a real title with commas and quotes is escaped RFC 4180 style');
  check(csvRow({ conceptId: '1', name: null }) === '"1","","","","https://store.playstation.com/en-us/concept/1"',
    'csv: a missing field is empty, not the string null');
  check(csvPath('catalog.json') === 'catalog.csv' && csvPath('/tmp/x.json') === '/tmp/x.csv' && csvPath('out') === 'out.csv',
    'csv: the csv sits beside whatever --out named');

  // getUntilDate(): the backfill must stop reading at the date, not download the
  // whole page. The stub answers like a concept page -- the ISO field early,
  // then megabytes of markup after it.
  const { getUntilDate } = require('./catalog.js');
  const FILLER = 'x'.repeat(64 * 1024);
  const dsrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url === '/nodate') {          // no ISO field: spec table is the fallback
      res.end('<p>Release Date</p><p>10/2/2025</p>' + FILLER);
      return;
    }
    res.write('<html>' + 'a'.repeat(4096) + '"releaseDate":"2025-10-02T04:00:00Z"');
    let sent = 0;
    const pump = () => {
      if (res.writableEnded || res.destroyed) return;
      if (sent++ > 48) return res.end();   // ~3 MB if nobody hangs up
      res.write(FILLER, pump);
    };
    pump();
  });
  await new Promise(r => dsrv.listen(0, r));
  const durl = 'http://localhost:' + dsrv.address().port;

  const early = await getUntilDate(durl + '/game');
  check(early.date === '2025-10-02' && early.text === null,
    'getUntilDate: reads the ISO date off the stream', '-> ' + early.date);
  check(early.bytes < 512 * 1024,
    'getUntilDate: hangs up early instead of downloading the whole page',
    '-> ' + Math.round(early.bytes / 1024) + ' kB of ~3 MB');

  const late = await getUntilDate(durl + '/nodate');
  check(late.date === null && late.text !== null && releaseDate(late.text, 'en-us') === '2025-10-02',
    'getUntilDate: returns the whole page when the ISO field never appears, so the spec table still parses');

  const gone = await getUntilDate(durl.replace(/:\d+$/, ':1') + '/game');
  check(gone.date === null && gone.text === null && gone.bytes === 0,
    'getUntilDate: an unreachable page yields nothing rather than throwing');

  dsrv.close();

  // Ghost of Tsushima DIRECTOR'S CUT, transcribed from the real product page.
  // Five entries, all classified as games: the two editions, two $19.99 trials
  // and a PS Plus "Included" upsell that reuses the $69.99 base price. The
  // trials were winning, and the page carries no JSON-LD at all, so the
  // embedded blocks are the only source.
  const gotEntry = (price, cls, opts = {}) =>
    '"storeDisplayClassification":"' + cls + '",' + 'x'.repeat(400) +
    '"offerApplicability":"APPLICABLE","offerIsTiedToSubscription":false,' +
    '"type":"ADD_TO_CART","upSellService":"' + (opts.service || 'NONE') + '",' +
    '"exclusive":false,"playabilityDate":null,' +
    '"basePrice":"' + price + '","discountedPrice":"' + (opts.disc || price) + '",' +
    '"currencyCode":"USD","displayDiscountText":' + (opts.discText || 'null') + ',' +
    '"endTime":null,"displayUpsellText":' + (opts.upsell ? '"' + opts.upsell + '"' : 'null') + ',';

  const GOT = '<html>' +
    gotEntry('$69.99', 'GAME_BUNDLE') +
    gotEntry('$59.99', 'GAME_BUNDLE') +
    gotEntry('$19.99', 'GAME_BUNDLE', { upsell: 'Trial' }) +
    gotEntry('$19.99', 'FULL_GAME',   { upsell: 'Trial' }) +
    gotEntry('$69.99', 'FULL_GAME',   { service: 'PS_PLUS', disc: 'Included', discText: '"Included"' });

  const got = grab(GOT);
  check(got.price === 59.99,
    'Ghost of Tsushima: the PS4 edition wins, not the $19.99 trial', '-> ' + got.price);
  check(got.suspect === false,
    'Ghost of Tsushima: nothing left to look suspicious once trials are gone');
  check(JSON.stringify(got.editions.map(e => e.price)) === '[59.99,69.99]',
    'Ghost of Tsushima: only real editions are offered', '-> ' + JSON.stringify(got.editions.map(e => e.price)));

  // Each marker has to work on its own, since they appear on different entries.
  const trialOnly = grab('<html>' + gotEntry('$69.99', 'FULL_GAME') +
                                    gotEntry('$19.99', 'FULL_GAME', { upsell: 'Trial' }));
  check(trialOnly.price === 69.99, 'a trial is excluded by displayUpsellText alone');

  const plusOnly = grab('<html>' + gotEntry('$59.99', 'FULL_GAME') +
                                   gotEntry('$9.99', 'FULL_GAME', { service: 'PS_PLUS' }));
  check(plusOnly.price === 59.99, 'a subscription entry is excluded by upSellService alone');

  // Localized wording must not matter: only presence is tested.
  const jpTrial = grab('<html>' + gotEntry('$69.99', 'FULL_GAME') +
                             gotEntry('$19.99', 'FULL_GAME', { upsell: '体験版' }));
  check(jpTrial.price === 69.99, 'a localized trial label is still a trial');

  // A real discount is not an upsell and must survive.
  const sale = grab('<html>' + gotEntry('$69.99', 'FULL_GAME') +
                               gotEntry('$69.99', 'FULL_GAME', { disc: '$17.49', discText: '"-75%"' }));
  check(sale.price === 17.49 && sale.original === 69.99,
    'a deeply discounted edition is kept, not mistaken for an upsell', '-> ' + sale.price);

  // Never leave a page priceless: if every entry looks like an upsell, report them.
  const allUpsell = grab('<html>' + gotEntry('$69.99', 'FULL_GAME', { upsell: 'Trial' }));
  check(allUpsell.price === 69.99, 'a page of nothing but upsells still yields a price');

  // The same game on the Japanese storefront, transcribed from the real page.
  // Two things the US page did not have: the trial announces itself in Japanese
  // (試用版), and the page ends with two stray entries 90,000 characters after
  // the real ones -- classification OTHER, a bare price, and none of the offer
  // fields. That stray ¥2,200 was beating the ¥7,590 edition.
  const jpEntry = (price, cls, opts = {}) =>
    '"storeDisplayClassification":"' + cls + '",' + 'x'.repeat(400) +
    (opts.bare ? '' :
      '"upSellService":"' + (opts.service || 'NONE') + '","exclusive":false,') +
    '"basePrice":"' + price + '",' +
    (opts.bare ? '' : '"discountedPrice":"' + (opts.disc || price) + '",') +
    '"currencyCode":"JPY","displayUpsellText":' +
    (opts.upsell ? '"' + opts.upsell + '"' : 'null') + ',';

  const JP = '<html>' +
    jpEntry('¥8,690', 'GAME_BUNDLE') +
    jpEntry('¥8,690', 'GAME_BUNDLE') +
    jpEntry('¥7,590', 'GAME_BUNDLE') +
    jpEntry('¥2,200', 'GAME_BUNDLE', { upsell: '試用版' }) +
    jpEntry('無料',    'FULL_GAME') +
    jpEntry('¥8,690', 'FULL_GAME', { service: 'PS_PLUS', disc: '含まれます',
                                     upsell: 'PlayStation Plus エクストラに加入してください' }) +
    jpEntry('¥2,200', 'GAME_BUNDLE', { upsell: '試用版' }) +
    'y'.repeat(90000) +
    jpEntry('¥2,200', 'OTHER', { bare: true }) +
    jpEntry('無料',    'OTHER', { bare: true });

  const jpGot = grab(JP);
  check(jpGot.price === 7590,
    'Ghost of Tsushima JP: the ¥7,590 edition wins, not the stray ¥2,200', '-> ' + jpGot.price);
  check(jpGot.cur === 'JPY', 'Ghost of Tsushima JP: currency is read as JPY', '-> ' + jpGot.cur);
  check(JSON.stringify(jpGot.editions.map(e => e.price)) === '[7590,8690]',
    'Ghost of Tsushima JP: only the two real editions are offered',
    '-> ' + JSON.stringify(jpGot.editions.map(e => e.price)));
  check(jpGot.suspect === false, 'Ghost of Tsushima JP: no suspicious price left to flag');

  // The two rules are independent: a bare entry is dropped even when nothing
  // about it is an upsell, and a marked upsell is dropped even when complete.
  const bare = grab('<html>' + jpEntry('¥7,590', 'FULL_GAME') +
                               jpEntry('¥2,200', 'OTHER', { bare: true }));
  check(bare.price === 7590, 'an entry with no offer fields is not an offer');

  // And the fallback still holds: a page of nothing but bare entries is not
  // silently priceless.
  const allBare = grab('<html>' + jpEntry('¥7,590', 'OTHER', { bare: true }));
  check(allBare.price === 7590, 'a page of only bare entries still yields a price');

  // reconcile(): the regions check each other, with no storefront wording involved.
  const reg = (region, price, eds, extra = {}) => ({
    region, price, editions: eds.map(p => ({ price: p, original: null, discount: null }), []), ...extra
  });
  const normal = () => [
    reg('US', 59.99, [59.99, 69.99]), reg('SG', 79, [79, 92]),
    reg('IN', 4499, [4499, 5299]),    reg('TR', 1799, [1799, 2099]),
    reg('GB', 54.99, [54.99, 64.99])
  ];

  const strayJp = [...normal(), reg('JP', 2200, [2200, 7590, 8690])];
  const fixed = reconcile(strayJp).find(r => r.region === 'JP');
  check(fixed.price === 7590 && fixed.adjusted === true,
    'reconcile: a stray entry no other region has is re-picked from that page',
    '-> ' + fixed.price);
  check(JSON.stringify(fixed.editions.map(e => e.price)) === '[7590,8690]',
    'reconcile: the stray is dropped from the editions too');
  check(reconcile(strayJp).filter(r => r.adjusted).length === 1,
    'reconcile: only the odd region is touched');

  // India is legitimately a fraction of the US -- absolute prices must not matter.
  check(reconcile(normal()).every(r => !r.adjusted),
    'reconcile: cheap regions are left alone, since only intra-region ratios are compared');

  // A region-only sale explains its own low ratio and must survive untouched.
  const onSale = [...normal(),
    { ...reg('JP', 2200, [2200, 8690]), original: 8690, discount: '-75%' }];
  const kept = reconcile(onSale).find(r => r.region === 'JP');
  check(kept.price === 2200 && !kept.adjusted,
    'reconcile: a discounted price is never overridden', '-> ' + kept.price);

  // Too few regions to agree on anything: change nothing.
  check(reconcile([reg('US', 59.99, [59.99, 69.99]), reg('JP', 2200, [2200, 8690])])
          .every(r => !r.adjusted),
    'reconcile: no consensus, no adjustment');

  // Regions with no price or a single edition contribute nothing and are safe.
  check(reconcile([...normal(), reg('DE', null, []), reg('BR', 199, [199])])
          .every(r => !r.adjusted),
    'reconcile: unpriced and single-edition regions are left as they are');

  // gqlCtas(): transport only. The mapping from its response to prices waits on
  // a look at a real one; what is pinned here is that the request is built the
  // way the store's own page builds it, and that nothing throws.
  const { gqlCtas, storeLocale } = require('./server.js');
  check(storeLocale('ja-jp') === 'ja-JP' && storeLocale('en-us') === 'en-US' && storeLocale('de') === 'de',
    'gql: the locale header capitalises the region subtag');

  let seen = null;
  const gsrv = http.createServer((req, res) => {
    seen = { url: req.url, headers: req.headers };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('boom')
      ? { errors: [{ message: 'PersistedQueryNotFound' }] }
      : { data: { conceptRetrieveForCtasWithPrice: { id: '10000886' } } }));
  });
  await new Promise(r => gsrv.listen(0, r));
  process.env.PS_GQL_OP = 'http://localhost:' + gsrv.address().port + '/op';
  delete require.cache[require.resolve('./server.js')];
  const gql2 = require('./server.js');

  const data = await gql2.gqlCtas('10000886', 'ja-jp');
  check(data && data.conceptRetrieveForCtasWithPrice.id === '10000886',
    'gql: a good response comes back as data');
  check(/operationName=conceptRetrieveForCtasWithPrice/.test(seen.url) &&
        decodeURIComponent(seen.url).includes('"conceptId":"10000886"') &&
        decodeURIComponent(seen.url).includes('"version":1'),
    'gql: operation, variables and persisted query are all in the request');
  check(seen.headers['x-psn-store-locale-override'] === 'ja-JP',
    'gql: the storefront is pinned by header, not left to caller IP',
    '-> ' + seen.headers['x-psn-store-locale-override']);
  check(seen.headers['apollo-require-preflight'] === 'true' &&
        seen.headers['x-apollo-operation-name'] === 'conceptRetrieveForCtasWithPrice',
    'gql: the CSRF headers Apollo demands are present');

  process.env.PS_GQL_HASH = 'boom';
  delete require.cache[require.resolve('./server.js')];
  check(await require('./server.js').gqlCtas('10000886', 'ja-jp') === null,
    'gql: a rotated hash yields null so the page path can take over');
  check(await gql2.gqlCtas(null, 'ja-jp') === null, 'gql: no concept id, no request');
  delete process.env.PS_GQL_HASH;

  gsrv.close();
  delete process.env.PS_GQL_OP;
  delete require.cache[require.resolve('./server.js')];

  // Concept resolution: the bug that priced a different game entirely.
  const { conceptIdsRanked, sameGame, resolveConcept } = require('./server.js');

  // A search page leads with a promoted tile; the game being searched for is
  // referenced throughout. Frequency, not position, identifies it.
  const searchPage =
    '/concept/10015299' + 'x'.repeat(50) +          // promoted neighbour, once
    '"conceptId":"235227"' + 'x'.repeat(50) +
    '/concept/235227' + 'x'.repeat(50) +
    '"conceptId":"235227"';
  check(JSON.stringify(conceptIdsRanked(searchPage)) === '["235227","10015299"]',
    'concept: the most-referenced id wins, not the first one on the page',
    '-> ' + JSON.stringify(conceptIdsRanked(searchPage)));

  check(sameGame('Ghost of Tsushima DIRECTOR’S CUT', 'Ghost of Tsushima'),
    'concept: an edition suffix is still the same game');
  check(sameGame('Ghost of Tsushima', 'Ghost of Tsushima DIRECTOR’S CUT'),
    'concept: and it holds in the other direction');
  check(!sameGame('Tyrion Cuthbert: Attorney of the Arcane', 'Ghost of Tsushima'),
    'concept: a different game is not the same game');
  check(!sameGame('', 'Ghost of Tsushima') && !sameGame('Ghost of Tsushima', null),
    'concept: a missing name never counts as a match');

  // Verification: the ranked winner is confirmed by fetching its concept page.
  const pages = {
    '10015299': '<script type="application/ld+json">{"name":"Tyrion Cuthbert: Attorney of the Arcane"}</script>',
    '235227':   '<script type="application/ld+json">{"name":"Ghost of Tsushima DIRECTOR’S CUT"}</script>'
  };
  const fakeGet = async u => pages[(u.match(/concept\/(\d+)/) || [])[1]] || null;

  // Even when the wrong id is referenced more often, the name check rejects it.
  const skewed = '/concept/10015299 /concept/10015299 /concept/10015299 /concept/235227';
  check(await resolveConcept(skewed, 'Ghost of Tsushima', fakeGet) === '235227',
    'concept: a wrong id is rejected by name even when it out-ranks the right one');

  check(await resolveConcept('/concept/10015299', 'Ghost of Tsushima', fakeGet) === null,
    'concept: nothing verifiable yields no concept, rather than a confident wrong one');

  check(await resolveConcept('/concept/10015299', null, fakeGet) === '10015299',
    'concept: with no title to check against, the ranking stands alone');

  check(await resolveConcept('no ids here', 'Ghost of Tsushima', fakeGet) === null,
    'concept: a page with no concept ids yields null');

  // Catalogue prefix matching, against the real catalogue in the repo.
  const { setCatalog, catalogPrefix } = require('./server.js');
  const realCat = loadCatalog('catalog.json');
  if (realCat) {
    setCatalog(realCat);
    check(catalogPrefix('Ghost of Tsushima DIRECTOR’S CUT') === '235227',
      'catalogue: an edition suffix still finds the concept, with no store search',
      '-> ' + catalogPrefix('Ghost of Tsushima DIRECTOR’S CUT'));
    check(catalogPrefix('Ghost of Tsushima') === null,
      'catalogue: an exact name is not a prefix match (the exact lookup handles it)');
    check(catalogPrefix('Horizon') === null,
      'catalogue: typing less than the catalogue knows never guesses a game');
    check(catalogPrefix('Zzzz Not A Real Game At All') === null,
      'catalogue: an unknown title matches nothing');
  }

  // Longest wins, so a suffixed game does not match a shorter unrelated name.
  setCatalog(Object.assign(new Map([['ghost', '1'], ['ghost of tsushima', '2']]),
                           { names: new Map() }));
  check(catalogPrefix('Ghost of Tsushima DIRECTOR’S CUT') === '2',
    'catalogue: the longest matching name wins');
  setCatalog(null);

  // The circular require that took the bot down in production, reproduced the
  // way it actually happened: server.js requires bot.js, which requires
  // server.js straight back. Whichever loads first, both must work. The suite
  // loads server.js first and so never saw it; a child process pins both orders.
  const child = require('child_process');
  const loadOrder = order => {
    const reqs = order.map(f => "require('" + require('path').resolve(f) + "')");
    return "const A=" + reqs[0] + ", B=" + reqs[1] + ";" +
      "const S = A.setCatalog ? A : B, bot = A.suggest ? A : B;" +
      "S.setCatalog(Object.assign(new Map([['ghost of yotei','10014719']])," +
      "  {names:new Map([['10014719','Ghost of Yotei']])}));" +
      "if (typeof S.getCatalog !== 'function') throw new Error('getCatalog missing');" +
      "if (bot.suggest('ghost').length !== 1) throw new Error('suggest broken');" +
      "console.log('ok');";
  };
  for (const order of [['bot.js', 'server.js'], ['server.js', 'bot.js']]) {
    let out = '';
    try { out = child.execFileSync(process.execPath, ['-e', loadOrder(order)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { out = 'threw: ' + (e.stderr || e.message); }
    check(/ok/.test(out), 'circular require survives loading ' + order[0] + ' first',
      out.trim().split('\n').pop());
  }

  // ---------------------------------------------------------------- the bot
  // Intl separates a currency code from its number with a non-breaking space.
  const nb = t => t.replace(/\u00a0/g, ' ');
  // Driven against a stub Telegram API, so every call the bot would make is
  // captured and nothing leaves the machine.
  const calls = [];
  const tsrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      calls.push({ method: req.url.split('/').pop(), body: JSON.parse(b || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
    });
  });
  await new Promise(r => tsrv.listen(0, r));
  process.env.TELEGRAM_API = 'http://localhost:' + tsrv.address().port;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  const bot = require('./bot.js');

  setCatalog(Object.assign(new Map([
    ['ghost of tsushima', '235227'],
    ['ghost of yotei', '10014719'],
    ['horizon forbidden west', '10000886']
  ]), { names: new Map([['235227', 'Ghost of Tsushima'],
                        ['10014719', 'Ghost of Yōtei'],
                        ['10000886', 'Horizon Forbidden West']]) }));

  check(bot.flag('US') === '🇺🇸' && bot.flag('JP') === '🇯🇵' && bot.flag('GB') === '🇬🇧',
    'bot: region codes become flag emoji, which Telegram draws everywhere');
  check(bot.convert(69.99, 'USD', 'SGD', { USD: 1, SGD: 1.35 }).toFixed(2) === '94.49',
    'bot: conversion goes through the USD base rate');
  check(bot.convert(69.99, 'USD', 'XXX', { USD: 1 }) === null,
    'bot: a missing rate converts to nothing rather than a wrong number');

  // The dropdown: prefix matches first, then anything containing the words.
  check(bot.suggest('ghost of').length === 2, 'bot: a partial title suggests every match');
  check(bot.suggest('ghost of')[0].name === 'Ghost of Tsushima',
    'bot: suggestions carry the real title, not the match key');
  check(bot.suggest('a').length === 0, 'bot: one character suggests nothing');
  check(bot.suggest('zzzz').length === 0, 'bot: an unknown title suggests nothing');

  // Ranking: cheapest first in the target currency, redirected regions dropped.
  const sample = {
    title: 'Ghost of Tsushima', priced: 3, total: 20, priceAdjusted: 0,
    results: [
      { region: 'US', currency: 'USD', price: 59.99, original: null, discount: null, editions: [{price:59.99},{price:69.99}], url: 'https://store/us', redirected: false, english: true },
      { region: 'IN', currency: 'INR', price: 2999, original: 4499, discount: '-33%', editions: [], url: 'https://store/in', redirected: false, english: true },
      { region: 'TR', currency: 'USD', price: 49.99, original: null, discount: null, editions: [], url: 'https://store/tr', redirected: true, english: true }
    ]
  };
  const rates = { USD: 1, SGD: 1.35, INR: 83 };
  const ranked = bot.rankRows(sample.results, 'SGD', rates);
  check(ranked.length === 2, 'bot: a redirected region is not ranked');
  check(ranked[0].region === 'IN', 'bot: cheapest in the target currency comes first',
    '-> ' + ranked.map(r => r.region).join(','));

  const shown5 = bot.formatPrices(sample, 'SGD', rates, 5);
  check(shown5.text.includes('🇮🇳') && shown5.text.includes('<s>₹4,499</s>'),
    'bot: a discounted row shows the old price struck through');
  check(!shown5.text.includes('-33%'),
    'bot: and not the percentage as well, which the strikethrough already says');
  check(/<a href="https:\/\/store\/in">S\$48\.78<\/a>/.test(shown5.text),
    'bot: and it is the converted price that carries it');
  check(!shown5.text.includes('editions'),
    'bot: the edition count is gone from the rows');
  check(!shown5.text.includes('ENG'),
    'bot: English support is not announced on every row');
  check(!shown5.text.includes('🇹🇷'), 'bot: the redirected region is absent from the message');
  check(shown5.text.includes('India') && shown5.text.includes('United States'),
    'bot: rows name the country, not just its code');
  const plain5 = shown5.text.replace(/<[^>]+>/g, '').split('\n');
  const plainRows = plain5.filter(l => /^[\d\u2007]+\./.test(l));
  check(plainRows.length === 2, 'bot: one ranked heading per region',
    '-> ' + JSON.stringify(plainRows));
  check(/^1\.\s+🇮🇳 India\s+·\s+S\$48\.78$/.test(plainRows[0]),
    'bot: rank, country and the converted price on the first line', '-> ' + plainRows[0]);
  check(/₹4,499\s+₹2,999$/.test(plain5[plain5.indexOf(plainRows[0]) + 1]),
    'bot: then the old price struck through and the price actually paid',
    '-> ' + plain5[plain5.indexOf(plainRows[0]) + 1].trim());

  // The prices must still line up beneath each other once the ranking reaches
  // double figures, which ordinary spaces cannot do in a proportional font.
  check(bot.rankLabel(0, 5) === '1.' && bot.rankLabel(0, 20) === '\u20071.' &&
        bot.rankLabel(9, 20) === '10.',
    'bot: single-digit ranks are padded with a figure space when the list runs past nine',
    '-> ' + JSON.stringify(bot.rankLabel(0, 20)));
  const wide = bot.formatPrices({ ...sample, results: Array.from({ length: 11 }, (_, k) => ({
    ...sample.results[0], region: 'US', price: 10 + k })) }, 'SGD', rates, 20)
    .text.replace(/<[^>]+>/g, '').split('\n').filter(l => /^[\d\u2007]+\./.test(l));
  check(new Set(wide.map(l => l.indexOf('🇺🇸'))).size === 1,
    'bot: so country names start at the same offset too, rows 1 through 11',
    '-> ' + JSON.stringify([...new Set(wide.map(l => l.indexOf('🇺🇸')))]));
  check(shown5.text.split('\n').filter(l => l.trim()).length === 1 + 2 * 2 + 2,
    'bot: two lines per region, plus a title and a two-line footer',
    '-> ' + shown5.text.split('\n').filter(l => l.trim()).length);
  check(!/Cheapest first/.test(shown5.text),
    'bot: no subtitle restating what the ordering and the symbols already show');
  check(/no live exchange rates/.test(bot.formatPrices(sample, 'SGD', null, 5).text),
    'bot: except when there are no rates, which is not self-evident');

  // Alignment was tried and reverted: a flushed column needs a code span, and
  // Telegram allows no nesting inside one, which costs the strikethrough.
  check(!/<code>/.test(shown5.text) && /<s>/.test(shown5.text),
    'bot: detail lines keep their markup rather than becoming a monospace column');

  // English is three-valued, and unknown must not be reported as unsupported.
  const langs = bot.formatPrices({ ...sample, results: [
    { ...sample.results[0], english: false }, { ...sample.results[1], english: null },
    { ...sample.results[1], region: 'MY', english: true }
  ] }, 'SGD', rates, 5).text;
  check((langs.match(/🚫 ENG/g) || []).length === 1,
    'bot: only the region without English is marked, and only once',
    '-> ' + (langs.match(/🚫 ENG/g) || []).length);

  // Both prices on a row point at the same page.
  check((shown5.text.match(/href="https:\/\/store\/in"/g) || []).length === 1,
    'bot: one link per region -- the converted price; the store\'s own is plain text',
    '-> ' + (shown5.text.match(/href="https:\/\/store\/in"/g) || []).length);

  // The narrow symbol for SGD is a bare "$", which is the ambiguity the whole
  // column exists to resolve.
  check(bot.converted('SGD', 47.28) === 'S$47.28' && bot.converted('USD', 69.99) === 'US$69.99' &&
        bot.converted('TWD', 1412) === 'NT$1,412',
    'bot: the converted column never prints a bare dollar sign',
    '-> ' + bot.converted('SGD', 47.28));
  check(nb(bot.money('TWD', 1412)) === 'NT$1,412' && nb(bot.money('UAH', 1649)) === 'UAH 1,649',
    'bot: local prices keep the disambiguated symbol their store uses',
    '-> ' + bot.money('TWD', 1412));

  const none = bot.formatPrices({ title: 'X', priced: 0, total: 20, results: [] }, 'SGD', rates, 5);
  check(none.rows === 0 && /No region/.test(none.text), 'bot: a game with no prices says so');

  // The footer is a count, with the edition tally under it.
  const foot5 = shown5.text.replace(/<[^>]+>/g, '').trim().split('\n');
  check(foot5[foot5.length - 2].trim() === '3/20 Regions Priced.',
    'bot: the footer is the count, said once', '-> ' + foot5[foot5.length - 2]);

  // Nearly every storefront lists the same editions, so one number covers them.
  const ed = (region, n) => ({ region, currency: 'USD', price: 10, original: null,
    discount: null, editions: Array.from({ length: n }, (_, k) => ({ price: k + 1 })),
    url: 'https://s/' + region, redirected: false, english: true });
  const tally = res => bot.editionSummary(res);
  check(tally([ed('US', 2), ed('IN', 2), ed('JP', 2)]) === '2 Editions Found.',
    'bot: agreement across regions is one number', '-> ' + tally([ed('US', 2), ed('IN', 2)]));
  check(tally([ed('US', 1), ed('IN', 1)]) === '1 Edition Found.',
    'bot: and it is singular when there is one');

  // A storefront that differs is named rather than averaged away.
  check(tally([ed('US', 2), ed('IN', 2), ed('JP', 2), ed('KR', 3)]) ===
        '2 Editions Found. 3 Editions in 🇰🇷',
    'bot: a region with more editions is called out',
    '-> ' + tally([ed('US', 2), ed('IN', 2), ed('JP', 2), ed('KR', 3)]));
  check(tally([ed('US', 2), ed('IN', 2), ed('KR', 3), ed('JP', 3)]).includes('3 Editions in 🇰🇷 🇯🇵'),
    'bot: regions sharing an odd count are named together',
    '-> ' + tally([ed('US', 2), ed('IN', 2), ed('KR', 3), ed('JP', 3)]));
  check(tally([ed('US', 2), ed('IN', 2), ed('KR', 1), ed('JP', 4)]) ===
        '2 Editions Found. 1 Edition in 🇰🇷 4 Editions in 🇯🇵',
    'bot: several odd counts are listed smallest first',
    '-> ' + tally([ed('US', 2), ed('IN', 2), ed('KR', 1), ed('JP', 4)]));

  // On a tie the smaller count is the norm: extra listings are the anomaly.
  check(tally([ed('US', 2), ed('KR', 3)]) === '2 Editions Found. 3 Editions in 🇰🇷',
    'bot: on a tie the smaller count is treated as the norm',
    '-> ' + tally([ed('US', 2), ed('KR', 3)]));

  check(tally([{ region: 'US', editions: [] }]) === null,
    'bot: regions with no editions say nothing either way');
  check(tally([]) === null && tally(null) === null, 'bot: and no results, no line');

  const noFx = bot.formatPrices(sample, 'SGD', null, 5);
  check(/local prices only/i.test(noFx.text),
    'bot: without rates the local prices still show, as on the website');

  // The home price: the reference every other row is read against, and usually
  // nowhere near the top five.
  check(bot.homeRegion('SGD') === 'SG' && bot.homeRegion('EUR') === 'DE' &&
        bot.homeRegion('USD') === 'US',
    'bot: the home store follows the currency being converted into');
  check(bot.homeRegion('XXX') === null, 'bot: an unknown currency has no home store');

  const withHome = {
    ...sample,
    results: [...sample.results,
      { region: 'SG', currency: 'SGD', price: 98.9, original: null, discount: null,
        editions: [], url: 'https://store/sg', redirected: false, english: true }]
  };
  const homed = bot.formatPrices(withHome, 'SGD', rates, 5);
  check(homed.home && homed.home.text === '🇸🇬 S$98.90',
    'bot: the home price becomes a compact button, not a line of text',
    '-> ' + JSON.stringify(homed.home));
  check(homed.home.url === 'https://store/sg', 'bot: and the button links to the home store');
  check(!homed.text.includes('🏠'),
    'bot: so it no longer takes a line above the list (it still ranks as a region)');

  const kb = bot.keyboard(homed, 'tok').inline_keyboard[0];
  check(kb.length === 2 && kb[0].url && kb[1].text === 'Show More',
    'bot: home and Show More share one row, so both render as small chips',
    '-> ' + JSON.stringify(kb.map(b2 => b2.text)));
  check(bot.keyboard(homed, null).inline_keyboard[0].length === 1,
    'bot: with nothing more to show, only the home button remains');
  check(bot.keyboard({ home: null }, null) === undefined,
    'bot: and no buttons at all rather than an empty row');

  // A home region that is itself the cheapest must not claim a saving.
  const cheapHome = {
    ...sample,
    results: [{ region: 'SG', currency: 'SGD', price: 9.9, original: null, discount: null,
                editions: [], url: 'https://store/sg', redirected: false, english: true },
              ...sample.results]
  };
  check(bot.formatPrices(cheapHome, 'SGD', rates, 5).home !== null,
    'bot: the home button shows wherever home ranks');

  // No price at home, and no rates at all: neither may break the message.
  check(bot.formatPrices(sample, 'SGD', rates, 5).home === null,
    'bot: an unpriced home region yields no button');
  check(nb(bot.formatPrices(withHome, 'SGD', null, 5).home.text) === '🇸🇬 SGD 98.90',
    'bot: without rates the home button still shows, in its own currency',
    '-> ' + bot.formatPrices(withHome, 'SGD', null, 5).home.text);

  // /start and /cur need no network at all.
  calls.length = 0;
  await bot.handleUpdate({ message: { chat: { id: 7 }, text: '/start' } });
  check(calls[0].method === 'sendMessage' && /price check/i.test(calls[0].body.text),
    'bot: /start explains itself');

  calls.length = 0;
  await bot.handleUpdate({ message: { chat: { id: 7 }, text: '/cur usd' } });
  check(/USD/.test(calls[0].body.text) && bot.target.get(7) === 'USD',
    'bot: /cur switches the conversion currency for that chat');

  // An ambiguous title offers buttons -- the dropdown, in a chat.
  calls.length = 0;
  await bot.handleUpdate({ message: { chat: { id: 7 }, text: 'ghost of' } });
  const pickKb = calls[0].body.reply_markup.inline_keyboard;
  check(pickKb.length === 2 && pickKb[0][0].callback_data === 'g:235227',
    'bot: an ambiguous title offers each match as a button',
    '-> ' + JSON.stringify(pickKb.map(r => r[0].text)));

  // Show more replays a finished lookup without touching the store again.
  calls.length = 0;
  const token = bot.remember(sample);
  await bot.handleUpdate({ callback_query: { id: '1', data: 'm:' + token,
    message: { message_id: 42, chat: { id: 7 } } } });
  const edit = calls.find(c => c.method === 'editMessageText');
  check(edit && edit.body.text.includes('🇺🇸') && edit.body.text.includes('🇮🇳'),
    'bot: "show all" re-renders every region from the cached result');

  calls.length = 0;
  await bot.handleUpdate({ callback_query: { id: '1', data: 'm:gone',
    message: { message_id: 42, chat: { id: 7 } } } });
  check(calls.some(c => /expired/.test(c.body.text || '')),
    'bot: an expired "show all" says so rather than failing silently');

  // Inline mode answers from memory only: no store request, no price lookup.
  calls.length = 0;
  await bot.handleUpdate({ inline_query: { id: '9', query: 'ghost of' } });
  const inline = calls[0];
  check(inline.method === 'answerInlineQuery' && inline.body.results.length === 2,
    'bot: inline typing returns the catalogue matches');
  check(inline.body.results[0].input_message_content.message_text === '/p 235227',
    'bot: picking an inline result sends the concept id, not the title');

  // A malformed update must never take the bot down.
  await bot.handleUpdate({});
  await bot.handleUpdate({ message: {} });
  check(true, 'bot: an update it does not understand is ignored quietly');

  // Polling: the abort must outlast the long poll, or every connection is
  // cancelled before Telegram has a chance to answer it.
  const polls = [];
  const psrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = JSON.parse(b || '{}');
      if (method === 'getUpdates') {
        polls.push(body);
        // Answer like a real long poll would: hold, then return nothing.
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: [] }));
        }, 300);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  await new Promise(r => psrv.listen(0, r));
  process.env.TELEGRAM_API = 'http://localhost:' + psrv.address().port;
  delete require.cache[require.resolve('./bot.js')];
  const bot2 = require('./bot.js');
  bot2.startPolling();
  await new Promise(r => setTimeout(r, 900));
  check(polls.length >= 1 && polls[0].timeout > 0 && polls[0].timeout <= 30,
    'bot: the long poll asks Telegram to hold the connection',
    '-> timeout=' + (polls[0] || {}).timeout);
  check(polls[0].allowed_updates.includes('inline_query'),
    'bot: inline queries are among the updates asked for');
  psrv.close();
  delete require.cache[require.resolve('./bot.js')];

  tsrv.close();
  setCatalog(null);

  // Cover art. Read off pages already fetched for prices, so it costs no
  // request, and shown as a link preview rather than a photo message.
  const IMG = 'https://image.api.playstation.com/vulcan/ap/rnd/x.png';
  check(coverImage('<script type="application/ld+json">{"image":"' + IMG + '"}</script>') === IMG,
    'coverImage: JSON-LD carries the product image');
  check(coverImage('<meta property="og:image" content="' + IMG + '?w=440">') === IMG + '?w=440',
    'coverImage: og:image is the fallback every storefront answers with');
  check(coverImage('<meta content="' + IMG + '" property="og:image">') === IMG,
    'coverImage: attribute order does not matter');
  check(coverImage('"image":"' + IMG + '?a=1&amp;b=2"') === IMG + '?a=1&b=2',
    'coverImage: an escaped query string is unescaped, or the fetch would 404');
  check(coverImage('"image":"/vulcan/relative.png"') === null,
    'coverImage: a relative URL is no use to Telegram, so it is not offered');
  check(coverImage('"image":"http://insecure/x.png"') === null,
    'coverImage: nor an insecure one');
  check(coverImage('<html>no art here</html>') === null, 'coverImage: and none is null');

  check(JSON.stringify(bot.preview(IMG)) ===
        JSON.stringify({ url: IMG, prefer_large_media: true, show_above_text: true }),
    'bot: the cover is a preview above the text, at full width');
  check(bot.preview(null).is_disabled === true,
    'bot: a game with no artwork gets no preview rather than an empty one');

  console.log('\n' + (fails === 0 ? 'All checks passed.' : fails + ' check(s) FAILED.'));
  process.exit(fails === 0 ? 0 : 1);
})();
