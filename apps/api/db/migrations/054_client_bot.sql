-- Клиентский Telegram-бот (п. 18 списка «20 улучшений»): в боте клуба клиент видит абонемент и остаток,
-- продлевает и оплачивает его, замораживает. Напоминания об окончании и долге уже уходят автосообщениями в тот же чат.
alter table msg_channels add column client_bot boolean not null default false;
-- Шаг разговора с ботом и клиент, подтверждённый своим номером телефона
alter table msg_conversations add column bot_state jsonb not null default '{}';
alter table msg_conversations add column bot_person_id uuid references persons(id);
-- Кнопки под сообщением бота (клавиатура Telegram)
alter table msg_messages add column reply_markup jsonb;
