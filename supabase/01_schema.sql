-- =============================================================
-- AI in Agriculture Symposium — check-in schema
-- Run this FIRST in the Supabase SQL editor.
-- =============================================================

create extension if not exists pgcrypto;

-- -------------------------------------------------------------
-- events: one row per symposium year. Everything is keyed to
-- this, so 2027 is a new row rather than a new deployment.
-- -------------------------------------------------------------
create table if not exists public.events (
  id             text primary key,               -- 'aiag2026'
  name           text not null,
  event_date     date not null,                  -- drives the admin year picker
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Exactly one event may be active at a time. The QR carries no
-- year, so "the active event" has to be unambiguous -- otherwise
-- check-ins land in whichever row the planner reached first.
create unique index if not exists events_one_active
  on public.events ((active)) where active;

-- -------------------------------------------------------------
-- app_settings: exactly one row (boolean PK + CHECK is the
-- standard trick). The check-in token lives here rather than on
-- the event, so the printed QR never has to change.
-- -------------------------------------------------------------
create table if not exists public.app_settings (
  id            boolean primary key default true check (id),
  checkin_token text not null
);

-- -------------------------------------------------------------
-- attendees: columns mirror the Microsoft Form 1:1, so a
-- pre-registered row and a walk-up row have the same shape.
-- -------------------------------------------------------------
create table if not exists public.attendees (
  id                      uuid primary key default gen_random_uuid(),
  event_id                text not null references public.events(id) on delete cascade,

  -- required. email is the sole matching key: normalized to
  -- lower(trim(...)) on every write so JOHN@X.COM == john@x.com
  email                   text not null check (position('@' in email) > 1
                                               and length(trim(email)) > 2),
  first_name              text not null check (length(trim(first_name)) > 0),
  last_name               text not null check (length(trim(last_name))  > 0),

  -- from the MS Form, all optional
  job_title               text,
  organization            text,
  academic_background     text,
  lightning_talk_abstract text,
  attending_reception     boolean,
  dietary_restrictions    text,
  heard_from              text,

  -- ours
  source                  text not null default 'onsite'
                          check (source in ('preregistered','onsite')),
  registered_at           timestamptz not null default now(),
  checked_in_at           timestamptz,
  checkin_method          text check (checkin_method in ('self','staff')),

  unique (event_id, email)
);

create index if not exists attendees_event_checkin_idx
  on public.attendees (event_id, checked_in_at);
create index if not exists attendees_event_name_idx
  on public.attendees (event_id, last_name, first_name);

-- -------------------------------------------------------------
-- Seed the event and the permanent token.
-- IMPORTANT: replace the token below before generating the QR
-- (tools/make-qr.mjs reads the same value from .env). Because
-- the QR is meant to be permanent, changing it later means
-- reprinting -- so set it once, here, and leave it alone.
-- -------------------------------------------------------------
insert into public.events (id, name, event_date)
values ('aiag2026', '2026 Arkansas AI in Agriculture Symposium', '2026-09-21')
on conflict (id) do nothing;

insert into public.app_settings (id, checkin_token)
values (true, 'CHANGE_ME_BEFORE_PRINTING')
on conflict (id) do nothing;
