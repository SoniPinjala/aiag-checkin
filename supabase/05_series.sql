-- =============================================================
-- Migration: two events under one roof.
--
--   AI in Ag Hackathon   Sept 18-20  (60 grad students)
--   AI in Ag Symposium   Sept 21     (open registration)
--
-- 04 enforced exactly ONE active event globally. That would mean
-- flipping `active` on the morning of the 21st -- and if nobody
-- did, symposium arrivals would land silently in the hackathon.
-- That is the exact failure the permanent QR was meant to kill.
--
-- So: each event belongs to a SERIES, the QR carries the series,
-- and the constraint becomes one active event PER SERIES. Both
-- run at once, each QR routes correctly, and each QR is still
-- permanent year over year.
--
-- Run ONCE. 01-03 produce this end state for a fresh setup.
-- =============================================================

-- -------------------------------------------------------------
-- 1. Series
-- -------------------------------------------------------------
alter table public.events
  add column if not exists series text;

update public.events set series = 'symposium' where series is null;

alter table public.events alter column series set not null;
alter table public.events drop constraint if exists events_series_check;
alter table public.events add constraint events_series_check
  check (series in ('hackathon', 'symposium'));

-- one active event PER SERIES, replacing 04's one-active-overall
drop index if exists public.events_one_active;
create unique index if not exists events_one_active_per_series
  on public.events (series) where active;

-- -------------------------------------------------------------
-- 2. Hackathon-specific answers. The symposium form asks about
--    job title, employer and the reception; the hackathon form
--    asks about college, degree program and background. Keeping
--    them as distinct columns means neither form's answers get
--    squeezed into a field that means something else.
-- -------------------------------------------------------------
alter table public.attendees add column if not exists college    text;
alter table public.attendees add column if not exists program    text;
alter table public.attendees add column if not exists background text;

-- The hackathon form collects ONE "Your Name" field. Splitting it
-- is a guess: "Maria Elena Vargas Ruiz" has no right answer, and
-- a mononym has no surname at all. Rather than invent a value,
-- allow it to be absent -- the walk-up form still requires both,
-- because at a desk you can just ask.
alter table public.attendees alter column last_name drop not null;

-- -------------------------------------------------------------
-- 3. Seed the hackathon
-- -------------------------------------------------------------
insert into public.events (id, name, event_date, series, active)
values ('aiag-hack2026', '2026 AI in Ag Hackathon', '2026-09-18', 'hackathon', true)
on conflict (id) do nothing;

update public.events set series = 'symposium' where id = 'aiag2026';

-- -------------------------------------------------------------
-- 4. Token + series -> event id
-- -------------------------------------------------------------
create or replace function public._active_event(p_token text, p_series text)
returns text
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select e.id
    from public.events e
   cross join public.app_settings s
   where e.active
     and e.series = p_series
     and s.checkin_token = p_token
   limit 1;
$$;

-- -------------------------------------------------------------
-- 5. RPCs gain p_series. The old two-argument forms are dropped
--    explicitly: CREATE OR REPLACE cannot change arity, so they
--    would otherwise survive as a second live entry point with
--    their own grants -- and one that resolves the wrong event.
-- -------------------------------------------------------------
drop function if exists public.checkin_lookup(text, text);
drop function if exists public.register_and_checkin(
  text, text, text, text, text, text, text, boolean, text, text);
drop function if exists public._active_event(text);

