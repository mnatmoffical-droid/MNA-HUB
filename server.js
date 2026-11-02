'use strict';
// MNA Hub: аккаунты с уникальными никами, друзья, чат, приглашения в игру.
// Без внешних зависимостей, нужен только Node.js 18+. Данные хранятся в data/db.json.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const VERSION = '1.1.0', PROTO = 2;
const env = process.env;
const PORT = env.PORT === undefined ? 8787 : +env.PORT;
const HOST = env.HOST || '0.0.0.0';
const DATA = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
const DBF = path.join(DATA, 'db.json');
const CF_KEY = env.CF_KEY || '';
const CF_BASE = env.CF_BASE || 'https://api.curseforge.com';
const REG_CODE = env.REG_CODE || '';
const ADMIN_KEY = env.ADMIN_KEY || '';
const TRUST_PROXY = env.TRUST_PROXY === '1';
const MAX_USERS = +env.MAX_USERS || 5000;
const REG_PER_HOUR = +env.REG_PER_HOUR || 10;
const MAX_FRIENDS = 200, MAX_PENDING = 50, HISTORY = 500, SESSION_TTL = 90 * 864e5;
const RESERVED = new Set(['admin', 'administrator', 'moderator', 'mna', 'system', 'server', 'console', 'owner', 'support']);
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const ADDR_RE = /^(?!-)[A-Za-z0-9._:\[\]-]{1,80}$/;

// ---------- хранилище ----------
let db = { v: 2, users: {}, byNick: {}, rels: {}, msgs: {}, sessions: {}, codes: {}, rooms: { global: [] } };
function load() {
  fs.mkdirSync(DATA, { recursive: true });
  try { db = { ...db, ...JSON.parse(fs.readFileSync(DBF, 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') { console.error('db.json повреждён или не читается: ' + e.message); process.exit(1); } }
  loadConf();
  const now = Date.now();
  for (const [k, s] of Object.entries(db.sessions)) if (!db.users[s.uid] || now - s.ts > SESSION_TTL) delete db.sessions[k];
}
let saveT = null;
function save() { if (!saveT) saveT = setTimeout(flush, 400); }
function flush() {
  clearTimeout(saveT); saveT = null;
  const tmp = DBF + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DBF);
}

// ---------- утилиты ----------
class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpErr(code, msg); };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomBytes(6).toString('hex');
const pk = (a, b) => a < b ? a + ':' + b : b + ':' + a;
const TIER_IDS = ['free', 'plus', 'plusplus', 'pro', 'admin'], TRANK = Object.fromEntries(TIER_IDS.map((t, i) => [t, i]));
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const tierOf = u => (u && own(TRANK, u.tier) ? u.tier : 'free');
const NICK_FONTS = ['sans', 'serif', 'mono', 'script', 'impact', 'comic', 'rounded', 'wide'], EFFECTS = ['none', 'gradient', 'shimmer', 'rainbow', 'glow'];
const hexc = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d);
function normStyle(s) { // то же правило, что и в лаунчере (tiers.js): только значения из белых списков
  if (!s || typeof s !== 'object') return null;
  const color = hexc(s.color, '#ffffff');
  return { font: NICK_FONTS.includes(s.font) ? s.font : 'sans', color, color2: hexc(s.color2, color), effect: EFFECTS.includes(s.effect) ? s.effect : 'none', bold: s.bold === true, italic: s.italic === true };
}
const styleOf = u => (TRANK[tierOf(u)] >= TRANK.pro && u.style ? u.style : null);
const pub = u => { const o = { id: u.id, nick: u.nick, tier: tierOf(u) }, st = styleOf(u); if (st) o.style = st; return o; };
let CONF = { currency: 'USD', prices: { plus: 0.99, plusplus: 2.99, pro: 4.99 }, buyUrls: {} };
function loadConf() { // data/config.json (необязательно): цены и ссылки на оплату
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
    if (typeof c.currency === 'string' && /^[A-Za-z$€₽£]{1,5}$/.test(c.currency)) CONF.currency = c.currency;
    for (const t of ['plus', 'plusplus', 'pro']) {
      if (c.prices && Number.isFinite(+c.prices[t]) && +c.prices[t] >= 0) CONF.prices[t] = +c.prices[t];
      if (c.buyUrls && /^https:\/\/[^\s"'<>]+$/.test(String(c.buyUrls[t] || ''))) CONF.buyUrls[t] = c.buyUrls[t];
    }
  } catch {}
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const J = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(b);
};
function readBody(req, limit = 8192) {
  return new Promise((ok, no) => {
    let n = 0, over = false; const ch = [];
    req.on('data', c => { n += c.length; if (n > limit) { over = true; ch.length = 0; } else ch.push(c); });
    req.on('end', () => {
      if (over) return no(new HttpErr(413, 'Слишком большой запрос'));
      if (!n) return ok({});
      try { const o = JSON.parse(Buffer.concat(ch).toString('utf8')); ok(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); }
      catch { no(new HttpErr(400, 'Неверный JSON')); }
    });
    req.on('error', no);
  });
}
const buckets = new Map();
const peek = (key, ms) => { const now = Date.now(), a = buckets.get(key); if (!a) return 0; while (a.length && a[0] <= now - ms) a.shift(); return a.length; };
const mark = key => { let a = buckets.get(key); if (!a) buckets.set(key, a = []); a.push(Date.now()); };
const limit = (key, max, ms, msg) => { if (peek(key, ms) >= max) fail(429, msg || 'Слишком часто, подожди немного'); mark(key); };
setInterval(() => { const now = Date.now(); for (const [k, a] of buckets) if (!a.length || a[a.length - 1] < now - 3600e3) buckets.delete(k); }, 60e3).unref();
const ipOf = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

function checkNick(n) {
  if (!NICK_RE.test(n)) fail(400, 'Ник: 3–16 символов, только латиница, цифры и _');
  if (RESERVED.has(n.toLowerCase())) fail(400, 'Этот ник зарезервирован');
}
function checkPass(p) { if (typeof p !== 'string' || p.length < 6 || p.length > 72) fail(400, 'Пароль: от 6 до 72 символов'); }
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 32)).toString('hex');

