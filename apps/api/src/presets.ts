// Готовые настройки клуба по модели продаж: воронки с этапами и источники лидов.
import type pg from 'pg';

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
  ['site', 'Сайт', 'site'], ['yandex_direct', 'Яндекс.Директ', 'ads'], ['telegram', 'Telegram', 'messenger'],
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
}

export async function ensureLeadSources(db: Q, tenantId: string) {
  for (const [code, name, channel] of SOURCE_PRESET) {
    await db.query('insert into lead_sources(tenant_id, code, name, channel) values ($1,$2,$3,$4) on conflict (tenant_id, code) do nothing', [tenantId, code, name, channel]);
  }
}
