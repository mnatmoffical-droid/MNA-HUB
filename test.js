'use strict';
// Проверка сервера целиком: node test.js
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mna-hub-'));
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, REG_PER_HOUR: '100', REG_CODE: 'secret1', ADMIN_KEY: 'adm1' }, stdio: ['ignore', 'pipe', 'inherit'] });
let passed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (name) => { passed++; console.log('  ✔', name); };

function waitPort() {
  return new Promise((res, rej) => {
    srv.stdout.on('data', d => { const m = /:(\d+)/.exec(String(d)); if (m) res(+m[1]); });
    srv.on('exit', c => rej(new Error('сервер завершился: ' + c)));
    setTimeout(() => rej(new Error('сервер не запустился')), 8000);
  });
}

(async () => {
  const port = await waitPort(), B = 'http://127.0.0.1:' + port;
  const api = async (method, p, body, token) => {
    const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const sse = async (token) => {
    const ev = [], ctl = new AbortController();
    const r = await fetch(B + '/api/events', { headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal });
    assert.strictEqual(r.status, 200);
    (async () => {
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      try { for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const e = /event: (.+)/.exec(blk), d = /data: (.+)/.exec(blk); if (e && d) ev.push({ e: e[1], d: JSON.parse(d[1]) }); } } } catch {}
    })();
    return { ev, close: () => ctl.abort(), until: async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const f = ev.find(fn); if (f) return f; await new Promise(r => setTimeout(r, 25)); } throw new Error('событие не пришло: ' + JSON.stringify(ev)); } };
  };

  console.log('Аккаунты и ники');
  let r = await api('GET', '/api/info'); assert(r.j.needCode && r.j.proto === 2); assert.deepStrictEqual(r.j.tiers.map(t => t.id), ['free', 'plus', 'plusplus', 'pro']); assert.deepStrictEqual(r.j.tiers.map(t => t.price), [0, 0.99, 2.99, 4.99]); ok('info: нужен код приглашения');
  r = await api('POST', '/api/register', { nick: 'Alex', password: 'password1' }); assert.strictEqual(r.s, 403); ok('регистрация без кода отклонена');
  r = await api('POST', '/api/register', { nick: 'Alex', password: 'password1', code: 'secret1' }); assert.strictEqual(r.s, 201); const A = r.j;
  assert(/^[a-f0-9]{64}$/.test(A.token) && A.user.nick === 'Alex'); ok('регистрация Alex');
  r = await api('POST', '/api/register', { nick: 'alex', password: 'password2', code: 'secret1' }); assert.strictEqual(r.s, 409); ok('ник alex занят (без учёта регистра)');
  r = await api('POST', '/api/register', { nick: 'ALEX', password: 'password2', code: 'secret1' }); assert.strictEqual(r.s, 409); ok('ник ALEX занят');
  for (const bad of ['ab', 'a b c', 'Имя', 'x'.repeat(17), 'admin', 'Ad-min']) { r = await api('POST', '/api/register', { nick: bad, password: 'password1', code: 'secret1' }); assert.strictEqual(r.s, 400, bad); }
  ok('плохие и зарезервированные ники отклонены');
  r = await api('POST', '/api/register', { nick: 'Bob', password: '123', code: 'secret1' }); assert.strictEqual(r.s, 400); ok('короткий пароль отклонён');
  r = await api('GET', '/api/nick/alex'); assert(r.j.taken && r.j.valid); r = await api('GET', '/api/nick/Free_Nick'); assert(!r.j.taken && r.j.valid); ok('проверка ника: занят/свободен');
  r = await api('POST', '/api/register', { nick: 'Bob', password: 'password2', code: 'secret1' }); const Bo = r.j; assert.strictEqual(r.s, 201); ok('регистрация Bob');
  r = await api('POST', '/api/login', { nick: 'alex', password: 'wrong' }); assert.strictEqual(r.s, 401); ok('вход с неверным паролем отклонён');
  r = await api('POST', '/api/login', { nick: 'alex', password: 'password1' }); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.user.nick, 'Alex'); ok('вход по нику в любом регистре');
  r = await api('GET', '/api/me', null, 'f'.repeat(64)); assert.strictEqual(r.s, 401); ok('чужой токен не работает');
  r = await api('GET', '/api/friends'); assert.strictEqual(r.s, 401); ok('без токена доступа нет');

  console.log('Друзья и присутствие');
  const sa = await sse(A.token); await sa.until(x => x.e === 'hello');
  const sb = await sse(Bo.token); await sb.until(x => x.e === 'hello'); ok('SSE: hello');
  r = await api('POST', '/api/chat/' + Bo.user.id, { text: 'привет' }, A.token); assert.strictEqual(r.s, 403); ok('писать не другу нельзя');
  r = await api('POST', '/api/friends/request', { nick: 'nobody' }, A.token); assert.strictEqual(r.s, 404); ok('заявка несуществующему');
  r = await api('POST', '/api/friends/request', { nick: 'alex' }, A.token); assert.strictEqual(r.s, 400); ok('заявка самому себе');
  r = await api('POST', '/api/friends/request', { nick: 'bob' }, A.token); assert.strictEqual(r.s, 200); assert(!r.j.accepted);
  await sb.until(x => x.e === 'friends'); ok('заявка Alex → Bob, у Bob событие');
  r = await api('POST', '/api/friends/request', { nick: 'bob' }, A.token); assert.strictEqual(r.s, 409); ok('повторная заявка отклонена');
  r = await api('GET', '/api/friends', null, Bo.token); assert.deepStrictEqual(r.j.incoming.map(x => x.nick), ['Alex']); ok('у Bob входящая заявка');
  r = await api('POST', '/api/friends/accept', { id: Bo.user.id }, A.token); assert.strictEqual(r.s, 404); ok('принять свою же заявку нельзя');
  r = await api('POST', '/api/friends/accept', { id: A.user.id }, Bo.token); assert.strictEqual(r.s, 200); ok('Bob принял заявку');
  r = await api('GET', '/api/friends', null, A.token); assert.strictEqual(r.j.friends.length, 1); assert(r.j.friends[0].online && r.j.friends[0].state === 'online'); ok('друг Bob виден как онлайн');
  r = await api('POST', '/api/presence', { state: 'ingame', server: 'play.example.com:25565' }, Bo.token); assert(r.j.ok);
  let pe = await sa.until(x => x.e === 'presence' && x.d.id === Bo.user.id && x.d.state === 'ingame'); assert.strictEqual(pe.d.server, 'play.example.com:25565'); ok('Alex видит, что Bob играет на сервере');
  r = await api('POST', '/api/presence', { state: 'ingame', server: '--bad arg' }, Bo.token); assert.strictEqual(r.s, 400); ok('плохой адрес в статусе отклонён');

  console.log('Чат и приглашения');
  r = await api('POST', '/api/chat/' + Bo.user.id, { text: '  Привет, Bob!  ' }, A.token); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.message.text, 'Привет, Bob!');
  const got = await sb.until(x => x.e === 'message' && x.d.text === 'Привет, Bob!'); assert.strictEqual(got.d.from, A.user.id); await sa.until(x => x.e === 'message' && x.d.id === got.d.id); ok('сообщение доставлено обоим по SSE');
  r = await api('POST', '/api/chat/' + Bo.user.id, { text: '   ' }, A.token); assert.strictEqual(r.s, 400); ok('пустое сообщение отклонено');
  r = await api('POST', '/api/chat/' + Bo.user.id, { text: 'я'.repeat(900) }, A.token); assert.strictEqual(r.j.message.text.length, 500); ok('длинное сообщение обрезано до 500');
  r = await api('GET', '/api/friends', null, Bo.token); assert.strictEqual(r.j.friends[0].unread, 2); ok('у Bob 2 непрочитанных');
  r = await api('POST', '/api/invite', { to: Bo.user.id, server: 'mc.example.com', note: 'го на ферму' }, A.token); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.message.type, 'invite');
  await sb.until(x => x.e === 'message' && x.d.type === 'invite' && x.d.server === 'mc.example.com'); ok('приглашение доставлено');
  r = await api('POST', '/api/invite', { to: Bo.user.id, server: '-Dbad=1' }, A.token); assert.strictEqual(r.s, 400); ok('приглашение с опасным адресом отклонено');
  r = await api('GET', '/api/chat/' + A.user.id, null, Bo.token); assert.strictEqual(r.j.messages.length, 3); assert(r.j.messages.every(m => m.to === Bo.user.id)); ok('история чата');
  r = await api('POST', '/api/chat/' + A.user.id + '/read', null, Bo.token); r = await api('GET', '/api/friends', null, Bo.token); assert.strictEqual(r.j.friends[0].unread, 0); ok('прочитано → 0 непрочитанных');

  console.log('Выход, смена пароля, отключение');
  sb.close(); await sa.until(x => x.e === 'presence' && x.d.id === Bo.user.id && x.d.online === false, 9000); ok('Bob отключился → Alex видит офлайн');
  r = await api('GET', '/api/friends', null, A.token); assert(!r.j.friends[0].online); ok('в списке Bob офлайн');
  r = await api('POST', '/api/account/password', { old: 'bad', new: 'newpass1' }, A.token); assert.strictEqual(r.s, 403);
  const l2 = await api('POST', '/api/login', { nick: 'alex', password: 'password1' }); const oldTok = l2.j.token;
  r = await api('POST', '/api/account/password', { old: 'password1', new: 'newpass1' }, A.token); assert.strictEqual(r.s, 200);
  r = await api('GET', '/api/me', null, oldTok); assert.strictEqual(r.s, 401); r = await api('GET', '/api/me', null, A.token); assert.strictEqual(r.s, 200); ok('смена пароля сбрасывает другие сессии');
  r = await api('POST', '/api/login', { nick: 'alex', password: 'newpass1' }); assert.strictEqual(r.s, 200); ok('вход с новым паролем');
  r = await api('GET', '/cf/v1/mods/search?gameId=432', null, A.token); assert.strictEqual(r.s, 503); r = await api('GET', '/cf/v1/mods/search'); assert.strictEqual(r.s, 401); ok('CurseForge-прокси: нужен вход и ключ на сервере');
  r = await api('POST', '/api/friends/remove', { id: Bo.user.id }, A.token); assert.strictEqual(r.s, 200); r = await api('GET', '/api/chat/' + Bo.user.id, null, A.token); assert.strictEqual(r.s, 403); ok('удаление из друзей закрывает чат');
  r = await api('POST', '/api/account/delete', { password: 'wrong' }, A.token); assert.strictEqual(r.s, 403);
  r = await api('POST', '/api/account/delete', { password: 'newpass1' }, A.token); assert.strictEqual(r.s, 200);
  r = await api('GET', '/api/nick/alex'); assert(!r.j.taken); ok('удаление аккаунта освобождает ник');
  sa.close();

  // сохранение на диск
  await new Promise(r => setTimeout(r, 700));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  assert(saved.byNick.bob && !saved.byNick.alex); assert(!JSON.stringify(saved).includes('newpass1') && !JSON.stringify(saved).includes('password2')); ok('db.json сохранён, паролей в открытом виде нет');

  console.log('Уровни, коды, оформление ника');
  const reg2 = async nick => (await api('POST', '/api/register', { nick, password: 'password1', code: 'secret1' })).j;
  const Cara = await reg2('Cara'), Dan = await reg2('Dan'), Eve = await reg2('Eve');
  assert.strictEqual(Cara.user.tier, 'free'); assert(!Cara.user.style); ok('новый игрок: обычный уровень');
  r = await api('POST', '/api/profile/style', { style: { font: 'serif' } }, Cara.token); assert.strictEqual(r.s, 403); ok('стиль ника без Pro закрыт');
  r = await api('POST', '/api/redeem', { code: 'MNA-AAAA-BBBB-CCCC' }, Cara.token); assert.strictEqual(r.s, 404); ok('несуществующий код отклонён');
  const adm = (p, b, key = 'adm1') => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Admin-Key': key } : {}) }, body: JSON.stringify(b) }).then(async x => ({ s: x.status, j: await x.json() }));
  r = await adm('/api/admin/code', { tier: 'plus', count: 2 }, null); assert.strictEqual(r.s, 403); r = await adm('/api/admin/code', { tier: 'plus', count: 2 }, 'wrong'); assert.strictEqual(r.s, 403); ok('админский интерфейс без ключа и с чужим ключом закрыт');
  r = await adm('/api/admin/code', { tier: 'plus', count: 2 }); assert.strictEqual(r.s, 200); const [c1, c2] = r.j.codes; assert(/^MNA-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(c1) && c1 !== c2); ok('коды созданы, формат MNA-XXXX-XXXX-XXXX');
  r = await adm('/api/admin/code', { tier: 'admin' }); assert.strictEqual(r.s, 400); ok('код на админа создать нельзя');
  assert(!fs.readFileSync(path.join(dir, 'db.json'), 'utf8').includes(c1.replace(/-/g, ''))) ; ok('в базе коды лежат только в виде хэшей');
  const sC = await sse(Cara.token); await sC.until(x => x.e === 'hello');
  r = await api('POST', '/api/redeem', { code: c1.toLowerCase().replace(/-/g, ' ') }, Cara.token); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.user.tier, 'plus'); await sC.until(x => x.e === 'me' && x.d.user.tier === 'plus'); ok('код активирован (регистр и пробелы не важны), событие «me» дошло');
  r = await api('POST', '/api/redeem', { code: c1 }, Dan.token); assert.strictEqual(r.s, 404); ok('один код нельзя использовать дважды');
  r = await api('POST', '/api/redeem', { code: c2 }, Cara.token); assert.strictEqual(r.s, 409); r = await api('POST', '/api/redeem', { code: c2 }, Dan.token); assert.strictEqual(r.s, 200); ok('код не тратится, если у игрока уже такой уровень; потом его активирует другой');
  r = await adm('/api/admin/grant', { nick: 'cara', tier: 'pro' }); assert.strictEqual(r.s, 200); await sC.until(x => x.e === 'me' && x.d.user.tier === 'pro'); ok('владелец выдал Pro через ключ');
  r = await adm('/api/admin/grant', { nick: 'cara', tier: 'king' }); assert.strictEqual(r.s, 400); r = await adm('/api/admin/grant', { nick: 'nobody', tier: 'pro' }); assert.strictEqual(r.s, 400); ok('неверный уровень и неизвестный игрок отклонены');
  await api('POST', '/api/friends/request', { nick: 'dan' }, Cara.token); await api('POST', '/api/friends/accept', { id: Cara.user.id }, Dan.token);
  const sD = await sse(Dan.token); await sD.until(x => x.e === 'hello');
  r = await api('POST', '/api/profile/style', { style: { font: 'script', color: '#FF00AA', color2: '#00ffcc', effect: 'rainbow', bold: true } }, Cara.token); assert.strictEqual(r.s, 200); assert.deepStrictEqual(r.j.user.style, { font: 'script', color: '#ff00aa', color2: '#00ffcc', effect: 'rainbow', bold: true, italic: false }); ok('Pro: стиль ника сохранён');
  r = await api('POST', '/api/profile/style', { style: { font: '__proto__;x', color: 'red', effect: 'nope' } }, Cara.token); assert.deepStrictEqual(r.j.user.style, { font: 'sans', color: '#ffffff', color2: '#ffffff', effect: 'none', bold: false, italic: false });
  await api('POST', '/api/profile/style', { style: { font: 'script', color: '#ff00aa', color2: '#00ffcc', effect: 'rainbow', bold: true } }, Cara.token); ok('подставные значения в стиле заменены безопасными');
  r = await api('GET', '/api/friends', null, Dan.token); const fc = r.j.friends.find(x => x.nick === 'Cara'); assert.strictEqual(fc.tier, 'pro'); assert.strictEqual(fc.style.effect, 'rainbow'); ok('друг видит уровень и стиль ника в списке');
  r = await api('POST', '/api/chat/' + Cara.user.id, { text: 'привет, Pro!' }, Dan.token); r = await api('POST', '/api/chat/' + Dan.user.id, { text: 'привет, Dan' }, Cara.token); assert.strictEqual(r.j.message.nick, 'Cara'); assert.strictEqual(r.j.message.tier, 'pro'); assert.strictEqual(r.j.message.style.font, 'script'); ok('личные сообщения несут ник со стилем и уровнем');

  console.log('Глобальный и локальный чаты');
  r = await api('POST', '/api/room/global', { text: 'всем привет' }, Cara.token); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.message.style.effect, 'rainbow');
  const gm = await sD.until(x => x.e === 'room' && x.d.kind === 'global' && x.d.msg.text === 'всем привет'); assert.strictEqual(gm.d.msg.nick, 'Cara'); assert.strictEqual(gm.d.msg.tier, 'pro'); ok('глобальный чат: сообщение доходит до всех со стилем ника');
  r = await api('GET', '/api/room/global', null, Eve.token); assert(r.j.messages.some(m => m.text === 'всем привет') && r.j.online >= 2 && r.j.room === 'global'); ok('история глобального чата и число игроков онлайн');
  r = await api('POST', '/api/room/local', { text: 'есть кто?' }, Cara.token); assert.strictEqual(r.s, 409); r = await api('GET', '/api/room/local', null, Cara.token); assert.deepStrictEqual(r.j.messages, []); assert.strictEqual(r.j.room, ''); ok('локальный чат вне игры недоступен');
  await api('POST', '/api/presence', { state: 'ingame', server: 'Play.Example.com:25565' }, Cara.token); await api('POST', '/api/presence', { state: 'ingame', server: 'play.example.com' }, Dan.token);
  const sE = await sse(Eve.token); await sE.until(x => x.e === 'hello'); await api('POST', '/api/presence', { state: 'ingame', server: 'other.net' }, Eve.token);
  await sC.until(x => x.e === 'lroom' && x.d.room === 'play.example.com'); ok('вход на сервер определяет локальную комнату (регистр и порт по умолчанию не важны)');
  r = await api('POST', '/api/room/local', { text: 'кто на спавне?' }, Cara.token); assert.strictEqual(r.s, 200); await sD.until(x => x.e === 'room' && x.d.kind === 'local' && x.d.msg.text === 'кто на спавне?'); ok('локальный чат: сообщение получает игрок с того же сервера');
  await sleep(300); assert(!sE.ev.some(x => x.e === 'room' && x.d.kind === 'local')); r = await api('GET', '/api/room/local', null, Eve.token); assert.strictEqual(r.j.messages.length, 0); assert.strictEqual(r.j.room, 'other.net'); ok('игрок с другого сервера этих сообщений не видит');
  r = await api('GET', '/api/room/local', null, Dan.token); assert.strictEqual(r.j.online, 2); ok('в локальной комнате двое игроков');

  console.log('Команды администратора и заглушение');
  r = await adm('/api/admin/grant', { nick: 'cara', tier: 'admin' }); assert.strictEqual(r.s, 200);
  r = await api('POST', '/api/room/global', { text: '/help' }, Cara.token); assert(r.j.system && r.j.system.includes('/grant') && !r.j.message); ok('админ в чате: /help отвечает только ему, в чат не попадает');
  r = await api('POST', '/api/room/global', { text: '/mute dan 5' }, Cara.token); assert(/заглушен/.test(r.j.system)); r = await api('POST', '/api/room/global', { text: 'я тут' }, Dan.token); assert.strictEqual(r.s, 403); assert(/заглушен/.test(r.j.error)); ok('/mute: игрок не может писать в общие чаты');
  r = await api('POST', '/api/chat/' + Cara.user.id, { text: 'в личку можно' }, Dan.token); assert.strictEqual(r.s, 200); ok('в личные сообщения заглушенный писать может');
  r = await api('POST', '/api/room/global', { text: '/unmute dan' }, Cara.token); assert(/снова/.test(r.j.system)); r = await api('POST', '/api/room/global', { text: 'я снова тут' }, Dan.token); assert.strictEqual(r.s, 200); ok('/unmute возвращает право писать');
  r = await api('POST', '/api/room/global', { text: '/mute cara 5' }, Dan.token); assert.strictEqual(r.s, 200); assert(r.j.message && r.j.message.text === '/mute cara 5'); r = await api('POST', '/api/room/global', { text: 'проверка' }, Cara.token); assert.strictEqual(r.s, 200); ok('обычный игрок не может командовать: «/mute …» просто текст');
  r = await api('POST', '/api/room/global', { text: '/grant dan plus' }, Cara.token); assert(/Dan: уровень plus/.test(r.j.system)); await sD.until(x => x.e === 'me' && x.d.user.tier === 'plus');
  r = await api('POST', '/api/room/global', { text: '/grant dan admin' }, Cara.token); assert(/Ошибка/.test(r.j.system)); r = await api('GET', '/api/me', null, Dan.token); assert.strictEqual(r.j.user.tier, 'plus'); ok('админ может выдавать уровни до Pro, но не admin');
  r = await api('POST', '/api/room/global', { text: '/code pro 2' }, Cara.token); assert.strictEqual(r.j.system.split('\n').length, 2); r = await api('POST', '/api/room/global', { text: '/code admin' }, Cara.token); assert(/Ошибка/.test(r.j.system)); ok('админ создаёт коды, на admin коды не бывают');
  r = await api('POST', '/api/room/global', { text: '/grant cara free' }, Cara.token); assert(/Ошибка/.test(r.j.system)); ok('админ не может сменить уровень другого админа');
  r = await adm('/api/admin/grant', { nick: 'cara', tier: 'plus' }); r = await api('GET', '/api/me', null, Cara.token); assert.strictEqual(r.j.user.tier, 'plus'); assert(!r.j.user.style); r = await api('POST', '/api/profile/style', { style: { font: 'serif' } }, Cara.token); assert.strictEqual(r.s, 403); ok('после понижения до Plus стиль ника пропадает и поменять его нельзя');
  r = await adm('/api/admin/grant', { nick: 'cara', tier: 'pro' }); r = await api('GET', '/api/me', null, Cara.token); assert.strictEqual(r.j.user.style.font, 'script'); ok('вернули Pro: прежний стиль снова на месте');
  let last; for (let i = 0; i < 8; i++) last = await api('POST', '/api/room/global', { text: 'спам ' + i }, Dan.token); assert.strictEqual(last.s, 429); ok('частые сообщения в общий чат ограничены');
  sC.close(); sD.close(); sE.close();

  // прокси CurseForge: ключ только на сервере
  console.log('Прокси CurseForge');
  const http = require('http'); let upstream = 0, lastKey = '';
  const fake = http.createServer((q, r) => { upstream++; lastKey = q.headers['x-api-key']; r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ data: [], url: q.url })); }).listen(0, '127.0.0.1');
  await new Promise(r => fake.on('listening', r));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mna-hub2-'));
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({ currency: 'EUR', prices: { plus: 1.5, pro: 9 }, buyUrls: { plus: 'https://pay.example.com/plus', pro: 'javascript:alert(1)', plusplus: 'http://x.com' } }));
  const srv2 = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir2, CF_KEY: 'k123', CF_BASE: 'http://127.0.0.1:' + fake.address().port }, stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => { try { srv2.kill(); } catch {} });
  const port2 = await new Promise(res => srv2.stdout.on('data', d => { const m = /:(\d+)/.exec(String(d)); if (m) res(+m[1]); }));
  const B2 = 'http://127.0.0.1:' + port2, call = async (p, tok) => { const r = await fetch(B2 + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  const reg = await (await fetch(B2 + '/api/register', { method: 'POST', body: JSON.stringify({ nick: 'Cfuser', password: 'secret12' }) })).json();
  let c = await call('/api/info'); assert.strictEqual(c.j.tiers[1].price, 1.5); assert.strictEqual(c.j.tiers[1].currency, 'EUR'); assert.strictEqual(c.j.tiers[1].buy, 'https://pay.example.com/plus'); assert.strictEqual(c.j.tiers[2].price, 2.99); assert.strictEqual(c.j.tiers[3].buy, ''); assert.strictEqual(c.j.tiers[2].buy, ''); ok('цены и ссылки на оплату берутся из config.json, небезопасные ссылки игнорируются');
  c = await call('/cf/v1/mods/search?gameId=432&searchFilter=sodium'); assert.strictEqual(c.s, 401); assert.strictEqual(upstream, 0); ok('без входа прокси закрыт, до CurseForge запрос не дошёл');
  c = await call('/cf/v1/mods/search?gameId=432&searchFilter=sodium', reg.token); assert.strictEqual(c.s, 200); assert.strictEqual(lastKey, 'k123'); assert(c.j.url.includes('searchFilter=sodium')); ok('вошедший получает ответ, ключ подставляет сервер');
  c = await call('/cf/v1/mods/search?gameId=432&searchFilter=sodium', reg.token); assert.strictEqual(upstream, 1); ok('повторный запрос берётся из кэша (экономит лимит ключа)');
  c = await call('/cf/v1/mods/12345/files?gameVersion=1.20.1', reg.token); assert.strictEqual(c.s, 200); assert.strictEqual(upstream, 2); ok('список файлов мода проходит');
  for (const bad of ['/cf/v1/games', '/cf/v1/mods/abc/files', '/cf/v1/mods/1/files/../../../x', '/cf/v1/users/me']) { c = await call(bad, reg.token); assert.strictEqual(c.s, 404, bad); }
  assert.strictEqual(upstream, 2); ok('любые другие пути CurseForge недоступны');
  c = await call('/cf/v1/mods/search?' + 'x'.repeat(500), reg.token); assert.strictEqual(c.s, 414); ok('слишком длинный запрос отклонён');
  srv2.kill(); fake.close(); fs.rmSync(dir2, { recursive: true, force: true });

  console.log('Команды консоли');
  const { spawnSync } = require('child_process'), cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'server.js'), ...a], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  let o = cli('tier', 'Cara', 'plus'); assert.strictEqual(o.status, 1); assert(/запущен/.test(o.stderr)); ok('пока сервер работает, консольные команды правки не выполняются (чтобы не потерять данные)');
  srv.kill(); await new Promise(res => srv.on('exit', res));
  o = cli('tier', 'Cara', 'admin'); assert(/Cara: уровень admin/.test(o.stdout)); o = cli('tier', 'Cara', 'king'); assert(/Формат/.test(o.stderr)); o = cli('code', 'pro', '3'); assert.strictEqual(o.stdout.trim().split('\n').length, 3); o = cli('code', 'admin'); assert(/plus, plusplus, pro/.test(o.stderr));
  o = cli('users'); assert(/Cara admin/.test(o.stdout) && /Dan plus/.test(o.stdout)); ok('консоль: выдать уровень, создать коды, список с уровнями');

  console.log(`\nГотово: ${passed} проверок прошли`);
  process.exit(0);
})().catch(e => { console.error('\n✖ ОШИБКА:', e.stack || e); srv.kill(); process.exit(1); });
