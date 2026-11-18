// Карточка клиента по замечаниям тестировщиков 18.11.2026:
//  №32 — исправить ФИО и дату рождения, загрузить фото клиента;
//  №31 — сфотографировать документ клиента телефоном, фото хранится в карточке;
//  №47 — «Показать номер»: полный номер по нажатию, каждое открытие записывается в журнал (кто и когда смотрел);
//  №48 — ответственный менеджер клиента, при продаже вдвоём — второй менеджер и его доля.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { can, requireAnyPerm, requirePerm } from '../auth.ts';
import { audit, withCtx, type Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { decode, saveFile, UPLOAD_LIMIT, type Upload } from './contracts.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Кто работает с клиентом и может править его карточку
const WORKERS = [P.crmWork, P.membershipsSell, P.membershipsManage, P.acsWork];

async function person(db: Db, id: string) {
  if (!UUID.test(id)) throw notFound('Клиент не найден');
  const p = (await db.query('select id, home_club_id, full_name, birth_date from persons where id = $1', [id])).rows[0];
  if (!p) throw notFound('Клиент не найден');
  return p as { id: string; home_club_id: string; full_name: string; birth_date: string | null };
}

export async function personCardRoutes(app: FastifyInstance, pool: pg.Pool, storage: string) {
  // №32: ФИО и дата рождения
  app.patch('/api/persons/:id', async (req) => {
    const ctx = requireAnyPerm(req, ...WORKERS);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { fullName?: string; birthDate?: string | null };
    const name = b.fullName === undefined ? undefined : String(b.fullName).replace(/\s+/g, ' ').trim();
    if (name !== undefined && (name.length < 2 || name.length > 160)) throw badRequest('Укажите фамилию и имя клиента');
    let birth: string | null | undefined;
    if (b.birthDate !== undefined) {
      birth = b.birthDate || null;
      if (birth && (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || Number.isNaN(Date.parse(birth)) || birth > new Date().toISOString().slice(0, 10) || birth < '1900-01-01'))
        throw badRequest('Дата рождения указана неверно');
    }
    return withCtx(pool, ctx, async (db) => {
      const p = await person(db, id);
      await db.query('update persons set full_name = coalesce($2, full_name), birth_date = case when $3 then $4::date else birth_date end, updated_at = now() where id = $1',
        [id, name ?? null, birth !== undefined, birth ?? null]);
      await audit(db, ctx, 'person.edited', 'person', id, { fullName: p.full_name, birthDate: p.birth_date }, { fullName: name ?? p.full_name, birthDate: birth === undefined ? p.birth_date : birth });
      return { ok: true };
    });
  });

  // №47: полный номер по нажатию «Показать номер», с записью в журнал
  app.post('/api/persons/:id/phone', async (req) => {
    const ctx = requireAnyPerm(req, ...WORKERS);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => {
      await person(db, id);
      const phones = (await db.query(`select value from person_contacts where person_id = $1 and type = 'phone' order by is_primary desc`, [id])).rows.map((r) => r.value as string);
      await audit(db, ctx, 'person.phone_viewed', 'person', id, null, { count: phones.length });
      return { phones };
    });
  });

  // Кто открывал номер клиента — видит руководитель
  app.get('/api/persons/:id/phone-views', async (req) => {
    const ctx = requireAnyPerm(req, P.crmViewAll, P.salesManage, P.staffManage);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select a.at, u.full_name as "userName" from audit_log a left join users u on u.id = a.actor_id
        where a.action = 'person.phone_viewed' and a.object_type = 'person' and a.object_id = $1 order by a.at desc limit 50`, [id])).rows);
  });

  // №31: документы клиента (фото с камеры телефона или файл)
  app.get('/api/persons/:id/documents', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select d.id, d.title, d.file_id as "fileId", f.mime, d.created_at as "createdAt", u.full_name as "byName"
         from person_documents d join files f on f.id = d.file_id left join users u on u.id = d.created_by
        where d.person_id = $1 order by d.created_at desc`, [id])).rows);
  });

  app.post('/api/persons/:id/documents', UPLOAD_LIMIT, async (req, reply) => {
    const ctx = requireAnyPerm(req, ...WORKERS);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Upload & { title?: string };
    const title = String(b.title ?? '').trim().slice(0, 120) || 'Документ';
    const f = decode(b, ['image/jpeg', 'image/png', 'application/pdf']);
    const r = await withCtx(pool, ctx, async (db) => {
      const p = await person(db, id);
      const file = await saveFile(db, storage, ctx, p.home_club_id, 'person_document', f);
      const docId = (await db.query(`insert into person_documents(tenant_id, club_id, person_id, file_id, title, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, p.home_club_id, id, file.id, title, ctx.userId])).rows[0].id as string;
      await audit(db, ctx, 'person.document_added', 'person', id, null, { title, bytes: f.buf.length });
      return { id: docId, fileId: file.id };
    });
    reply.code(201);
    return r;
  });

  app.delete('/api/persons/:id/documents/:docId', async (req) => {
    const ctx = requireAnyPerm(req, ...WORKERS);
    const { id, docId } = req.params as { id: string; docId: string };
    if (!UUID.test(docId)) throw notFound('Документ не найден');
    return withCtx(pool, ctx, async (db) => {
      const d = (await db.query('delete from person_documents where id = $1 and person_id = $2 returning title', [docId, id])).rows[0];
      if (!d) throw notFound('Документ не найден');
      await audit(db, ctx, 'person.document_removed', 'person', id, null, { title: d.title });
      return { ok: true };
    });
  });

  app.get('/api/persons/:id/documents/:docId/file', async (req, reply) => {
    const ctx = requirePerm(req, P.personsView);
    const { id, docId } = req.params as { id: string; docId: string };
    if (!UUID.test(docId)) throw notFound('Документ не найден');
    const f = await withCtx(pool, ctx, async (db) => (await db.query(
      'select f.mime, f.storage_path, f.original_name from person_documents d join files f on f.id = d.file_id where d.id = $1 and d.person_id = $2', [docId, id])).rows[0]);
    if (!f) throw notFound('Документ не найден');
    const abs = join(storage, f.storage_path);
    if (!existsSync(abs)) throw notFound('Файл не найден в хранилище');
    reply.header('content-type', f.mime).header('cache-control', 'private, max-age=3600')
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
    return reply.send(readFileSync(abs));
  });

  // №48: ответственный менеджер (и второй с долей). Менеджер может взять клиента себе, если ответственного нет;
  // назначить или поменять кого угодно — руководитель (РОП, управляющий).
  app.get('/api/persons/:id/owner', async (req) => {
    const ctx = requirePerm(req, P.personsView);
    const { id } = req.params as { id: string };
    return withCtx(pool, ctx, async (db) => (await db.query(
      `select p.owner_id as "ownerId", o.full_name as "ownerName", p.co_owner_id as "coOwnerId", c.full_name as "coOwnerName", p.co_owner_share as "coOwnerShare"
         from persons p left join users o on o.id = p.owner_id left join users c on c.id = p.co_owner_id where p.id = $1`, [id])).rows[0] ?? null);
  });

  app.put('/api/persons/:id/owner', async (req) => {
    const ctx = requireAnyPerm(req, P.crmWork, P.membershipsSell);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { ownerId?: string | null; coOwnerId?: string | null; coOwnerShare?: number | null };
    const ownerId = b.ownerId || null; const coId = b.coOwnerId || null;
    const share = coId ? Math.round(Number(b.coOwnerShare)) : null;
    if ((ownerId && !UUID.test(ownerId)) || (coId && !UUID.test(coId))) throw badRequest('Сотрудник не найден');
    if (coId && !ownerId) throw badRequest('Сначала выберите ответственного менеджера');
    if (coId && coId === ownerId) throw badRequest('Второй менеджер должен отличаться от ответственного');
    if (coId && (!share || share < 1 || share > 99)) throw badRequest('Доля второго менеджера — от 1 до 99 %');
    const boss = can(ctx, P.crmViewAll) || can(ctx, P.salesManage);
    return withCtx(pool, ctx, async (db) => {
      const p = await person(db, id);
      const cur = (await db.query('select owner_id, co_owner_id, co_owner_share from persons where id = $1', [id])).rows[0];
      // Менеджер без прав руководителя: может стать ответственным, если клиент ничей, и добавить второго к своему клиенту
      if (!boss) {
        const mineNow = cur.owner_id === ctx.userId;
        const takesFree = !cur.owner_id && ownerId === ctx.userId;
        if (!(mineNow && ownerId === ctx.userId) && !takesFree) throw forbidden('Поменять ответственного может руководитель отдела продаж или управляющий');
      }
      for (const u of [ownerId, coId].filter(Boolean)) {
        const ok = (await db.query(`select 1 from users u join user_assignments a on a.user_id = u.id
          where u.id = $1 and u.status = 'active' and (a.club_id = $2 or a.club_id is null)
            and a.active_from <= current_date and (a.active_to is null or a.active_to >= current_date) limit 1`, [u, p.home_club_id])).rowCount;
        if (!ok) throw badRequest('Сотрудник не работает в клубе клиента');
      }
      await db.query('update persons set owner_id = $2, co_owner_id = $3, co_owner_share = $4, updated_at = now() where id = $1', [id, ownerId, coId, share]);
      await audit(db, ctx, 'person.owner_set', 'person', id, { ownerId: cur.owner_id, coOwnerId: cur.co_owner_id, coOwnerShare: cur.co_owner_share }, { ownerId, coOwnerId: coId, coOwnerShare: share });
      return { ok: true };
    });
  });
}
