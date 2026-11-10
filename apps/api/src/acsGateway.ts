// Шаг 11. Шлюз клуба: программа на компьютере ресепшн между турникетами и системой.
// - Пока есть связь, спрашивает решение у системы (ответ меньше секунды).
// - Нет связи — решает сам по сохранённому снимку правил, проходы копит в очереди.
// - Связь вернулась — выгружает очередь; повтор одного и того же события система не посчитает дважды.
// Драйвер конкретного турникета (модель уточним на финише) вызывает pass() и открывает турникет по ответу.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { offlineDecide, type Direction, type Snapshot } from './modules/acsRules.ts';

export type QueuedEvent = { externalId: string; pointId: string; code: string; direction: Direction; at: string; allow: boolean; reasonCode: string; reason: string };
export type PassResult = { allow: boolean; reason: string; reasonCode: string; name: string | null; warn?: string | null; mode: 'online' | 'offline'; ms: number };
type State = { rules: Snapshot | null; queue: QueuedEvent[]; seq: number; lastSyncAt: string | null; lastOnlineAt: string | null };

export const GATEWAY_VERSION = '1.0'; // уходит в заголовке запроса, только латиница

export class AcsGateway {
  state: State = { rules: null, queue: [], seq: 0, lastSyncAt: null, lastOnlineAt: null };
  /** Ручной режим «нет интернета» для проверки AT16 */
  forceOffline = false;
  online = false;
  lastError: string | null = null;
  log: (PassResult & { at: string; code: string; pointId: string; direction: Direction })[] = [];
  onOpen: (pointId: string) => void = () => {};

  constructor(private o: { server: string; id: string; key: string; fetch?: typeof fetch; file?: string; timeoutMs?: number; now?: () => Date }) {
    if (o.file && existsSync(o.file)) {
      try { this.state = { ...this.state, ...JSON.parse(readFileSync(o.file, 'utf8')) }; } catch { /* испорченный файл — начинаем с чистого листа */ }
    }
  }

  private get f() { return this.o.fetch ?? fetch; }
  private now() { return this.o.now ? this.o.now() : new Date(); }
  private save() {
    if (!this.o.file) return;
    writeFileSync(`${this.o.file}.tmp`, JSON.stringify(this.state));
    renameSync(`${this.o.file}.tmp`, this.o.file);
  }
  private async call(method: string, path: string, body?: unknown) {
    if (this.forceOffline) throw new Error('Нет связи (режим проверки)');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 800);
    try {
      const r = await this.f(`${this.o.server.replace(/\/$/, '')}/api/acs/gw/${this.o.id}${path}`, {
        method, signal: ctl.signal,
        headers: { 'x-gateway-key': this.o.key, 'x-gateway-queued': String(this.state.queue.length), 'x-gateway-version': GATEWAY_VERSION, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 401) throw new Error('Неверный ключ шлюза: выпустите новый ключ в системе');
      if (!r.ok) throw new Error(`Система ответила ${r.status}`);
      this.online = true; this.lastError = null; this.state.lastOnlineAt = this.now().toISOString();
      return await r.json();
    } catch (e) {
      this.online = false;
      this.lastError = (e as Error).name === 'AbortError' ? 'Система не ответила вовремя' : (e as Error).message;
      throw e;
    } finally { clearTimeout(timer); }
  }

  /** Забрать свежие правила и команды «открыть турникет». */
  async sync() {
    const timeout = this.o.timeoutMs;
    this.o.timeoutMs = Math.max(timeout ?? 800, 15_000); // снимок большой, ждём дольше
    try {
      const rules = await this.call('GET', '/rules') as Snapshot;
      this.state.rules = rules; this.state.lastSyncAt = this.now().toISOString();
      this.save();
      for (const c of rules.commands ?? []) {
        this.onOpen(c.pointId);
        await this.call('POST', `/commands/${c.id}/done`).catch(() => {});
      }
      return true;
    } catch { return false; } finally { this.o.timeoutMs = timeout; }
  }

  /** Человек приложил карту или QR. Возвращает решение: открыть турникет или нет. */
  async pass(pointId: string, code: string, direction: Direction = 'in'): Promise<PassResult> {
    const t0 = Date.now();
    const at = this.now();
    const externalId = `${this.o.id.slice(0, 8)}-${at.getTime()}-${++this.state.seq}`;
    let res: PassResult;
    try {
      const r = await this.call('POST', '/decide', { pointId, code, direction, externalId });
      res = { allow: r.allow, reason: r.reason, reasonCode: r.reasonCode, name: r.name, warn: r.warn, mode: 'online', ms: Date.now() - t0 };
    } catch {
      // Нет связи: решаем по сохранённым правилам, если они не слишком старые
      const s = this.state.rules;
      const stale = !s || !this.state.lastSyncAt || at.getTime() - Date.parse(this.state.lastSyncAt) > (s.offlineHours ?? 24) * 3600_000;
      const v = stale ? { allow: false, reasonCode: 'no_rules', reason: 'Нет связи и нет свежих правил: пустите вручную', name: null } : offlineDecide(s!, code, direction, at);
      res = { allow: v.allow, reason: v.reason, reasonCode: v.reasonCode, name: v.name, warn: (v as { warn?: string | null }).warn ?? null, mode: 'offline', ms: Date.now() - t0 };
      this.state.queue.push({ externalId, pointId, code, direction, at: at.toISOString(), allow: v.allow, reasonCode: v.reasonCode, reason: v.reason });
    }
    this.save();
    this.log.unshift({ ...res, at: at.toISOString(), code, pointId, direction });
    this.log.length = Math.min(this.log.length, 50);
    return res;
  }

  /** Выгрузить проходы, накопленные без связи. */
  async flush() {
    if (!this.state.queue.length) return { sent: 0 };
    const batch = this.state.queue.slice(0, 500);
    const timeout = this.o.timeoutMs;
    this.o.timeoutMs = Math.max(timeout ?? 800, 30_000);
    try {
      const r = await this.call('POST', '/events', { events: batch });
      const sent = new Set(batch.map((e) => e.externalId));
      this.state.queue = this.state.queue.filter((e) => !sent.has(e.externalId));
      this.save();
      return { sent: batch.length, accepted: r.accepted as number, duplicates: r.duplicates as number };
    } catch { return { sent: 0 }; } finally { this.o.timeoutMs = timeout; }
  }

  status() {
    return { online: this.online && !this.forceOffline, forceOffline: this.forceOffline, lastError: this.lastError, lastSyncAt: this.state.lastSyncAt,
      queued: this.state.queue.length, club: this.state.rules?.clubName ?? null, points: this.state.rules?.points ?? [], cards: this.state.rules?.entries.length ?? 0, log: this.log };
  }
}
