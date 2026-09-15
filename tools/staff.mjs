#!/usr/bin/env node
/* =============================================================
   Manage staff access to the admin dashboard.

     node tools/staff.mjs list
     node tools/staff.mjs add    someone@uark.edu
     node tools/staff.mjs reset  someone@uark.edu
     node tools/staff.mjs remove someone@uark.edu

   Runs on YOUR laptop with the secret key. Nobody you add ever
   opens Supabase, and neither do you -- they just go to
   admin.html and sign in.

   `add` generates the password for you and prints a message you
   can paste straight to the person. `reset` issues a new one.

   Why not passwordless codes? Supabase's built-in mailer sends
   only 2 emails PER HOUR. Three staff signing in on event
   morning would mean the third waiting an hour. Configure
   custom SMTP and that cap is yours to set -- until then, a
   password is the thing that cannot fail at 8am.

   Sign-ups stay disabled, so an account must exist here to sign
   in at all. Adding someone IS granting access; removing them
   revokes it immediately.
   ============================================================= */

import { readFileSync } from "node:fs";
import { argv, env, exit } from "node:process";

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

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`,
            "Content-Type": "application/json" };

const cmd   = (argv[2] || "list").toLowerCase();
const email = (argv[3] || "").trim().toLowerCase();

// Readable beats cryptic: this gets typed on a desk laptop,
// possibly read aloud, possibly by someone in a hurry. Four
// words plus digits is far stronger than the "Xk9$mQ" a person
// would otherwise write on a sticky note.
const WORDS = ("amber anvil basin cedar clover copper delta ember fern " +
  "flint garnet harvest indigo juniper kestrel lantern maple meadow " +
  "nutmeg onyx pepper quartz river saffron thistle umber velvet willow " +
  "yarrow zephyr").split(" ");
function makePassword() {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  const n = () => Math.floor(Math.random() * 10);
  return `${pick()}-${pick()}-${pick()}-${n()}${n()}${n()}${n()}`;
}

function handover(email, pw) {
  const site = (env.SITE_URL || "").replace(/\/?$/, "/");
  console.log(`\n  ----- paste this to ${email} -----\n`);
  console.log(`    Staff dashboard for the AI in Ag events:`);
  console.log(`      ${site}admin.html`);
  console.log(`      email:    ${email}`);
  console.log(`      password: ${pw}`);
  console.log(`\n    Bookmark it. Any browser, phone or laptop.`);
  console.log(`\n  ----------------------------------------\n`);
  console.log(`  This password is shown ONCE. Run "reset" to issue a new one.\n`);
}

async function users() {
  const r = await fetch(`${URL_}/auth/v1/admin/users?per_page=200`, { headers: H });
  if (!r.ok) { console.error(`  FAILED ${r.status}: ${await r.text()}`); exit(1); }
  return (await r.json()).users || [];
}

const need = () => {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("  Give a valid email address.\n");
    exit(1);
  }
};

switch (cmd) {
  case "list": {
    const us = await users();
    console.log(`\n  ${us.length} staff account(s) with admin access:\n`);
    us.forEach((u) => {
      const seen = u.last_sign_in_at
        ? new Date(u.last_sign_in_at).toLocaleString()
        : "never signed in";
      console.log(`    ${u.email.padEnd(32)} ${seen}`);
    });
    console.log();
    break;
  }

  case "add": {
    need();
    // email_confirm skips the confirmation round-trip: we are
    // vouching for this address by adding it at all.
    const pw = makePassword();
    const r = await fetch(`${URL_}/auth/v1/admin/users`, {
      method: "POST", headers: H,
      body: JSON.stringify({ email, password: pw, email_confirm: true })
    });
    const body = await r.json();
    if (!r.ok) {
      const msg = JSON.stringify(body);
      if (/already|exists|registered/i.test(msg)) {
        console.log(`\n  ${email} already has access — nothing to do.\n`);
        break;
      }
      console.error(`\n  FAILED ${r.status}: ${msg}\n`);
      exit(1);
    }
    console.log(`\n  ✓ ${email} can now sign in.`);
    handover(email, pw);
    break;
  }

  case "reset": {
    need();
    const u = (await users()).find((x) => x.email === email);
    if (!u) { console.log(`\n  ${email} does not have access. Use "add".\n`); break; }
    const pw = makePassword();
    const r = await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, {
      method: "PUT", headers: H, body: JSON.stringify({ password: pw })
    });
    if (!r.ok) { console.error(`\n  FAILED ${r.status}: ${await r.text()}\n`); exit(1); }
    console.log(`\n  ✓ new password issued for ${email}`);
    handover(email, pw);
    break;
  }

  case "remove": {
    need();
    const u = (await users()).find((x) => x.email === email);
    if (!u) { console.log(`\n  ${email} does not have access.\n`); break; }
    const r = await fetch(`${URL_}/auth/v1/admin/users/${u.id}`,
                          { method: "DELETE", headers: H });
    if (!r.ok) { console.error(`\n  FAILED ${r.status}: ${await r.text()}\n`); exit(1); }
    console.log(`\n  ✓ access revoked for ${email}\n`);
    break;
  }

  default:
    console.error("\n  Usage: node tools/staff.mjs list | add <email> | reset <email> | remove <email>\n");
    exit(1);
}
