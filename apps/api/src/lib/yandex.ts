// Yandex Cloud: YandexGPT (тексты, итоги, «Коротко о ситуации») и SpeechKit (расшифровка записей разговоров).
// Выбор Андрея 14.11.2026: расшифровка — сторонний сервис (SpeechKit, асинхронный режим), анализ — YandexGPT.
// Данные обрабатываются в облаке Яндекса в РФ. Телефоны и e-mail клиентов в YandexGPT не передаются.
// Ключи: YANDEX_API_KEY (API-ключ сервисного аккаунта) и YANDEX_FOLDER_ID (каталог). Без них функции выключены.
import type { Fetch, Transcript, Segment } from './aiClient.ts';

export type YandexConfig = {
  apiKey: string;
  folderId: string;
  fetch: Fetch;
  model?: string;          // по умолчанию yandexgpt/latest
  pollMs?: number;
  llmUrl?: string; sttUrl?: string; opUrl?: string;
};

export function yandexConfigFromEnv(f: Fetch = fetch): YandexConfig | null {
  const apiKey = process.env.YANDEX_API_KEY?.trim();
  const folderId = process.env.YANDEX_FOLDER_ID?.trim();
  if (!apiKey || !folderId) return null;
  return { apiKey, folderId, fetch: f, model: process.env.YANDEX_GPT_MODEL?.trim() || undefined };
}

const LLM = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
const STT = 'https://stt.api.cloud.yandex.net/stt/v3';
const OPS = 'https://operation.api.cloud.yandex.net/operations';

async function req(cfg: YandexConfig, url: string, init: RequestInit, timeoutMs: number) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Api-Key ${cfg.apiKey}`);
  headers.set('x-folder-id', cfg.folderId);
  const res = await cfg.fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { const b = JSON.parse(text); msg = b?.error?.message ?? b?.message ?? msg; } catch { /* не JSON */ }
    throw new Error(`Яндекс ответил ${res.status}: ${msg}`);
  }
  return text;
}

/* ---------- YandexGPT ---------- */
export async function ygptComplete(cfg: YandexConfig, system: string, user: string, o: { temperature?: number; maxTokens?: number } = {}) {
  const body = {
    modelUri: `gpt://${cfg.folderId}/${cfg.model ?? 'yandexgpt/latest'}`,
    completionOptions: { stream: false, temperature: o.temperature ?? 0.2, maxTokens: String(o.maxTokens ?? 2000) },
    messages: [{ role: 'system', text: system }, { role: 'user', text: user }],
  };
  const text = await req(cfg, cfg.llmUrl ?? LLM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 120_000);
  const j = JSON.parse(text);
  const out = j?.result?.alternatives?.[0]?.message?.text;
  if (typeof out !== 'string' || !out.trim()) throw new Error('YandexGPT вернул пустой ответ');
  return out.trim();
}

/** Ответ модели в виде JSON: вырезает объект из текста (модель иногда оборачивает его в ```json) */
export function parseJsonLoose(text: string): unknown {
  const s = text.replace(/```(?:json)?/gi, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('В ответе модели нет JSON');
  return JSON.parse(s.slice(a, b + 1));
}

export async function ygptJson<T>(cfg: YandexConfig, system: string, user: string, maxTokens = 2000): Promise<T> {
  return parseJsonLoose(await ygptComplete(cfg, `${system}\nОтвечай только JSON-объектом, без пояснений.`, user, { temperature: 0.1, maxTokens })) as T;
}

/* ---------- SpeechKit, асинхронное распознавание файла (API v3) ---------- */
const CONTAINER: Record<string, string> = { 'audio/mpeg': 'MP3', 'audio/wav': 'WAV', 'audio/ogg': 'OGG_OPUS' };

/** Отправляет запись и ждёт результат. MP3, WAV, OGG — как есть; остальные форматы нужно сохранять в АТС как MP3. */
export async function sttRecognize(cfg: YandexConfig, audio: Buffer, mime: string): Promise<Transcript & { engine: string }> {
  const type = CONTAINER[mime];
  if (!type) throw new Error('SpeechKit принимает записи MP3, WAV или OGG. Настройте в АТС сохранение в MP3');
  const body: Record<string, unknown> = {
    content: audio.toString('base64'),
    recognitionModel: {
      model: 'general',
      audioFormat: { containerAudio: { containerAudioType: type } },
      textNormalization: { textNormalization: 'TEXT_NORMALIZATION_ENABLED', profanityFilter: false, literatureText: true, phoneFormattingMode: 'PHONE_FORMATTING_MODE_DISABLED' },
      languageRestriction: { restrictionType: 'WHITELIST', languageCode: ['ru-RU'] },
    },
  };
  const url = `${cfg.sttUrl ?? STT}/recognizeFileAsync`;
  const op = JSON.parse(await req(cfg, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 120_000));
  const opId = op?.id;
  if (!opId) throw new Error('SpeechKit не вернул номер операции');
  // Ждём готовности: минута записи распознаётся примерно за 10 секунд
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const st = JSON.parse(await req(cfg, `${cfg.opUrl ?? OPS}/${opId}`, { method: 'GET' }, 30_000));
    if (st?.done) { if (st.error) throw new Error(`SpeechKit: ${st.error.message ?? 'ошибка распознавания'}`); break; }
    if (Date.now() > deadline) throw new Error('SpeechKit ещё распознаёт запись, попробуем позже');
    await new Promise((r) => setTimeout(r, cfg.pollMs ?? 5_000));
  }
  const raw = await req(cfg, `${cfg.sttUrl ?? STT}/getRecognition?operationId=${encodeURIComponent(opId)}`, { method: 'GET' }, 120_000);
  return { ...parseRecognition(raw), engine: 'speechkit-v3' };
}

/** Ответ getRecognition — поток JSON-объектов (по одному в строке или массив). Берём итоговые фразы по каналам. */
export function parseRecognition(raw: string): Transcript {
  const items: Record<string, any>[] = [];
  const t = raw.trim();
  if (t.startsWith('[')) items.push(...JSON.parse(t));
  else for (const line of t.split('\n')) { const s = line.trim(); if (s) { try { items.push(JSON.parse(s)); } catch { /* пропуск */ } } }
  const segs: Segment[] = [];
  for (const it0 of items) {
    const it = it0.result ?? it0;
    const fin = it.finalRefinement?.normalizedText ?? it.final;
    const alt = fin?.alternatives?.[0];
    if (!alt?.text) continue;
    const channel = it.channelTag ?? fin.channelTag ?? '0';
    const start = Number(alt.startTimeMs ?? 0) / 1000;
    const end = Number(alt.endTimeMs ?? 0) / 1000;
    // Если та же фраза уже пришла в «сыром» виде, нормализованная её заменяет
    const same = segs.findIndex((s) => s.start === start && s.speaker === `канал ${channel}`);
    const seg = { speaker: `канал ${channel}`, start, end, text: String(alt.text).trim() };
    if (same >= 0) { if (it.finalRefinement) segs[same] = seg; } else segs.push(seg);
  }
  segs.sort((a, b) => a.start - b.start);
  const durationSec = segs.length ? Math.round(Math.max(...segs.map((s) => s.end))) : 0;
  return { text: segs.map((s) => s.text).join(' '), segments: segs, language: 'ru', durationSec };
}
