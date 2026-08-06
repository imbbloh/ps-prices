// Telegram front end for the same price lookup the website uses.
//
// It shares server.js outright -- the catalogue, the resolver, the extractor,
// the cross-region reconciliation -- so a fix to prices is a fix here too, and
// there is no second copy of any of it to drift.
//
// Three ways in, because Telegram has no equivalent of a text box with a
// dropdown under it:
//
//   INLINE     Typing "@yourbot ghost" in any chat asks the bot for matches as
//              you type, and Telegram renders them as a live list. This is the
//              closest thing to the website's suggestion dropdown, and it is
//              the reason the catalogue matters here: matching runs in memory
//              against 12,000 names, so it answers instantly.
//   BUTTONS    Sending a title to the bot directly. When the text matches one
//              game it prices it; when it matches several it offers them as
//              buttons, which is the dropdown again in a form that works in a
//              plain chat.
//   COMMANDS   /start, /cur, and a concept ID or store URL pasted straight in.
//
// Prices take ten to forty seconds (twenty storefronts, and a cold Render dyno
// before them), which is far too long for a silent chat. So every lookup posts
// "Looking up..." immediately and edits that same message when the results
// land, rather than leaving the user wondering.
//
// Long polling by default: it needs no public URL and keeps the free dyno awake
// so the next lookup is not a cold start. Set TELEGRAM_WEBHOOK_SECRET to have
// server.js accept updates on a secret path instead.

// Held as a module reference, not destructured. server.js requires this file
// back, and a circular require returns whatever the other module has exported so
// far -- which, at the moment it loads the bot, may be nothing at all.
// Destructuring freezes those undefined values forever; reading through the
// reference at call time picks up the real functions once both files finish
// loading.
const S = require('./server.js');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const FX_URL = process.env.FX_URL || 'https://open.er-api.com/v6/latest/USD';

const TOP = 5;                       // regions shown before "Show more"
const SUGGEST = 8;                   // buttons offered when a title is ambiguous
const INLINE = 20;                   // Telegram's own cap on inline results
const FX_TTL = 6 * 3600 * 1000;      // the rates are daily; six hours is plenty
const CACHE_TTL = 10 * 60 * 1000;    // a "Show more" press long after the fact

// ---------------------------------------------------------------- transport

// Every failure here used to return null silently, which made a broken bot look
// like an idle one: no reply, no log line, nothing to go on. Telegram explains
// its refusals in `description`, so say so.
async function tg(method, body, ms = 20000) {
  if (!TOKEN) return null;
  try {
    const r = await fetch(API + '/bot' + TOKEN + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms)
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok) return j.result;
    // 409 means a second instance is polling the same token -- an old Render
    // deploy still winding down, or a webhook left set. Updates go to whichever
    // asked last, so this looks exactly like messages being ignored.
    console.error('telegram: ' + method + ' -> ' +
      ((j && (j.description || j.error_code)) || 'HTTP ' + r.status));
    return null;
  } catch (e) {
    console.error('telegram: ' + method + ' -> ' + (e.name === 'TimeoutError' ? 'timed out' : e.message));
    return null;
  }
}

// ---------------------------------------------------------------- currency

let fxCache = { rates: null, ts: 0 };
async function getFx() {
  if (fxCache.rates && Date.now() - fxCache.ts < FX_TTL) return fxCache;
  try {
    const j = await (await fetch(FX_URL, { signal: AbortSignal.timeout(10000) })).json();
    if (j && j.rates) fxCache = { rates: j.rates, ts: Date.now() };
  } catch (e) { /* keep whatever we had: stale rates beat no prices */ }
  return fxCache;
}

// Rates are quoted against USD, so any pair is one divide and one multiply.
const convert = (price, from, to, rates) =>
  (rates && rates[from] && rates[to]) ? (price / rates[from]) * rates[to] : null;

// Local prices use the disambiguated symbol, because twenty storefronts put
// several dollars and several kroner next to each other and a bare "$" would be
// a lie in half of them -- TWD prints NT$, UAH prints UAH. The converted column
// uses the narrow symbol instead: it repeats on every row, the header already
// names the currency, and "S$47.28" reads better than "SGD 47.28" twenty times.
function money(cur, n, narrow) {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency', currency: cur,
      currencyDisplay: narrow ? 'narrowSymbol' : 'symbol',
      maximumFractionDigits: n >= 1000 ? 0 : 2
    }).format(n);
  } catch (e) { return cur + ' ' + n; }
}

