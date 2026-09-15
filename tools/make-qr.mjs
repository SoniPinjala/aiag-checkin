#!/usr/bin/env node
/* =============================================================
   Generates the printable QR code.

     npm install                 # one-time, installs `qrcode`
     node tools/make-qr.mjs

   Writes qr-checkin.svg (vector -- scales to any poster size)
   and qr-checkin.png. Reads SITE_URL / CHECKIN_TOKEN from .env
   so the token never gets typed by hand.

   This QR is designed to be PERMANENT: it carries no year, so
   the same printed sign works every symposium. Rotating the
   token means reprinting, so treat the generated files as
   long-lived artifacts and scan one with a real phone before
   sending anything to a printer.
   ============================================================= */

import QRCode from "qrcode";
import { readFileSync, writeFileSync } from "node:fs";
import { env, exit } from "node:process";

try {
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n").forEach((line) => {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
    });
} catch { /* fall back to real env vars */ }

const SITE  = (env.SITE_URL || "https://SoniPinjala.github.io/aiag-checkin/").replace(/\/?$/, "/");
const TOKEN = env.CHECKIN_TOKEN;

if (!TOKEN || TOKEN === "CHANGE_ME_BEFORE_PRINTING") {
  console.error("\n  CHECKIN_TOKEN is unset or still the placeholder.");
  console.error("  Generate one, put it in .env AND in the events table, then re-run:");
  console.error("    node -e \"console.log(crypto.randomUUID().replace(/-/g,''))\"\n");
  exit(1);
}

// No event id in the URL -- the database resolves which
// symposium is active. That is what makes this QR permanent.
const url = `${SITE}?k=${encodeURIComponent(TOKEN)}`;

// High error correction: posters get scuffed, and people scan
// them at an angle from six feet away.
const opts = { errorCorrectionLevel: "H", margin: 2, width: 1400,
               color: { dark: "#0A0E14", light: "#FFFFFF" } };

writeFileSync(`qr-checkin.svg`, await QRCode.toString(url, { ...opts, type: "svg" }));
await QRCode.toFile(`qr-checkin.png`, url, opts);

console.log(`\n  ✓ qr-checkin.svg and qr-checkin.png`);
console.log(`\n  encodes: ${url}\n`);
console.log("  Scan it with a real phone before it goes to print.\n");
