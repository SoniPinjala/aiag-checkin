-- =============================================================
-- Migration: make the printed QR permanent.
--
-- Before: the QR encoded ?e=aiag2026&k=<2026 token>, so it had
-- to be reprinted every year, and scanning an old one would
-- silently file people under the wrong year.
--
-- After: the QR encodes only ?k=<permanent token>. The database
-- decides which event that means, so flipping to 2027 is one
-- UPDATE and the printed sign never changes.
--
-- Run this ONCE on an existing project. 01-03 already produce
-- this end state for a fresh setup.
-- =============================================================

-- -------------------------------------------------------------
-- 1. The token moves off the event and becomes a property of the
--    installation. A boolean primary key with a CHECK is the
--    standard trick for a table that must hold exactly one row.
-- -------------------------------------------------------------
create table if not exists public.app_settings (
  id            boolean primary key default true check (id),
  checkin_token text not null
);

-- carry the existing token across so the QR you already printed
-- keeps working
insert into public.app_settings (id, checkin_token)
select true, checkin_token from public.events where id = 'aiag2026'
on conflict (id) do nothing;

-- -------------------------------------------------------------
-- 2. Exactly one event may be active at a time. Without this,
--    "the active event" is ambiguous and check-ins would land
--    wherever the planner happened to look first -- the same
--    silent-wrong-year failure this migration exists to remove.
-- -------------------------------------------------------------
create unique index if not exists events_one_active
  on public.events ((active)) where active;

-- -------------------------------------------------------------
-- 3. Resolve token -> the active event id. Returns NULL when the
--    token is wrong OR when no event is active, which is the
--    normal state for the 51 weeks between symposiums.
-- -------------------------------------------------------------
create or replace function public._active_event(p_token text)
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
     and s.checkin_token = p_token
   limit 1;
$$;

-- -------------------------------------------------------------
-- 4. Replace the attendee RPCs with token-only signatures.
--    The old three-argument forms are dropped explicitly --
--    CREATE OR REPLACE cannot change a function's signature, so
--    leaving them would quietly keep a second, stale entry point
--    alive with its own grants.
-- -------------------------------------------------------------
drop function if exists public.checkin_lookup(text, text, text);
drop function if exists public.register_and_checkin(
  text, text, text, text, text, text, text, text, boolean, text, text);
drop function if exists public._event_ok(text, text);

create or replace function public.checkin_lookup(
  p_token text,
  p_email text
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
  v_event := public._active_event(p_token);
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
  v_event := public._active_event(p_token);
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
-- 5. Grants. app_settings holds the token, so anon must never
--    read it -- only the SECURITY DEFINER functions touch it.
-- -------------------------------------------------------------
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
grant  all on public.app_settings to service_role;

revoke all on function public._active_event(text)          from public;
revoke all on function public.checkin_lookup(text, text)   from public;
revoke all on function public.register_and_checkin(
  text, text, text, text, text, text, text, boolean, text, text) from public;

grant execute on function public.checkin_lookup(text, text) to anon;
grant execute on function public.register_and_checkin(
  text, text, text, text, text, text, text, boolean, text, text) to anon;

-- -------------------------------------------------------------
-- 6. events.checkin_token is now dead weight. Dropping it means
--    there is exactly one place a token can live.
-- -------------------------------------------------------------
alter table public.events drop column if exists checkin_token;
