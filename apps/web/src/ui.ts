import { ApiError } from './api.ts';

export const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Нет связи с сервером');

export function toast(text: string) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.textContent = text;
  el.className = 'toast';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

const tf = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const dt = (s: string | null | undefined) => (s ? tf.format(new Date(s)) : '—');

/** Значение для <input type="datetime-local"> через N минут от текущего момента. */
export function localInput(minutesAhead: number) {
  const d = new Date(Date.now() + minutesAhead * 60_000);
  d.setSeconds(0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocal = (v: string) => new Date(v).toISOString();
