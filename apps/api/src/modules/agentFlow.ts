// «Коротко о ситуации» алгоритмом, а не текстом (просьба Андрея 15.11.2026).
// Из тех же фактов, что и текстовая сводка, собирается схема:
//   1) «Как развивалась ситуация» — лента шагов по времени (обращение → звонки → этапы → задачи → покупки → приходы);
//   2) «Где сейчас» — одна строка;
//   3) «Что делать — по шагам» — нумерованный алгоритм с развилками «если … → …».
// Схему строят правила, поэтому она одинаковая с нейросетью и без неё; текстовая сводка остаётся на вкладке «Текстом».
import { ago, cut, fmtDate, lastContact, plural, type Facts } from './agent.ts';

export type FlowEvent = { at: string; kind: 'lead' | 'call' | 'stage' | 'task' | 'message' | 'buy' | 'visit' | 'class' | 'meeting'; title: string; detail?: string; bad?: boolean };
export type FlowStep = { title: string; detail?: string; urgent?: boolean; branches?: { when: string; then: string }[] };
export type FlowStage = { title: string; status: 'done' | 'active' | 'pending' | 'skipped'; who: string | null; when: string | null; result: string | null; late: boolean };
export type Flow = { head: string; history: FlowEvent[]; now: string; steps: FlowStep[]; stages?: FlowStage[] };

/** Лента событий по времени: последние 8 */
function historyOf(f: Facts): FlowEvent[] {
  const tz = f.timezone;
  const ev: FlowEvent[] = [];
  for (const l of f.leads) ev.push({ at: l.at, kind: 'lead', title: `Обращение${l.source ? ` — ${l.source}` : ''}`,
    detail: [l.comment ? `«${cut(l.comment, 90)}»` : '', l.firstResponseMin != null ? `ответили через ${l.firstResponseMin} мин` : 'первого ответа не было'].filter(Boolean).join(', '),
    bad: l.firstResponseMin == null || l.firstResponseMin > 15 });
  for (const c of f.calls) ev.push({ at: c.at, kind: 'call', title: `${c.direction[0].toUpperCase()}${c.direction.slice(1)} звонок${c.manager ? ` · ${c.manager}` : ''}`,
    detail: cut([c.outcome ? `итог: ${c.outcome}` : '', c.essence ?? '', c.agreements ? `договорились: ${c.agreements}` : ''].filter(Boolean).join('; '), 160) || undefined,
    bad: c.outcome === 'отказ' });
  for (const h of f.opportunity?.stageHistory ?? []) ev.push({ at: h.at, kind: 'stage', title: `Этап: ${h.from ? `${h.from} → ` : ''}${h.to}`, detail: [h.actor, h.comment ? cut(h.comment, 100) : ''].filter(Boolean).join(' — ') || undefined });
  for (const t of f.tasks.filter((x) => x.doneAt)) ev.push({ at: t.doneAt!, kind: 'task', title: `Сделано: «${cut(t.title, 70)}»`, detail: [t.assignee, t.result ? cut(t.result, 120) : ''].filter(Boolean).join(' — ') || undefined });
  for (const m of f.meetings) ev.push({ at: m.at, kind: 'meeting', title: `Встреча — ${m.status}`, bad: m.status === 'не пришёл' });
  for (const m of f.memberships) ev.push({ at: m.startsOn, kind: 'buy', title: `Абонемент «${m.product}»`, detail: `${m.status}${m.endsOn ? `, до ${fmtDate(m.endsOn, tz, false)}` : ''}` });
  for (const c of f.classes.filter((x) => x.status === 'пришёл' || x.status === 'не пришёл').slice(0, 4))
    ev.push({ at: c.at, kind: 'class', title: `Занятие «${c.name}» — ${c.status}`, detail: [c.trainer ? `тренер ${c.trainer}` : '', c.room ?? ''].filter(Boolean).join(', ') || undefined, bad: c.status === 'не пришёл' });
  if (!f.classes.length) for (const v of f.visits.recent.slice(0, 2)) ev.push({ at: v.at, kind: 'visit', title: 'Пришёл в клуб', detail: v.club });
  const lastIn = [...f.clientMessages].reverse().find((m) => m.from === 'клиент');
  if (lastIn) ev.push({ at: lastIn.at, kind: 'message', title: 'Клиент написал', detail: `«${cut(lastIn.text, 110)}»` });
  const lastOut = [...f.clientMessages].reverse().find((m) => m.from !== 'клиент' && m.from !== 'автосообщение');
  if (lastOut) ev.push({ at: lastOut.at, kind: 'message', title: `Ответ клиенту · ${lastOut.from}`, detail: `«${cut(lastOut.text, 110)}»` });
  return ev.filter((e) => e.at).sort((a, b) => +new Date(a.at) - +new Date(b.at)).slice(-8);
}

