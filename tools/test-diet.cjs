// Load it exactly as the browser does: a script that assigns to
// window. No test-only export path, so what is tested here is
// literally what ships.
const fs = require("fs");
const src = fs.readFileSync("/Users/soni/Library/CloudStorage/OneDrive-UniversityofArkansas/Soni/aiag-checkin/assets/diet.js", "utf8");
const win = {};
new Function("window", src)(win);
const Diet = win.Diet;

const CASES = [
  // [input, expected keys, note]
  ["None",                         [], "plain none"],
  ["none.",                        [], "trailing period"],
  ["N/A",                          [], "n/a"],
  ["n/a",                          [], "lowercase n/a"],
  ["-",                            [], "dash"],
  ["  ",                           [], "whitespace"],
  ["no known allergies",           [], "no known allergies"],
  ["No allergies",                 [], "no allergies"],
  ["no dietary restrictions",      [], "no dietary restrictions"],
  ["I have no dietary restrictions",[], "full sentence none"],
  ["no nut allergies",             [], "NEGATED nut -- must not count"],
  ["Nothing",                      [], "nothing"],

  ["Vegetarian",                   ["vegetarian"], "plain"],
  ["VEGAN",                        ["vegan"], "uppercase vegan"],
  ["  vegan  ",                    ["vegan"], "padded"],
  ["vegetarian",                   ["vegetarian"], "vegetarian not vegan"],
  ["Gluten-free, no shellfish",    ["gluten","shellfish"], "TWO categories"],
  ["peanut allergy",               ["nut"], "peanut"],
  ["Peanut & tree nut allergy",    ["nut"], "both nut phrasings, one bucket"],
  ["no nuts please",               ["nut"], "no nuts IS a restriction"],
  ["I love coconut",               [], "coconut must NOT match nut"],
  ["lactose intolerant",           ["dairy"], "lactose"],
  ["No pork",                      ["pork"], "pork"],
  ["no beef or pork",              ["pork","beef"], "two prefs"],
  ["Halal",                        ["halal"], "halal"],
  ["allergic to shrimp",           ["shellfish"], "shrimp"],
  ["fish allergy",                 ["fish"], "fish"],
  ["shellfish allergy",            ["shellfish"], "shellfish must NOT also be fish"],
  ["egg allergy",                  ["egg"], "egg"],
  ["soy",                          ["soy"], "soy"],
  ["low FODMAP",                   null, "UNCATEGORIZED"],
  ["allergic to nightshades",      null, "UNCATEGORIZED"],
  ["Vegetarian, gluten free",      ["gluten","vegetarian"], "mixed group"],
];

let pass = 0, fail = 0;
for (const [input, expected, label] of CASES) {
  const got = Diet.categorize(input).sort();
  let ok;
  if (expected === null) ok = got.length === 0 && !Diet.isNone(input);
  else ok = JSON.stringify(got) === JSON.stringify([...expected].sort());
  if (ok) { pass++; }
  else {
    fail++;
    console.log(`  FAIL  ${label}`);
    console.log(`        input:    ${JSON.stringify(input)}`);
    console.log(`        expected: ${expected === null ? "uncategorized (non-none, no match)" : JSON.stringify([...expected].sort())}`);
    console.log(`        got:      ${JSON.stringify(got)}  isNone=${Diet.isNone(input)}`);
  }
}
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
