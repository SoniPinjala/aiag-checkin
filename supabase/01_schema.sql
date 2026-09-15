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
  event_date     date not null,                  -- drives the admin picker
  series         text not null
                 check (series in ('hackathon', 'symposium')),
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- One active event PER SERIES. The hackathon (Sept 18-20) and the
-- symposium (Sept 21) overlap in the calendar, so a single global
-- "active event" would force someone to flip a switch mid-week --
-- and a missed flip files arrivals into the wrong event with a
-- cheerful "you're in". The QR names its series instead.
create unique index if not exists events_one_active_per_series
  on public.events (series) where active;

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
  -- nullable: the hackathon form collects ONE "Your Name" field,
  -- and a mononym has no surname to split off. Better absent than
  -- invented. The walk-up form still requires both -- at a desk
  -- you can simply ask.
  last_name               text,

  -- symposium form
  job_title               text,
  organization            text,
  academic_background     text,
  lightning_talk_abstract text,
  attending_reception     boolean,

  -- hackathon form
  college                 text,
  program                 text,
  background              text,

  -- both forms
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

-- Email is the identity key, so normalization belongs to the
-- TABLE, not to whichever code path happens to do the writing.
-- Without this, a direct insert (table editor, manual fix, a
-- future script) can store "A@B.com" and that person then fails
-- to match their own check-in scan.
create or replace function public.normalize_attendee_email()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;

drop trigger if exists attendees_normalize_email on public.attendees;
create trigger attendees_normalize_email
  before insert or update of email on public.attendees
  for each row execute function public.normalize_attendee_email();

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
insert into public.events (id, name, event_date, series) values
  ('aiag-hack2026', '2026 AI in Ag Hackathon',                   '2026-09-18', 'hackathon'),
  ('aiag2026',      '2026 Arkansas AI in Agriculture Symposium', '2026-09-21', 'symposium')
on conflict (id) do nothing;

insert into public.app_settings (id, checkin_token)
values (true, 'CHANGE_ME_BEFORE_PRINTING')
on conflict (id) do nothing;
