// «Дядя Витя» сверяет разговоры менеджеров со скриптами отдела продаж (просьба Андрея 17.11.2026):
// — по расшифровке звонка выбирает подходящий скрипт (по заявке, входящий, по базе, подтверждение, продление, повторный);
// — ИИ отмечает, какие этапы пройдены и не прозвучало ли «нельзя»; короткое резюме берётся из итога разговора;
// — менеджеру в мессенджер CRM — разбор: что упущено и как сказать по скрипту, с кнопкой «Открыть разговор»;
// — если менеджер отходит от скрипта и после второго такого сообщения (третий разбор за 30 дней) — РОПу сводка со ссылками на разговоры;
// — упущения идут в рейтинг менеджера (часть «Скрипты», agentSalesTeam.ts).
// Скрипты — «Скрипты ОП — коротко» Сандов Фитнес, присланные Андреем 17.11.2026.
import { aiEvaluateCall, type AiConfig } from '../lib/aiClient.ts';
import type { Db } from '../db.ts';
import { botSay } from './agentMeetings.ts';
import { standardAt } from './config.ts';

export type ScriptItem = { id: string; text: string; how: string };
export type Script = { code: string; title: string; steps: ScriptItem[]; never: ScriptItem[] };

const step = (id: string, text: string, how: string): ScriptItem => ({ id, text, how });
const never = (id: string, phrase: string, how: string): ScriptItem => ({ id, text: `Не прозвучало: ${phrase}`, how });

const NEVER_COMMON = [
  never('n_actual', '«вам актуально?»', 'Вместо вопроса — предложение: «Приходите на пробную тренировку — в будни или на выходных?»'),
  never('n_whenever', '«приезжайте / приходите, когда удобно» (без конкретного дня и времени)', 'Всегда называйте день и время: «Тогда четверг, 19:00 — записываю»'),
];

