-- =============================================================
-- Migration: make email normalization a property of the TABLE.
--
-- Email is the ground truth for identity: it is how someone is
-- matched at check-in, and the only way to tell that a hackathon
-- student and a symposium attendee are the same person (they may
-- well type their NAME differently on the two forms).
--
-- Until now, lowercasing happened in application code -- in the
-- RPCs and in the importer. Anything that wrote directly to the
-- table bypassed it: the Supabase table editor, a hand-written
-- UPDATE, a future script. A row stored as "MEVargas@uark.edu"
-- then fails to match a scan of "mevargas@uark.edu" and reports
-- "not registered" to somebody standing at the desk who really
-- did register.
--
-- A trigger normalizes instead of rejecting, so a careless write
-- is repaired rather than turned into an error someone has to
-- decipher at 8am.
-- =============================================================

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

-- repair anything already stored with stray case or whitespace
update public.attendees
   set email = lower(trim(email))
 where email <> lower(trim(email));
