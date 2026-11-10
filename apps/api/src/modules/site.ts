// Выгрузка предложений на сайт. Управляющий готовит предложения своего клуба и публикует их;
// сайт забирает опубликованные предложения по ключу источника «Сайт» (тот же ключ, что для приёма заявок).
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requirePerm } from '../auth.ts';
import { audit, withCtx } from '../db.ts';
import { badRequest, notFound, unauthorized } from '../errors.ts';
import { PERMISSIONS as P } from '../roles.ts';
import { decode, saveFile, UPLOAD_LIMIT, type Upload } from './contracts.ts';

type OfferIn = { clubId?: string; productId?: string | null; title?: string; description?: string | null; priceKop?: number | null; oldPriceKop?: number | null;
  priceNote?: string | null; validFrom?: string | null; validTo?: string | null; sort?: number; image?: Upload | null };

const SELECT = `select o.id, o.club_id as "clubId", c.name as "clubName", o.product_id as "productId", o.title, o.description, o.price_kop as "priceKop",
  o.old_price_kop as "oldPriceKop", o.price_note as "priceNote", to_char(o.valid_from, 'YYYY-MM-DD') as "validFrom", to_char(o.valid_to, 'YYYY-MM-DD') as "validTo",
  o.image_file_id as "imageFileId", o.status, o.sort, o.published_at as "publishedAt", o.updated_at as "updatedAt"
  from site_offers o join clubs c on c.id = o.club_id`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const num = (r: any) => ({ ...r, priceKop: r.priceKop === null ? null : Number(r.priceKop), oldPriceKop: r.oldPriceKop === null ? null : Number(r.oldPriceKop) });
const isDate = (s: unknown) => s === null || s === undefined || s === '' || (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s));
const isKop = (v: unknown) => v === null || v === undefined || (Number.isInteger(v) && (v as number) >= 0);

function check(b: OfferIn, partial: boolean) {
  if (!partial || b.title !== undefined) { if (!b.title?.trim() || b.title.trim().length < 2) throw badRequest('Укажите заголовок предложения'); }
  if (b.title && b.title.trim().length > 120) throw badRequest('Заголовок не длиннее 120 символов');
  if (b.description && b.description.length > 2000) throw badRequest('Описание не длиннее 2000 символов');
  if (!isKop(b.priceKop) || !isKop(b.oldPriceKop)) throw badRequest('Неверная цена');
  if (!isDate(b.validFrom) || !isDate(b.validTo)) throw badRequest('Неверная дата');
  if (b.validFrom && b.validTo && b.validTo < b.validFrom) throw badRequest('Дата окончания раньше даты начала');
}

