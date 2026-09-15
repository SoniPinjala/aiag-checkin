/* =============================================================
   Dietary restrictions: free text -> counted categories.

   Catering needs "12 vegetarian, 8 nut-free", not 200 lines of
   prose. These rules turn one into the other.

   TUNING: after a real import, open the Uncategorized row on the
   dashboard. Anything sitting in there is a phrase the rules do
   not know yet -- add it to RULES below. Categories are derived
   at display time and never stored, so editing a rule
   reclassifies every past event too. Nothing to migrate.
   ============================================================= */
(() => {
  "use strict";

  // Word boundaries on EVERY alternative. /\bpork|bacon\b/ binds
  // the \b to "pork" only, leaving "bacon" free to match inside
  // other words -- so the group has to wrap the whole alternation.
  const RULES = [
    // ---- allergies & intolerances ----
    { key: "nut",       label: "Nuts",            group: "allergy",
      re: /\b(pea ?nuts?|tree ?nuts?|nuts?|almonds?|cashews?|walnuts?|pecans?|pistachios?|hazelnuts?|macadamias?)\b/i },
    { key: "gluten",    label: "Gluten",          group: "allergy",
      re: /\b(gluten|gluten[- ]?free|celiac|coeliac|wheat)\b/i },
    { key: "dairy",     label: "Dairy / lactose", group: "allergy",
      re: /\b(dairy|lactose|milk|cheese|casein)\b/i },
    { key: "shellfish", label: "Shellfish",       group: "allergy",
      re: /\b(shell ?fish|shrimps?|prawns?|crabs?|lobsters?|crustaceans?|scallops?|oysters?)\b/i },
    { key: "egg",       label: "Egg",             group: "allergy",
      re: /\beggs?\b/i },
    { key: "soy",       label: "Soy",             group: "allergy",
      re: /\b(soy|soya|soybeans?)\b/i },
    { key: "fish",      label: "Fish",            group: "allergy",
      re: /\b(fish|salmon|tuna|anchov(y|ies))\b/i },

    // ---- preferences ----
    { key: "vegan",      label: "Vegan",      group: "pref", re: /\bvegan\b/i },
    { key: "vegetarian", label: "Vegetarian", group: "pref", re: /\bveg(etarian|gie)?\b/i },
    { key: "halal",      label: "Halal",      group: "pref", re: /\bhalal\b/i },
    { key: "kosher",     label: "Kosher",     group: "pref", re: /\bkosher\b/i },
    { key: "pork",       label: "No pork",    group: "pref", re: /\b(pork|bacon|ham)\b/i },
    { key: "beef",       label: "No beef",    group: "pref", re: /\b(beef|steak)\b/i }
  ];

  const GROUPS = [
    { group: "allergy", label: "Allergies & intolerances" },
    { group: "pref",    label: "Preferences" }
  ];

  // "None", "n/a", "no known allergies" -- people answering that
  // they have NO restriction. Counting these would inflate the
  // Uncategorized row, which is the one number that has to stay
  // trustworthy, since it is where a missed restriction surfaces.
  //
  // Each pattern is anchored to the WHOLE string on purpose:
  // "no nut allergies" means none, but "no nuts, allergic to
  // shellfish" is two real restrictions and must survive.
  const NONE = [
    /^[\s\-–—.,/]*$/,
    /^(no|none|n\/?a|nil|nope|nothing|never|no\s*thanks?)\.?$/i,
    /^none\s+(that\s+i\s+know\s+of|at\s+all|whatsoever|really)\.?$/i,
    /^(i\s+)?(have\s+|has\s+)?(no|none|not\s+any)\s+(known\s+)?(\w+\s+)?(\w+\s+)?(allergies|allergy|restrictions?|preferences?|requirements?|issues?)\.?$/i,
    /^(all\s+good|anything|everything|any|all)\.?$/i
  ];

  const isNone = (note) => {
    const t = String(note == null ? "" : note).trim();
    return NONE.some((re) => re.test(t));
  };

  /** categorize("Gluten-free, no shellfish") -> ["gluten","shellfish"] */
  function categorize(note) {
    if (isNone(note)) return [];
    const t = String(note);
    return RULES.filter((r) => r.re.test(t)).map((r) => r.key);
  }

  /**
   * people: [{ name, note, checkedIn }]
   * -> { total, none, groups:[{label, rows:[{key,label,count,people}]}],
   *      uncategorized:[{name,note}], all:[{name,note}] }
   */
  function summarize(people) {
    const rows = new Map(RULES.map((r) => [r.key, { ...r, count: 0, people: [] }]));
    const uncategorized = [];
    const all = [];
    let none = 0, total = 0;

    people.forEach((p) => {
      const note = (p.note || "").trim();
      if (!note) return;
      if (isNone(note)) { none++; return; }

      total++;
      all.push({ name: p.name, note });

      const keys = categorize(note);
      if (keys.length === 0) { uncategorized.push({ name: p.name, note }); return; }
      keys.forEach((k) => {
        const row = rows.get(k);
        row.count++;
        row.people.push({ name: p.name, note });
      });
    });

    const groups = GROUPS.map((g) => ({
      label: g.label,
      rows: [...rows.values()]
        .filter((r) => r.group === g.group && r.count > 0)
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    })).filter((g) => g.rows.length > 0);

    return { total, none, groups, uncategorized, all };
  }

  const api = { categorize, summarize, isNone, RULES, GROUPS };
  if (typeof window !== "undefined") window.Diet = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