export const SCRIPTS: Script[] = [
  { code: 'lead', title: 'Звонок по заявке', steps: [
    step('contact', 'Контакт: представился, поблагодарил за заявку, спросил, удобно ли говорить', '«[Имя], добрый день! Это [Имя] из {клуба}. Вы оставляли заявку — спасибо. Удобно две минуты?»'),
    step('road', 'Спросил, рядом ли клиент живёт или работает', '«Вы рядом живёте или работаете?»'),
    step('expect', 'Спросил, чего клиент ждёт от занятий (тонус, вес, осанка, сила, спина)', '«А чего вы ждёте от занятий? Что должно измениться — тонус, вес, осанка, сила, спина?»'),
    step('block', 'Спросил, что мешало заниматься раньше', '«А что мешало заниматься раньше?»'),
    step('react', 'Повторил запрос клиента его словами', '«Поняла: хочется вернуть тонус и убрать тяжесть в спине, а раньше не находилось времени. У нас как раз так и ходят»'),
    step('present', 'Презентация: три факта о клубе под запрос клиента', 'Три факта под его слова: 1 100 м² зала и 140 тренажёров без очереди · групповые · круглосуточно · сауна, полотенца, вода · бокс'),
    step('trial', 'Пригласил на бесплатную пробную тренировку с тренером', '«Приходите на пробную тренировку с тренером — бесплатно. Он подберёт программу под вашу задачу»'),
    step('time', 'Назвал конкретный день и время (выбор: будни/выходные, утро/вечер)', '«Вам удобнее в будни или на выходных?» → «Утром или вечером?» → «Тогда четверг, 19:00 — записываю»'),
    step('final', 'Итог: адрес, паспорт, сообщение в мессенджер', '«{адрес}. Возьмите паспорт — пропускная система. Отправлю адрес и время — Телеграм или Ватсап?»'),
  ], never: [never('n_price_first', 'цена до вопросов о задаче клиента', 'Сначала задача: «От {цена} в месяц, зависит от формата. Но цифра без задачи ничего не значит — на пробной подберём под вас»'), ...NEVER_COMMON] },

  { code: 'incoming', title: 'Входящий звонок', steps: [
    step('contact', 'Контакт: «{клуб}, добрый день! Меня зовут…»', '«{клуб}, добрый день! Меня зовут [Имя]. Слушаю вас»'),
    step('price', 'На вопрос о цене — ориентир «от {цена}» и вопрос о задаче', '«Варианты от {цена} в месяц, зависит от формата. Чтобы не путать вас цифрами — какую задачу ставите?»'),
    step('expect', 'Спросил, чего клиент ждёт от занятий', '«А чего ждёте от занятий? Что должно измениться — тонус, вес, спина, сила?»'),
    step('exp', 'Спросил про опыт тренировок и что важно для комфорта', '«Был опыт тренировок? Что важно, чтобы было комфортно?»'),
    step('present', 'Презентация: три факта о клубе под запрос', 'Три факта под его слова: зал 1 100 м², групповые, круглосуточно, сауна и полотенца, бокс'),
    step('trial', 'Пригласил на бесплатную пробную тренировку', '«Приходите на пробную тренировку с тренером — бесплатно»'),
    step('time', 'Назвал конкретный день и время', '«В будни или на выходных? Утром или вечером? Тогда четверг, 19:00»'),
    step('final', 'Итог: адрес, паспорт, сообщение в мессенджер', 'Адрес, «возьмите паспорт», «отправлю адрес и время в мессенджер»'),
  ], never: [never('n_pricelist', 'прайс списком', 'Одна цифра-ориентир и вопрос о задаче'), never('n_nopool', '«бассейна нет, извините» (сначала — что есть)', '«Клуб без бассейна. Зато 2 500 м², зал 1 100 м², круглосуточно, сауна и полотенца в абонементе»'), NEVER_COMMON[1]] },

  { code: 'base', title: 'Звонок по базе', steps: [
    step('contact', 'Контакт: напомнил, откуда знакомы (заявка / гостевой визит), спросил, удобно ли', '«[Имя], добрый день! Это [Имя] из {клуба}, мы с вами раньше общались. Удобно пару минут?»'),
    step('reason', 'Назвал повод: бесплатная пробная тренировка с тренером на этой неделе', '«Звоню с конкретным предложением: бесплатная пробная тренировка с тренером по вашей задаче»'),
    step('now', 'Спросил, тренируется ли клиент сейчас', '«Скажите, вы сейчас тренируетесь?»'),
    step('expect', 'Спросил, чего клиент ждёт от занятий', '«А чего ждёте от занятий? Что должно измениться — тонус, вес, спина, вернуться в форму?»'),
    step('block', 'Спросил, что мешало раньше, и ответил его словами', '«А что мешало раньше?» → реакция его словами'),
    step('changed', 'Рассказал, что изменилось в клубе', '«Теперь клуб круглосуточный, есть бесплатная пробная тренировка с тренером, программу подбирают под задачу»'),
    step('time', 'Назвал конкретный день и время', '«В будни или на выходных? Утром или вечером? Тогда среда, 19:00»'),
    step('final', 'Итог: адрес, паспорт, мессенджер', 'Адрес, паспорт, сообщение в мессенджер'),
  ], never: [never('n_fake', 'выдуманная акция', 'Только действующие условия: бесплатная пробная, рассрочка на 10 платежей'), NEVER_COMMON[0]] },

  { code: 'confirm', title: 'Подтверждение встречи', steps: [
    step('contact', 'Контакт: представился, спросил, удобно ли', '«[Имя], добрый день! Это [Имя] из {клуба}. Удобно две минуты?»'),
    step('remind', 'Напомнил день и время встречи, что ждёт тренер', '«Звоню напомнить: мы встречаемся в четверг в 19:00, вас ждёт тренер»'),
    step('road', 'Предложил помочь с дорогой, назвал адрес', '«Помощь, как добраться, нужна? {адрес}»'),
    step('passport', 'Напомнил взять паспорт', '«Возьмите, пожалуйста, паспорт — пропускная система»'),
    step('final', 'Финал: «Тренер ждёт вас. До встречи!»', '«Тренер уже в клубе, ждёт вас. До встречи!»'),
  ], never: [never('n_still', '«всё в силе?» / «вы придёте?» / «позвоните, если не сможете»', 'Утверждение вместо вопроса: «Звоню напомнить: мы встречаемся в четверг в 19:00, вас ждёт тренер»')] },

  { code: 'renewal', title: 'Продление', steps: [
    step('contact', 'Начало: представился, спросил, есть ли пара минут', '«[Имя], здравствуйте! Это [Имя] из {клуба}. Есть пара минут?»'),
    step('why', 'Объяснил, зачем звонит: поблагодарить и узнать мнение о клубе', '«Звоню поблагодарить вас за то, что вы с нами, и узнать мнение о клубе — что нравится, что изменить»'),
    step('feedback', 'Спросил, что нравится и что улучшить, отреагировал на ответы', '«Что особенно нравится? А что хотелось бы улучшить?»'),
    step('early', 'Предложил условия раннего продления', '«Сейчас для вас действуют условия раннего продления — чтобы успеть зафиксировать выгодную стоимость. Удобно обсудить?»'),
    step('price', 'Назвал цену через месяц: ≈3 600 ₽, раннее ≈3 248 ₽, рассрочка ≈4 330 ₽', '«Годовой — 43 300 ₽, около 3 600 ₽ в месяц. Раннее продление — 38 970 ₽, около 3 248 ₽. Рассрочка на 10 платежей, около 4 330 ₽»'),
    step('close', 'Закрытие: полная оплата или 10 платежей, бонус за оплату сегодня', '«Вам удобнее полная оплата или разбивка на 10 платежей?» · «Оплатите сегодня — 30 дней заморозки в подарок»'),
  ], never: [never('n_plan', '«планируете продлевать?»', 'Сразу условия: «Для вас действуют условия раннего продления…»'), never('n_full_first', 'полная сумма первой (без цены в месяц)', 'Сначала цена в месяц: «около 3 248 ₽ в месяц»'), never('n_quit', '«уволился» про прошлого менеджера', '«Теперь я ваш менеджер, буду рада помочь»')] },

  { code: 'repeat', title: 'Повторный звонок, «занят», отказ, заморозка', steps: [
    step('contact', 'Напомнил о договорённости созвониться', '«[Имя], добрый день! Договаривались созвониться сегодня. Удобно?»'),
    step('clarify', 'При отказе уточнил: «совсем не про тренировки или сейчас не время?»', '«Поняла. Уточню одно: совсем не про тренировки или сейчас не время?»'),
    step('next', 'Договорился о следующем шаге с датой (звонок, визит)', '«Когда удобнее — утром или вечером? Записываю: завтра в 10:00»'),
  ], never: [never('n_argue', 'спор с клиентом и дожим после второго «нет»', 'После второго «нет» — вежливо закончить и поставить тег'), never('n_nodate', 'разговор без даты следующего шага', 'Всегда договаривайтесь о дате: «Помечу и позвоню ровно тогда — через месяц?»')] },
];

