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
  checkin_token  text not null,                  -- shared secret carried in the QR
  active         boolean not null default true,
  created_at     timestamptz not null default now()
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
-- Seed the 2026 event.
-- IMPORTANT: replace the token below with your own secret before
-- generating the QR code (tools/make-qr.mjs reads it from .env).
-- -------------------------------------------------------------
insert into public.events (id, name, event_date, checkin_token)
values ('aiag2026',
        '2026 Arkansas AI in Agriculture Symposium',
        '2026-09-21',
        'CHANGE_ME_BEFORE_PRINTING')
on conflict (id) do nothing;
