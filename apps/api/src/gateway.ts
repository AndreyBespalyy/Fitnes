// Запуск шлюза клуба: npm run gateway (в папке apps/api). Открыть http://localhost:3100
// На странице: подключение к системе (номер шлюза и ключ), эмулятор турникета, режим «нет интернета» для проверки.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcsGateway, GATEWAY_VERSION } from './acsGateway.ts';

const dir = process.env.STORAGE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'storage');
mkdirSync(dir, { recursive: true });
const cfgFile = join(dir, 'gateway-config.json');
const stateFile = join(dir, 'gateway-state.json');
type Cfg = { server: string; id: string; key: string };
const fromEnv = process.env.ACS_GATEWAY_ID && process.env.ACS_GATEWAY_KEY
  ? { server: process.env.ACS_SERVER || 'http://localhost:3000', id: process.env.ACS_GATEWAY_ID, key: process.env.ACS_GATEWAY_KEY } : null;
let cfg: Cfg | null = fromEnv ?? (existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : null);
let gw: AcsGateway | null = null;
const opened: { at: string; pointId: string }[] = [];

function start() {
  if (!cfg) return;
  gw = new AcsGateway({ ...cfg, file: stateFile });
  gw.onOpen = (pointId) => { opened.unshift({ at: new Date().toISOString(), pointId }); opened.length = Math.min(opened.length, 10); console.log(`Команда: открыть турникет ${pointId}`); };
  gw.sync().then((ok) => console.log(ok ? 'Шлюз: правила получены' : `Шлюз: нет связи с системой (${gw?.lastError})`));
}
start();
setInterval(() => { gw?.sync(); }, 60_000);   // правила раз в минуту
setInterval(() => { gw?.flush(); }, 10_000);  // очередь проходов раз в 10 секунд