/** Подстановки клуба (повторная проверка CRM 18.11.2026, п. 12): раньше в стандартных скриптах было зашито «Сандов Фитнес»
 *  и «от 2 690 ₽» — в любом клубе сети менеджер называл чужое имя и чужую цену.
 *  {клуб} — название клуба, {клуба} — оно же для «из …», {цена} — самая низкая цена за месяц из прейскуранта, {адрес} — адрес. */
export async function clubVars(db: Db, clubId: string): Promise<Record<string, string>> {
  const c = (await db.query(`select name, address from clubs where id = $1`, [clubId])).rows[0] as { name: string; address: string | null } | undefined;
  const r = (await db.query(
    `select min(case when p.kind = 'term' then v.amount_kop / greatest(1, round(coalesce(p.duration_days, 30) / 30.0)) else v.amount_kop end) as kop
       from products p
       join lateral (select amount_kop from price_versions where product_id = p.id and valid_from <= now() order by valid_from desc limit 1) v on true
      where p.club_id = $1 and p.is_active and p.kind in ('term', 'subscription')`, [clubId])).rows[0];
  const name = c?.name || 'клуб';
  const m = /^клуб\s+(.+)$/i.exec(name);
  const kop = r?.kop != null ? Number(r.kop) : null;
  return {
    '{клуба}': m ? `клуба ${m[1]}` : name, '{клуб}': name,
    '{цена}': kop ? `${(Math.round(kop / 1000) * 10).toLocaleString('ru-RU')} ₽` : '[цена из прейскуранта]',
    '{адрес}': c?.address || 'адрес клуба',
  };
}
export const fillVars = (vars: Record<string, string>, s: string) => Object.entries(vars).reduce((a, [k, v]) => a.replaceAll(k, v), s);