// ---------- сессии ----------
function auth(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) fail(401, 'Нужен вход');
  const th = sha(m[1]), s = db.sessions[th], now = Date.now();
  if (!s || !db.users[s.uid] || now - s.ts > SESSION_TTL) { if (s) { delete db.sessions[th]; save(); } fail(401, 'Сессия недействительна, войди заново'); }
  if (now - s.ts > 3600e3) { s.ts = now; save(); }
  return { u: db.users[s.uid], th };
}
function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { uid, ts: Date.now() };
  const mine = Object.entries(db.sessions).filter(([, s]) => s.uid === uid).sort((a, b) => b[1].ts - a[1].ts);
  for (const [k] of mine.slice(10)) delete db.sessions[k];
  save(); return token;
}

// ---------- присутствие и события ----------
const conns = new Map(), pres = new Map(), offT = new Map();
const isOn = id => (conns.get(id) ? conns.get(id).size : 0) > 0;
const statusOf = id => isOn(id) ? { online: true, state: (pres.get(id) || {}).state || 'online', server: (pres.get(id) || {}).server || '' } : { online: false, state: 'offline', server: '' };
function emit(uid, ev, data) {
  const set = conns.get(uid); if (!set) return;
  const line = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of set) { try { r.write(line); } catch {} }
}
const relOf = (a, b) => db.rels[pk(a, b)];
const friendIds = uid => Object.values(db.rels).filter(r => r.st === 'f' && (r.a === uid || r.b === uid)).map(r => r.a === uid ? r.b : r.a);
const broadcast = id => { const st = { id, ...statusOf(id) }; for (const f of friendIds(id)) emit(f, 'presence', st); };
function unread(r, uid) {
  const rd = (r.rd && r.rd[uid]) || 0;
  return (db.msgs[pk(r.a, r.b)] || []).filter(m => m.from !== uid && m.ts > rd).length;
}
function listFor(uid) {
  const friends = [], incoming = [], outgoing = [];
  for (const r of Object.values(db.rels)) {
    if (r.a !== uid && r.b !== uid) continue;
    const oid = r.a === uid ? r.b : r.a, o = db.users[oid]; if (!o) continue;
    if (r.st === 'f') friends.push({ ...pub(o), ...statusOf(oid), unread: unread(r, uid) });
    else if (r.from === uid) outgoing.push(pub(o)); else incoming.push(pub(o));
  }
  friends.sort((x, y) => (y.online - x.online) || x.nick.localeCompare(y.nick));
  return { friends, incoming, outgoing };
}
function needFriend(a, b) {
  const r = relOf(a, b);
  if (!r || r.st !== 'f') fail(403, 'Вы не друзья');
  return r;
}
function addMsg(a, b, from, type, text, server) {
  const key = pk(a, b), arr = db.msgs[key] || (db.msgs[key] = []), last = arr[arr.length - 1];
  const ts = Math.max(Date.now(), last ? last.ts + 1 : 0);
  const m = { id: ts.toString(36) + crypto.randomBytes(3).toString('hex'), from, ts, type, text }, fu = db.users[from];
  if (fu) { m.nick = fu.nick; m.tier = tierOf(fu); const st = styleOf(fu); if (st) m.style = st; }
  if (server) m.server = server;
  arr.push(m); if (arr.length > HISTORY) arr.splice(0, arr.length - HISTORY);
  save(); return m;
}
const cleanText = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

