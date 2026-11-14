// Клиент ИИ-сервера (services/ai). Сервер свой, внутренний: записи и расшифровки во внешние сервисы не уходят.
// Адрес и ключ задаются AI_URL и AI_TOKEN. Вместо своего сервера можно подключить Яндекс (YANDEX_API_KEY, YANDEX_FOLDER_ID).
// Если не задано ни то ни другое, ИИ выключен: записи копятся и ждут подключения.
import { sttRecognize, ygptComplete, ygptJson, type YandexConfig, yandexConfigFromEnv } from './yandex.ts';

export type Fetch = typeof fetch;
export type Segment = { speaker: string | null; start: number; end: number; text: string };
export type Transcript = { text: string; segments: Segment[]; language?: string; durationSec?: number };
export type NextStep = { title: string; kind: 'call' | 'meeting' | 'message' | 'other'; dueAt: string | null };
export type Summary = {
  essence: string;          // суть разговора
  need: string;             // потребность клиента
  objections: string[];     // возражения
  agreements: string;       // договорённости
  outcome: 'interested' | 'thinking' | 'refused' | 'bought' | 'other' | null;
  nextStep: NextStep | null;
};
/** url — свой ИИ-сервер (services/ai); yandex — SpeechKit + YandexGPT (выбор Андрея 14.11.2026). Свой сервер главнее, если заданы оба. */
export type AiConfig = { url: string; token?: string; fetch: Fetch; timeoutMs?: number; yandex?: YandexConfig };

export function aiConfigFromEnv(f: Fetch = fetch): AiConfig | null {
  const url = process.env.AI_URL?.trim();
  if (url) return { url: url.replace(/\/+$/, ''), token: process.env.AI_TOKEN, fetch: f };
  const yandex = yandexConfigFromEnv(f);
  return yandex ? { url: '', fetch: f, yandex } : null;
}
const ya = (cfg: AiConfig) => (!cfg.url && cfg.yandex ? cfg.yandex : null);

async function call<T>(cfg: AiConfig, path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const headers = new Headers(init.headers);
  if (cfg.token) headers.set('authorization', `Bearer ${cfg.token}`);
  const res = await cfg.fetch(`${cfg.url}${path}`, { ...init, headers, signal: AbortSignal.timeout(cfg.timeoutMs ?? timeoutMs) });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  if (!res.ok) {
    const msg = (body as { detail?: string; message?: string } | null)?.detail ?? (body as { message?: string } | null)?.message ?? text.slice(0, 200);
    throw new Error(`ИИ-сервер ответил ${res.status}: ${msg}`);
  }
  return body as T;
}

export async function aiHealth(cfg: AiConfig) {
  const y = ya(cfg);
  if (y) { await ygptComplete(y, 'Ответь одним словом.', 'Проверка связи', { maxTokens: 5 }); return { ok: true, asr: 'Yandex SpeechKit', llm: `YandexGPT (${y.model ?? 'yandexgpt/latest'})` }; }
  return call<{ ok: boolean; asr?: string; llm?: string; promptVersion?: string }>(cfg, '/health', { method: 'GET' }, 5_000);
}

export async function aiTranscribe(cfg: AiConfig, audio: Buffer, fileName: string, mime: string) {
  const y = ya(cfg);
  if (y) return sttRecognize(y, audio, mime);
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(audio)], { type: mime }), fileName);
  form.set('language', 'ru');
  return call<Transcript & { engine: string }>(cfg, '/v1/transcribe', { method: 'POST', body: form }, 15 * 60_000);
}

const SUMMARY_PROMPT = `Ты помогаешь менеджеру фитнес-клуба. По расшифровке телефонного разговора с клиентом составь итог.
Поля JSON: essence — суть разговора (2–4 предложения), need — потребность клиента, objections — массив возражений,
agreements — о чём договорились, outcome — одно из interested, thinking, refused, bought, other,
nextStep — {title, kind: call|meeting|message|other, dueAt: дата-время ISO 8601 с часовым поясом или null} либо null.
Пиши по-русски, только то, что прозвучало в разговоре. Если разговора по сути не было, верни {"essence": ""}.`;

export async function aiSummarize(cfg: AiConfig, transcript: Transcript, context: Record<string, unknown>) {
  const y = ya(cfg);
  if (y) {
    const lines = transcript.segments?.length ? transcript.segments.map((s) => `${s.speaker ?? ''}: ${s.text}`).join('\n') : transcript.text;
    const raw = await ygptJson<unknown>(y, SUMMARY_PROMPT, `Контекст: ${JSON.stringify(context)}\n\nРасшифровка:\n${lines.slice(0, 24000)}`);
    const summary = normalizeSummary(raw);
    return { summary, confidence: summary ? 0.8 : null, engine: `yandexgpt:${y.model ?? 'yandexgpt/latest'}`, reason: summary ? undefined : 'Недостаточно данных в разговоре' };
  }
  return call<{ summary: Summary | null; confidence: number | null; engine: string; reason?: string }>(cfg, '/v1/summarize', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcript, context }),
  }, 5 * 60_000);
}

