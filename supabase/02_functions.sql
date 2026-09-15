-- =============================================================
-- RPCs. Run SECOND.
--
-- The browser holds a PUBLIC anon key, so it never touches the
-- attendees table directly. It gets EXECUTE on exactly three
-- functions below and SELECT on nothing (see 03_policies.sql).
-- These return a status and a first name -- never a list.
-- =============================================================

-- Resolve the QR token to whichever event is currently active.
-- Returns NULL for a wrong token OR when nothing is running,
-- which is the normal state for the 51 weeks between symposiums.
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
-- checkin_lookup: matches on EMAIL ALONE and records the
-- check-in in the same round trip (venue wifi is slow; one call).
--   checked_in | already_checked_in | not_registered
--   | invalid_email | no_active_event
-- -------------------------------------------------------------
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

-- -------------------------------------------------------------
-- register_and_checkin: walk-up path. Requires email + both
-- names; everything else is optional so the desk never stalls.
-- -------------------------------------------------------------
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
-- keepalive: the daily GitHub Actions cron hits this so the free
-- project never crosses the ~7-day inactivity pause threshold.
-- Reveals nothing.
-- -------------------------------------------------------------
create or replace function public.keepalive()
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('ok', true, 'at', now());
$$;

-- -------------------------------------------------------------
-- event_stats: admin analytics for one year, as ONE round trip.
-- SECURITY INVOKER on purpose -- it runs as the caller, so RLS
-- applies and an anon caller gets nothing back.
-- -------------------------------------------------------------
create or replace function public.event_stats(p_event text)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  with a as (
    select * from public.attendees where event_id = p_event
  )
  select jsonb_build_object(
    'registered',        (select count(*) from a),
    'checked_in',        (select count(*) from a where checked_in_at is not null),
    'prereg_total',      (select count(*) from a where source = 'preregistered'),
    'prereg_checked',    (select count(*) from a where source = 'preregistered'
                                                   and checked_in_at is not null),
    'onsite_total',      (select count(*) from a where source = 'onsite'),
    'reception_yes',     (select count(*) from a where attending_reception is true),
    'reception_yes_in',  (select count(*) from a where attending_reception is true
                                                   and checked_in_at is not null),
    'dietary_count',     (select count(*) from a where dietary_restrictions is not null),
    'dietary_list',      (select coalesce(jsonb_agg(jsonb_build_object(
                             'name', first_name || ' ' || last_name,
                             'note', dietary_restrictions)
                             order by last_name), '[]'::jsonb)
                            from a where dietary_restrictions is not null),
    -- arrival curve, 15-minute buckets
    'arrivals',          (select coalesce(jsonb_agg(jsonb_build_object(
                             'bucket', b, 'n', n) order by b), '[]'::jsonb)
                            from (
                              select to_timestamp(
                                       floor(extract(epoch from checked_in_at) / 900) * 900
                                     ) as b, count(*) as n
                                from a where checked_in_at is not null
                               group by 1
                            ) s),
    'heard_from',        (select coalesce(jsonb_agg(jsonb_build_object(
                             'label', k, 'n', n) order by n desc), '[]'::jsonb)
                            from (
                              select coalesce(heard_from, 'Not answered') as k,
                                     count(*) as n
                                from a group by 1
                            ) s),
    'top_orgs',          (select coalesce(jsonb_agg(jsonb_build_object(
                             'label', k, 'n', n) order by n desc), '[]'::jsonb)
                            from (
                              select organization as k, count(*) as n
                                from a where organization is not null
                               group by 1 order by 2 desc limit 12
                            ) s)
  );
$$;

-- -------------------------------------------------------------
-- staff_checkin: manual check-in from the admin page. Invoker
-- rights, so RLS decides -- anon calling this achieves nothing.
-- -------------------------------------------------------------
create or replace function public.staff_checkin(p_id uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_rec public.attendees%rowtype;
begin
  update public.attendees
     set checked_in_at  = coalesce(checked_in_at, now()),
         checkin_method = coalesce(checkin_method, 'staff')
   where id = p_id
  returning * into v_rec;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'ok',
                            'checked_in_at', v_rec.checked_in_at);
end;
$$;
