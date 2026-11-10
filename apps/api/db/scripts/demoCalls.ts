// Шаг 14. Демо-разговоры для тестового сервера, пока ИИ-сервер (GPU) не подключён: расшифровки и резюме
// подготовлены заранее и помечены «демо-пример», чтобы было видно, как выглядят экраны «Звонки» и «Качество ИИ».
// Добавляются один раз для демо-сети.
import type { Db } from '../../src/db.ts';
import type { Summary } from '../../src/lib/aiClient.ts';

export const DEMO_CALLS_MARK = 'demo.calls_seeded';
const ENGINE = 'демо-пример (без ИИ-сервера)';

type Line = ['m' | 'c', string];
type Demo = { lines: Line[]; summary: Summary; dir: 'in' | 'out'; dur: number };

const H = 3600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const DEMOS: Demo[] = [
  {
    dir: 'in', dur: 186,
    lines: [
      ['m', 'Добрый день, фитнес-клуб, меня зовут Мария, слушаю вас.'],
      ['c', 'Здравствуйте, я оставляла заявку на сайте, хотела узнать про годовой абонемент.'],
      ['m', 'Да, конечно. Подскажите, как часто планируете заниматься и в какое время удобно?'],
      ['c', 'Хочу три раза в неделю, вечером после работы, часов с семи. Интересует тренажёрный зал и бассейн.'],
      ['m', 'Годовой безлимит включает зал, бассейн и групповые программы. Давайте я приглашу вас на гостевой визит, всё покажу.'],
      ['c', 'Давайте. Только меня смущает цена, в соседнем клубе дешевле.'],
      ['m', 'Понимаю. На визите расскажу про рассрочку, многие так берут. В четверг в семь вечера удобно?'],
      ['c', 'Да, в четверг в семь подойду.'],
    ],
    summary: {
      essence: 'Клиентка оставила заявку на сайте, интересуется годовым абонементом. Записана на гостевой визит.',
      need: 'Зал и бассейн три раза в неделю, вечером с 19:00', objections: ['В соседнем клубе дешевле'],
      agreements: 'Гостевой визит в четверг в 19:00, на визите рассказать про рассрочку', outcome: 'interested',
      nextStep: { title: 'Гостевой визит: показать клуб, рассказать про рассрочку', kind: 'meeting', dueAt: iso(46 * H) },
    },
  },
  {
    dir: 'out', dur: 142,
    lines: [
      ['m', 'Добрый день, это Мария из фитнес-клуба. Вы были у нас на пробной тренировке в субботу, как впечатления?'],
      ['c', 'Добрый день. В целом понравилось, тренер хороший. Но я пока думаю.'],
      ['m', 'Что больше всего смущает?'],
      ['c', 'Не уверена, что буду ходить регулярно, не хочу платить за год сразу.'],
      ['m', 'Можно начать с абонемента на месяц, а потом перейти на полгода с зачётом. Подойдёт?'],
      ['c', 'Месяц, наверное, да. Я подумаю до пятницы и перезвоню.'],
      ['m', 'Хорошо, я сама наберу вам в пятницу днём, если не возражаете.'],
      ['c', 'Хорошо, договорились.'],
    ],
    summary: {
      essence: 'Звонок после пробной тренировки. Клиентке понравилось, но она сомневается в регулярности занятий.',
      need: 'Начать с короткого абонемента', objections: ['Не уверена, что будет ходить регулярно', 'Не хочет платить за год сразу'],
      agreements: 'Предложен абонемент на месяц с переходом на полгода. Клиентка думает до пятницы', outcome: 'thinking',
      nextStep: { title: 'Перезвонить: решение по абонементу на месяц', kind: 'call', dueAt: iso(70 * H) },
    },
  },
  {
    dir: 'out', dur: 95,
    lines: [
      ['m', 'Здравствуйте, это фитнес-клуб. Ваш абонемент заканчивается через неделю, хотела предложить продление.'],
      ['c', 'Добрый день. Да, я собирался продлевать. Есть какие-то скидки для своих?'],
      ['m', 'При продлении на год до конца срока цена остаётся прежней, без повышения.'],
      ['c', 'Отлично, тогда продлю на год. Могу оплатить по ссылке?'],
      ['m', 'Да, отправлю ссылку в мессенджер сегодня.'],
      ['c', 'Спасибо, жду.'],
    ],
    summary: {
      essence: 'Предложено продление абонемента, клиент согласился продлить на год по прежней цене.',
      need: 'Продление на год, оплата по ссылке', objections: [], agreements: 'Отправить ссылку на оплату в мессенджер сегодня', outcome: 'bought',
      nextStep: { title: 'Отправить ссылку на оплату продления на год', kind: 'message', dueAt: iso(2 * H) },
    },
  },
  {
    dir: 'in', dur: 210,
    lines: [
      ['c', 'Алло, здравствуйте, мне дали ваш номер, я по поводу персональных тренировок.'],
      ['m', 'Здравствуйте! Подскажите, какая цель: снижение веса, сила, восстановление?'],
      ['c', 'После травмы колена, врач разрешил нагрузки, но аккуратно.'],
      ['m', 'У нас есть тренер, который работает с реабилитацией. Пакет на десять занятий. Можем начать с вводной консультации.'],
      ['c', 'А сколько стоит пакет?'],
      ['m', 'Тридцать пять тысяч за десять занятий, консультация бесплатно.'],
      ['c', 'Дороговато, но здоровье важнее. Давайте консультацию в понедельник утром.'],
      ['m', 'Записываю на понедельник на десять утра.'],
    ],
    summary: {
      essence: 'Входящий звонок по рекомендации: персональные тренировки после травмы колена. Записан на вводную консультацию.',
      need: 'Аккуратные нагрузки после травмы колена, тренер по реабилитации', objections: ['Дорого: пакет 35 000 ₽ за 10 занятий'],
      agreements: 'Бесплатная вводная консультация с тренером в понедельник в 10:00', outcome: 'interested',
      nextStep: { title: 'Вводная консультация с тренером по реабилитации', kind: 'meeting', dueAt: iso(118 * H) },
    },
  },
  {
    dir: 'out', dur: 64,
    lines: [
      ['m', 'Добрый день, это фитнес-клуб, вы оставляли заявку на пробную тренировку.'],
      ['c', 'Да, но я уже записался в другой клуб, рядом с работой. Спасибо.'],
      ['m', 'Понимаю. Если что-то поменяется, будем рады видеть.'],
      ['c', 'Хорошо, до свидания.'],
    ],
    summary: {
      essence: 'Клиент отказался: уже записался в другой клуб рядом с работой.', need: '', objections: ['Выбрал другой клуб рядом с работой'],
      agreements: '', outcome: 'refused', nextStep: null,
    },
  },
];