create or replace function public.checkin_lookup(
  p_token  text,
  p_series text,
  p_email  text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event text;
  v_email text;
  v_rec   public.attendees%rowtype;
begin
  v_event := public._active_event(p_token, p_series);
  if v_event is null then
    return jsonb_build_object('status', 'no_active_event');
  end if;

  v_email := lower(trim(coalesce(p_email, '')));
  if position('@' in v_email) < 2 or length(v_email) < 3 then
    return jsonb_build_object('status', 'invalid_email');
  end if;

  select * into v_rec
    from public.attendees
   where event_id = v_event and email = v_email
   for update;

  if not found then
    return jsonb_build_object('status', 'not_registered', 'email', v_email);
  end if;

  if v_rec.checked_in_at is not null then
    return jsonb_build_object(
      'status', 'already_checked_in', 'first_name', v_rec.first_name,
      'checked_in_at', v_rec.checked_in_at,
      'attending_reception', v_rec.attending_reception);
  end if;

  update public.attendees
     set checked_in_at = now(), checkin_method = 'self'
   where id = v_rec.id;

  return jsonb_build_object(
    'status', 'checked_in', 'first_name', v_rec.first_name,
    'attending_reception', v_rec.attending_reception);
end;
$$;

create or replace function public.register_and_checkin(
  p_token                text,
  p_series               text,
  p_email                text,
  p_first_name           text,
  p_last_name            text,
  p_job_title            text default null,
  p_organization         text default null,
  p_academic_background  text default null,
  p_attending_reception  boolean default null,
  p_dietary_restrictions text default null,
  p_heard_from           text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event text;
  v_email text;
  v_first text;
  v_last  text;
  v_rec   public.attendees%rowtype;
begin
  v_event := public._active_event(p_token, p_series);
  if v_event is null then
    return jsonb_build_object('status', 'no_active_event');
  end if;

  v_email := lower(trim(coalesce(p_email, '')));
  v_first := trim(coalesce(p_first_name, ''));
  v_last  := trim(coalesce(p_last_name, ''));

  if position('@' in v_email) < 2 or length(v_email) < 3 then
    return jsonb_build_object('status', 'invalid_email');
  end if;
  if v_first = '' or v_last = '' then
    return jsonb_build_object('status', 'missing_name');
  end if;

  insert into public.attendees (
    event_id, email, first_name, last_name,
    job_title, organization, academic_background,
    attending_reception, dietary_restrictions, heard_from,
    source, checked_in_at, checkin_method
  ) values (
    v_event, v_email, v_first, v_last,
    nullif(trim(coalesce(p_job_title, '')), ''),
    nullif(trim(coalesce(p_organization, '')), ''),
    nullif(trim(coalesce(p_academic_background, '')), ''),
    p_attending_reception,
    nullif(trim(coalesce(p_dietary_restrictions, '')), ''),
    nullif(trim(coalesce(p_heard_from, '')), ''),
    'onsite', now(), 'self'
  )
  on conflict (event_id, email) do nothing
  returning * into v_rec;

  if found then
    return jsonb_build_object('status', 'checked_in',
      'first_name', v_rec.first_name,
      'attending_reception', v_rec.attending_reception);
  end if;

  select * into v_rec
    from public.attendees
   where event_id = v_event and email = v_email
   for update;

  if v_rec.checked_in_at is not null then
    return jsonb_build_object(
      'status', 'already_checked_in', 'first_name', v_rec.first_name,
      'checked_in_at', v_rec.checked_in_at,
      'attending_reception', v_rec.attending_reception);
  end if;

  update public.attendees
     set checked_in_at = now(), checkin_method = 'self'
   where id = v_rec.id;

  return jsonb_build_object('status', 'checked_in',
    'first_name', v_rec.first_name,
    'attending_reception', v_rec.attending_reception);
end;
$$;

-- -------------------------------------------------------------
-- 6. Grants for the new signatures
-- -------------------------------------------------------------
revoke all on function public._active_event(text, text)           from public;
revoke all on function public.checkin_lookup(text, text, text)    from public;
revoke all on function public.register_and_checkin(
  text, text, text, text, text, text, text, text, boolean, text, text) from public;

grant execute on function public.checkin_lookup(text, text, text) to anon;
grant execute on function public.register_and_checkin(
  text, text, text, text, text, text, text, text, boolean, text, text) to anon;
