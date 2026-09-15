#!/usr/bin/env node
/* =============================================================
   Microsoft Forms export  ->  attendees table.

   Runs on YOUR LAPTOP with the service role key. That key
   bypasses RLS, so it must never reach the browser or a commit;
   it lives in a gitignored .env.

   Usage:
     node tools/import-prereg.mjs responses.csv          # dry run
     node tools/import-prereg.mjs responses.csv --commit # write

   Dry run is the default on purpose: it prints exactly what
   would change so you can eyeball it before touching the DB.

   Excel exports .xlsx -- open it and File > Save As > "CSV UTF-8"
   first. Keeping this script dependency-free is worth the extra
   click.
   ============================================================= */

import { readFileSync } from "node:fs";
import { argv, env, exit } from "node:process";

/* ---- .env ------------------------------------------------- */
try {
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n").forEach((line) => {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
    });
} catch { /* fall back to real env vars */ }

const URL_ = env.SUPABASE_URL;
const KEY  = env.SUPABASE_SERVICE_KEY;
const EVENT = env.EVENT_ID || "aiag2026";

if (!URL_ || !KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY (see .env.example)");
  exit(1);
}

const file   = argv[2];
const commit = argv.includes("--commit");
if (!file) { console.error("Usage: node tools/import-prereg.mjs <export.csv> [--commit]"); exit(1); }

/* ---- CSV parser ------------------------------------------- */
// Hand-rolled because abstracts and dietary notes are free text:
// they contain commas, quotes and hard newlines, and a naive
// split(",") silently shreds the file.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  text = text.replace(/^﻿/, "");          // Excel's UTF-8 BOM
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/* ---- header mapping --------------------------------------- */
// MS Forms prepends its own metadata block. Because this form is
// anonymous those columns are blank -- and critically, one of
// them is ALSO called "Email". Matching by name alone would
// silently import 200 empty addresses, so we skip the metadata
// prefix first and only then look for the question headers.
const META = ["id", "start time", "completion time", "email", "name",
              "last modified time", "total points", "quiz feedback"];

const QUESTIONS = {
  first_name:              "First Name",
  last_name:               "Last Name",
  email:                   "Email",
  job_title:               "Job Title",
  organization:            "Company/Organization",
  academic_background:     "Academic background/field of study",
  lightning_talk_abstract: "Are you interested giving a lightning talk? Include your abstract below.",
  attending_reception:     "Are you planning to attend the 5 PM reception?",
  dietary_restrictions:    "Do you have any dietary restrictions?",
  heard_from:              "How did you hear about this event?"
};

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ")
  .replace(/[^\w\s/]/g, "").trim();

function buildMap(header) {
  let qStart = 0;
  while (qStart < header.length && META.includes(norm(header[qStart]))) qStart++;

  const map = {}, missing = [];
  for (const [col, question] of Object.entries(QUESTIONS)) {
    const want = norm(question);
    let idx = header.findIndex((h, i) => i >= qStart && norm(h) === want);
    if (idx === -1) {                       // tolerate small wording drift
      idx = header.findIndex((h, i) => i >= qStart &&
        (norm(h).startsWith(want.slice(0, 18)) || want.startsWith(norm(h).slice(0, 18))));
    }
    if (idx === -1) missing.push(question); else map[col] = idx;
  }
  return { map, missing, qStart };
}

/* ---- value coercion --------------------------------------- */
const clean = (v) => { const s = String(v ?? "").trim(); return s === "" ? null : s; };
const YES = /^(yes|y|true|1)$/i, NO = /^(no|n|false|0)$/i;
const bool = (v) => { const s = String(v ?? "").trim();
  return YES.test(s) ? true : NO.test(s) ? false : null; };
const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/* ---- run --------------------------------------------------- */
const rows = parseCSV(readFileSync(file, "utf8"));
if (rows.length < 2) { console.error("No data rows found."); exit(1); }

const header = rows[0];
const { map, missing, qStart } = buildMap(header);

console.log(`\n  ${file}`);
console.log(`  ${rows.length - 1} response rows · ${header.length} columns ` +
            `· ${qStart} metadata column${qStart === 1 ? "" : "s"} skipped\n`);

if (missing.length) {
  console.error("  Could not find these questions in the header:");
  missing.forEach((m) => console.error(`    · ${m}`));
  console.error("\n  Headers seen after the metadata block:");
  header.slice(qStart).forEach((h, i) => console.error(`    [${i + qStart}] ${h}`));
  console.error("\n  Fix the QUESTIONS map at the top of this file and re-run.\n");
  exit(1);
}

const out = [], skipped = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const get = (c) => map[c] === undefined ? null : clean(r[map[c]]);

  const email = (get("email") || "").toLowerCase();
  const first = get("first_name"), last = get("last_name");

  // Hard-fail loudly rather than importing junk: a blank email
  // is unusable (it's the check-in key) and a missing name would
  // violate the NOT NULL constraint anyway.
  if (!okEmail(email))  { skipped.push([i + 1, `bad email ${JSON.stringify(get("email"))}`]); continue; }
  if (!first || !last)  { skipped.push([i + 1, `missing name (${email})`]); continue; }

  out.push({
    event_id: EVENT, email, first_name: first, last_name: last,
    job_title: get("job_title"),
    organization: get("organization"),
    academic_background: get("academic_background"),
    lightning_talk_abstract: get("lightning_talk_abstract"),
    attending_reception: bool(map.attending_reception === undefined
                               ? null : r[map.attending_reception]),
    dietary_restrictions: get("dietary_restrictions"),
    heard_from: get("heard_from"),
    source: "preregistered"
  });
}

// last write wins if someone submitted the form twice
const byEmail = new Map();
out.forEach((r) => byEmail.set(r.email, r));
const final = [...byEmail.values()];
const dupes = out.length - final.length;

console.log(`  ready:   ${final.length}`);
if (dupes)          console.log(`  merged:  ${dupes} duplicate email${dupes === 1 ? "" : "s"}`);
if (skipped.length) {
  console.log(`  skipped: ${skipped.length}`);
  skipped.forEach(([ln, why]) => console.log(`             row ${ln}: ${why}`));
}
console.log(`  yes to reception: ${final.filter((r) => r.attending_reception === true).length}`);
console.log(`  dietary notes:    ${final.filter((r) => r.dietary_restrictions).length}\n`);

if (!commit) {
  console.log("  DRY RUN — nothing written. Re-run with --commit to apply.\n");
  console.log("  First row would be:");
  console.log(JSON.stringify(final[0], null, 2).split("\n").map((l) => "    " + l).join("\n"));
  console.log();
  exit(0);
}

// merge-duplicates updates only the columns we send, so an
// already-recorded checked_in_at survives a re-import.
const res = await fetch(
  `${URL_}/rest/v1/attendees?on_conflict=event_id,email`, {
  method: "POST",
  // apikey ONLY -- no "Authorization: Bearer". The new-style
  // sb_secret_... keys are plain strings, not JWTs, and are
  // documented to travel on apikey alone. Legacy service_role
  // JWTs resolve the same way, so this works for both.
  headers: {
    apikey: KEY,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal"
  },
  body: JSON.stringify(final)
});

if (!res.ok) {
  console.error(`  FAILED ${res.status}: ${await res.text()}\n`);
  exit(1);
}
console.log(`  ✓ ${final.length} attendees upserted into ${EVENT}\n`);