const body = (req: IncomingMessage) => new Promise<Record<string, unknown>>((ok) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } });
});
const send = (res: ServerResponse, code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return; }
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, { configured: !!cfg, fromEnv: !!fromEnv, server: cfg?.server ?? null, id: cfg?.id ?? null, opened, ...(gw?.status() ?? {}) });
    if (req.method === 'POST' && req.url === '/setup') {
      if (fromEnv) return send(res, 400, { message: 'Шлюз настроен через файл .env' });
      const b = await body(req) as Partial<Cfg>;
      if (!b.server || !b.id || !b.key) return send(res, 400, { message: 'Заполните адрес системы, номер шлюза и ключ' });
      cfg = { server: String(b.server).trim(), id: String(b.id).trim(), key: String(b.key).trim() };
      writeFileSync(cfgFile, JSON.stringify(cfg));
      start();
      const ok = await gw!.sync();
      return send(res, ok ? 200 : 400, ok ? { ok: true } : { message: `Не удалось подключиться: ${gw!.lastError}` });
    }
    if (!gw) return send(res, 400, { message: 'Сначала подключите шлюз к системе' });
    // Точка для драйвера турникета: приложили карту → решение
    if (req.method === 'POST' && req.url === '/pass') {
      const b = await body(req) as { pointId?: string; code?: string; direction?: 'in' | 'out' };
      if (!b.pointId || !b.code) return send(res, 400, { message: 'Нужны pointId и code' });
      return send(res, 200, await gw.pass(b.pointId, b.code, b.direction === 'out' ? 'out' : 'in'));
    }
    if (req.method === 'POST' && req.url === '/offline') { gw.forceOffline = !!(await body(req)).on; if (!gw.forceOffline) { await gw.sync(); await gw.flush(); } return send(res, 200, gw.status()); }
    if (req.method === 'POST' && req.url === '/sync') { await gw.sync(); await gw.flush(); return send(res, 200, gw.status()); }
    send(res, 404, { message: 'Не найдено' });
  } catch (e) { send(res, 500, { message: (e as Error).message }); }
}).listen(Number(process.env.ACS_GATEWAY_PORT || 3100), '127.0.0.1', () => console.log(`Клубная ОС, шлюз ${GATEWAY_VERSION}: откройте http://localhost:${process.env.ACS_GATEWAY_PORT || 3100}`));

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Шлюз турникетов</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--mut:#6b7280;--ok:#15803d;--bad:#b91c1c;--line:#e5e7eb;--acc:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--fg:#e8eaf0;--mut:#9aa3b2;--line:#2b303b;--ok:#4ade80;--bad:#f87171;--acc:#60a5fa}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.wrap{max-width:860px;margin:0 auto;padding:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
h1{font-size:20px;margin:4px 0}h2{font-size:16px;margin:0 0 10px}.mut{color:var(--mut)}label{display:block;margin:8px 0 4px;color:var(--mut);font-size:13px}
input,select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:9px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer}button.p{background:var(--acc);border-color:var(--acc);color:#fff}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.row>*{flex:1 1 160px}.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:13px;border:1px solid currentColor}
.ok{color:var(--ok)}.bad{color:var(--bad)}.big{font-size:22px;font-weight:600;margin:6px 0}table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left}
</style></head><body><div class="wrap">
<h1>Шлюз турникетов</h1><div class="mut">Связывает турникеты клуба с системой и пускает людей, даже когда пропал интернет.</div>
<div class="card" id="setup" hidden><h2>Подключение к системе</h2><div class="mut">Номер шлюза и ключ выдаются в системе: «Проходы» → «Настройка» → «Добавить шлюз».</div>
<label>Адрес системы</label><input id="server" value="http://localhost:3000"><label>Номер шлюза</label><input id="gid"><label>Ключ шлюза</label><input id="key">
<p><button class="p" onclick="setup()">Подключить</button> <span id="setupMsg" class="bad"></span></p></div>
<div class="card" id="main" hidden>
<div class="row"><div><div class="mut">Клуб</div><div class="big" id="club">—</div></div><div><div class="mut">Связь с системой</div><div class="big" id="net">—</div></div><div><div class="mut">Ждут выгрузки</div><div class="big" id="queue">0</div></div></div>
<div class="mut" id="sync"></div>
<p><label style="display:inline;color:var(--fg)"><input type="checkbox" id="off" style="width:auto" onchange="offline(this.checked)"> Проверка: «нет интернета» (шлюз не обращается к системе)</label></p></div>
<div class="card" id="emu" hidden><h2>Эмулятор турникета</h2><div class="mut">Так будет работать настоящий турникет: приложили карту — шлюз решает, открыть ли.</div>
<div class="row"><div><label>Турникет</label><select id="point"></select></div><div><label>Номер карты или QR</label><input id="code" placeholder="например, 100001"></div></div>
<p class="row"><button class="p" onclick="pass('in')">Приложить на вход</button><button onclick="pass('out')">Приложить на выход</button></p>
<div id="res"></div></div>
<div class="card"><h2>Последние проходы</h2><table><thead><tr><th>Время</th><th>Кто</th><th>Решение</th><th>Как</th></tr></thead><tbody id="log"></tbody></table></div>
</div><script>
const $=id=>document.getElementById(id);
const t=s=>new Date(s).toLocaleTimeString('ru-RU');
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function j(u,b){const r=await fetch(u,{method:b?'POST':'GET',headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});const d=await r.json();if(!r.ok)throw new Error(d.message||'Ошибка');return d}
async function setup(){$('setupMsg').textContent='';try{await j('/setup',{server:$('server').value,id:$('gid').value,key:$('key').value});load()}catch(e){$('setupMsg').textContent=e.message}}
async function offline(on){await j('/offline',{on});load()}
async function pass(direction){const r=await j('/pass',{pointId:$('point').value,code:$('code').value,direction});
$('res').innerHTML='<div class="big '+(r.allow?'ok':'bad')+'">'+(r.allow?'Открыто':'Закрыто')+(r.name?': '+e(r.name):'')+'</div><div>'+e(r.reason)+'</div>'+(r.warn?'<div class="bad">'+e(r.warn)+'</div>':'')+'<div class="mut">'+(r.mode==='online'?'решила система':'решил шлюз без связи')+', '+r.ms+' мс</div>';load()}
let pts='';
async function load(){const s=await j('/status');$('setup').hidden=s.configured;$('main').hidden=$('emu').hidden=!s.configured;if(!s.configured)return;
$('club').textContent=s.club||'—';$('net').innerHTML=s.online?'<span class="ok">есть</span>':'<span class="bad">нет</span>';$('queue').textContent=s.queued;$('off').checked=s.forceOffline;
$('sync').textContent=(s.lastSyncAt?'Правила обновлены '+t(s.lastSyncAt)+', карт в памяти: '+s.cards:'Правил ещё нет')+(s.lastError&&!s.forceOffline?'. Ошибка: '+s.lastError:'');
const p=JSON.stringify(s.points);if(p!==pts){pts=p;$('point').innerHTML=s.points.map(x=>'<option value="'+e(x.id)+'">'+e(x.name)+'</option>').join('')}
$('log').innerHTML=(s.log||[]).map(x=>'<tr><td>'+t(x.at)+'</td><td>'+e(x.name||x.code)+'</td><td class="'+(x.allow?'ok':'bad')+'">'+(x.allow?'пустил':'не пустил')+': '+e(x.reason)+'</td><td>'+(x.mode==='online'?'онлайн':'без связи')+'</td></tr>').join('')}
load();setInterval(load,2000);
</script></body></html>`;
