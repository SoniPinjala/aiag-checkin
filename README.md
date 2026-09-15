# AI in Agriculture Symposium — Check-In

QR check-in and analytics for the Arkansas AI in Agriculture Symposium.
Static site on GitHub Pages, Postgres on Supabase, $0/month.

**Attendee flow:** scan the QR → enter email → if we know that email you're
checked in; if not, a short form registers and checks you in, tagged as a
walk-up. **Matching is on email alone** — a typo'd name never turns anyone away.

Built multi-year: every row is keyed to an `event_id`, so 2027 is a new row
and a new QR, with 2026 still queryable in the same dashboard.

---

## Setup (once)

### 1. Supabase

1. Create a free project at supabase.com.
2. SQL Editor → run these **in order**:
   `supabase/01_schema.sql`, `02_functions.sql`, `03_policies.sql`.
3. Generate a check-in token and put it in the `events` row:
   ```bash
   node -e "console.log(crypto.randomUUID().replace(/-/g,''))"
   ```
   ```sql
   update events set checkin_token = 'PASTE_IT_HERE' where id = 'aiag2026';
   ```
4. **Authentication → Providers → Email: turn OFF "Enable signup."**
   Then Authentication → Users → *Add user* → `spinjala@uark.edu` with a
   password. That is how every admin account gets made; there is no self-signup.

### 2. The site

Put your **Project URL** (Settings → Data API) and your **publishable** key
(Settings → API Keys — called the *anon* key on older projects) into
`assets/config.js`. That key is public on purpose — `03_policies.sql` is what
keeps it harmless.

```bash
git remote add origin https://github.com/SoniPinjala/aiag-checkin.git
git push -u origin main
```

Settings → Pages → deploy from branch `main` / root. Live at
`https://SoniPinjala.github.io/aiag-checkin/`.

> GitHub Pages on a free account requires a **public** repo. No attendee data
> lives in the repo, so this is fine. `spinjala@uark.edu` likely qualifies for
> GitHub Education (free Pro) if you'd rather it were private.

### 3. Keepalive — don't skip this

Supabase pauses free projects after ~7 days idle. `.github/workflows/keepalive.yml`
pings it daily and needs **no configuration** — it reads the project URL and
publishable key straight out of `assets/config.js`, which is the single source
of truth for both.

There are deliberately no GitHub Actions secrets. Those two values already ship
to every phone that scans the QR, so storing them as "secrets" would imply a
secrecy that doesn't exist and leave two copies to drift apart. The *secret*
key is the one that must never reach the repo; it lives only in a gitignored
`.env`.

After the first push, go to Actions → keepalive → Run workflow and confirm
HTTP 200.

**Leave it enabled year-round.** That is what makes the project still be here
next September rather than needing a manual restore.

### 4. Local env

```bash
cp .env.example .env    # fill it in; .env is gitignored
npm install             # only for the QR generator
```

The **service role key** goes in `.env` and nowhere else. It bypasses every
RLS policy. If it ever lands in a commit, rotate it in the dashboard.

### 5. The QR code

```bash
npm run qr
```

Writes `qr-aiag2026.svg` (vector, for print) and `.png`.

> **The URL is permanent once printed.** Scan the generated file with a real
> phone and complete a check-in before anything goes to a printer.

---

## Importing pre-registrations

Microsoft Forms exports `.xlsx` — open it and **File → Save As → CSV UTF-8**.

```bash
node tools/import-prereg.mjs responses.csv           # dry run, writes nothing
node tools/import-prereg.mjs responses.csv --commit  # apply
```

Dry run is the default. It prints what would change, and lists every row it
would skip and why.

MS Forms prepends its own metadata columns, one of which is **also called
`Email`** — and because this form is anonymous, that one is blank. The script
skips the metadata block before matching question headers, so it reads
question #3 and not the empty column. If a header has drifted, it stops with
the list of headers it actually saw; fix the `QUESTIONS` map at the top and
re-run.

Safe to run repeatedly — it upserts on `(event_id, email)`, and only touches
the columns it sends, so anyone already checked in stays checked in.

Test it against `tools/fixtures/sample-msforms-export.csv` to see the
skip-and-report behavior without a real export.

---

## Event day

| When | Do |
|---|---|
| Night before | Final import. Scan the printed QR and check yourself in. Confirm the Supabase project is awake. |
| Morning | Open `admin.html` on the desk laptop and sign in. |
| After the rush | **Export CSV.** The free plan has no automatic backups — this is the backup. |
| Before lunch | Dietary restrictions panel → hand to catering. |
| ~4pm | Reception headcount → hand to catering. |
| End of day | Export CSV again. |

**If the wifi dies:** the page retries without losing what was typed. If it
stays down, take names on paper and use the admin search to check people in
later. The admin page is also the fix for typo'd emails and dead phones.

---

## Next year

No migration and no re-setup — just:

```sql
insert into events (id, name, event_date, checkin_token)
values ('aiag2027', '2027 Arkansas AI in Agriculture Symposium',
        '2027-09-20', 'A_FRESH_TOKEN');
```

Update `.env`, run `npm run qr`, import the new list. 2026's data stays put
and the dashboard's year picker gains an entry.

---

## Security

The anon key is public — it ships in `assets/config.js` to every phone that
scans the QR. Everything rests on `supabase/03_policies.sql`: RLS is on, anon
has `SELECT` on **nothing**, and `EXECUTE` on exactly three functions that
return a status and a first name.

**After any change to the SQL, re-run this:**

```bash
curl "$SUPABASE_URL/rest/v1/attendees?select=*" -H "apikey: $ANON_KEY"
```

It must return `[]` or a permission error. If it returns rows, the attendee
list is public — stop and fix it before anything else.

---

## Layout

```
index.html              attendee check-in + walk-up registration
admin.html              staff dashboard: year picker, analytics, search, CSV
assets/
  theme.css             shared visual system
  checkin.js            attendee state machine
  admin.js              dashboard
  charts.js             hand-built SVG charts, no library
  config.js             Supabase URL + anon key (public)
supabase/               run 01 → 02 → 03 in the SQL editor
tools/
  import-prereg.mjs     MS Forms CSV → attendees (service key, local only)
  make-qr.mjs           printable QR
  fixtures/             synthetic MS Forms export for testing the importer
```