/** Скрипт клуба (проверка CRM 17.11.2026, п. 4): правки РОПа из «Отдел продаж → Скрипты звонков», иначе стандартный текст. */
export async function clubScript(db: Db, clubId: string, code: string): Promise<Script> {
  const base = SCRIPTS.find((s) => s.code === code) ?? SCRIPTS[0];
  const own = (await db.query(`select data from club_call_scripts where club_id = $1 and code = $2`, [clubId, base.code])).rows[0]?.data as { steps?: ScriptItem[]; neverItems?: ScriptItem[] } | undefined;
  const vars = await clubVars(db, clubId);
  const fill = (x: ScriptItem) => ({ ...x, text: fillVars(vars, x.text), how: fillVars(vars, x.how) });
  return { ...base, steps: (own?.steps?.length ? own.steps : base.steps).map(fill), never: (own?.neverItems?.length ? own.neverItems : base.never).map(fill) };
}

/** Один стандарт звонка (повторная проверка CRM 18.11.2026, п. 6): что проверяется в разговоре —
 *  этапы скрипта, «пункты для всех звонков» (бывший общий чек-лист из «Настроек клуба») и то, чего говорить нельзя.
 *  По этому же списку — разбор Дяди Вити, «Обзоры → Качество звонков», ручная оценка РОПа и рейтинг. */
export type CheckItem = ScriptItem & { kind: 'step' | 'common' | 'never' };
export async function checkList(db: Db, clubId: string, code: string, at: Date | string = new Date()) {
  const sc = await clubScript(db, clubId, code);
  const std = await standardAt(db, clubId, at);
  const version = Number((await db.query(`select max(version_no) as v from club_call_script_versions where club_id = $1 and code = $2 and created_at <= $3`, [clubId, sc.code, at])).rows[0]?.v ?? 0);
  const stepTexts = new Set(sc.steps.map((x) => x.text.toLowerCase()));
  const items: CheckItem[] = [
    ...sc.steps.map((x) => ({ ...x, kind: 'step' as const })),
    ...std.items.filter((i) => !stepTexts.has(i.text.toLowerCase())).map((i) => ({ id: `c_${i.id}`.slice(0, 30), text: i.text, how: '', kind: 'common' as const })),
    ...sc.never.map((x) => ({ ...x, kind: 'never' as const })),
  ];
  return { script: sc, version, standard: std, items };
}

/** Какой скрипт подходит разговору: входящий — по направлению, остальное — по словам из расшифровки */
export function pickScript(direction: string, text: string): Script {
  const t = text.toLowerCase();
  const by = (c: string) => SCRIPTS.find((s) => s.code === c)!;
  if (direction === 'in') return by('incoming');
  if (/продлен|продлит|продлевать/.test(t)) return by('renewal');
  if (/звоню напомнить|встречаемся|ждёт тренер|ждет тренер|напоминаю о встрече/.test(t)) return by('confirm');
  if (/договаривались созвониться|заморозк/.test(t)) return by('repeat');
  if (/раньше общались|гостев|вы сейчас тренируетесь/.test(t)) return by('base');
  return by('lead');
}

/** Телефоны и почта не уходят в ИИ (152-ФЗ) */
const maskPii = (s: string) => s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[почта]').replace(/(?:\+7|8)?[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, '[телефон]');

type Item = ScriptItem & { kind: 'step' | 'common' | 'never'; ok: boolean | null; quote?: string };
type Tr = { text: string; segments?: { speaker: string | null; start: number; end: number; text: string }[] };

export const STAGE: Record<string, string> = { contact: 'Контакт', road: 'Дорога', expect: 'Ожидания', block: 'Что мешало', react: 'Реакция его словами', present: 'Презентация',
  trial: 'Повод прийти', time: 'День и время', final: 'Итог', price: 'Вопрос о цене', exp: 'Опыт и критерий', reason: 'Повод звонка', now: 'Тренируется ли сейчас',
  changed: 'Что изменилось', remind: 'Напоминание', passport: 'Паспорт', why: 'Зачем звоню', feedback: 'Обратная связь', early: 'Раннее продление', close: 'Закрытие',
  clarify: 'Уточнение при отказе', next: 'Следующий шаг с датой' };