// ---------- коды активации, уровни, комнаты, команды администратора ----------
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => 'MNA-' + [0, 1, 2].map(() => Array.from({ length: 4 }, () => CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)]).join('')).join('-');
const normCode = c => { const t = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return t.length === 12 ? 'MNA' + t : t; };
function makeCodes(tier, count) {
  if (!['plus', 'plusplus', 'pro'].includes(tier)) throw new Error('Коды бывают для уровней plus, plusplus, pro');
  count = Math.min(50, Math.max(1, Math.floor(+count) || 1)); const out = [];
  for (let i = 0; i < count; i++) { const c = newCode(); db.codes[sha(normCode(c))] = { tier, created: Date.now() }; out.push(c); }
  save(); return out;
}
function notifyProfile(u) { emit(u.id, 'me', { user: pub(u) }); for (const f of friendIds(u.id)) emit(f, 'friends', {}); }
function grantTier(u, tier) { u.tier = tier; save(); notifyProfile(u); }
const userByNick = n => db.users[db.byNick[String(n || '').toLowerCase()]];
const normAddr = a => String(a || '').trim().toLowerCase().replace(/\.$/, '').replace(/:25565$/, '');
const localKey = uid => { const p = pres.get(uid); return isOn(uid) && p && p.state === 'ingame' && p.server ? normAddr(p.server) : ''; };
const localRooms = new Map();
const roomUsers = (kind, key) => [...conns.keys()].filter(id => isOn(id) && (kind === 'global' || localKey(id) === key));
const roomArr = (kind, key) => (kind === 'global' ? db.rooms.global : localRooms.get(key) || []);
function postRoom(u, kind, text) {
  const key = kind === 'global' ? 'global' : localKey(u.id);
  if (!key) fail(409, 'Локальный чат доступен, когда ты играешь на сервере');
  if (u.mutedUntil && u.mutedUntil > Date.now()) fail(403, 'Ты заглушен ещё на ' + Math.ceil((u.mutedUntil - Date.now()) / 60000) + ' мин.');
  const m = { id: rid(), ts: Date.now(), from: u.id, nick: u.nick, tier: tierOf(u), text }, st = styleOf(u); if (st) m.style = st;
  let arr = kind === 'global' ? db.rooms.global : localRooms.get(key);
  if (!arr) { if (localRooms.size >= 500) localRooms.delete(localRooms.keys().next().value); localRooms.set(key, arr = []); }
  arr.push(m); if (arr.length > (kind === 'global' ? 200 : 50)) arr.splice(0, arr.length - (kind === 'global' ? 200 : 50));
  if (kind === 'global') save();
  for (const id of roomUsers(kind, key)) emit(id, 'room', { kind, room: key, msg: m });
  return m;
}
// Команды вида «/grant Bob pro». Выполняют админ в чате лаунчера и владелец сервера по ADMIN_KEY или из консоли.
function adminCmd(line, owner) {
  const [cmd, ...a] = String(line).replace(/^\//, '').trim().split(/\s+/);
  const need = (n, usage) => { if (a.length < n) throw new Error('Формат: ' + usage); };
  switch ((cmd || '').toLowerCase()) {
    case 'help': return 'Команды: /grant <ник> <free|plus|plusplus|pro>, /code <plus|plusplus|pro> [сколько], /mute <ник> [минуты], /unmute <ник>, /who';
    case 'grant': {
      need(2, '/grant <ник> <free|plus|plusplus|pro>'); const u = userByNick(a[0]), t = a[1].toLowerCase();
      if (!u) throw new Error('Игрок не найден'); if (!own(TRANK, t) || (t === 'admin' && !owner)) throw new Error('Уровень: free, plus, plusplus или pro' + (owner ? ', admin' : ' (admin выдаёт только владелец сервера)'));
      if (tierOf(u) === 'admin' && !owner) throw new Error('У админа уровень меняет только владелец сервера');
      grantTier(u, t); return `${u.nick}: уровень ${t}`;
    }
    case 'code': need(1, '/code <plus|plusplus|pro> [сколько]'); return makeCodes(a[0].toLowerCase(), a[1]).join('\n');
    case 'mute': {
      need(1, '/mute <ник> [минуты]'); const u = userByNick(a[0]); if (!u) throw new Error('Игрок не найден');
      if (tierOf(u) === 'admin' && !owner) throw new Error('Админа заглушить нельзя');
      const min = Math.min(10080, Math.max(1, Math.floor(+a[1]) || 30)); u.mutedUntil = Date.now() + min * 60000; save(); return `${u.nick} заглушен на ${min} мин.`;
    }
    case 'unmute': { need(1, '/unmute <ник>'); const u = userByNick(a[0]); if (!u) throw new Error('Игрок не найден'); delete u.mutedUntil; save(); return `${u.nick} снова может писать`; }
    case 'who': return `Онлайн: ${[...conns.keys()].filter(isOn).length}, всего аккаунтов: ${Object.keys(db.users).length}`;
    default: throw new Error('Неизвестная команда, список: /help');
  }
}

// ---------- прокси CurseForge (ключ хранится только на сервере) ----------
const cfCache = new Map();
async function cfProxy(req, res, u, url) {
  if (!CF_KEY) fail(503, 'На сервере не настроен ключ CurseForge');
  const sub = url.pathname.slice(3);
  if (!(sub === '/v1/mods/search' || /^\/v1\/mods\/\d{1,10}\/files$/.test(sub))) fail(404, 'Нет такого пути');
  if (url.search.length > 400) fail(414, 'Слишком длинный запрос');
  limit('cf:' + u.id, 60, 60e3);
  const full = sub + url.search, hit = cfCache.get(full);
  if (hit && Date.now() - hit.t < 60e3) return sendRaw(res, 200, hit.body);
  const r = await fetch(CF_BASE + full, { headers: { 'x-api-key': CF_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const body = await r.text();
  if (r.status === 401 || r.status === 403) fail(502, 'Ключ CurseForge на сервере недействителен');
  if (r.ok) { if (cfCache.size > 200) cfCache.clear(); cfCache.set(full, { t: Date.now(), body }); }
  sendRaw(res, r.status, body);
}
const sendRaw = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };

// ---------- маршруты ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method, ip = ipOf(req);

  if (m === 'GET' && (p === '/' || p === '/health')) return J(res, 200, { name: 'MNA Hub', version: VERSION, proto: PROTO });
  if (m === 'GET' && p === '/api/info') return J(res, 200, { name: 'MNA Hub', version: VERSION, proto: PROTO, needCode: !!REG_CODE, cf: !!CF_KEY, tiers: [{ id: 'free', price: 0 }, ...['plus', 'plusplus', 'pro'].map(id => ({ id, price: CONF.prices[id], currency: CONF.currency, buy: CONF.buyUrls[id] || '' }))] });

  let q;
  if (m === 'GET' && (q = /^\/api\/nick\/([^/]+)$/.exec(p))) {
    limit('nick:' + ip, 60, 60e3);
    let n; try { n = decodeURIComponent(q[1]); } catch { n = ''; }
    const ok = NICK_RE.test(n) && !RESERVED.has(n.toLowerCase());
    return J(res, 200, { valid: ok, taken: ok && !!db.byNick[n.toLowerCase()] });
  }

  if (m === 'POST' && p === '/api/register') {
    limit('reg:' + ip, REG_PER_HOUR, 3600e3, 'Слишком много регистраций с этого адреса, попробуй позже');
    const b = await readBody(req), nick = String(b.nick || '').trim();
    checkNick(nick); checkPass(b.password);
    if (REG_CODE && !safeEq(b.code || '', REG_CODE)) fail(403, 'Неверный код приглашения');
    if (Object.keys(db.users).length >= MAX_USERS) fail(503, 'Регистрация закрыта: достигнут лимит игроков');
    const low = nick.toLowerCase();
    if (db.byNick[low]) fail(409, 'Этот ник уже занят');
    const salt = crypto.randomBytes(16).toString('hex'), hash = await hashPw(b.password, salt);
    if (db.byNick[low]) fail(409, 'Этот ник уже занят');
    const u = { id: rid(), nick, salt, hash, created: Date.now() };
    db.users[u.id] = u; db.byNick[low] = u.id;
    return J(res, 201, { token: newSession(u.id), user: pub(u) });
  }

  if (m === 'POST' && p === '/api/login') {
    limit('login:' + ip, 30, 600e3, 'Слишком много попыток входа, подожди 10 минут');
    const b = await readBody(req), nick = String(b.nick || '').trim(), low = nick.toLowerCase();
    if (peek('lf:' + low, 600e3) >= 10) fail(429, 'Слишком много неудачных попыток для этого ника, подожди 10 минут');
    const u = db.users[db.byNick[low]];
    const h = await hashPw(String(b.password || ''), u ? u.salt : '0'.repeat(32));
    if (!u || !safeEq(h, u.hash)) { mark('lf:' + low); fail(401, 'Неверный ник или пароль'); }
    return J(res, 200, { token: newSession(u.id), user: pub(u) });
  }

  // CurseForge-прокси: только для вошедших
  if (m === 'GET' && p.startsWith('/cf/')) { const { u } = auth(req); return cfProxy(req, res, u, url); }

  if (m === 'POST' && p.startsWith('/api/admin/')) {
    if (!ADMIN_KEY) fail(404, 'Не найдено');
    limit('adm:' + ip, 60, 60e3);
    if (!safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) fail(403, 'Неверный ключ администратора');
    const b = await readBody(req);
    try {
      if (p === '/api/admin/grant') return J(res, 200, { ok: true, result: adminCmd(`/grant ${String(b.nick || '')} ${String(b.tier || '')}`, true) });
      if (p === '/api/admin/code') return J(res, 200, { ok: true, codes: makeCodes(String(b.tier || ''), b.count) });
      if (p === '/api/admin/cmd') return J(res, 200, { ok: true, result: adminCmd(String(b.line || ''), true) });
    } catch (e) { fail(400, e.message); }
    fail(404, 'Не найдено');
  }

  if (!p.startsWith('/api/')) fail(404, 'Не найдено');
  const { u, th } = auth(req);

  if (m === 'GET' && p === '/api/me') return J(res, 200, { user: pub(u) });
  if (m === 'POST' && p === '/api/logout') { delete db.sessions[th]; save(); return J(res, 200, { ok: true }); }

  if (m === 'POST' && p === '/api/account/password') {
    limit('pw:' + u.id, 5, 600e3);
    const b = await readBody(req); checkPass(b.new);
    if (!safeEq(await hashPw(String(b.old || ''), u.salt), u.hash)) fail(403, 'Старый пароль неверный');
    u.salt = crypto.randomBytes(16).toString('hex'); u.hash = await hashPw(b.new, u.salt);
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === u.id && k !== th) delete db.sessions[k];
    save(); return J(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/account/delete') {
    limit('del:' + u.id, 5, 600e3);
    const b = await readBody(req);
    if (!safeEq(await hashPw(String(b.password || ''), u.salt), u.hash)) fail(403, 'Пароль неверный');
    const others = friendIds(u.id).concat(Object.values(db.rels).filter(r => r.st === 'p' && (r.a === u.id || r.b === u.id)).map(r => r.a === u.id ? r.b : r.a));
    for (const [k, r] of Object.entries(db.rels)) if (r.a === u.id || r.b === u.id) { delete db.rels[k]; delete db.msgs[k]; }
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[k];
    delete db.byNick[u.nick.toLowerCase()]; delete db.users[u.id]; save();
    const set = conns.get(u.id); if (set) for (const r of [...set]) { try { r.end(); } catch {} }
    pres.delete(u.id); for (const o of new Set(others)) emit(o, 'friends', {});
    return J(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/profile/style') {
    limit('style:' + u.id, 20, 600e3);
    const b = await readBody(req);
    if (TRANK[tierOf(u)] < TRANK.pro) fail(403, 'Оформление ника доступно с уровня Pro');
    u.style = b.style === null ? null : normStyle(b.style); save(); notifyProfile(u);
    return J(res, 200, { user: pub(u) });
  }
  if (m === 'POST' && p === '/api/redeem') {
    limit('redeem:' + u.id, 8, 600e3, 'Слишком много попыток, подожди 10 минут'); limit('redeemip:' + ip, 40, 3600e3, 'Слишком много попыток с этого адреса');
    const b = await readBody(req), c = db.codes[sha(normCode(b.code))];
    if (!c || c.usedBy) fail(404, 'Код не найден или уже использован');
    if (TRANK[c.tier] <= TRANK[tierOf(u)]) fail(409, 'У тебя уже этот уровень или выше, код не потрачен');
    c.usedBy = u.id; c.usedAt = Date.now(); grantTier(u, c.tier);
    return J(res, 200, { user: pub(u) });
  }
  if ((q = /^\/api\/room\/(global|local)$/.exec(p))) {
    const kind = q[1], key = kind === 'global' ? 'global' : localKey(u.id);
    if (m === 'GET') {
      if (!key) return J(res, 200, { messages: [], online: 0, room: '' });
      const before = +url.searchParams.get('before') || Infinity, lim = Math.min(100, Math.max(1, +url.searchParams.get('limit') || 50));
      return J(res, 200, { messages: roomArr(kind, key).filter(x => x.ts < before).slice(-lim), online: roomUsers(kind, key).length, room: key });
    }
    if (m === 'POST') {
      const b = await readBody(req), text = cleanText(b.text, 300);
      if (!text) fail(400, 'Пустое сообщение');
      if (text.startsWith('/') && tierOf(u) === 'admin') { limit('admcmd:' + u.id, 30, 60e3); try { return J(res, 200, { system: adminCmd(text, false) }); } catch (e) { return J(res, 200, { system: 'Ошибка: ' + e.message }); } }
      limit('room:' + u.id, 5, 10e3, 'Не так быстро: подожди пару секунд');
      return J(res, 200, { message: postRoom(u, kind, text) });
    }
  }

  if (m === 'GET' && p === '/api/friends') return J(res, 200, listFor(u.id));

  if (m === 'POST' && p === '/api/friends/request') {
    limit('fr:' + u.id, 20, 600e3);
    const b = await readBody(req), nick = String(b.nick || '').trim(), t = db.users[db.byNick[nick.toLowerCase()]];
    if (!t) fail(404, 'Игрок с таким ником не найден');
    if (t.id === u.id) fail(400, 'Нельзя добавить самого себя');
    const r = relOf(u.id, t.id);
    if (r && r.st === 'f') fail(409, 'Вы уже друзья');
    if (r && r.from === u.id) fail(409, 'Заявка уже отправлена');
    if (r) { r.st = 'f'; r.ts = Date.now(); }
    else {
      const rels = Object.values(db.rels);
      if (rels.filter(x => x.st === 'p' && x.from === u.id).length >= MAX_PENDING) fail(429, 'Слишком много отправленных заявок');
      if (friendIds(u.id).length >= MAX_FRIENDS) fail(429, 'Достигнут лимит друзей');
      const [a, c] = u.id < t.id ? [u.id, t.id] : [t.id, u.id];
      db.rels[pk(u.id, t.id)] = { a, b: c, st: 'p', from: u.id, ts: Date.now(), rd: {} };
    }
    save(); emit(u.id, 'friends', {}); emit(t.id, 'friends', {});
    if (r) { emit(t.id, 'presence', { id: u.id, ...statusOf(u.id) }); emit(u.id, 'presence', { id: t.id, ...statusOf(t.id) }); }
    return J(res, 200, { ok: true, accepted: !!r, nick: t.nick });
  }
  if (m === 'POST' && p === '/api/friends/accept') {
    const b = await readBody(req), r = relOf(u.id, String(b.id || ''));
    if (!r || r.st !== 'p' || r.from === u.id) fail(404, 'Заявка не найдена');
    if (friendIds(u.id).length >= MAX_FRIENDS) fail(429, 'Достигнут лимит друзей');
    const oid = r.from; r.st = 'f'; r.ts = Date.now(); save();
    emit(u.id, 'friends', {}); emit(oid, 'friends', {});
    emit(oid, 'presence', { id: u.id, ...statusOf(u.id) }); emit(u.id, 'presence', { id: oid, ...statusOf(oid) });
    return J(res, 200, { ok: true });
  }
  if (m === 'POST' && (p === '/api/friends/decline' || p === '/api/friends/remove')) {
    const b = await readBody(req), oid = String(b.id || ''), r = relOf(u.id, oid);
    if (!r || (p.endsWith('remove') ? r.st !== 'f' : r.st !== 'p')) fail(404, 'Не найдено');
    delete db.rels[pk(u.id, oid)]; delete db.msgs[pk(u.id, oid)]; save();
    emit(u.id, 'friends', {}); emit(oid, 'friends', {});
    return J(res, 200, { ok: true });
  }

  if ((q = /^\/api\/chat\/([a-f0-9]{12})$/.exec(p))) {
    const fid = q[1];
    if (m === 'GET') {
      needFriend(u.id, fid);
      const before = +url.searchParams.get('before') || Infinity, lim = Math.min(100, Math.max(1, +url.searchParams.get('limit') || 50));
      const arr = (db.msgs[pk(u.id, fid)] || []).filter(x => x.ts < before).slice(-lim);
      return J(res, 200, { messages: arr.map(x => ({ ...x, to: x.from === u.id ? fid : u.id })) });
    }
    if (m === 'POST') {
      needFriend(u.id, fid); limit('msg:' + u.id, 15, 10e3);
      const b = await readBody(req), text = cleanText(b.text, 500);
      if (!text) fail(400, 'Пустое сообщение');
      const msg = { ...addMsg(u.id, fid, u.id, 'text', text), to: fid };
      emit(fid, 'message', msg); emit(u.id, 'message', msg);
      return J(res, 200, { message: msg });
    }
  }
  if (m === 'POST' && (q = /^\/api\/chat\/([a-f0-9]{12})\/read$/.exec(p))) {
    const r = needFriend(u.id, q[1]), arr = db.msgs[pk(u.id, q[1])] || [];
    (r.rd || (r.rd = {}))[u.id] = Math.max(Date.now(), arr.length ? arr[arr.length - 1].ts : 0); save();
    return J(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/invite') {
    limit('msg:' + u.id, 15, 10e3);
    const b = await readBody(req), to = String(b.to || ''), server = String(b.server || '').trim();
    needFriend(u.id, to);
    if (!ADDR_RE.test(server)) fail(400, 'Неверный адрес сервера');
    const msg = { ...addMsg(u.id, to, u.id, 'invite', cleanText(b.note, 100), server), to };
    emit(to, 'message', msg); emit(u.id, 'message', msg);
    return J(res, 200, { message: msg });
  }

  if (m === 'POST' && p === '/api/presence') {
    limit('pr:' + u.id, 30, 60e3);
    const b = await readBody(req), state = b.state === 'ingame' ? 'ingame' : 'online', server = String(b.server || '').trim();
    if (server && !ADDR_RE.test(server)) fail(400, 'Неверный адрес сервера');
    if (!isOn(u.id)) return J(res, 200, { ok: false });
    pres.set(u.id, { state, server: state === 'ingame' ? server : '' }); broadcast(u.id); emit(u.id, 'lroom', { room: localKey(u.id) });
    return J(res, 200, { ok: true });
  }

  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    res.on('error', () => {});
    res.write('retry: 3000\n\n');
    let set = conns.get(u.id); if (!set) conns.set(u.id, set = new Set());
    while (set.size >= 5) { const old = set.values().next().value; set.delete(old); try { old.end(); } catch {} }
    const first = set.size === 0;
    clearTimeout(offT.get(u.id)); offT.delete(u.id);
    set.add(res);
    if (first && !pres.has(u.id)) { pres.set(u.id, { state: 'online', server: '' }); broadcast(u.id); }
    res.write(`event: hello\ndata: ${JSON.stringify({ me: pub(u), proto: PROTO })}\n\n`);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => {
      clearInterval(hb); set.delete(res);
      if (!set.size) {
        conns.delete(u.id);
        offT.set(u.id, setTimeout(() => { offT.delete(u.id); if (!isOn(u.id)) { pres.delete(u.id); broadcast(u.id); } }, 6000));
      }
    });
    return;
  }

  fail(404, 'Не найдено');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    if (e instanceof HttpErr) return J(res, e.code, { error: e.message });
    console.error('Ошибка:', e); J(res, 500, { error: 'Внутренняя ошибка сервера' });
  });
});

