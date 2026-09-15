#!/usr/bin/env node
/* =============================================================
   Generates the printable QR code.

     npm install                 # one-time, installs `qrcode`
     node tools/make-qr.mjs

   Writes qr-<event>.svg (vector -- scales to any poster size)
   and qr-<event>.png. Reads SITE_URL / EVENT_ID / CHECKIN_TOKEN
   from .env so the token never gets typed by hand.

   The URL this bakes in is PERMANENT once printed. Check it
   twice, and scan the generated file with a real phone before
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
const EVENT = env.EVENT_ID || "aiag2026";
const TOKEN = env.CHECKIN_TOKEN;

if (!TOKEN || TOKEN === "CHANGE_ME_BEFORE_PRINTING") {
  console.error("\n  CHECKIN_TOKEN is unset or still the placeholder.");
  console.error("  Generate one, put it in .env AND in the events table, then re-run:");
  console.error("    node -e \"console.log(crypto.randomUUID().replace(/-/g,''))\"\n");
  exit(1);
}

const url = `${SITE}?e=${encodeURIComponent(EVENT)}&k=${encodeURIComponent(TOKEN)}`;

// High error correction: posters get scuffed, and people scan
// them at an angle from six feet away.
const opts = { errorCorrectionLevel: "H", margin: 2, width: 1400,
               color: { dark: "#0A0E14", light: "#FFFFFF" } };

writeFileSync(`qr-${EVENT}.svg`, await QRCode.toString(url, { ...opts, type: "svg" }));
await QRCode.toFile(`qr-${EVENT}.png`, url, opts);

console.log(`\n  ✓ qr-${EVENT}.svg and qr-${EVENT}.png`);
console.log(`\n  encodes: ${url}\n`);
console.log("  Scan it with a real phone before it goes to print.\n");
