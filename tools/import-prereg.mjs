#!/usr/bin/env node
/* =============================================================
   Microsoft Forms export  ->  attendees table.

   Runs on YOUR LAPTOP with the service role key. That key
   bypasses RLS, so it must never reach the browser or a commit;
   it lives in a gitignored .env.

   Usage:
     node tools/import-prereg.mjs responses.csv          # dry run
     node tools/import-prereg.mjs responses.csv --commit # write

   The form -- symposium or hackathon -- is detected from the
   header, and picks the event it imports into. --event=<id>
   overrides that if you ever need it to.

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

if (!URL_ || !KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY (see .env.example)");
  exit(1);
}

const file   = argv[2];
const commit = argv.includes("--commit");
// Explicit override only. EVENT_ID from .env must NOT win here:
// it says "aiag2026", so a hackathon export would have been
// filed into the symposium without a word.
const eventArg = (argv.find((a) => a.startsWith("--event=")) || "").split("=")[1];
if (!file) {
  console.error("Usage: node tools/import-prereg.mjs <export.csv> [--commit] [--event=<id>]");
  exit(1);
}

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

// Two events, two forms, two shapes. The importer detects which
// one it is looking at rather than making you remember a flag --
// picking the wrong one would mis-map every column.
const FORMS = {
  symposium: {
    event:   "aiag2026",
    detect:  "First Name",
    columns: {
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
    }
  },
  hackathon: {
    event:   "aiag-hack2026",
    detect:  "Your Name",
    columns: {
      full_name:            "Your Name",
      // MS Forms appends a digit when a question name collides
      // with one of its own metadata columns -- hence "Email2".
      email:                "Email2",
      college:              "College",
      program:              "MS/PhD program (Major)",
      background:           "Your background?",
      heard_from:           "How did you hear about this event?",
      dietary_restrictions: "Any dietary restrictions?"
    }
  }
};

// "Maria Elena Vargas Ruiz" has no correct split, so this uses
// the only defensible rule -- last token is the surname -- and
// reports every row it touched so they can be eyeballed. A
// single-token name keeps a NULL surname rather than inventing
// one; the column is nullable for exactly this reason.
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ")
  .replace(/[^\w\s/]/g, "").trim();

// Which form is this? Detected from the header rather than asked
// for as a flag -- choosing wrong would mis-map every column.
function detectForm(header) {
  const hs = header.map(norm);
  for (const [name, f] of Object.entries(FORMS)) {
    if (hs.includes(norm(f.detect))) return name;
  }
  return null;
}

function buildMap(header, columns) {
  // Skip MS Forms' own metadata block first. One of those columns
  // is also called "Email", and on an anonymous form it is blank --
  // matching by name alone would silently import empty addresses.
  let qStart = 0;
  while (qStart < header.length && META.includes(norm(header[qStart]))) qStart++;

  const map = {}, missing = [];
  for (const [col, question] of Object.entries(columns)) {
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

const formName = detectForm(header);
if (!formName) {
  console.error("  Could not tell which form this is.");
  console.error("  Expected a column called \"First Name\" (symposium) or " +
                "\"Your Name\" (hackathon).");
  console.error("  Headers seen:");
  header.forEach((h, i) => console.error(`    [${i}] ${h}`));
  console.error();
  exit(1);
}
const form  = FORMS[formName];
const EVENT = eventArg || form.event;
const { map, missing, qStart } = buildMap(header, form.columns);

console.log(`\n  ${file}`);
console.log(`  detected: ${formName.toUpperCase()} form  ->  event "${EVENT}"`);
console.log(`  ${rows.length - 1} response rows · ${header.length} columns ` +
            `· ${qStart} metadata column${qStart === 1 ? "" : "s"} skipped\n`);

if (missing.length) {
  console.error("  Could not find these questions in the header:");
  missing.forEach((m) => console.error(`    · ${m}`));
  console.error("\n  Headers seen after the metadata block:");
  header.slice(qStart).forEach((h, i) => console.error(`    [${i + qStart}] ${h}`));
  console.error("\n  Fix the FORMS map at the top of this file and re-run.\n");
  exit(1);
}

const out = [], skipped = [], splitNames = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const get = (c) => map[c] === undefined ? null : clean(r[map[c]]);

  const email = (get("email") || "").toLowerCase();

  let first, last;
  if (formName === "hackathon") {
    const n = splitName(get("full_name"));
    first = n.first; last = n.last;
    if (first) splitNames.push([get("full_name"), first, last]);
  } else {
    first = get("first_name"); last = get("last_name");
  }

  if (!okEmail(email)) { skipped.push([i + 1, `bad email ${JSON.stringify(get("email"))}`]); continue; }
  if (!first)          { skipped.push([i + 1, `no name (${email})`]); continue; }

  out.push({
    event_id: EVENT, email, first_name: first, last_name: last,
    job_title: get("job_title"),
    organization: get("organization"),
    academic_background: get("academic_background"),
    lightning_talk_abstract: get("lightning_talk_abstract"),
    attending_reception: map.attending_reception === undefined
                           ? null : bool(r[map.attending_reception]),
    dietary_restrictions: get("dietary_restrictions"),
    heard_from: get("heard_from"),
    college: get("college"),
    program: get("program"),
    background: get("background"),
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
if (formName === "symposium")
  console.log(`  yes to reception: ${final.filter((r) => r.attending_reception === true).length}`);
console.log(`  dietary notes:    ${final.filter((r) => r.dietary_restrictions).length}`);

const mononyms = final.filter((r) => !r.last_name);
if (mononyms.length) {
  console.log(`\n  ${mononyms.length} name(s) had no surname to split off — ` +
              `stored first-name-only:`);
  mononyms.forEach((r) => console.log(`             ${r.first_name}  <${r.email}>`));
}
if (splitNames.length && !commit) {
  console.log(`\n  name splits (first 8) — check these read correctly:`);
  splitNames.slice(0, 8).forEach(([full, f, l]) =>
    console.log(`             "${full}"  ->  first="${f}"  last="${l ?? ""}"`));
}
console.log();

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