// ---------- команды администратора (сервер должен быть остановлен) ----------
const pidFile = () => path.join(DATA, 'server.pid');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function cli(args) {
  load();
  if (['reset', 'delete', 'tier', 'code'].includes(args[0])) {
    let pid = 0; try { pid = +fs.readFileSync(pidFile(), 'utf8'); } catch {}
    if (pid && pid !== process.pid && alive(pid)) { console.error('Сервер сейчас запущен. Останови его для этой команды или используй команды в лаунчере (/grant, /code) либо ADMIN_KEY.'); process.exitCode = 1; return; }
  }
  const [cmd, nick, pw] = args, u = nick && db.users[db.byNick[String(nick).toLowerCase()]];
  if (cmd === 'users') { for (const x of Object.values(db.users)) console.log(x.nick, tierOf(x), new Date(x.created).toISOString().slice(0, 10)); console.log('Всего:', Object.keys(db.users).length); }
  else if (cmd === 'tier') {
    if (!u || !own(TRANK, pw)) return console.error('Формат: node server.js tier <ник> <free|plus|plusplus|pro|admin>');
    u.tier = pw; flush(); console.log(u.nick + ': уровень ' + pw);
  } else if (cmd === 'code') {
    try { const list = makeCodes(String(nick || ''), pw); flush(); console.log(list.join('\n')); } catch (e) { console.error(e.message + '. Формат: node server.js code <plus|plusplus|pro> [сколько]'); }
  } else if (cmd === 'reset') {
    if (!u) return console.error('Игрок не найден'); checkPass(pw);
    u.salt = crypto.randomBytes(16).toString('hex'); u.hash = await hashPw(pw, u.salt);
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[k];
    flush(); console.log('Пароль для ' + u.nick + ' изменён, старые сессии сброшены');
  } else if (cmd === 'delete') {
    if (!u) return console.error('Игрок не найден');
    for (const [k, r] of Object.entries(db.rels)) if (r.a === u.id || r.b === u.id) { delete db.rels[k]; delete db.msgs[k]; }
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[k];
    delete db.byNick[u.nick.toLowerCase()]; delete db.users[u.id]; flush(); console.log('Аккаунт ' + u.nick + ' удалён, ник свободен');
  } else console.log('Команды: node server.js users | reset <ник> <новый пароль> | delete <ник> | tier <ник> <уровень> | code <уровень> [сколько]');
}

if (['users', 'reset', 'delete', 'tier', 'code', 'help'].includes(process.argv[2])) {
  cli(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
} else {
  load();
  server.listen(PORT, HOST, () => console.log(`MNA Hub ${VERSION} слушает ${HOST}:${server.address().port}` + (CF_KEY ? ' (CurseForge-прокси включён)' : '') + (REG_CODE ? ' (регистрация по коду)' : '')));
  try { fs.writeFileSync(pidFile(), String(process.pid)); } catch {}
  const bye = () => { try { flush(); fs.rmSync(pidFile(), { force: true }); } catch {} process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