// The narrow symbol for SGD is a bare "$", which is exactly the ambiguity the
// disambiguated form exists to avoid -- and this is the column every row is
// compared on. These are the compact-but-unambiguous forms people actually
// write; anything not listed falls back to the narrow symbol.
const COMPACT = { SGD: 'S$', USD: 'US$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', HKD: 'HK$', TWD: 'NT$' };
function converted(cur, n) {
  const p = COMPACT[cur];
  if (!p) return money(cur, n, true);
  const digits = n >= 1000 ? 0 : 2;
  return p + new Intl.NumberFormat('en', {
    minimumFractionDigits: digits, maximumFractionDigits: digits
  }).format(n);
}

// Region codes are for the URL bar. A list of places to buy something should
// name the places.
const REGION_NAMES = {
  US: 'United States', UA: 'Ukraine', IN: 'India', JP: 'Japan', BR: 'Brazil',
  TR: 'Turkey', ID: 'Indonesia', MY: 'Malaysia', TW: 'Taiwan', HK: 'Hong Kong',
  KR: 'South Korea', ZA: 'South Africa', PL: 'Poland', NO: 'Norway',
  CA: 'Canada', AU: 'Australia', MX: 'Mexico', GB: 'United Kingdom',
  DE: 'Germany', SG: 'Singapore'
};

// US -> 🇺🇸. Telegram draws these itself on every platform, so unlike the
// website -- where Chrome on Windows has no glyphs and needs image flags --
// the emoji are safe here.
const flag = r => String.fromCodePoint(...[...r.toUpperCase()]
  .map(c => 0x1f1e6 + c.charCodeAt(0) - 65));

// ---------------------------------------------------------------- matching

// The same prefix logic the website's dropdown uses: match on the loose key so
// punctuation, trademark signs and case cannot get in the way.
function suggest(q, limit = SUGGEST) {
  const cat = S.getCatalog();
  const k = S.keyName(q || '');
  if (!cat || k.length < 2) return [];
  const starts = [], has = [];
  for (const [name, id] of cat) {
    if (name.startsWith(k)) starts.push([name, id]);
    else if (name.includes(k)) has.push([name, id]);
    if (starts.length >= limit) break;
  }
  // Prefixes first: someone typing "ghost of" wants Ghost of Tsushima before
  // any game with "ghost of" buried in the middle of its name.
  return [...starts, ...has].slice(0, limit).map(([name, id]) => ({
    conceptId: id,
    name: (cat.names && cat.names.get(id)) || name
  }));
}

// ---------------------------------------------------------------- rendering

const esc = s => ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Ranked cheapest first in the target currency. Regions the store redirected to
// a foreign currency are dropped: their price is real but it is not that
// region's, so ranking them would be comparing the wrong thing.
function rankRows(results, target, rates) {
  return results
    .filter(x => x.price != null && !x.redirected)
    .map(x => ({ ...x, conv: convert(x.price, x.currency, target, rates) }))
    .sort((a, b) => (a.conv == null) - (b.conv == null) || (a.conv - b.conv));
}

// Two lines per region rather than one long one. Everything used to run
// together on a single row that wrapped mid-price on a phone; splitting it puts
// the number being compared -- the converted price -- at the end of a short
// first line, and the store's own price with its discount underneath.
// Telegram has no text alignment. The only fixed-width context it offers is a
// code span, so flushing anything right means rendering that whole line as one
// -- which rules out a link or a strikethrough inside it, since Telegram allows
// no nesting there. Hence the link moves up to the country name on the first
// line, where it stays clickable, and the old price is prefixed "was" instead
// of being struck through.
const DETAIL_W = 34;                   // fits a phone's monospace width without wrapping

function line(x, target, i) {
  const place = REGION_NAMES[x.region] || x.region;
  const conv = x.conv != null ? converted(target, x.conv) : '—';
  const name = x.url ? '<a href="' + esc(x.url) + '">' + esc(place) + '</a>' : esc(place);
  const head = '<b>' + (i + 1) + '. ' + flag(x.region) + ' ' + name +
               '  ·  ' + esc(conv) + '</b>';

  const left = [money(x.currency, x.price)];
  if (x.original != null) left.push('was ' + money(x.currency, x.original));
  if (x.english === false) left.push('no English');
  const right = x.editions && x.editions.length > 1 ? x.editions.length + ' editions' : '';

  let detail = left.join('  ');
  // Pad to the column when it fits; when it does not, one space, because a
  // wrapped line is worse than an unaligned one.
  if (right) detail += ' '.repeat(Math.max(1, DETAIL_W - detail.length - right.length)) + right;
  return head + '\n<code>' + esc(detail) + '</code>';
}

// The home store, worked out from the currency being converted into: SGD -> SG,
// EUR -> DE. Its price is the one worth comparing everything against -- a list
// of cheap regions means nothing without knowing what the game costs at home --
// and it is usually nowhere near the top five.
function homeRegion(target) {
  const S_ = require('./server.js');
  return Object.keys(S_.EXPECT).find(r => S_.EXPECT[r] === target) || null;
}