/* ---------- проверка и нормализация резюме (от ИИ и от менеджера одинаково) ---------- */
const OUTCOMES = ['interested', 'thinking', 'refused', 'bought', 'other'];
const KINDS = ['call', 'meeting', 'message', 'other'];
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function normalizeSummary(raw: unknown): Summary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const objections = Array.isArray(r.objections) ? r.objections : typeof r.objections === 'string' ? r.objections.split('\n') : [];
  const ns = r.nextStep as Record<string, unknown> | null | undefined;
  let nextStep: NextStep | null = null;
  if (ns && typeof ns === 'object' && str(ns.title, 200)) {
    const due = typeof ns.dueAt === 'string' && ns.dueAt ? new Date(ns.dueAt) : null;
    nextStep = {
      title: str(ns.title, 200),
      kind: (KINDS.includes(String(ns.kind)) ? ns.kind : 'call') as NextStep['kind'],
      dueAt: due && !Number.isNaN(due.getTime()) ? due.toISOString() : null,
    };
  }
  const s: Summary = {
    essence: str(r.essence, 1500),
    need: str(r.need, 800),
    objections: objections.map((o) => str(o, 300)).filter(Boolean).slice(0, 10),
    agreements: str(r.agreements, 800),
    outcome: OUTCOMES.includes(String(r.outcome)) ? (r.outcome as Summary['outcome']) : null,
    nextStep,
  };
  return s.essence ? s : null;
}

export const summaryText = (s: Summary | null) => !s ? '' : [s.essence, s.need, ...s.objections, s.agreements, s.outcome ?? '', s.nextStep?.title ?? ''].join('\n');

/** Доля изменённого текста между черновиком ИИ и итогом менеджера по словам (0 — без правок, 1 — переписано целиком) */
export function editRatio(a: string, b: string) {
  const wa = a.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 600);
  const wb = b.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 600);
  if (!wa.length && !wb.length) return 0;
  let prev = new Array(wb.length + 1).fill(0);
  for (let i = 1; i <= wa.length; i++) {
    const cur = new Array(wb.length + 1).fill(0);
    for (let j = 1; j <= wb.length; j++) cur[j] = wa[i - 1] === wb[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return Math.round((1 - (2 * prev[wb.length]) / (wa.length + wb.length)) * 1000) / 1000;
}

/** Правки до 20 % текста считаются несущественными: резюме принято (цель шага 14 — не менее 80 % таких) */
export const MINOR_EDIT = 0.2;

/* ---------- ИИ-помощник настройки ---------- */
export type ConfigFieldBrief = { path: string; label: string; type: string; min?: number; max?: number; value: unknown };
export type ConfigSuggestion = { changes: { path: string; value: unknown }[]; preset?: string; explanation?: string; unknown?: string[]; engine?: string };
/** Предложение изменений настроек по просьбе словами. Уходят только названия и значения настроек клуба. */
export async function aiConfigSuggest(cfg: AiConfig, text: string, fields: ConfigFieldBrief[]) {
  const y = ya(cfg);
  if (y) {
    const r = await ygptJson<ConfigSuggestion>(y, `Ты помогаешь настроить фитнес-клуб. Даны настройки (path, label, type, min, max, value) и просьба словами.
Верни JSON {changes: [{path, value}], explanation: кратко по-русски что меняешь, unknown: [части просьбы, для которых нет настройки]}. Меняй только перечисленные path, соблюдай min и max.`,
      `Настройки: ${JSON.stringify(fields)}\n\nПросьба: ${text}`);
    return { changes: Array.isArray(r.changes) ? r.changes : [], explanation: r.explanation, unknown: r.unknown, engine: 'yandexgpt' } as ConfigSuggestion;
  }
  return call<ConfigSuggestion>(cfg, '/v1/config-suggest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, fields }),
  }, 60_000);
}

/* ---------- оценка разговора по чек-листу стандарта ---------- */
export type CallEvalResult = { items: { id: string; ok: boolean | null; quote?: string }[]; engine?: string };
/** Оценка расшифровки по пунктам чек-листа. Расшифровка уходит только на свой ИИ-сервер клуба. */
export async function aiEvaluateCall(cfg: AiConfig, transcript: unknown, checklist: { id: string; text: string }[]) {
  const y = ya(cfg);
  if (y) {
    const r = await ygptJson<CallEvalResult>(y, `Оцени телефонный разговор менеджера фитнес-клуба по пунктам чек-листа.
Верни JSON {items: [{id, ok: true|false|null, quote: короткая цитата из разговора}]}. null — если по разговору нельзя понять.`,
      `Чек-лист: ${JSON.stringify(checklist)}\n\nРасшифровка: ${JSON.stringify(transcript).slice(0, 24000)}`);
    return { items: Array.isArray(r.items) ? r.items : [], engine: 'yandexgpt' };
  }
  return call<CallEvalResult>(cfg, '/v1/evaluate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcript, checklist }),
  }, 5 * 60_000);
}
