-- =============================================================
-- RLS + grants. Run THIRD. This is the file that keeps the
-- attendee list off the public internet -- read it carefully.
--
-- Threat model: the anon key is embedded in a static page on
-- GitHub Pages. Anyone can read it and call the API with it.
-- So anon must be able to do EXACTLY two things: look up its
-- own email, and register itself.
-- =============================================================

alter table public.events    enable row level security;
alter table public.attendees enable row level security;

-- -------------------------------------------------------------
-- 1. Take away the table access Supabase grants by default.
--    With RLS on and zero policies for anon, these are already
--    inert -- the revokes are belt and braces.
-- -------------------------------------------------------------
revoke all on public.attendees from anon;
revoke all on public.events    from anon;
revoke all on public.attendees from authenticated;
revoke all on public.events    from authenticated;

-- -------------------------------------------------------------
-- 2. Staff (signed in via Supabase Auth) get the table.
--    There are no privilege tiers: every admin account is equal.
--    Accounts are created BY HAND in the dashboard -- make sure
--    signups are disabled under Authentication > Providers.
-- -------------------------------------------------------------
grant select, update on public.attendees to authenticated;
grant select          on public.events    to authenticated;

drop policy if exists staff_read_attendees   on public.attendees;
drop policy if exists staff_update_attendees on public.attendees;
drop policy if exists staff_read_events      on public.events;

create policy staff_read_attendees   on public.attendees
  for select to authenticated using (true);

-- staff may only ever move check-in state; they cannot rewrite
-- someone's registration answers through the API
create policy staff_update_attendees on public.attendees
  for update to authenticated using (true) with check (true);

create policy staff_read_events      on public.events
  for select to authenticated using (true);

-- NOTE: no INSERT or DELETE policy for authenticated, on purpose.
-- Bulk import goes through tools/import-prereg.mjs with the
-- secret key, which runs from a laptop -- not from anything
-- reachable on the web.

-- -------------------------------------------------------------
-- 2b. The importer connects as service_role (that is what the
--     secret key resolves to). service_role has BYPASSRLS, so
--     policies never apply to it -- but it still needs a table
--     GRANT, and with the project's "Automatically expose new
--     tables" setting OFF it does not get one by default.
--     Without this the importer fails with:
--       42501 permission denied for table attendees
-- -------------------------------------------------------------
grant all on public.attendees to service_role;
grant all on public.events    to service_role;

-- -------------------------------------------------------------
-- 3. Functions. Postgres grants EXECUTE to PUBLIC by default,
--    so every one of these must be revoked before granting.
-- -------------------------------------------------------------
revoke all on function public._event_ok(text, text)            from public;
revoke all on function public.checkin_lookup(text, text, text) from public;
revoke all on function public.keepalive()                      from public;
revoke all on function public.event_stats(text)                from public;
revoke all on function public.staff_checkin(uuid)              from public;
revoke all on function public.register_and_checkin(
  text, text, text, text, text, text, text, text, boolean, text, text
) from public;

-- the attendee page: exactly these three, nothing else
grant execute on function public.checkin_lookup(text, text, text) to anon;
grant execute on function public.register_and_checkin(
  text, text, text, text, text, text, text, text, boolean, text, text
) to anon;
grant execute on function public.keepalive() to anon;

-- the admin page
grant execute on function public.event_stats(text)   to authenticated;
grant execute on function public.staff_checkin(uuid) to authenticated;

-- _event_ok stays internal: it is called by the SECURITY DEFINER
-- functions above, which run as owner, so nobody needs EXECUTE.

-- -------------------------------------------------------------
-- 4. Verify. After running this, from a terminal:
--
--   curl "$SUPABASE_URL/rest/v1/attendees?select=*" \
--        -H "apikey: $ANON_KEY"
--
-- MUST return [] or a permission error. If it returns rows,
-- stop and fix it before the QR code goes anywhere.
-- -------------------------------------------------------------