function homeLine(pr, target, rates, cheapest) {
  const home = homeRegion(target);
  if (!home) return null;
  const row = pr.results.find(x => x.region === home && x.price != null);
  if (!row) return null;
  const conv = convert(row.price, row.currency, target, rates);
  // The price alone: the list underneath already shows what the cheapest region
  // costs, so spelling out the difference was arithmetic the reader can see.
  const link = row.url ? '<a href="' + esc(row.url) + '">' + esc(REGION_NAMES[home] || home) + '</a>'
                       : esc(REGION_NAMES[home] || home);
  return '<b>🏠 ' + flag(home) + ' ' + link + '  ·  ' +
         esc(conv != null ? converted(target, conv) : money(row.currency, row.price)) + '</b>';
}

function formatPrices(pr, target, rates, limit) {
  const rows = rankRows(pr.results, target, rates);
  if (!rows.length) {
    return { text: '<b>' + esc(pr.title) + '</b>\nNo region has a price for this one.', rows: 0 };
  }
  const shown = rows.slice(0, limit);
  const body = shown.map((x, i) => line(x, target, i)).join('\n');
  const head = '🎮 <b>' + esc(pr.title) + '</b>\n<i>' +
    esc(rates ? 'Cheapest first, converted to ' + target
              : 'Local prices only — no live exchange rates') + '</i>';
  // The home price goes above the list, not buried in it: it is the reference
  // every other number is being read against.
  const home = homeLine(pr, target, rates, rows[0]);
  const foot = [
    pr.priced + ' of ' + pr.total + ' regions priced',
    shown.length < rows.length ? 'showing ' + shown.length : null,
    pr.priceAdjusted ? pr.priceAdjusted + ' re-checked against other regions' : null
  ].filter(Boolean).join(' · ');
  return {
    text: head + (home ? '\n\n' + home : '') + '\n\n' + body + '\n\n<i>' + esc(foot) + '</i>',
    rows: rows.length
  };
}

// ---------------------------------------------------------------- state

// Two small in-memory maps. Losing either on restart costs a user one repeated
// search, so neither is worth a database.
const target = new Map();            // chat id -> currency to convert into
const recent = new Map();            // token -> a finished lookup, for "Show more"

function remember(pr) {
  const token = Math.random().toString(36).slice(2, 10);
  recent.set(token, { pr, ts: Date.now() });
  for (const [k, v] of recent) if (Date.now() - v.ts > CACHE_TTL) recent.delete(k);
  return token;
}

// ---------------------------------------------------------------- flows

const HELP = [
  '<b>PlayStation price check</b>',
  '',
  'Send a game title and I will price it in 20 regions, cheapest first.',
  '',
  '· Type <code>@BOT ghost of</code> in any chat for a live list of titles.',
  '· A concept ID or a store URL works too.',
  '· <code>/cur USD</code> changes the currency I convert into (default SGD).'
].join('\n');

async function priceInto(chatId, messageId, query, cur) {
  const pr = await S.lookup(query);
  if (pr.error) {
    return tg('editMessageText', {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      text: esc(pr.error)
    });
  }
  const { rates } = await getFx();
  const out = formatPrices(pr, cur, rates, TOP);
  const token = remember(pr);
  return tg('editMessageText', {
    chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: out.text,
    reply_markup: out.rows > TOP
      ? { inline_keyboard: [[{ text: 'Show all ' + out.rows + ' regions', callback_data: 'm:' + token }]] }
      : undefined
  });
}

// Posts the placeholder first: twenty storefronts take far too long to leave a
// chat silent, and editing one message reads better than a second one arriving.
async function startLookup(chatId, query, label, cur) {
  const msg = await tg('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: 'Looking up <b>' + esc(label || query) + '</b>…'
  });
  if (!msg) return;
  return priceInto(chatId, msg.message_id, query, cur);
}

async function onText(chatId, text) {
  const cur = target.get(chatId) || 'SGD';
  const t = text.trim();

  if (/^\/(start|help)/.test(t)) {
    return tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: HELP });
  }
  if (/^\/cur/i.test(t)) {
    const c = (t.split(/\s+/)[1] || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) {
      return tg('sendMessage', { chat_id: chatId, text: 'Currency now: ' + cur + '. Use e.g. /cur USD' });
    }
    target.set(chatId, c);
    return tg('sendMessage', { chat_id: chatId, text: 'Converting into ' + c + ' from now on.' });
  }

  // "/p 235227" is what an inline pick sends back; a pasted URL or bare ID is
  // the same thing typed by hand. All go straight to the lookup.
  const direct = t.replace(/^\/p\s+/, '');
  if (/^\d{5,}$/.test(direct) || /store\.playstation\.com/.test(direct)) {
    return startLookup(chatId, direct, direct, cur);
  }

  // One catalogue match, or a title specific enough to resolve on its own:
  // price it. Several matches: offer them, which is the dropdown in a chat.
  const cat = S.getCatalog();
  const exact = cat && (cat.get(S.keyName(t)) || S.catalogPrefix(t));
  if (exact) return startLookup(chatId, t, t, cur);

  const hits = suggest(t);
  if (hits.length === 1) return startLookup(chatId, hits[0].conceptId, hits[0].name, cur);
  if (hits.length) {
    return tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: 'Which one?',
      reply_markup: {
        inline_keyboard: hits.map(h => [{
          text: h.name.length > 60 ? h.name.slice(0, 57) + '…' : h.name,
          callback_data: 'g:' + h.conceptId
        }])
      }
    });
  }
  // Nothing catalogued: the store's own search still resolves plenty.
  return startLookup(chatId, t, t, cur);
}

