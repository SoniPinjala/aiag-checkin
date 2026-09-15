-- =============================================================
-- Migration: the walk-up form asks the RIGHT questions.
--
-- A hackathon walk-up was being shown the symposium's questions
-- -- job title, employer, the 5 PM reception -- because
-- register_and_checkin only accepted symposium columns. The
-- routing was right; the form was not.
--
-- Adds p_college / p_program / p_background so a hackathon
-- walk-up is stored in the same shape as an imported hackathon
-- registration.
--
-- Run ONCE. 01-03 produce this end state for a fresh setup.
-- =============================================================

drop function if exists public.register_and_checkin(
  text, text, text, text, text, text, text, text, boolean, text, text);

create or replace function public.register_and_checkin(
  p_token                text,
  p_series               text,
  p_email                text,
  p_first_name           text,
  p_last_name            text,
  -- symposium
  p_job_title            text default null,
  p_organization         text default null,
  p_academic_background  text default null,
  p_attending_reception  boolean default null,
  -- hackathon
  p_college              text default null,
  p_program              text default null,
  p_background           text default null,
  -- both
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
    job_title, organization, academic_background, attending_reception,
    college, program, background,
    dietary_restrictions, heard_from,
    source, checked_in_at, checkin_method
  ) values (
    v_event, v_email, v_first, v_last,
    nullif(trim(coalesce(p_job_title, '')), ''),
    nullif(trim(coalesce(p_organization, '')), ''),
    nullif(trim(coalesce(p_academic_background, '')), ''),
    p_attending_reception,
    nullif(trim(coalesce(p_college, '')), ''),
    nullif(trim(coalesce(p_program, '')), ''),
    nullif(trim(coalesce(p_background, '')), ''),
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

revoke all on function public.register_and_checkin(
  text, text, text, text, text, text, text, text, boolean,
  text, text, text, text, text) from public;
grant execute on function public.register_and_checkin(
  text, text, text, text, text, text, text, text, boolean,
  text, text, text, text, text) to anon;
