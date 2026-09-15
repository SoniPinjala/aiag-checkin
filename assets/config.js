/* =============================================================
   Supabase connection.

   The anon key is PUBLIC by design -- it ships in this file, in
   a public repo, to every phone that scans the QR. That is fine
   and expected: supabase/03_policies.sql makes sure it can do
   exactly two things (look up an email, register one attendee)
   and cannot read the attendee list.

   The SERVICE ROLE key must NEVER appear in this file. It lives
   only in a gitignored .env for tools/import-prereg.mjs.
   ============================================================= */

window.CONFIG = {
  SUPABASE_URL: "https://oxycvbysjvkjhikxqmyk.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_8rmMWmquFAF-bk8hHYqu4g_Ren6tw9k",

  // fallback when the URL has no ?e= (i.e. someone typed the
  // address instead of scanning the poster)
  DEFAULT_EVENT: "aiag2026",

  // how long to wait on venue wifi before offering Retry
  TIMEOUT_MS: 12000
};
