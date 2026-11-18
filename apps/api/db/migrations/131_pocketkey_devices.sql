-- PocketKey (протокол «Pocketkey API СКУД», получен 18.11.2026). Список терминалов PocketKey берёт у CRM запросом /devices,
-- поэтому у каждого устройства в CRM хранятся адрес терминала в сети клуба, порт, вид терминала и признак распознавания лиц.
alter table access_points add column device_ip text;
alter table access_points add column device_port int check (device_port between 1 and 65535);
alter table access_points add column device_type text not null default 'pocket' check (device_type in ('pocket', 'jsp'));  -- pocket — Pocketkey, jsp — Pocketface
alter table access_points add column biometrics boolean not null default false;