const transcript = (d: Demo) => {
  let t = 0;
  const segments = d.lines.map(([who, text]) => {
    const len = Math.max(2, Math.round(text.split(' ').length * 0.45));
    const s = { speaker: who === 'm' ? 'manager' : 'client', start: t, end: t + len, text };
    t += len + 1;
    return s;
  });
  return { text: d.lines.map(([w, x]) => `${w === 'm' ? 'Менеджер' : 'Клиент'}: ${x}`).join('\n'), segments, language: 'ru', durationSec: d.dur };
};

// Правка менеджера для демонстрации «мелких» и «существенных» правок
const edited = (s: Summary, kind: 'minor' | 'major'): Summary => kind === 'minor'
  ? { ...s, agreements: `${s.agreements}. Клиент просил напомнить накануне` }
  : { ...s, essence: 'Клиент перезвонил сам, обсуждали рассрочку и заморозку. Решение после визита.', need: 'Рассрочка на полгода, заморозка на время отпуска', objections: ['Нужна заморозка на август'] };

export async function seedDemoCalls(c: Db, t: string) {
  if ((await c.query(`select 1 from audit_log where tenant_id = $1 and action = $2`, [t, DEMO_CALLS_MARK])).rowCount) return false;
  const clubs = (await c.query(`select id from clubs where tenant_id = $1 order by created_at`, [t])).rows;
  for (const [ci, club] of clubs.entries()) {
    const mgr = (await c.query(`select a.user_id from user_assignments a where a.club_id = $1 and a.role_code = 'manager' order by a.active_from, a.id limit 1`, [club.id])).rows[0]?.user_id;
    const rop = (await c.query(`select a.user_id from user_assignments a where a.club_id = $1 and a.role_code in ('rop', 'gm') order by (a.role_code = 'rop') desc limit 1`, [club.id])).rows[0]?.user_id;
    if (!mgr) continue;
    const people = (await c.query(
      `select o.id as opp, o.person_id, p.full_name, (select normalized_value from person_contacts pc where pc.person_id = o.person_id and pc.type = 'phone' limit 1) as phone
       from opportunities o join persons p on p.id = o.person_id where o.club_id = $1 and o.status = 'open' order by o.created_at desc limit 9`, [club.id])).rows;
    // [демо, статус резюме, часов назад, правка, оценка РОПа]
    const plan: [number, string, number, '' | 'minor' | 'major', string | null][] = ci === 0
      ? [[0, 'draft', 1, '', null], [1, 'draft', 0.5, '', null], [2, 'confirmed', 26, '', 'ok'], [3, 'confirmed', 30, 'minor', 'minor'], [0, 'confirmed', 50, 'major', 'major'],
        [1, 'auto_applied', 20, '', null], [4, 'confirmed', 52, '', 'ok'], [-1, 'needs_manual', 3, '', null], [-2, 'short', 4, '', null]]
      : [[3, 'draft', 2, '', null], [2, 'confirmed', 28, '', null], [4, 'confirmed', 75, 'minor', null]];
    for (const [i, [di, status, ago, edit, rating]] of plan.entries()) {
      const p = people[i % Math.max(1, people.length)];
      if (!p) break;
      const d = di >= 0 ? DEMOS[di] : null;
      const tr = d ? transcript(d) : di === -2 ? { text: 'Менеджер: Алло, добрый день. Клиент: Перезвоните позже, я за рулём.', segments: [], language: 'ru', durationSec: 9 } : null;
      const started = new Date(Date.now() - ago * H);
      const call = (await c.query(
        `insert into calls(tenant_id, club_id, person_id, opportunity_id, user_id, direction, phone, started_at, duration_sec, source, transcript, asr_status, asr_error, attempts, engine)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'demo',$10,$11,$12,$13,$14) returning id`,
        [t, club.id, p.person_id, p.opp, mgr, d?.dir ?? 'out', p.phone, started, d?.dur ?? (di === -2 ? 9 : 240), tr ? JSON.stringify(tr) : null,
          di === -1 ? 'failed' : 'done', di === -1 ? 'Демо: запись повреждена, речь не распознана' : null, di === -1 ? 3 : 1, d ? ENGINE : null])).rows[0].id;
      if (status === 'short') continue;
      const s = d?.summary ?? null;
      const final = s && status !== 'draft' ? (edit ? edited(s, edit) : s) : null;
      const ratio = !s || status !== 'confirmed' ? null : edit === 'minor' ? 0.08 : edit === 'major' ? 0.46 : 0;
      await c.query(
        `insert into call_summaries(tenant_id, club_id, call_id, draft, engine, confidence, status, final, edit_ratio, confirmed_by, confirmed_at, rop_rating, rated_by, rated_at, rop_notified_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [t, club.id, call, s ? JSON.stringify(s) : null, s ? ENGINE : null, s ? 0.86 : null, status, final ? JSON.stringify(final) : null, ratio,
          status === 'confirmed' ? mgr : null, ['confirmed', 'auto_applied'].includes(status) ? new Date(started.getTime() + H) : null,
          rating, rating ? rop : null, rating ? new Date() : null, status === 'auto_applied' ? new Date(started.getTime() + 2 * H) : null, new Date(started.getTime() + 5 * 60_000)]);
      const who = p.full_name;
      if (status === 'draft') await c.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, call_id, kind, title, due_at) values ($1,$2,$3,$4,$5,'other',$6,$7)`,
        [t, club.id, mgr, p.person_id, call, `Проверьте итог разговора с ${who} (черновик ИИ)`, new Date(started.getTime() + 2 * H)]);
      if (status === 'needs_manual') await c.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, call_id, kind, title, due_at) values ($1,$2,$3,$4,$5,'other',$6,$7)`,
        [t, club.id, mgr, p.person_id, call, `Запись разговора с ${who} не распозналась: напишите итог вручную`, new Date(started.getTime() + 2 * H)]);
      if (status === 'auto_applied' && rop) await c.query(`insert into tasks(tenant_id, club_id, assignee_id, person_id, call_id, kind, title, due_at) values ($1,$2,$3,$4,$5,'other',$6,$7)`,
        [t, club.id, rop, p.person_id, call, `Менеджер не проверил итог разговора с ${who}: ИИ перенёс черновик в карточку, проверьте`, new Date(started.getTime() + 6 * H)]);
    }
  }
  await c.query(`insert into audit_log(tenant_id, actor_id, action, object_type, object_id) values ($1, null, $2, 'tenant', $3)`, [t, DEMO_CALLS_MARK, String(t)]);
  return true;
}
