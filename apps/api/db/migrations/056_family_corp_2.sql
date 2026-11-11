-- Семейные и корпоративные абонементы, вторая часть.
-- 1) Общий семейный абонемент: тариф на несколько человек. Покупает и платит один, у каждого члена семьи своё «место»
--    (свой проход и история), сроки, заморозка и отмена основного абонемента сами переходят на места.
-- 2) Долевая оплата: компания платит свою долю по счёту, остальное сотрудник платит сам.
-- 3) НДС в счёте компании (ставка в реквизитах юрлица клуба).
-- 4) Счета компаниям выставляются сами в начале месяца, о неоплаченном в срок счёте — задача ответственному.
alter table products add column family_seats int check (family_seats is null or family_seats between 2 and 12);
alter table memberships add column parent_membership_id uuid references memberships(id);
create index memberships_parent on memberships (parent_membership_id) where parent_membership_id is not null;

alter table companies add column share_percent int not null default 100 check (share_percent between 10 and 100);
alter table companies add column auto_invoice boolean not null default false;
alter table companies add column manager_id uuid references users(id);

alter table legal_entities add column invoice_vat text check (invoice_vat is null or invoice_vat in ('0', '5', '7', '10', '20', '22'));
alter table company_invoices add column vat_rate int;
alter table company_invoices add column vat_kop bigint not null default 0;
alter table company_invoices add column auto boolean not null default false;
alter table company_invoices add column overdue_task_id uuid references tasks(id);

alter table membership_operations drop constraint membership_operations_kind_check;
alter table membership_operations add constraint membership_operations_kind_check
  check (kind in ('sale', 'renewal', 'freeze', 'unfreeze', 'cancel', 'charge_paid', 'subscription_period', 'class_charge', 'bonus_days', 'seat_added', 'seat_removed'));

-- Места общего абонемента живут по его срокам: заморозка, разморозка, перенос и отмена основного переходят на всех
create or replace function family_seats_follow() returns trigger language plpgsql as $$
begin
  if new.starts_on is distinct from old.starts_on or new.ends_on is distinct from old.ends_on or new.status is distinct from old.status then
    update memberships set starts_on = new.starts_on, ends_on = new.ends_on,
      status = case when new.status = 'cancelled' then 'cancelled' else status end, updated_at = now()
    where parent_membership_id = new.id and status = 'active';
  end if;
  return new;
end $$;
create trigger memberships_seats_follow after update of starts_on, ends_on, status on memberships
  for each row when (new.parent_membership_id is null) execute function family_seats_follow();
