/* =============================================================
   Attendee check-in flow.

   Four states, swapped with [hidden] -- no router, no reload.
   Every network call is wrapped so a failure lands on a Retry
   that re-sends the SAME payload, rather than dumping someone
   back to an empty email box. Conference wifi is the single
   most likely thing to go wrong here.
   ============================================================= */
(() => {
  "use strict";

  const cfg = window.CONFIG;
  const db  = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: false }
  });

  const $ = (id) => document.getElementById(id);

  /* ---- token + series -------------------------------------- */
  // The QR carries a token and a SERIES ("hackathon" /
  // "symposium") -- never a year. The database resolves which
  // event that means, so both printed signs are permanent: next
  // year is one UPDATE, not a reprint.
  // Remembered so a bookmarked visit still works on the day.
  const params = new URLSearchParams(location.search);
  const token  = params.get("k") || localStorage.getItem("aiag_token")  || "";
  const series = params.get("s") || localStorage.getItem("aiag_series") || "";
  if (params.get("k")) localStorage.setItem("aiag_token", token);
  if (params.get("s")) localStorage.setItem("aiag_series", series);

  // Two events run three days apart -- the hackathon (18-20) and
  // the symposium (21) -- so the QR says WHICH. Without it we
  // would be guessing, and guessing wrong files someone into the
  // wrong event with a cheerful "you're in".
  const EVENT_LABEL = { hackathon: "AI in Ag Hackathon",
                        symposium: "AI in Agriculture Symposium" }[series] || "";

  // The two events ask different things of a walk-up: the
  // symposium wants job title, employer and the 5 PM reception;
  // the hackathon wants college, degree program and background.
  // Showing the wrong set is how a hackathon student ends up
  // being asked which company they work for.
  document.querySelectorAll("[data-series]").forEach((el) => {
    el.hidden = el.dataset.series !== series;
  });

  // Name the event in the header as soon as the series is known,
  // not only on a successful lookup. This line is the one thing
  // a person can glance at to confirm they are at the right
  // desk -- it must be right even when the token is wrong.
  if (EVENT_LABEL) {
    const k = document.querySelector(".brand .kicker");
    if (k) k.textContent = EVENT_LABEL + " \u00b7 Check-In";
  }

  /* ---- state machine -------------------------------------- */
  const STATES = ["s-email", "s-register", "s-success", "s-already", "s-error"];
  let lastAction = null;          // for Retry

  function show(id) {
    STATES.forEach((s) => { $(s).hidden = (s !== id); });
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function busy(btn, on, label) {
    btn.disabled = on;
    btn.innerHTML = on
      ? '<span class="spin"></span><span>Checking&hellip;</span>'
      : label;
  }

  /* ---- network -------------------------------------------- */
  // supabase-js has no built-in timeout; without one a dead
  // connection just spins forever and people queue up.
  async function rpc(fn, args) {
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("timeout")), cfg.TIMEOUT_MS));
    const { data, error } = await Promise.race([db.rpc(fn, args), timeout]);
    if (error) throw error;
    return data;
  }

  function fail(action, msg) {
    lastAction = action;
    $("fail-msg").textContent = msg ||
      "We couldn't reach the server. The wifi here can be patchy — give it another try.";
    show("s-error");
  }

  /* ---- shared result rendering ----------------------------- */
  const receptionText = (v) =>
    v === true  ? "See you at the 5 PM reception"
  : v === false ? "Not attending the 5 PM reception"
  : null;

  function renderSuccess(res) {
    $("ok-name").textContent = res.first_name ? `, ${res.first_name}` : "";
    $("ok-stamp").textContent = "Checked in at " +
      new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const rec = receptionText(res.attending_reception);
    const badge = $("ok-badge");
    badge.hidden = !rec;
    if (rec) badge.textContent = rec;
    show("s-success");
  }

  function renderAlready(res) {
    $("dup-name").textContent = res.first_name ? `, ${res.first_name}` : "";
    $("dup-stamp").textContent = res.checked_in_at
      ? "Checked in at " + new Date(res.checked_in_at).toLocaleTimeString([], {
          hour: "numeric", minute: "2-digit" })
      : "";
    const rec = receptionText(res.attending_reception);
    const badge = $("dup-badge");
    badge.hidden = !rec;
    if (rec) badge.textContent = rec;
    show("s-already");
  }

  function handleStatus(res, onNotRegistered) {
    switch (res && res.status) {
      case "checked_in":         renderSuccess(res); return true;
      case "already_checked_in": renderAlready(res); return true;
      case "not_registered":     onNotRegistered();  return true;
      // One status covers both "wrong token" and "nothing running
      // today" -- from the attendee's side those are the same
      // situation, and the sign stays up all year.
      case "no_active_event":
        fail(null, "Check-in isn't open right now. If the event is " +
                   "running today, please ask a staff member for help.");
        return true;
      default: return false;
    }
  }

  /* =========================================================
     STATE 1 -- email
     ========================================================= */
  let pendingEmail = "";

  $("email-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = $("email");
    const email = input.value.trim().toLowerCase();
    const err   = $("email-err");

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      err.textContent = "That doesn't look like an email address.";
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    err.textContent = "";
    input.removeAttribute("aria-invalid");
    doLookup(email);
  });

  async function doLookup(email) {
    pendingEmail = email;
    const btn = $("email-btn");
    busy(btn, true);
    try {
      const res = await rpc("checkin_lookup",
        { p_token: token, p_series: series, p_email: email });
      const handled = handleStatus(res, () => {
        $("r-email").value = email;
        $("reg-err").textContent = "";
        show("s-register");
        $("r-first").focus();
      });
      if (!handled) {
        fail(() => doLookup(email), "We couldn't read the response. Try once more.");
      }
    } catch (e) {
      fail(() => doLookup(email));
    } finally {
      busy(btn, false, "Check in");
    }
  }

  /* =========================================================
     STATE 2 -- registration
     ========================================================= */
  let reception = null;   // null = not answered, and that's allowed

  function setReception(v) {
    reception = (reception === v) ? null : v;   // tap again to clear
    $("rec-yes").setAttribute("aria-pressed", String(reception === true));
    $("rec-no").setAttribute("aria-pressed",  String(reception === false));
  }
  $("rec-yes").addEventListener("click", () => setReception(true));
  $("rec-no").addEventListener("click",  () => setReception(false));

  $("r-heard").addEventListener("change", (ev) => {
    const other = $("r-heard-other");
    other.hidden = ev.target.value !== "__other";
    if (!other.hidden) other.focus();
  });

  // Clear a validation message as soon as the person starts
  // fixing it -- a red line that survives the correction reads
  // as "still broken" and makes people re-check work they
  // already did.
  ["r-first", "r-last"].forEach((id) =>
    $(id).addEventListener("input", () => { $("reg-err").textContent = ""; }));
  $("email").addEventListener("input", () => {
    $("email-err").textContent = "";
    $("email").removeAttribute("aria-invalid");
  });

  $("reg-back").addEventListener("click", () => {
    show("s-email");
    $("email").focus();
    $("email").select();
  });

  $("reg-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const first = $("r-first").value.trim();
    const last  = $("r-last").value.trim();
    const err   = $("reg-err");

    // Only these three are required. Everything else can be
    // skipped so nobody is stuck at the desk.
    if (!first || !last) {
      err.textContent = "First and last name are both required.";
      ($("r-first").value.trim() ? $("r-last") : $("r-first")).focus();
      return;
    }
    err.textContent = "";

    const heardSel = $("r-heard").value;
    const heard = heardSel === "__other" ? $("r-heard-other").value.trim() : heardSel;

    // Only ever send the hidden group's values as null -- a
    // stale value from the other event's fields would be stored
    // against a person who was never asked the question.
    const sym  = series === "symposium";
    const hack = series === "hackathon";
    const val  = (id, when) => (when && $(id).value.trim()) || null;

    doRegister({
      p_token: token,
      p_series: series,
      p_email: pendingEmail,
      p_first_name: first,
      p_last_name: last,
      p_job_title:           val("r-title",      sym),
      p_organization:        val("r-org",        sym),
      p_academic_background: val("r-acad",       sym),
      p_attending_reception: sym ? reception : null,
      p_college:             val("r-college",    hack),
      p_program:             val("r-program",    hack),
      p_background:          val("r-background", hack),
      p_dietary_restrictions: $("r-diet").value.trim() || null,
      p_heard_from: heard || null
    });
  });

  async function doRegister(payload) {
    const btn = $("reg-btn");
    busy(btn, true);
    try {
      const res = await rpc("register_and_checkin", payload);
      const handled = handleStatus(res, () => {});
      if (!handled) {
        const msg = res && res.status === "missing_name"
          ? "First and last name are both required."
          : res && res.status === "invalid_email"
          ? "That email address isn't valid."
          : null;
        if (msg) {
          $("reg-err").textContent = msg;
          show("s-register");
        } else {
          fail(() => doRegister(payload), "We couldn't read the response. Try once more.");
        }
      }
    } catch (e) {
      // Retry re-sends the identical payload, so a timeout that
      // actually succeeded server-side comes back as
      // "already checked in" rather than a duplicate.
      fail(() => doRegister(payload));
    } finally {
      busy(btn, false, "Register &amp; check in");
    }
  }

  /* =========================================================
     Reset / retry
     ========================================================= */
  function reset() {
    $("email").value = "";
    $("email-err").textContent = "";
    $("email").removeAttribute("aria-invalid");
    $("reg-form").reset();
    $("r-heard-other").hidden = true;
    reception = null;
    $("rec-yes").setAttribute("aria-pressed", "false");
    $("rec-no").setAttribute("aria-pressed", "false");
    show("s-email");
    $("email").focus();
  }

  // No "check in someone else" on the success screens -- checking
  // in is one person, one scan. Staff who need to check somebody
  // in by hand do it from admin.html, not from here.
  $("fail-start").addEventListener("click", reset);
  $("fail-retry").addEventListener("click", () => {
    if (lastAction) { const a = lastAction; lastAction = null; a(); }
    else reset();
  });

  /* ---- boot ------------------------------------------------ */
  if (!token || !series) {
    fail(null, "This page needs the link from the QR code on the poster. " +
               "Please scan it, or ask a staff member for help.");
  } else {
    $("email").focus();
  }
})();
