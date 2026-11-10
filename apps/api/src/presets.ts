// Готовые настройки клуба по модели продаж: воронки с этапами и источники лидов.
import type pg from 'pg';
import { ensureMsgDefaults } from './modules/messaging.ts';

type Q = Pick<pg.ClientBase, 'query'>;
type StageDef = [name: string, kind: 'open' | 'won' | 'lost'];
type PipelineDef = { name: string; purpose: string; isDefault?: boolean; stages: StageDef[] };

const NEW_STAGES: StageDef[] = [['Новый лид', 'open'], ['Дозвонились', 'open'], ['Встреча назначена', 'open'], ['Пришёл на встречу', 'open'], ['Купил', 'won'], ['Отказ', 'lost']];

export const PIPELINE_PRESETS: Record<'term' | 'subscription', PipelineDef[]> = {
  term: [
    { name: 'Новые клиенты', purpose: 'new', isDefault: true, stages: NEW_STAGES },
    { name: 'Продление', purpose: 'renewal', stages: [['Скоро окончание', 'open'], ['Связались', 'open'], ['Предложение сделано', 'open'], ['Продлил', 'won'], ['Не продлил', 'lost']] },
    { name: 'Возобновление бывших', purpose: 'former', stages: [['В работе', 'open'], ['Связались', 'open'], ['Пришёл в клуб', 'open'], ['Вернулся', 'won'], ['Отказ', 'lost']] },
  ],
  subscription: [
    { name: 'Новые подписки', purpose: 'new', isDefault: true, stages: NEW_STAGES.map(([n, k]) => [n === 'Купил' ? 'Оформил подписку' : n, k] as StageDef) },
    { name: 'Неуспешное списание', purpose: 'billing_failed', stages: [['Списание не прошло', 'open'], ['Связались', 'open'], ['Оплатил', 'won'], ['Отписался', 'lost']] },
    { name: 'Риск отписки', purpose: 'churn_risk', stages: [['Давно не был', 'open'], ['Связались', 'open'], ['Вернулся к посещениям', 'won'], ['Отписался', 'lost']] },
    { name: 'Отписавшиеся', purpose: 'churned', stages: [['В работе', 'open'], ['Связались', 'open'], ['Подписался снова', 'won'], ['Отказ', 'lost']] },
  ],
};

export const SOURCE_PRESET: [code: string, name: string, channel: string][] = [
  ['site', 'Сайт', 'site'], ['yandex_direct', 'Яндекс.Директ', 'ads'], ['telegram', 'Telegram', 'messenger'], ['whatsapp', 'WhatsApp', 'messenger'],
  ['phone', 'Входящий звонок', 'phone'], ['yandex_maps', 'Яндекс.Карты', 'maps'], ['walk_in', 'Пришёл сам', 'walk_in'],
  ['referral', 'Рекомендация', 'referral'], ['other', 'Другое', 'other'],
];

export async function applyClubPreset(db: Q, tenantId: string, clubId: string, model: 'term' | 'subscription') {
  let sort = 0;
  for (const p of PIPELINE_PRESETS[model]) {
    const id = (await db.query(
      'insert into pipelines(tenant_id, club_id, name, purpose, is_default_for_leads, sort) values ($1,$2,$3,$4,$5,$6) returning id',
      [tenantId, clubId, p.name, p.purpose, !!p.isDefault, sort++])).rows[0].id;
    let i = 0;
    for (const [name, kind] of p.stages) {
      await db.query('insert into pipeline_stages(tenant_id, pipeline_id, name, kind, sort) values ($1,$2,$3,$4,$5)', [tenantId, id, name, kind, i++]);
    }
  }
  await applyMembershipPreset(db, tenantId, clubId, model);
  await ensureMsgDefaults(db as never, tenantId, clubId);
}

export async function ensureLeadSources(db: Q, tenantId: string) {
  for (const [code, name, channel] of SOURCE_PRESET) {
    await db.query('insert into lead_sources(tenant_id, code, name, channel) values ($1,$2,$3,$4) on conflict (tenant_id, code) do nothing', [tenantId, code, name, channel]);
  }
}

// Шаг 6. Тарифы по умолчанию для нового клуба (цены в копейках, собственник или управляющий меняет их в разделе «Тарифы»)
type ProductDef = { kind: string; name: string; priceKop: number; durationDays?: number; visitsCount?: number; validityDays?: number; freeze?: boolean; installments?: boolean; accessTo?: string };
export const PRODUCT_PRESETS: Record<'term' | 'subscription', ProductDef[]> = {
  term: [
    { kind: 'term', name: 'Годовой безлимит', priceKop: 4_200_000, durationDays: 365, freeze: true, installments: true },
    { kind: 'term', name: 'Полгода безлимит', priceKop: 2_580_000, durationDays: 182, freeze: true, installments: true },
    { kind: 'term', name: 'Месяц безлимит', priceKop: 650_000, durationDays: 30, freeze: false },
    { kind: 'visits', name: '10 посещений', priceKop: 900_000, visitsCount: 10, validityDays: 60, freeze: false },
    { kind: 'guest', name: 'Гостевой визит', priceKop: 100_000, validityDays: 1, freeze: false },
    { kind: 'personal', name: 'Персональные тренировки, 10 занятий', priceKop: 2_500_000, visitsCount: 10, validityDays: 90, freeze: false, installments: true },
  ],
  subscription: [
    { kind: 'subscription', name: 'Подписка «Безлимит»', priceKop: 490_000, freeze: false },
    { kind: 'subscription', name: 'Подписка «Дневная» (до 17:00)', priceKop: 340_000, freeze: false, accessTo: '17:00' },
    { kind: 'guest', name: 'Гостевой визит', priceKop: 100_000, validityDays: 1, freeze: false },
    { kind: 'personal', name: 'Персональные тренировки, 10 занятий', priceKop: 2_500_000, visitsCount: 10, validityDays: 90, freeze: false, installments: true },
  ],
};

export async function applyMembershipPreset(db: Q, tenantId: string, clubId: string, model: 'term' | 'subscription') {
  await db.query('insert into club_membership_settings(club_id, tenant_id) values ($1,$2) on conflict (club_id) do nothing', [clubId, tenantId]);
  await db.query('insert into club_access_settings(club_id, tenant_id) values ($1,$2) on conflict (club_id) do nothing', [clubId, tenantId]);
  if ((await db.query('select 1 from products where club_id = $1 limit 1', [clubId])).rowCount) return;
  let sort = 0;
  for (const p of PRODUCT_PRESETS[model]) {
    const id = (await db.query(
      `insert into products(tenant_id, club_id, kind, name, duration_days, visits_count, validity_days, freeze_allowed, installments_allowed, sort, access_to)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [tenantId, clubId, p.kind, p.name, p.durationDays ?? null, p.visitsCount ?? null, p.validityDays ?? null, !!p.freeze, !!p.installments, sort++, p.accessTo ?? null])).rows[0].id;
    await db.query('insert into price_versions(tenant_id, club_id, product_id, amount_kop) values ($1,$2,$3,$4)', [tenantId, clubId, id, p.priceKop]);
  }
}