/** Алгоритм: от самого срочного, у каждого шага — развилки «если … → …» */
function stepsOf(f: Facts): FlowStep[] {
  const now = new Date(f.now);
  const s: FlowStep[] = [];
  const lc = lastContact(f);
  if (f.waitingReplySince) s.push({ urgent: true, title: 'Ответьте клиенту в переписке', detail: `Он написал ${ago(f.waitingReplySince, now)} и ждёт ответа.`,
    branches: [{ when: 'вопрос простой (цены, расписание, заморозка)', then: 'ответьте сразу сами' }, { when: 'вопрос о покупке', then: 'ответьте и предложите созвониться или прийти в клуб' }] });
  if (f.task && !f.task.doneAt && f.task.overdueHours > 0) s.push({ urgent: true, title: `Выполните задачу «${cut(f.task.title, 70)}»`,
    detail: `Просрочена на ${f.task.overdueHours >= 48 ? `${Math.floor(f.task.overdueHours / 24)} дн.` : `${f.task.overdueHours} ч.`}`,
    branches: [{ when: 'не дозвонились', then: 'напишите в мессенджер и поставьте повтор через 2 часа' }, { when: 'клиент просит перенести', then: 'перенесите срок и запишите причину' }] });
  if (f.debts.length) s.push({ urgent: true, title: 'Напомните о долге', detail: f.debts.map((d) => `${d.amount} — ${d.title}, срок ${fmtDate(d.dueOn, f.timezone, false)}`).join('; '),
    branches: [{ when: 'готов оплатить', then: 'отправьте ссылку на оплату' }, { when: 'не может сейчас', then: 'предложите рассрочку по правилам клуба и поставьте задачу на дату оплаты' }] });
  const active = f.memberships.find((m) => m.status === 'действует');
  if (active?.endsOn) {
    const days = Math.ceil((new Date(active.endsOn).getTime() - now.getTime()) / 86_400_000);
    if (days >= 0 && days <= 14) s.push({ title: 'Предложите продление', detail: `Абонемент «${active.product}» заканчивается через ${days} ${plural(days, 'день', 'дня', 'дней')}.`,
      branches: [{ when: 'согласен', then: 'оформите продление в карточке клиента' }, { when: 'думает', then: 'поставьте задачу перезвонить через 2 дня' }, { when: 'отказ', then: 'запишите причину — помощник предложит, чем вернуть' }] });
  }
  const promise = f.calls.find((c) => c.nextStep);
  if (promise?.nextStep) s.push({ title: 'Проверьте договорённость из последнего разговора', detail: `«${cut(promise.nextStep, 140)}»`,
    branches: [{ when: 'сделано', then: 'сообщите клиенту и переходите к следующему шагу' }, { when: 'не сделано', then: 'сделайте сегодня или предупредите клиента о новом сроке' }] });
  if (f.opportunity?.status === 'в работе') {
    if (!lc || now.getTime() - new Date(lc.at).getTime() > 3 * 86_400_000) s.push({ urgent: true, title: 'Свяжитесь с клиентом сегодня', detail: `Контакта не было ${lc ? ago(lc.at, now) : 'ни разу'}.`,
      branches: [{ when: 'ответил', then: 'выясните, что мешает решению, и договоритесь о следующем шаге с датой' }, { when: 'не ответил', then: 'напишите в мессенджер и поставьте повторный звонок на завтра' }] });
    if (f.opportunity.daysInStage >= 7) s.push({ title: `Решите судьбу сделки на этапе «${f.opportunity.stage}»`, detail: `Стоит ${f.opportunity.daysInStage} ${plural(f.opportunity.daysInStage, 'день', 'дня', 'дней')}.`,
      branches: [{ when: 'интерес есть', then: 'переведите на следующий этап и назначьте встречу или пробное' }, { when: 'интереса нет', then: 'закройте сделку с причиной отказа' }] });
  }
  const objections = [...new Set(f.calls.flatMap((c) => c.objections))].slice(0, 3);
  if (objections.length) s.push({ title: 'Подготовьте ответы на возражения', detail: objections.map((o) => `«${cut(o, 70)}»`).join(', ') });
  if (f.classes.some((c) => c.status === 'не пришёл') && f.classes[0]?.status === 'не пришёл') s.push({ title: 'Узнайте, почему клиент не пришёл на занятие',
    branches: [{ when: 'неудобное время', then: 'предложите другое занятие в расписании' }, { when: 'потерял интерес', then: 'передайте менеджеру: нужен звонок' }] });
  if (f.opportunity?.status === 'в работе' && !f.tasks.some((t) => !t.doneAt)) s.push({ title: 'Поставьте следующий шаг', detail: 'У сделки нет открытой задачи — без неё клиент потеряется.' });
  if (!s.length) s.push({ title: f.task && !f.task.doneAt ? `Выполните задачу «${cut(f.task.title, 70)}»` : 'Срочного нет — действуйте по плану', detail: f.task && !f.task.doneAt ? `Срок — ${fmtDate(f.task.dueAt, f.timezone)}.` : undefined });
  s.push({ title: 'Запишите итог', detail: 'Отметьте результат в задаче — помощник подскажет следующий шаг и напомнит вовремя.' });
  return s.slice(0, 7);
}

