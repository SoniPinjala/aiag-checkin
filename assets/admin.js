/* =============================================================
   Staff dashboard.

   Unlike the attendee page this one authenticates, so it can
   read the table directly -- RLS grants SELECT/UPDATE to the
   `authenticated` role and nothing to anon.
   ============================================================= */
(() => {
  "use strict";

  const cfg = window.CONFIG;
  const db  = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const POLL_MS = 10000;
  let eventId = null, roster = [], timer = null;

  /* ---------- auth ----------------------------------------- */
  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("l-btn");
    btn.disabled = true; btn.textContent = "Signing in…";
    $("l-err").textContent = "";
    const { error } = await db.auth.signInWithPassword({
      email: $("l-email").value.trim(),
      password: $("l-pass").value
    });
    btn.disabled = false; btn.textContent = "Sign in";
    if (error) { $("l-err").textContent = error.message; return; }
    boot();
  });

  $("btn-out").addEventListener("click", async () => {
    if (timer) clearInterval(timer);
    await db.auth.signOut();
    location.reload();
  });

  /* ---------- boot ----------------------------------------- */
  async function boot() {
    const { data: { session } } = await db.auth.getSession();
    if (!session) { $("gate").hidden = false; $("dash").hidden = true; return; }
    $("gate").hidden = true;
    $("dash").hidden = false;

    // Name the signed-in account. On a shared desk laptop this is
    // the difference between "am I logged in as me?" and guessing.
    const whoEl = $("who");
    if (whoEl && session.user && session.user.email) {
      whoEl.textContent = session.user.email;
      whoEl.title = session.user.email;
    }

    const { data: events, error } = await db
      .from("events").select("id,name,event_date,series").order("event_date", { ascending: false });

    if (error || !events || !events.length) {
      $("ev-name").textContent = "No events found";
      return;
    }

    // Two events share 2026, so the year alone no longer
    // identifies one. Name + date does.
    $("ev-pick").innerHTML = events.map((e) => {
      const d = new Date(e.event_date + "T00:00:00");
      const when = d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
      return `<option value="${esc(e.id)}">${esc(e.name)} — ${when}</option>`;
    }).join("");

    eventId = events[0].id;
    $("ev-pick").value = eventId;
    $("ev-name").textContent = events[0].name;

    $("ev-pick").addEventListener("change", (e) => {
      eventId = e.target.value;
      const ev2 = events.find((x) => x.id === eventId);
      $("ev-name").textContent = ev2 ? ev2.name : "";
      refresh();
    });

    refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, POLL_MS);
  }

  $("btn-refresh").addEventListener("click", refresh);

  /* ---------- load ----------------------------------------- */
  async function refresh() {
    if (!eventId) return;
    try {
      const [stats, rows] = await Promise.all([
        db.rpc("event_stats", { p_event: eventId }),
        db.from("attendees").select("*").eq("event_id", eventId)
          .order("last_name", { ascending: true })
      ]);
      if (stats.error) throw stats.error;
      if (rows.error)  throw rows.error;

      roster = rows.data || [];
      renderTiles(stats.data);
      renderCharts(stats.data);
      renderDiet();
      applyFilter();
      $("footnote").innerHTML = "Updated " +
        new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) +
        " · refreshes every 10s";
    } catch (e) {
      $("footnote").innerHTML = '<span class="stale">Couldn\'t refresh — ' +
        esc(e.message || "network error") + ". Showing the last good numbers.</span>";
    }
  }

  /* ---------- tiles ---------------------------------------- */
  function renderTiles(s) {
    const rate = s.registered ? Math.round((s.checked_in / s.registered) * 100) : 0;
    const tiles = [
      { k: "Checked in", v: s.checked_in, d: `of ${s.registered} registered`, hero: true },
      { k: "Show rate",  v: rate + "%",   d: "checked in ÷ registered" },
      { k: "5 PM reception", v: s.reception_yes_in,
        d: `${s.reception_yes} said yes overall` },
      { k: "Dietary needs", v: s.dietary_count, d: "see the list below" },
      { k: "Pre-registered", v: `${s.prereg_checked}/${s.prereg_total}`, d: "checked in / expected" },
      { k: "Walk-ups", v: s.onsite_total, d: "registered at the door" }
    ];
    $("tiles").innerHTML = tiles.map((t) => `
      <div class="tile${t.hero ? " hero" : ""}">
        <div class="k">${t.k}</div>
        <div class="v">${t.v}</div>
        <div class="d">${t.d}</div>
      </div>`).join("");
  }

  function renderCharts(s) {
    window.Charts.areaChart($("c-arrivals"), s.arrivals || []);
    window.Charts.barsH($("c-heard"), s.heard_from || [], {
      aria: "How attendees heard about the event", unit: "people",
      empty: "No responses yet."
    });
    window.Charts.barsH($("c-orgs"), s.top_orgs || [], {
      color: window.Charts.SERIES[1], aria: "Top organizations represented",
      unit: "attendees", empty: "No organizations recorded yet."
    });
  }

  /* ---------- dietary breakdown ---------------------------- */
  // Reads from `roster`, not stats.dietary_list -- the RPC's list
  // carries no check-in state, and the Registered/Checked-in
  // toggle needs it. Everything here is derived at render time;
  // nothing about categories is stored.
  let dietScope = "reg";   // "reg" | "in"

  $("diet-reg").addEventListener("click", () => setDietScope("reg"));
  $("diet-in").addEventListener("click",  () => setDietScope("in"));

  function setDietScope(v) {
    dietScope = v;
    $("diet-reg").setAttribute("aria-pressed", String(v === "reg"));
    $("diet-in").setAttribute("aria-pressed",  String(v === "in"));
    renderDiet();
  }

  function renderDiet() {
    const host = $("diet-list");

    // The dashboard re-renders every 10s, and replacing innerHTML
    // throws away which <details> the reader had open -- so a row
    // expanded to read names would snap shut mid-sentence. Snapshot
    // the open ones and put them back.
    const wasOpen = new Set(
      [...host.querySelectorAll("details[open][data-key]")].map((el) => el.dataset.key)
    );
    const people = roster
      .filter((r) => dietScope === "reg" || r.checked_in_at)
      .map((r) => ({
        name: `${r.first_name} ${r.last_name || ""}`.trim(),
        note: r.dietary_restrictions
      }));

    const d = window.Diet.summarize(people);

    if (!d.total) {
      host.innerHTML = '<p class="empty">Nobody in this view has flagged a restriction.</p>';
      return;
    }

    const li = (p) => `<li><span class="nm">${esc(p.name)}</span>` +
                      `<span class="dnote">${esc(p.note)}</span></li>`;

    const group = (g) => {
      const max = Math.max(...g.rows.map((r) => r.count));
      return `<div class="dgroup">
        <h3>${esc(g.label)}</h3>
        ${g.rows.map((r) => `
          <details class="drow ${r.group}" data-key="cat:${r.key}">
            <summary>
              <span class="dlabel">${esc(r.label)}</span>
              <span class="dbar"><i style="width:${Math.round(r.count / max * 100)}%"></i></span>
              <span class="dcount">${r.count}</span>
            </summary>
            <ul class="dpeople">${r.people.map(li).join("")}</ul>
          </details>`).join("")}
      </div>`;
    };

    // Uncategorized is collapsed like the rest, but its COUNT stays
    // on the closed row: that is where a restriction the rules did
    // not recognise shows up, and a bare label would be scrolled past.
    const uncat = d.uncategorized.length ? `
      <details class="dfoot" data-key="uncat">
        <summary>Uncategorized <span class="n">${d.uncategorized.length}</span></summary>
        <ul class="dpeople">${d.uncategorized.map(li).join("")}</ul>
      </details>` : "";

    // Said once, at the top: "gluten-free, no shellfish" is counted
    // in two rows, so these deliberately do not sum to the total.
    // A number that looks like a total but is not is worse than none.
    const caveat = `<p class="overlap">Counts overlap &mdash; one note can appear
      in more than one row, so these do not sum to ${d.total}.</p>`;

    host.innerHTML = caveat + d.groups.map(group).join("") + uncat + `
      <details class="dfoot" data-key="all">
        <summary>All notes <span class="n">${d.total}</span></summary>
        <ul class="dpeople">${d.all.map(li).join("")}</ul>
      </details>`;

    host.querySelectorAll("details[data-key]").forEach((el) => {
      if (wasOpen.has(el.dataset.key)) el.open = true;
    });
  }

  /* ---------- roster + manual check-in --------------------- */
  $("q").addEventListener("input", applyFilter);

  function applyFilter() {
    const q = $("q").value.trim().toLowerCase();
    // Show everyone only once a search starts -- a 300-row table
    // on load buries the charts above it.
    let rows = q
      ? roster.filter((r) =>
          (r.first_name + " " + r.last_name).toLowerCase().includes(q) ||
          r.email.toLowerCase().includes(q) ||
          (r.organization || "").toLowerCase().includes(q))
      : roster.filter((r) => !r.checked_in_at).slice(0, 25);

    const tb = $("roster").querySelector("tbody");
    $("roster-empty").hidden = rows.length > 0;
    $("roster-empty").textContent = q ? "No matches." : "Everyone registered has checked in.";

    tb.innerHTML = rows.map((r) => `
      <tr>
        <td><span class="nm">${esc(r.first_name)} ${esc(r.last_name)}</span><br>
            <span class="em">${esc(r.email)}</span></td>
        <td>${esc(r.organization || "—")}</td>
        <td><span class="pill ${r.source === "preregistered" ? "pre" : "walk"}">${
             r.source === "preregistered" ? "Pre-reg" : "Walk-up"}</span></td>
        <td>${r.checked_in_at
              ? `<span class="pill in">${new Date(r.checked_in_at)
                  .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>`
              : '<span class="pill out">Not in</span>'}</td>
        <td style="text-align:right">${r.checked_in_at ? "" :
          `<button class="btn mini" data-in="${r.id}">Check in</button>`}</td>
      </tr>`).join("");

    tb.querySelectorAll("[data-in]").forEach((b) => {
      b.addEventListener("click", async () => {
        b.disabled = true; b.textContent = "…";
        const { error } = await db.rpc("staff_checkin", { p_id: b.dataset.in });
        if (error) { b.disabled = false; b.textContent = "Retry"; return; }
        refresh();
      });
    });
  }

  /* ---------- CSV ------------------------------------------ */
  const COLS = ["email", "first_name", "last_name", "job_title", "organization",
    "academic_background", "lightning_talk_abstract", "attending_reception",
    "dietary_restrictions", "heard_from", "source", "registered_at",
    "checked_in_at", "checkin_method"];

  $("btn-csv").addEventListener("click", () => {
    // quote everything: free-text answers are full of commas
    const cell = (v) => v == null ? "" : `"${String(v).replace(/"/g, '""')}"`;
    // Include the derived categories so a spreadsheet can be
    // filtered the same way the panel groups things.
    const head = COLS.concat("dietary_categories");
    const csv = [head.join(",")]
      .concat(roster.map((r) => COLS.map((c) => cell(r[c]))
        .concat(cell(window.Diet.categorize(r.dietary_restrictions).join("; ")))
        .join(",")))
      .join("\r\n");

    const url = URL.createObjectURL(new Blob(["﻿" + csv],
      { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${eventId}-attendees-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  boot();
})();