async function onCallback(cb) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const data = cb.data || '';
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  if (!chatId) return;
  const cur = target.get(chatId) || 'SGD';

  if (data.startsWith('g:')) {                     // a title was picked
    const cat = S.getCatalog();
    const id = data.slice(2);
    const name = (cat && cat.names && cat.names.get(id)) || id;
    return tg('editMessageText', {
      chat_id: chatId, message_id: cb.message.message_id, parse_mode: 'HTML',
      text: 'Looking up <b>' + esc(name) + '</b>…'
    }).then(() => priceInto(chatId, cb.message.message_id, id, cur));
  }

  if (data.startsWith('m:')) {                     // show every region
    const hit = recent.get(data.slice(2));
    if (!hit) {
      return tg('sendMessage', { chat_id: chatId, text: 'That search has expired — send the title again.' });
    }
    const { rates } = await getFx();
    const out = formatPrices(hit.pr, cur, rates, Object.keys(S.LOCALES).length);
    return tg('editMessageText', {
      chat_id: chatId, message_id: cb.message.message_id, parse_mode: 'HTML',
      disable_web_page_preview: true, text: out.text
    });
  }
}

// The live dropdown. Answers from the in-memory catalogue only -- no store
// request, no price lookup -- because Telegram expects an inline answer in well
// under a second and prices take tens of them.
async function onInline(q) {
  const hits = suggest(q.query, INLINE);
  return tg('answerInlineQuery', {
    inline_query_id: q.id,
    cache_time: 60,
    results: hits.map(h => ({
      type: 'article',
      id: String(h.conceptId),
      title: h.name,
      description: 'Price it in 20 regions',
      input_message_content: { message_text: '/p ' + h.conceptId }
    }))
  });
}

async function handleUpdate(u) {
  try {
    // One line per update, so a quiet bot can be told apart from a deaf one.
    const what = u.inline_query ? 'inline ' + JSON.stringify(u.inline_query.query)
      : u.callback_query ? 'button ' + u.callback_query.data
      : (u.message && u.message.text) ? 'text ' + JSON.stringify(u.message.text)
      : Object.keys(u).filter(k => k !== 'update_id').join(',');
    console.log('telegram: ' + what);
    if (u.inline_query) return await onInline(u.inline_query);
    if (u.callback_query) return await onCallback(u.callback_query);
    const m = u.message || u.edited_message;
    if (m && m.text && m.chat) return await onText(m.chat.id, m.text);
  } catch (e) {
    // One malformed update must never take the bot down.
    console.error('bot: ' + (e && e.message));
  }
}

// ---------------------------------------------------------------- polling

// Long polling needs no public URL, and the open request keeps the free Render
// dyno awake -- which also spares the next searcher a cold start.
const POLL = 25;                       // seconds Telegram holds an empty poll open

async function startPolling() {
  if (!TOKEN) return;
  await tg('deleteWebhook', { drop_pending_updates: false });
  let offset = 0;
  console.log('telegram: polling');
  for (;;) {
    // The abort has to outlast the long poll. It did not -- a 50 s poll under a
    // 20 s abort was cancelled every single time, so the bot spent its life
    // restarting the connection and answered only what happened to arrive in
    // the first few seconds of a window.
    const ups = await tg('getUpdates',
      { offset, timeout: POLL, allowed_updates: ['message', 'callback_query', 'inline_query'] },
      (POLL + 15) * 1000);
    if (!ups) { await new Promise(r => setTimeout(r, 3000)); continue; }
    for (const u of ups) {
      offset = u.update_id + 1;
      handleUpdate(u);                 // not awaited: a slow lookup must not
    }                                  // stall the next person's message
  }
}

module.exports = {
  handleUpdate, startPolling, suggest, rankRows, formatPrices,
  convert, money, converted, flag, homeLine, homeRegion, remember, recent, target, tg, hasToken: () => !!TOKEN
};