export function situationFlow(f: Facts): Flow {
  const now = new Date(f.now);
  const head = [f.person ? f.person.name : '', f.opportunity ? `сделка «${f.opportunity.pipeline}»` : '', f.task ? `задача «${cut(f.task.title, 60)}»` : ''].filter(Boolean).join(' · ');
  const lc = lastContact(f);
  const where = [
    f.opportunity ? `Этап «${f.opportunity.stage}» (${f.opportunity.status})${f.opportunity.daysInStage ? ` — ${f.opportunity.daysInStage} ${plural(f.opportunity.daysInStage, 'день', 'дня', 'дней')}` : ''}` : '',
    f.memberships.find((m) => m.status === 'действует') ? `абонемент «${f.memberships.find((m) => m.status === 'действует')!.product}» действует` : '',
    lc ? `последний контакт ${ago(lc.at, now)}` : 'контактов ещё не было',
    f.opportunity?.owner ? `ответственный ${f.opportunity.owner}` : '',
  ].filter(Boolean).join(', ');
  return { head, history: historyOf(f), now: where, steps: stepsOf(f) };
}

/** Схема для бизнес-процесса: шаги процесса со статусами, затем алгоритм — текущий шаг и что делать по клиенту */
export function processFlow(p: Record<string, any>, steps: Record<string, any>[], client: Facts | null): Flow {
  const tz = p.timezone as string;
  const nowD = new Date();
  const stages: FlowStage[] = steps.map((x) => ({ title: x.title, status: x.status, who: x.assignee ?? null,
    when: x.status === 'done' ? `сделано ${fmtDate(x.done_at, tz)}` : x.due_at ? `срок ${fmtDate(x.due_at, tz)}` : null,
    result: x.result ? cut(x.result, 120) : null, late: x.status === 'active' && x.due_at && new Date(x.due_at) < nowD }));
  const done = steps.filter((x) => x.status === 'done').length;
  const cur = steps.find((x) => x.status === 'active');
  const next = cur ? steps.find((x) => x.ord > cur.ord && x.status === 'pending') : null;
  const out: FlowStep[] = [];
  if (cur) out.push({ urgent: new Date(cur.due_at) < nowD, title: `Выполните шаг «${cut(cur.title, 70)}»`,
    detail: `${cur.assignee ? `Исполнитель — ${cur.assignee}. ` : ''}Срок — ${fmtDate(cur.due_at, tz)}${new Date(cur.due_at) < nowD ? ', уже прошёл' : ''}.`,
    branches: [{ when: 'сделано', then: next ? `нажмите «Шаг выполнен» — помощник запустит «${cut(next.title, 60)}»` : 'нажмите «Шаг выполнен» — процесс завершится' },
      { when: 'не получается в срок', then: 'напишите ответственному процесса и передайте шаг свободному сотруднику' }] });
  if (client) out.push(...situationFlow(client).steps.filter((x) => x.title !== 'Запишите итог').slice(0, 3));
  if (p.status === 'done') out.push({ title: 'Процесс завершён', detail: 'Проверьте, что клиент доволен, и при необходимости запустите следующий процесс.' });
  return { head: `Процесс «${p.title}»${p.person ? ` · ${p.person}` : ''}`, history: client ? historyOf(client) : [], stages,
    now: `${p.status === 'done' ? 'Завершён' : p.status === 'cancelled' ? 'Отменён' : `Выполнено ${done} из ${steps.length}`}${cur ? `, сейчас: «${cut(cur.title, 60)}»` : ''}; ответственный ${p.owner ?? '—'}`, steps: out.slice(0, 6) };
}