const fmt = (d: Date, tz: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', ' в');
const surname = (n: string) => n.split(' ')[0];
export const callUrl = (id: string) => `/?tab=calls&call=${id}`;

/** Разобрать свежие разговоры менеджеров по скриптам (фоновая работа, раз в 10 минут) */
export async function scriptCheckCalls(db: Db, tenantId: string, ai: AiConfig, limit = 5) {
  const calls = (await db.query(`select c.id, c.club_id, c.user_id, c.direction, c.started_at, c.transcript, cl.timezone,
      p.full_name as person_name, u.full_name as user_name, coalesce(s.final, s.draft) ->> 'essence' as essence
    from calls c join clubs cl on cl.id = c.club_id join users u on u.id = c.user_id
    left join persons p on p.id = c.person_id left join call_summaries s on s.call_id = c.id
    where c.transcript is not null and c.asr_status = 'done' and c.started_at > now() - interval '3 days'
      and (s.id is not null or c.created_at < now() - interval '30 minutes')
      and exists (select 1 from user_assignments a where a.user_id = c.user_id and a.club_id = c.club_id and a.role_code in ('manager', 'rop')
        and (a.active_to is null or a.active_to >= current_date))
      and not exists (select 1 from call_script_checks k where k.call_id = c.id)
    order by c.started_at limit $1`, [limit])).rows;
  let n = 0;
  for (const c of calls) {
    const tr = c.transcript as Tr;
    const cl = await checkList(db, c.club_id, pickScript(c.direction, tr.text ?? '').code, c.started_at);
    const sc = cl.script; const all = cl.items;
    let r: Awaited<ReturnType<typeof aiEvaluateCall>>;
    try {
      const masked = { text: maskPii(tr.text ?? ''), segments: (tr.segments ?? []).map((s) => ({ ...s, text: maskPii(s.text) })) };
      r = await aiEvaluateCall(ai, masked, all.map((i) => ({ id: i.id, text: i.text })));
    } catch { continue; } // ИИ недоступен — разберём в следующий раз
    const items: Item[] = all.map((i) => { const x = r.items?.find((y) => y.id === i.id); return { ...i, ok: typeof x?.ok === 'boolean' ? x.ok : null, quote: typeof x?.quote === 'string' ? x.quote.slice(0, 200) : undefined }; });
    const rated = items.filter((i) => i.ok !== null);
    if (!rated.length) continue;
    const missed = items.filter((i) => i.ok === false);
    const score = Math.round((rated.filter((i) => i.ok).length / rated.length) * 100);
    const summary = (c.essence as string | null)?.trim() || null;
    const ins = await db.query(`insert into call_script_checks(tenant_id, club_id, call_id, user_id, script_code, items, missed, score, summary, engine, script_version)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (call_id) do nothing`,
    [tenantId, c.club_id, c.id, c.user_id, sc.code, JSON.stringify(items), missed.length, score, summary, r.engine ?? 'ИИ-сервер', cl.version]);
    if (!ins.rowCount) continue;
    // Та же оценка — в «Обзоры → Качество звонков» (одна оценка звонка, а не две по разным правилам)
    const evItems = items.map((i) => ({ id: i.id, text: i.kind === 'never' ? `Не прозвучало: ${i.text}` : i.text, weight: 1, ok: i.ok, comment: i.quote }));
    await db.query(`insert into call_evaluations(tenant_id, club_id, call_id, user_id, standard_id, standard_version, items, score, source, engine) values ($1,$2,$3,$4,$5,$6,$7,$8,'ai',$9)
      on conflict (call_id, source) do nothing`, [tenantId, c.club_id, c.id, c.user_id, cl.standard.id, cl.version, JSON.stringify(evItems), score, r.engine ?? 'ИИ-сервер']);
    n++;
    if (missed.length) await warn(db, tenantId, c, sc, items, missed, summary);
  }
  return n;
}

async function warn(db: Db, tenantId: string, c: Record<string, any>, sc: Script, items: Item[], missed: Item[], summary: string | null) {
  const who = c.person_name ?? 'клиент';
  const when = fmt(new Date(c.started_at), c.timezone);
  const good = items.filter((i) => i.ok && i.kind === 'step').map((i) => STAGE[i.id] ?? i.text);
  const lines = [`**Разбор звонка: ${who}, ${when}** — скрипт «${sc.title}»`];
  if (summary) lines.push(`Коротко: ${summary}`);
  lines.push('Что упущено:');
  missed.slice(0, 5).forEach((m, i) => lines.push(`${i + 1}. ${m.kind === 'never' ? `Прозвучало то, что нельзя${m.quote ? `: «${m.quote}»` : ''}` : `Пропущен этап «${STAGE[m.id] ?? m.text}»`}. Как по скрипту: ${m.how}`));
  if (good.length) lines.push(`Получилось: ${good.slice(0, 4).join(', ')}.`);
  await botSay(db, tenantId, c.user_id, lines.join('\n'), { kind: 'script_check', callId: c.id, actions: [{ label: 'Открыть разговор', url: callUrl(c.id) }] }, false);
  await db.query(`update call_script_checks set warned_at = now() where call_id = $1`, [c.id]);

  // Третий разбор за 30 дней (то есть после второго сообщения менеджеру) — сводка РОПу со ссылками на разговоры
  const prev = (await db.query(`select k.call_id, k.missed, k.script_code, c.started_at, p.full_name as person_name from call_script_checks k
      join calls c on c.id = k.call_id left join persons p on p.id = c.person_id
    where k.club_id = $1 and k.user_id = $2 and k.warned_at is not null and k.created_at > now() - interval '30 days'
    order by c.started_at desc`, [c.club_id, c.user_id])).rows;
  if (prev.length < 3) return;
  const heads = (await db.query(`select distinct a.user_id, a.role_code from user_assignments a join users u on u.id = a.user_id and u.status = 'active'
    where a.club_id = $1 and a.role_code in ('rop', 'gm') and a.user_id <> $2 and (a.active_to is null or a.active_to >= current_date)`, [c.club_id, c.user_id])).rows;
  const rops = heads.filter((h) => h.role_code === 'rop');
  const to = [...new Set((rops.length ? rops : heads).map((h) => h.user_id as string))];
  if (!to.length) return;
  const often = new Map<string, number>();
  for (const k of (await db.query(`select items from call_script_checks where club_id = $1 and user_id = $2 and warned_at is not null and created_at > now() - interval '30 days'`, [c.club_id, c.user_id])).rows)
    for (const i of k.items as Item[]) if (i.ok === false) { const key = i.kind === 'never' ? i.text.replace(/^Не прозвучало: /, 'прозвучало ') : `пропущен этап «${STAGE[i.id] ?? i.text}»`; often.set(key, (often.get(key) ?? 0) + 1); }
  const top = [...often.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const text = [`**${c.user_name} снова отходит от скрипта продаж** — ${prev.length}-й разбор за 30 дней, два сообщения с разбором менеджеру уже отправлены.`,
    `Последний: ${who}, ${when}, скрипт «${sc.title}», упущено пунктов: ${missed.length}.`,
    top.length ? `Чаще всего: ${top.map(([t, k]) => `${t} (${k})`).join('; ')}.` : '',
    'Разговоры — по кнопкам ниже. Это учтено в рейтинге менеджера.'].filter(Boolean).join('\n');
  const actions = [
    ...prev.slice(0, 5).map((p) => ({ label: `Разговор ${fmt(new Date(p.started_at), c.timezone)} — ${p.person_name ? surname(p.person_name) : 'клиент'}`, url: callUrl(p.call_id) })),
    { label: `Чат с менеджером: ${c.user_name.split(' ').slice(-1)[0]}`, chat: { userId: c.user_id, text: `Отклонения от скрипта продаж: ${prev.length} разговоров за 30 дней${top.length ? `, чаще всего — ${top[0][0]}` : ''}. Давайте разберём один разговор вместе и потренируем этот этап.` } },
  ];
  for (const u of to) await botSay(db, tenantId, u, text, { kind: 'script_rop', userId: c.user_id, callId: c.id, actions }, true);
  await db.query(`update call_script_checks set rop_sent_at = now() where call_id = $1`, [c.id]);
}

/** Для рейтинга: разборы по скриптам за 14 дней */
export async function scriptStats(db: Db, clubId: string, userId: string, day: string) {
  const r = (await db.query(`select count(*)::int as n, count(*) filter (where missed > 0)::int as bad, round(avg(score))::int as avg
    from call_script_checks where club_id = $1 and user_id = $2 and created_at >= ($3::date - 13)::timestamp and created_at < ($3::date + 1)::timestamp`, [clubId, userId, day])).rows[0];
  return { checks: r.n as number, misses: r.bad as number, avg: r.avg as number | null };
}
