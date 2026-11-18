// Кнопка «Показать скрипт звонка» рядом с «Коротко о ситуации» (просьба Андрея 17.11.2026):
// тема звонка определяется заранее по данным CRM (заявка, база, подтверждение встречи, продление, повторный звонок),
// в скрипт сразу подставлены имя клиента, имя менеджера, дата встречи, дата окончания абонемента.
// Тексты — «Скрипты ОП — коротко» Сандов Фитнес (PDF от Андрея 17.11.2026).
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { can, requireCtx, requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { addressName, givenName } from '../lib/names.ts';
import { SCRIPTS, type ScriptItem } from './agentScripts.ts';

type Line = [stage: string, text: string];
type Book = { code: string; title: string; lines: Line[]; ifSays: Line[]; never: string };

/** {к} — имя клиента, {я} — имя менеджера, {когда} — день и время встречи, {откуда} — откуда знакомы, {до} — дата окончания абонемента */
const BOOK: Book[] = [
  { code: 'lead', title: 'Звонок по заявке', lines: [
    ['Контакт', '«{к}, добрый день! Это {я} из Сандов Фитнес. Вы оставляли заявку — спасибо. Удобно две минуты?»'],
    ['Дорога', '«Вы рядом живёте или работаете?»'],
    ['Ожидания', '«А чего вы ждёте от занятий? Что должно измениться — тонус, вес, осанка, сила, спина?» Если «просто позаниматься»: «А главное что — тело подтянулось, вес пошёл вниз, или спина перестала беспокоить?»'],
    ['Что мешало', '«А что мешало заниматься раньше?»'],
    ['Реакция', 'Повторите его словами: «Поняла: хочется вернуть тонус и убрать тяжесть в спине, а раньше не находилось времени. У нас как раз так и ходят»'],
    ['Презентация', 'Три факта под его слова: 1 100 м² зала и больше 140 тренажёров без очереди · групповые (йога, пилатес, здоровая спина, зумба, бодипамп) · круглосуточно · сауна, полотенца, вода · бокс и кикбоксинг'],
    ['Повод прийти', '«Приходите на пробную тренировку с тренером — бесплатно. Он посмотрит и подберёт программу под вашу задачу»'],
    ['День и время', '«Вам удобнее в будни или на выходных?» → «Утром или вечером?» → «Тогда {когда} — записываю»'],
    ['Итог', '«{адрес}. Возьмите паспорт — пропускная система. Отправлю адрес и время в мессенджер. Телеграм или Ватсап?»'],
  ], ifSays: [
    ['«Только цену»', '«От 2 690 ₽ в месяц, зависит от формата. Но цифра без задачи ничего не значит — на пробной подберём под вас. Давайте {когда}?»'],
    ['«Подумаю»', '«Конечно. Просто посмотрите клуб и попробуйте тренировку — бесплатно, ничего не теряете. В будни или на выходных?»'],
    ['«Дорого»', '«Сравним не цену, а за что платите: круглосуточно, все групповые, сауна, полотенца, вода. И рассрочка на 10 платежей — около 4 330 ₽ в месяц»'],
    ['«Далеко»', '«А откуда едете? … Это N минут. Многие ходят с этой стороны, заезжают с работы. Давайте {когда} — проверите дорогу сами»'],
    ['«Хожу в другой клуб»', '«Приходите сравнить — пробная бесплатная. Часто переходят из-за круглосуточного доступа и того, что зал не забит»'],
  ], never: 'цена до вопросов · «вам актуально?» · «приезжайте, когда удобно»' },

  { code: 'base', title: 'Звонок по базе', lines: [
    ['Контакт', '«{к}, добрый день! Это {я} из Сандов Фитнес, мы с вами раньше общались — {откуда}. Удобно пару минут?»'],
    ['Повод', '«Звоню с конкретным предложением: бесплатная пробная тренировка с тренером по вашей задаче. Хочу забронировать время на этой неделе»'],
    ['Сейчас', '«Скажите, вы сейчас тренируетесь?»'],
    ['Ожидания', '«А чего ждёте от занятий? Что должно измениться — тонус, вес, спина, вернуться в форму?»'],
    ['Что мешало', '«А что мешало раньше?» → реакция его словами'],
    ['Что изменилось', '«Теперь клуб круглосуточный, есть бесплатная пробная тренировка с тренером, и программу подбирают под задачу»'],
    ['День и время', '«В будни или на выходных? Утром или вечером? Тогда {когда}»'],
    ['Итог', 'Адрес ({адрес}), паспорт, сообщение в мессенджер'],
  ], ifSays: [
    ['«Неинтересно»', '«Уточню одно: совсем не про тренировки или сейчас не время? Если время — подберём другое, если совсем — уберу вас из списка»'],
    ['«Не звоните больше»', '«Извините за беспокойство, отмечу — больше не потревожу» (тег в тот же день)'],
    ['«Было дорого»', '«Ориентир от 2 690 ₽ в месяц и рассрочка на 10 платежей. Но дело не в цене — приходите на бесплатную тренировку, сравните не цифры, а что получаете»'],
    ['«Переехал / далеко»', '«А где вы сейчас? Если это другой конец города — не буду мучить. Если рядом — найдём время»'],
    ['«Откуда мой номер?»', '«{Откуда}. Если неудобно — отмечу и больше не позвоню»'],
  ], never: 'звонить с тегом «не звонить», «Неформат», «переезд» · выдуманная акция · «вам актуально?»' },

  { code: 'confirm', title: 'Подтверждение встречи', lines: [
    ['Контакт', '«{к}, добрый день! Это {я} из Сандов Фитнес. Удобно две минуты?»'],
    ['Напоминание', '«Звоню напомнить: мы встречаемся {когда}, вас ждёт тренер»'],
    ['Дорога', '«Помощь, как добраться, нужна? {адрес}»'],
    ['Паспорт', '«Возьмите, пожалуйста, паспорт — пропускная система»'],
    ['Финал', '«Тренер уже в клубе, ждёт вас. До встречи!»'],
  ], ifSays: [
    ['«Не получится»', '«Конечно. Завтра или на выходных? Записываю сразу»'],
    ['«Опаздываю»', '«Предупрежу тренера, будет ждать на 20 минут позже»'],
    ['«Передумал»', '«Что смущает? Отвечу сейчас, чтобы вы не тратили время на визит»'],
  ], never: '«всё в силе?» · «вы придёте?» · «позвоните, если не сможете»' },

  { code: 'renewal', title: 'Продление', lines: [
    ['Начало', '«{к}, здравствуйте! Это {я} из Сандов Фитнес. Есть пара минут?»'],
    ['Зачем звоню', '«Звоню поблагодарить вас за то, что вы с нами, и узнать мнение о клубе — что нравится, что изменить. Передам руководству»'],
    ['Новый менеджер', 'Если раньше вёл другой менеджер: «Теперь я ваш менеджер, буду рада помочь. Как проходят тренировки?» (слово «уволился» не говорить)'],
    ['Обратная связь', '«Что особенно нравится? А что хотелось бы улучшить?» — реакция на каждый ответ'],
    ['Раннее продление', '«Ваш абонемент действует до {до}. Сейчас для вас действуют условия раннего продления — чтобы успеть зафиксировать выгодную стоимость. Удобно обсудить?»'],
    ['Цена', '«Годовой — 43 300 ₽, около 3 600 ₽ в месяц. Раннее продление — 38 970 ₽, около 3 248 ₽. Рассрочка на 10 платежей, около 4 330 ₽ в месяц»'],
    ['Закрытие', '«Вам удобнее полная оплата или разбивка на 10 платежей?» · полная: «Оплатите сегодня — 30 дней заморозки в подарок» · «Халва»: «Нужно ваше присутствие с паспортом, работаем до 22:00 — сегодня вечером или завтра? Также можно оплатить онлайн по ссылке, я подготовлю документы, останется только подписать в клубе»'],
    ['«Подумаю»', '«Уточню одно: по условиям что-то поправить?» → если в деньгах: «Спрошу управляющего. Позвонить в [день] или написать?»'],
  ], ifSays: [
    ['«Всё нравится»', '«Очень приятно, спасибо»'],
    ['«Душновато»', '«Спасибо, передам управляющему, проверим вентиляцию»'],
    ['«Дорого»', '«Поэтому звоню заранее — при раннем продлении выгоднее»'],
  ], never: '«планируете продлевать?» · полная сумма первой · цены в переписке' },

  { code: 'repeat', title: 'Повторный звонок, «занят», отказ', lines: [
    ['Контакт', '«{к}, добрый день! Это {я} из Сандов Фитнес. Договаривались созвониться сегодня. Удобно?»'],
    ['Что изменилось', '«Вы были в отпуске / ждали расчёта — как сейчас?» → «Что решили?»'],
    ['Задача', 'Если задача не выяснена: «А чего ждёте от занятий?»'],
    ['День и время', '«Тогда {когда}»'],
  ], ifSays: [
    ['«Занят»', '«Поняла, не буду отвлекать. Когда удобнее — утром или вечером? Записываю: завтра в 10:00. Хорошего дня!» — и одно сообщение в мессенджер'],
    ['Отказ', '«Поняла. Уточню одно: совсем не про тренировки или сейчас не время?»'],
    ['«Не время»', '«Когда удобнее — через месяц, два? Помечу и позвоню ровно тогда»'],
    ['«Дорого»', '«Оставлю цифру: от 2 690 ₽ в месяц, рассрочка на 10 платежей. Передумаете — я на связи»'],
    ['«Переехал»', '«Спасибо, что сказали. Больше не буду беспокоить — отмечу. Хороших вам тренировок на новом месте!» Ставим тег'],
    ['«Не звоните»', '«Извините за беспокойство, отмечу, чтобы больше мы вам не звонили». Тег в тот же день'],
    ['Заморозка', '«Уезжаете или восстанавливаетесь после травмы? От этого зависит, что предложить» → «Заморозка от 7 дней, 30 дней — по действующим условиям, дата окончания сдвигается»'],
  ], never: 'спорить · дожимать после второго «нет» · отказ без тега · длинный разговор без даты' },

  { code: 'incoming', title: 'Входящий звонок', lines: [
    ['Контакт', '«Сандов Фитнес, добрый день! Меня зовут {я}. Слушаю вас» (трубку до третьего гудка)'],
    ['Вопрос о цене', '«Варианты от 2 690 ₽ в месяц, зависит от формата. Чтобы не путать вас цифрами — какую задачу ставите?»'],
    ['Ожидания', '«А чего ждёте от занятий? Что должно измениться — тонус, вес, спина, сила?»'],
    ['Опыт и критерий', '«Был опыт тренировок? Что важно, чтобы было комфортно?»'],
    ['Презентация', 'Три факта под его слова: зал 1 100 м², групповые, круглосуточно, сауна и полотенца, бокс'],
    ['Повод прийти', '«Приходите на пробную тренировку с тренером — бесплатно»'],
    ['День и время', '«В будни или на выходных? Утром или вечером? Тогда {когда}»'],
    ['Итог', 'Адрес, паспорт, сообщение в мессенджер'],
  ], ifSays: [
    ['«Бассейн есть?»', '«Клуб без бассейна. Зато 2 500 м², зал 1 100 м², круглосуточно, сауна и полотенца в абонементе, без очередей»'],
    ['«Единоборства?»', '«Есть бойцовский клуб: бокс и кикбоксинг, октагон, мешки, груши, татами. Входит в абонемент»'],
    ['«До скольки работаете?»', '«Клуб круглосуточный для членов, отдел продаж — до 22:00»'],
    ['«Парковка?»', '«Да, охраняемая. Варианты с парковкой и без — подберём на встрече»'],
    ['«Приехать не могу»', '«Тогда отправлю варианты в сообщении, и в четверг или пятницу позвоню — вам когда удобнее принять звонок?»'],
  ], never: 'прайс списком · «бассейна нет, извините» (сначала что есть) · «приходите, когда удобно»' },
];

const AFTER = ['Спросил, чего человек ждёт от тренировок', 'Спросил, что мешало раньше', 'Назвал день и время', 'Сказал про паспорт', 'Отправил сообщение в мессенджер'];
const WD = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу'];

/** Ближайшее удобное время для записи на пробную: завтра (если завтра воскресенье — в понедельник) в 19:00 */
function suggestWhen(now: Date, tz: string) {
  const dow = (d: Date) => new Date(d.toLocaleString('en-US', { timeZone: tz })).getDay();
  let d = new Date(now.getTime() + 86_400_000);
  if (dow(d) === 0) d = new Date(d.getTime() + 86_400_000);
  return `${WD[dow(d)]} в 19:00`;
}
function whenOf(d: Date, tz: string) {
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const hm = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
  const dm = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long' }).format(d);
  return `${WD[local.getDay()]}, ${dm}, в ${hm}`;
}
const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

export type CallScript = {
  code: string; title: string; why: string; client: string | null;
  lines: { stage: string; text: string }[]; ifSays: { q: string; a: string }[]; never: string; after: string[];
  others: { code: string; title: string }[];
};

/** Определить тему звонка и собрать скрипт с подставленными данными */
export async function callScript(db: Db, ctx: { userId: string }, type: 'task' | 'opportunity' | 'person', id: string, force?: string): Promise<CallScript> {
  let personId: string | null = null; let taskTitle = ''; let taskKind = '';
  if (type === 'task') {
    const t = (await db.query(`select t.person_id, t.title, t.kind, o.person_id as opp_person from tasks t left join opportunities o on o.id = t.opportunity_id where t.id = $1`, [id])).rows[0];
    if (!t) throw notFound('Задача не найдена');
    personId = t.person_id ?? t.opp_person; taskTitle = t.title; taskKind = t.kind;
  } else if (type === 'opportunity') {
    const o = (await db.query(`select person_id from opportunities where id = $1`, [id])).rows[0];
    if (!o) throw notFound('Сделка не найдена');
    personId = o.person_id;
  } else personId = id;
  const p = personId ? (await db.query(`select p.id, p.full_name, c.timezone, c.id as club_id from persons p join clubs c on c.id = p.home_club_id where p.id = $1`, [personId])).rows[0] : null;
  if (personId && !p) throw notFound('Клиент не найден');
  const tz = p?.timezone ?? 'Europe/Moscow';
  const me = (await db.query(`select full_name from users where id = $1`, [ctx.userId])).rows[0]?.full_name as string | undefined;

  // Данные о клиенте для выбора темы и подстановки
  const q = async (sql: string) => (personId ? (await db.query(sql, [personId])).rows[0] : undefined);
  const memb = await q(`select to_char(ends_on, 'YYYY-MM-DD') as ends from memberships where person_id = $1 and status = 'active' and ends_on is not null
    and ends_on between current_date - 30 and current_date + 60 order by ends_on desc limit 1`);
  const meet = await q(`select due_at from tasks where person_id = $1 and kind = 'meeting' and done_at is null and due_at > now() and due_at < now() + interval '4 days' order by due_at limit 1`);
  const lead = await q(`select l.created_at from leads l where l.person_id = $1 order by l.created_at desc limit 1`);
  const visited = await q(`select 1 as v from visits where person_id = $1 limit 1`);
  const lastCall = await q(`select started_at from calls where person_id = $1 and started_at > now() - interval '14 days' order by started_at desc limit 1`);

  let code = 'base'; let why = '';
  const tt = taskTitle.toLowerCase();
  if (/продл/.test(tt)) { code = 'renewal'; why = 'задача о продлении'; }
  else if (/подтверд|напомн/.test(tt) || (meet && /встреч|визит|пробн/.test(tt))) { code = 'confirm'; why = 'задача — подтвердить встречу'; }
  else if (/перезвон|повторн|договорились созвон/.test(tt)) { code = 'repeat'; why = 'договаривались перезвонить'; }
  else if (taskKind === 'first_response') { code = 'lead'; why = 'новая заявка — первый звонок'; }
  else if (memb) { code = 'renewal'; why = `абонемент заканчивается ${dmy(memb.ends)}`; }
  else if (meet) { code = 'confirm'; why = `встреча назначена: ${whenOf(new Date(meet.due_at), tz)}`; }
  else if (lastCall) { code = 'repeat'; why = 'уже говорили на этой неделе — повторный звонок'; }
  else if (lead && new Date(lead.created_at).getTime() > Date.now() - 14 * 86_400_000) { code = 'lead'; why = 'заявка свежая — звонок по заявке'; }
  else { why = lead ? 'заявка старше двух недель — звонок по базе' : 'клиент из базы'; }
  if (force && BOOK.some((b) => b.code === force)) { code = force; why = 'тема выбрана вручную'; }
  // Текст — из скриптов клуба (правит РОП в «Отдел продаж → Скрипты звонков»), иначе стандартный
  const clubId = (p?.club_id as string | undefined) ?? (await db.query(`select club_id from user_assignments where user_id = $1 and club_id is not null limit 1`, [ctx.userId])).rows[0]?.club_id;
  const b = clubId ? await clubBook(db, clubId, code) : BOOK.find((x) => x.code === code)!;
  const addr = clubId ? ((await db.query(`select address from clubs where id = $1`, [clubId])).rows[0]?.address as string | null) : null;

  const fromWhere = visited ? 'вы были у нас на гостевом визите' : 'вы оставляли заявку';
  const vars: Record<string, string> = {
    '{к}': p ? addressName(p.full_name) : '[Имя]', '{я}': me ? givenName(me) : '[Имя]',
    '{когда}': meet ? whenOf(new Date(meet.due_at), tz) : suggestWhen(new Date(), tz),
    '{откуда}': fromWhere, '{Откуда}': fromWhere[0].toUpperCase() + fromWhere.slice(1),
    '{до}': memb ? dmy(memb.ends) : '[дата окончания]',
    '{адрес}': addr || '[адрес клуба]',
  };
  const fill = (s: string) => Object.entries(vars).reduce((a, [k, v]) => a.replaceAll(k, v), s);
  return {
    code, title: b.title, why, client: p?.full_name ?? null,
    lines: b.lines.map(([stage, text]) => ({ stage, text: fill(text) })),
    ifSays: b.ifSays.map(([q2, a]) => ({ q: q2, a: fill(a) })),
    never: fill(b.never), after: AFTER,
    others: BOOK.filter((x) => x.code !== code).map((x) => ({ code: x.code, title: x.title })),
  };
}

/* ---------- скрипты клуба: правка РОПом (проверка CRM 17.11.2026, п. 4) ---------- */
type Own = { lines?: Line[]; ifSays?: Line[]; never?: string; steps?: ScriptItem[]; neverItems?: ScriptItem[] };
const CODES = ['lead', 'incoming', 'base', 'confirm', 'renewal', 'repeat'];

async function ownOf(db: Db, clubId: string, code: string) {
  return (await db.query(`select data, updated_at from club_call_scripts where club_id = $1 and code = $2`, [clubId, code])).rows[0] as { data: Own; updated_at: string } | undefined;
}
async function clubBook(db: Db, clubId: string, code: string): Promise<Book> {
  const base = BOOK.find((x) => x.code === code)!;
  const own = (await ownOf(db, clubId, code))?.data;
  return { ...base, lines: own?.lines?.length ? own.lines : base.lines, ifSays: own?.ifSays ?? base.ifSays, never: own?.never ?? base.never };
}

const cleanLines = (v: unknown): Line[] => (Array.isArray(v) ? v : []).filter((x): x is [unknown, unknown] => Array.isArray(x) && x.length === 2)
  .map(([a, b]) => [String(a ?? '').trim().slice(0, 80), String(b ?? '').trim().slice(0, 1500)] as Line).filter(([a, b]) => a && b).slice(0, 30);
const cleanItems = (v: unknown, prefix: string): ScriptItem[] => (Array.isArray(v) ? v : []).map((x, i) => {
  const o = (x ?? {}) as { id?: unknown; text?: unknown; how?: unknown };
  const id = typeof o.id === 'string' && /^[a-z0-9_]{1,30}$/.test(o.id) ? o.id : `${prefix}${i + 1}`;
  return { id, text: String(o.text ?? '').trim().slice(0, 300), how: String(o.how ?? '').trim().slice(0, 1500) };
}).filter((x) => x.text).slice(0, 20);

export function callScriptRoutes(app: FastifyInstance, pool: pg.Pool) {
  // Скрипты клуба: смотрят все в отделе продаж, правят РОП, управляющий и собственник
  app.get('/api/call-scripts', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { clubId } = req.query as { clubId?: string };
    if (!clubId) throw badRequest('Выберите клуб');
    return withCtx(pool, ctx, async (db) => {
      const items = [];
      for (const code of CODES) {
        const book = BOOK.find((x) => x.code === code)!; const check = SCRIPTS.find((x) => x.code === code)!;
        const own = await ownOf(db, clubId, code);
        items.push({ code, title: book.title, custom: !!own, updatedAt: own?.updated_at ?? null,
          lines: own?.data.lines?.length ? own.data.lines : book.lines, ifSays: own?.data.ifSays ?? book.ifSays, never: own?.data.never ?? book.never,
          steps: own?.data.steps?.length ? own.data.steps : check.steps, neverItems: own?.data.neverItems?.length ? own.data.neverItems : check.never });
      }
      return { items, canEdit: can(ctx, P.planManage) || can(ctx, P.salesManage) };
    });
  });
  app.put('/api/call-scripts', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.planManage) && !can(ctx, P.salesManage)) throw forbidden('Скрипты меняют РОП и управляющий');
    const b = (req.body ?? {}) as { clubId?: string; code?: string } & Record<string, unknown>;
    if (!b.clubId || !CODES.includes(b.code ?? '')) throw badRequest('Выберите клуб и скрипт');
    const data: Own = { lines: cleanLines(b.lines), ifSays: cleanLines(b.ifSays), never: String(b.never ?? '').trim().slice(0, 500),
      steps: cleanItems(b.steps, 's'), neverItems: cleanItems(b.neverItems, 'n') };
    if (!data.lines!.length || !data.steps!.length) throw badRequest('В скрипте должны остаться этапы разговора и пункты проверки');
    return withCtx(pool, ctx, async (db) => {
      await db.query(`insert into club_call_scripts(club_id, code, tenant_id, data, updated_by) values ($1,$2,$3,$4,$5)
        on conflict (club_id, code) do update set data = excluded.data, updated_by = excluded.updated_by, updated_at = now()`, [b.clubId, b.code, ctx.tenantId, JSON.stringify(data), ctx.userId]);
      await audit(db, ctx, 'call_script.updated', 'club', b.clubId!, null, { code: b.code });
      return { ok: true };
    });
  });
  app.delete('/api/call-scripts', async (req) => {
    const ctx = requireCtx(req);
    if (!can(ctx, P.planManage) && !can(ctx, P.salesManage)) throw forbidden('Скрипты меняют РОП и управляющий');
    const { clubId, code } = req.query as { clubId?: string; code?: string };
    return withCtx(pool, ctx, async (db) => {
      await db.query(`delete from club_call_scripts where club_id = $1 and code = $2`, [clubId, code]);
      await audit(db, ctx, 'call_script.reset', 'club', clubId ?? '', null, { code });
      return { ok: true };
    });
  });

  app.get('/api/agent/call-script/:type/:id', async (req) => {
    const ctx = requirePerm(req, P.crmWork);
    const { type, id } = req.params as { type: string; id: string };
    const { as } = req.query as { as?: string };
    if (type !== 'task' && type !== 'opportunity' && type !== 'person') throw badRequest('Неизвестный тип');
    return withCtx(pool, ctx, (db) => callScript(db, ctx, type, id, as));
  });
}
