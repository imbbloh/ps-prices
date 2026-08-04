// Offline unit tests for the price parser + resolver helpers (no network needed).
// Run: node test.js
//
// A fake store on localhost stands in for store.playstation.com, so the 3-tier
// resolver is exercised for real without touching the network.
const PORT = 39217;
process.env.PS_BASE = 'http://localhost:' + PORT;

const { parseNum, grab, pool, productIds, conceptId, conceptIds, parseQuery, acceptLang,
        isAccepted, isForeign, region, languages, keyName, loadCatalog } = require('./server.js');
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
check(ED.editions === 3, 'grab() reports how many priced entries it saw', '-> ' + ED.editions);

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
check(WA.editions === 2 && WA.onPage === 4, 'grab() counts games separately from everything priced',
  '-> ' + WA.editions + ' games of ' + WA.onPage + ' entries');

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
check(RL.editions === 5 && RL.onPage === 8,
  'grab() real layout: five game entries, eight priced in all', '-> ' + RL.editions + ' of ' + RL.onPage);

// "ITEM" alone must not be mistaken for a game.
const itemOnly = '<html>' + blk('$69.99', '$69.99', null) + blk('$19.99', '$19.99', 'ITEM') + '</html>';
check(grab(itemOnly).price === 69.99, 'grab() ITEM is an add-on, not a game', '-> ' + grab(itemOnly).price);

// An add-on class we have never seen still gets dropped, because everything
// after the carousel begins is discarded.
const unknownAddon = '<html>' + blk('$69.99', '$69.99', null) +
  blk('$9.99', '$9.99', 'VIRTUAL_CURRENCY') + blk('$1.99', '$1.99', 'SOMETHING_ELSE') + '</html>';
check(grab(unknownAddon).price === 69.99, 'grab() drops everything after the add-on carousel starts',
  '-> ' + grab(unknownAddon).price);

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

  console.log('\n' + (fails === 0 ? 'All checks passed.' : fails + ' check(s) FAILED.'));
  process.exit(fails === 0 ? 0 : 1);
})();
