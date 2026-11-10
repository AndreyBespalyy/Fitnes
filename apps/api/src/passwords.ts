import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

const COMMON = new Set(['1234567890', 'qwertyuiop', 'password123', 'йцукенгшщз', '0987654321', 'qwerty1234', '1q2w3e4r5t', 'fitnes2026']);

export const hashPassword = (p: string) => hash(p);
export const verifyPassword = (h: string, p: string) => verify(h, p).catch(() => false);

/** Возвращает текст ошибки или null, если пароль подходит. */
export function checkPasswordPolicy(password: string, login: string): string | null {
  if (password.length < 10) return 'Пароль должен быть не короче 10 символов';
  if (password.toLowerCase().includes(login.toLowerCase())) return 'Пароль не должен содержать логин';
  if (COMMON.has(password.toLowerCase())) return 'Этот пароль слишком простой';
  if (/^(.)\1+$/.test(password)) return 'Пароль не должен состоять из одного символа';
  return null;
}

/** Временный пароль без похожих символов (0/O, 1/l). */
export function tempPassword(): string {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += a[randomInt(a.length)];
  return s;
}