export function siteRoutes(app: FastifyInstance, pool: pg.Pool, storage: string) {
  app.get('/api/site/offers', async (req) => {
    const ctx = requirePerm(req, P.clubsView);
    const { clubId } = req.query as { clubId?: string };
    return withCtx(pool, ctx, async (db) => (await db.query(`${SELECT} where ($1::uuid is null or o.club_id = $1) and o.status <> 'archived' order by c.name, o.sort, o.created_at`,
      [clubId || null])).rows.map(num));
  });

  app.post('/api/site/offers', UPLOAD_LIMIT, async (req, reply) => {
    const ctx = requirePerm(req, P.siteManage);
    const b = (req.body ?? {}) as OfferIn;
    if (!b.clubId) throw badRequest('Выберите клуб');
    check(b, false);
    const img = b.image?.dataBase64 ? decode(b.image, ['image/jpeg', 'image/png']) : null;
    const res = await withCtx(pool, ctx, async (db) => {
      if (!(await db.query('select 1 from clubs where id = $1', [b.clubId])).rowCount) throw badRequest('Клуб не найден');
      if (b.productId && !(await db.query('select 1 from products where id = $1 and club_id = $2', [b.productId, b.clubId])).rowCount) throw badRequest('Тариф другого клуба');
      const file = img ? await saveFile(db, storage, ctx, b.clubId!, 'site_image', img) : null;
      const id = (await db.query(
        `insert into site_offers(tenant_id, club_id, product_id, title, description, price_kop, old_price_kop, price_note, valid_from, valid_to, image_file_id, sort, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [ctx.tenantId, b.clubId, b.productId || null, b.title!.trim(), b.description?.trim() || null, b.priceKop ?? null, b.oldPriceKop ?? null, b.priceNote?.trim() || null,
          b.validFrom || null, b.validTo || null, file?.id ?? null, b.sort ?? 0, ctx.userId])).rows[0].id;
      const row = num((await db.query(`${SELECT} where o.id = $1`, [id])).rows[0]);
      await audit(db, ctx, 'site_offer.created', 'site_offer', id, null, row);
      return row;
    });
    reply.code(201);
    return res;
  });

  app.patch('/api/site/offers/:id', UPLOAD_LIMIT, async (req) => {
    const ctx = requirePerm(req, P.siteManage);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as OfferIn & { status?: string };
    check(b, true);
    if (b.status !== undefined && !['draft', 'published', 'archived'].includes(b.status)) throw badRequest('Неверный статус');
    const img = b.image?.dataBase64 ? decode(b.image, ['image/jpeg', 'image/png']) : null;
    return withCtx(pool, ctx, async (db) => {
      const before = (await db.query(`${SELECT} where o.id = $1`, [id])).rows[0];
      if (!before) throw notFound('Предложение не найдено');
      const file = img ? await saveFile(db, storage, ctx, before.clubId, 'site_image', img) : null;
      const sets: string[] = []; const vals: unknown[] = [id];
      const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (b.title !== undefined) put('title', b.title.trim());
      if (b.description !== undefined) put('description', b.description?.trim() || null);
      if (b.priceKop !== undefined) put('price_kop', b.priceKop);
      if (b.oldPriceKop !== undefined) put('old_price_kop', b.oldPriceKop);
      if (b.priceNote !== undefined) put('price_note', b.priceNote?.trim() || null);
      if (b.validFrom !== undefined) put('valid_from', b.validFrom || null);
      if (b.validTo !== undefined) put('valid_to', b.validTo || null);
      if (b.sort !== undefined) put('sort', b.sort);
      if (file) put('image_file_id', file.id);
      if (b.image === null) put('image_file_id', null);
      if (b.status !== undefined) { put('status', b.status); if (b.status === 'published') sets.push('published_at = now()'); }
      if (!sets.length) return num(before);
      try {
        await db.query(`update site_offers set ${sets.join(', ')}, updated_at = now() where id = $1`, vals);
      } catch (e) {
        if ((e as { code?: string }).code === '23514') throw badRequest('Дата окончания раньше даты начала');
        throw e;
      }
      const after = num((await db.query(`${SELECT} where o.id = $1`, [id])).rows[0]);
      await audit(db, ctx, b.status === 'published' ? 'site_offer.published' : b.status ? `site_offer.${b.status}` : 'site_offer.updated', 'site_offer', id, num(before), after);
      return after;
    });
  });

  /* ---------- для сайта ---------- */
  // Сайт запрашивает опубликованные и действующие сегодня предложения всех клубов сети
  app.get('/api/public/v1/offers', async (req) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) throw unauthorized('Нужен ключ сайта');
    const src = (await pool.query('select * from auth_lead_source($1)', [createHash('sha256').update(token).digest('hex')])).rows[0];
    if (!src) throw unauthorized('Ключ не найден или отключён');
    const { clubId } = req.query as { clubId?: string };
    const base = `${req.protocol}://${req.headers.host}`;
    return withCtx(pool, { tenantId: src.tenant_id, allClubs: true, clubIds: [] }, async (db) => {
      const rows = (await db.query(`${SELECT} where o.status = 'published' and ($1::uuid is null or o.club_id = $1)
          and (o.valid_from is null or o.valid_from <= (now() at time zone c.timezone)::date) and (o.valid_to is null or o.valid_to >= (now() at time zone c.timezone)::date)
        order by c.name, o.sort, o.published_at`, [clubId || null])).rows.map(num);
      const clubs = (await db.query(`select id, name, address from clubs where status = 'active' order by name`)).rows;
      return {
        generatedAt: new Date().toISOString(),
        clubs,
        offers: rows.map((o) => ({
          id: o.id, clubId: o.clubId, clubName: o.clubName, title: o.title, description: o.description,
          price: o.priceKop === null ? null : (o.priceKop as number) / 100, oldPrice: o.oldPriceKop === null ? null : (o.oldPriceKop as number) / 100,
          priceNote: o.priceNote, validFrom: o.validFrom, validTo: o.validTo,
          imageUrl: o.imageFileId ? `${base}/api/public/v1/offers/${o.id}/image` : null, updatedAt: o.updatedAt,
        })),
      };
    });
  });

  app.get('/api/public/v1/offers/:id/image', async (req, reply) => {
    const { id } = req.params as { id: string };
    const f = (await pool.query('select * from public_offer_image($1)', [id])).rows[0];
    if (!f || !existsSync(join(storage, f.storage_path))) throw notFound('Картинка не найдена');
    reply.header('Content-Type', f.mime);
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(readFileSync(join(storage, f.storage_path)));
  });
}
