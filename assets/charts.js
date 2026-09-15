/* =============================================================
   Hand-built SVG charts. No library -- the whole admin page
   stays under ~40KB, which matters on venue wifi.

   Palette: single-series marks use CYAN. When a chart carries
   two series, the second is CARDINAL. That pair was validated
   on this dark surface (#131A24):
     lightness band PASS | chroma PASS | CVD deutan dE 18.2 PASS
     | normal-vision dE 27.8 PASS | contrast PASS
   Don't substitute the brighter UI cyan (#58A9DE) here -- it
   sits outside the dark-mode lightness band (L 0.705 > 0.67).
   ============================================================= */
(() => {
  "use strict";

  const SERIES  = ["#4098D4", "#C74357"];
  const INK     = "#9BA9BA";
  const INK_DIM = "#64748B";
  const GRID    = "rgba(255,255,255,.075)";

  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Pick a round STEP first, then let the axis top fall out of
  // it. Scaling the top directly gives you ticks like 0/9/18/26,
  // which nobody can read a value off.
  const niceAxis = (max, steps) => {
    if (max <= steps) return { step: 1, top: Math.max(steps, 1) };
    const raw = max / steps;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = ([1, 2, 2.5, 5, 10].find((m) => raw <= m * p) || 10) * p;
    return { step, top: step * steps };
  };

  /* rounded on the data end only; the baseline end stays square */
  function barPath(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w));
    if (w <= 0.5) return "";
    return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r}` +
           ` V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
  }

  function tipFor(host) {
    const t = document.createElement("div");
    t.className = "tip";
    host.appendChild(t);
    return {
      show(x, y, html) { t.innerHTML = html; t.style.left = x + "px";
                         t.style.top = y + "px"; t.style.opacity = "1"; },
      hide() { t.style.opacity = "0"; }
    };
  }

  /* -----------------------------------------------------------
     Arrival curve: area + 2px line, crosshair tooltip.
     Single series, so no legend -- the panel heading names it.
     ----------------------------------------------------------- */
  function areaChart(host, pts) {
    host.innerHTML = "";
    if (!pts || pts.length === 0) {
      host.innerHTML = '<p class="empty">No check-ins yet.</p>';
      return;
    }

    const W = 860, H = 260, L = 44, R = 14, T = 14, B = 34;
    const iw = W - L - R, ih = H - T - B;
    const xs = pts.map((p) => +new Date(p.bucket));
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const span = Math.max(x1 - x0, 15 * 60 * 1000);
    const steps = 4;
    const { step, top: ymax } = niceAxis(Math.max(...pts.map((p) => p.n)), steps);

    const X = (t) => L + ((t - x0) / span) * iw;
    const Y = (v) => T + ih - (v / ymax) * ih;

    // recessive grid on round steps
    const grid = [];
    for (let i = 0; i <= steps; i++) {
      const v = step * i, y = Y(v);
      grid.push(`<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`);
      grid.push(`<text x="${L - 9}" y="${y + 4}" fill="${INK_DIM}" font-size="11"
                  text-anchor="end" font-family="ui-monospace,monospace">${
                    Number.isInteger(v) ? v : v.toFixed(1)}</text>`);
    }

    // hour ticks along the bottom
    const ticks = [];
    const seen = new Set();
    pts.forEach((p) => {
      const d = new Date(p.bucket);
      const k = d.getHours();
      if (seen.has(k)) return;
      seen.add(k);
      ticks.push(`<text x="${X(+d)}" y="${H - 11}" fill="${INK_DIM}" font-size="11"
        text-anchor="middle" font-family="ui-monospace,monospace">${
          d.toLocaleTimeString([], { hour: "numeric" }).replace(" ", "")}</text>`);
    });

    const line = pts.map((p, i) => `${i ? "L" : "M"}${X(+new Date(p.bucket))},${Y(p.n)}`).join("");
    const area = line + `L${X(x1)},${Y(0)} L${X(x0)},${Y(0)} Z`;

    host.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"
           aria-label="Check-ins per 15 minutes over the course of the day">
        <defs>
          <linearGradient id="aFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="${SERIES[0]}" stop-opacity=".42"/>
            <stop offset="100%" stop-color="${SERIES[0]}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid.join("")}
        <path d="${area}" fill="url(#aFill)"/>
        <path d="${line}" fill="none" stroke="${SERIES[0]}" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round"/>
        ${ticks.join("")}
        <line id="cross" x1="0" y1="${T}" x2="0" y2="${T + ih}" stroke="${SERIES[0]}"
              stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
        <circle id="dot" r="4.5" fill="${SERIES[0]}" stroke="#0A0E14" stroke-width="2" opacity="0"/>
        <rect x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent" id="hit"/>
      </svg>`;

    const svg = host.querySelector("svg");
    const tip = tipFor(host);
    const cross = svg.querySelector("#cross"), dot = svg.querySelector("#dot");

    function move(ev) {
      const r = svg.getBoundingClientRect();
      const px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * W;
      // nearest bucket, so the tooltip never sits between two points
      let best = pts[0], bd = Infinity;
      pts.forEach((p) => {
        const d = Math.abs(X(+new Date(p.bucket)) - px);
        if (d < bd) { bd = d; best = p; }
      });
      const bx = X(+new Date(best.bucket)), by = Y(best.n);
      cross.setAttribute("x1", bx); cross.setAttribute("x2", bx); cross.setAttribute("opacity", ".55");
      dot.setAttribute("cx", bx); dot.setAttribute("cy", by); dot.setAttribute("opacity", "1");
      const d = new Date(best.bucket);
      tip.show(bx / W * r.width, by / H * r.height,
        `<span class="t">${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
         <b>${best.n}</b> check-in${best.n === 1 ? "" : "s"}`);
    }
    function leave() { cross.setAttribute("opacity", "0"); dot.setAttribute("opacity", "0"); tip.hide(); }

    svg.addEventListener("mousemove", move);
    svg.addEventListener("mouseleave", leave);
    svg.addEventListener("touchstart", move, { passive: true });
    svg.addEventListener("touchmove",  move, { passive: true });
    svg.addEventListener("touchend",   leave);
  }

  /* -----------------------------------------------------------
     Horizontal bars. Length encodes magnitude, so every bar is
     one hue -- color carries no extra meaning here.
     ----------------------------------------------------------- */
  function barsH(host, rows, opts) {
    opts = opts || {};
    host.innerHTML = "";
    if (!rows || rows.length === 0) {
      host.innerHTML = `<p class="empty">${esc(opts.empty || "Nothing to show yet.")}</p>`;
      return;
    }
    rows = rows.slice(0, opts.limit || 8);

    const color = opts.color || SERIES[0];
    const W = 520, RH = 34, PAD = 6, LW = 186;
    const H = rows.length * RH + PAD;
    const max = Math.max(...rows.map((r) => r.n)) || 1;
    const iw = W - LW - 52;

    const bars = rows.map((r, i) => {
      const y = i * RH + PAD;
      const w = Math.max((r.n / max) * iw, 2);
      const label = String(r.label);
      const short = label.length > 30 ? label.slice(0, 29) + "…" : label;
      return `<g class="row" data-i="${i}">
        <text x="0" y="${y + 17}" fill="${INK}" font-size="12.5">${esc(short)}</text>
        <path d="${barPath(LW, y + 6, w, 16, 4)}" fill="${color}"/>
        <text x="${LW + w + 9}" y="${y + 18}" fill="${INK_DIM}" font-size="12"
              font-family="ui-monospace,monospace">${r.n}</text>
        <rect x="0" y="${y}" width="${W}" height="${RH}" fill="transparent"/>
      </g>`;
    }).join("");

    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet"
       role="img" aria-label="${esc(opts.aria || "Bar chart")}">${bars}</svg>`;

    const svg = host.querySelector("svg");
    const tip = tipFor(host);
    svg.querySelectorAll(".row").forEach((g) => {
      const r = rows[+g.dataset.i];
      g.style.cursor = "default";
      g.addEventListener("mouseenter", (ev) => {
        g.style.opacity = ".82";
        const b = svg.getBoundingClientRect();
        tip.show(ev.clientX - b.left, ev.clientY - b.top - 6,
          `<span class="t">${esc(r.label)}</span><b>${r.n}</b> ${esc(opts.unit || "people")}`);
      });
      g.addEventListener("mouseleave", () => { g.style.opacity = "1"; tip.hide(); });
    });
  }

  window.Charts = { areaChart, barsH, SERIES };
})();
