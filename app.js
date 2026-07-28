import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { h, render } from "https://esm.sh/preact@10.23.2";
import {
  useState, useEffect, useMemo, useCallback, useRef,
} from "https://esm.sh/preact@10.23.2/hooks";
import htm from "https://esm.sh/htm@3.1.1";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const html = htm.bind(h);
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ============================================================
   Units
   ============================================================ */

const MASS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOL = {
  ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868,
  cup: 236.588, floz: 29.5735, pint: 473.176, quart: 946.353,
};
const COUNTISH = ["count", "ea", "each", "whole", "clove", "slice"];
const UNITS = ["count", "clove", "slice", "g", "kg", "oz", "lb",
               "ml", "l", "tsp", "tbsp", "cup", "floz"];

function canonicalFor(unit) {
  const u = (unit || "").toLowerCase();
  if (u in MASS) return "g";
  if (u in VOL) return "ml";
  return "count";
}

const FRACTIONS = [[0, ""], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"],
                   [2 / 3, "⅔"], [0.75, "¾"], [1, ""]];

function frac(n) {
  const whole = Math.floor(n);
  const rem = n - whole;
  let best = FRACTIONS[0], bd = Infinity;
  for (const f of FRACTIONS) {
    const d = Math.abs(rem - f[0]);
    if (d < bd) { bd = d; best = f; }
  }
  const w = whole + (best[0] === 1 ? 1 : 0);
  const f = best[1];
  if (!w && !f) return n > 0 ? "¼" : "0";
  return (w ? String(w) : "") + (f ? (w ? " " : "") + f : "");
}

function trim(n) {
  return String(Math.round(n * 100) / 100);
}

/**
 * How to present a canonical quantity. Everything is stored in grams,
 * millilitres, or counts; these decide what a person reads on the list.
 */
const SYSTEMS = [
  { key: "us-cups", label: "Cups, ounces & pounds" },
  { key: "us-oz", label: "Ounces & fluid ounces" },
  { key: "metric", label: "Grams & millilitres" },
  { key: "metric-scaled", label: "Grams, kilos & litres" },
];

// Older builds stored just "us" or "metric".
function normaliseSystem(key) {
  if (key === "us") return "us-cups";
  if (key === "metric") return "metric-scaled";
  return SYSTEMS.some((s) => s.key === key) ? key : "us-cups";
}

function showQty(qty, canonUnit, system) {
  const q = Number(qty);
  if (canonUnit === "count") return { n: String(Math.ceil(q - 0.001)), u: "" };

  const isMass = canonUnit === "g";

  switch (system) {
    case "us-oz":
      if (isMass) return { n: frac(q / MASS.oz), u: "oz" };
      // Below half a fluid ounce, spoons read better than fractions of one.
      if (q < VOL.floz / 2) return { n: frac(q / VOL.tsp), u: "tsp" };
      return { n: frac(q / VOL.floz), u: "fl oz" };

    case "metric":
      return { n: String(Math.round(q)), u: isMass ? "g" : "ml" };

    case "metric-scaled":
      if (q >= 1000) {
        return { n: trim(q / 1000), u: isMass ? "kg" : "L" };
      }
      return { n: String(Math.round(q)), u: isMass ? "g" : "ml" };

    case "us-cups":
    default:
      if (isMass) {
        const oz = q / MASS.oz;
        if (oz >= 16) return { n: trim(Math.round((oz / 16) * 20) / 20), u: "lb" };
        if (oz >= 1) return { n: frac(oz), u: "oz" };
        return { n: String(Math.round(q)), u: "g" };
      }
      if (q >= VOL.cup * 0.75) return { n: frac(q / VOL.cup), u: "cup" };
      if (q >= VOL.tbsp) return { n: frac(q / VOL.tbsp), u: "tbsp" };
      return { n: frac(q / VOL.tsp), u: "tsp" };
  }
}

/**
 * Fraction glyphs like ⅔ render tiny next to full-size digits. Wrap them
 * so they can be scaled back up to something readable in a shop aisle.
 */
const FRACTION_GLYPH = /([\u00bc-\u00be\u2150-\u215e])/;

/** Show a recipe's own amount, scaled, in the unit it was written in. */
function showAmount(qty, unit) {
  const q = Number(qty);
  const whole = Math.abs(q - Math.round(q)) < 0.02;
  return {
    n: whole ? String(Math.round(q)) : (q < 10 ? frac(q) : trim(q)),
    u: unit === "count" ? "" : unit,
  };
}

function qtyNodes(text) {
  return String(text)
    .split(FRACTION_GLYPH)
    .filter(Boolean)
    .map((part) => (FRACTION_GLYPH.test(part)
      ? html`<em class="fr">${part}</em>`
      : part));
}

/* ============================================================
   Photos
   ============================================================ */

const BUCKET = "recipe-photos";
const MAX_EDGE = 1200;

function photoUrl(path) {
  if (!path) return null;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Whether a recipe's photo should be shown to this viewer. */
function photoVisible(recipe, own) {
  if (!recipe.image_path) return false;
  return own || recipe.share_photo;
}

/**
 * Scale down and re-encode as JPEG before upload. A phone photo is
 * 3–5 MB; a recipe card needs about 150 KB. This also sidesteps HEIC
 * on iPhones, where the file picker hands over a JPEG anyway.
 */
async function shrink(file) {
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    const url = URL.createObjectURL(file);
    el.onload = () => { URL.revokeObjectURL(url); resolve(el); };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(
        "This browser can't read that image file. If it came off an iPhone " +
        "as HEIC, save it as JPEG first, or upload from the phone instead."));
    };
    el.src = url;
  });

  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);

  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
  if (!blob) throw new Error("Could not process that image.");
  return blob;
}

/* ============================================================
   Reading ingredient lines the way people write them

   "1 1/2 cups all-purpose flour, sifted"
     -> 1.5 · cup · all-purpose flour · (sifted)

   Everything parsed is shown in the normal editor fields before it's
   saved, so a wrong guess is visible and fixable rather than silent.
   ============================================================ */

const VULGAR = {
  "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4",
  "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5", "⅙": "1/6",
  "⅚": "5/6", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};

const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  dozen: 12, half: 0.5, quarter: 0.25,
};

// Only real measures live here. Words like "large" or "can" stay in the
// ingredient name, because "large egg" and "can diced tomatoes" are what
// you actually shop for.
const UNIT_WORDS = {
  tsp: ["tsp", "tsps", "teaspoon", "teaspoons"],
  tbsp: ["tbsp", "tbsps", "tbs", "tablespoon", "tablespoons"],
  cup: ["cup", "cups"],
  floz: ["floz", "fl oz", "fluid ounce", "fluid ounces"],
  ml: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"],
  l: ["l", "liter", "liters", "litre", "litres"],
  pint: ["pint", "pints", "pt"],
  quart: ["quart", "quarts", "qt"],
  g: ["g", "gr", "gram", "grams"],
  kg: ["kg", "kilo", "kilos", "kilogram", "kilograms"],
  oz: ["oz", "ounce", "ounces"],
  lb: ["lb", "lbs", "pound", "pounds"],
  clove: ["clove", "cloves"],
  slice: ["slice", "slices"],
};

const UNIT_LOOKUP = (() => {
  const m = new Map();
  for (const [unit, words] of Object.entries(UNIT_WORDS)) {
    for (const w of words) m.set(w, unit);
  }
  return m;
})();

// Prep instructions, not part of what you buy. Moved to the note.
const PREP_WORDS = [
  "fresh", "freshly", "ripe", "chopped", "diced", "minced", "sliced",
  "shredded", "grated", "softened", "melted", "cooked", "raw", "peeled",
  "seeded", "rinsed", "drained", "packed", "sifted", "beaten", "warm",
  "cold", "room temperature", "unsalted", "salted", "extra virgin",
  "boneless", "skinless", "finely", "roughly", "thinly",
];

// A bare number with no unit is only believable as a count up to about
// here. Eggs come by the dozen, 18, or 30, so the ceiling has to clear
// those. Above it, a leading number is far more likely part of a product
// name — 90 second rice, 100% whole wheat, 1000 island dressing.
const MAX_BARE_COUNT = 48;

function unvulgar(text) {
  let out = text;
  for (const [glyph, plain] of Object.entries(VULGAR)) {
    out = out.split(glyph).join(" " + plain + " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

function readNumber(text) {
  const s = text.trim();

  // 1 1/2  ·  1-1/2  ·  1 and 1/2
  let m = s.match(/^(\d+)\s*(?:[-–]\s*|\s+and\s+|\s+)(\d+)\s*\/\s*(\d+)\b/);
  if (m) return { qty: +m[1] + +m[2] / +m[3], rest: s.slice(m[0].length) };

  // 2 to 3  or  2-3  (take the smaller; you can always buy more)
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*\d+(?:\.\d+)?(?!\s*\/)\b/);
  if (m) return { qty: +m[1], rest: s.slice(m[0].length) };

  // 3/4
  m = s.match(/^(\d+)\s*\/\s*(\d+)\b/);
  if (m) return { qty: +m[1] / +m[2], rest: s.slice(m[0].length) };

  // 1.5  or  2
  m = s.match(/^(\d*\.\d+|\d+)\b/);
  if (m) return { qty: +m[1], rest: s.slice(m[0].length) };

  // "two", "a", "half"
  m = s.match(/^([a-z]+)\b/i);
  if (m && WORD_NUMBERS[m[1].toLowerCase()] !== undefined) {
    return { qty: WORD_NUMBERS[m[1].toLowerCase()], rest: s.slice(m[0].length) };
  }

  return { qty: null, rest: s };
}

function readUnit(text) {
  const s = text.trim().replace(/^\.\s*/, "");

  const two = s.match(/^([a-z]+\s+[a-z]+)\b\.?/i);
  if (two && UNIT_LOOKUP.has(two[1].toLowerCase())) {
    return { unit: UNIT_LOOKUP.get(two[1].toLowerCase()), rest: s.slice(two[0].length) };
  }

  const one = s.match(/^([a-z]+)\b\.?/i);
  if (one && UNIT_LOOKUP.has(one[1].toLowerCase())) {
    return { unit: UNIT_LOOKUP.get(one[1].toLowerCase()), rest: s.slice(one[0].length) };
  }

  return { unit: null, rest: s };
}

function singular(word) {
  const w = word.toLowerCase();
  if (/(ss|us|is|ies)$/.test(w) && !/ies$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(ch|sh|x|z|s)es$/.test(w)) return w.slice(0, -2);
  if (/oes$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}

function singularPhrase(phrase) {
  const parts = phrase.trim().split(/\s+/);
  if (!parts.length) return phrase;
  parts[parts.length - 1] = singular(parts[parts.length - 1]);
  return parts.join(" ");
}

/**
 * Look for an ingredient that already exists. Two grades of result:
 *
 *   exact  — same word, or just a plural ("eggs" → "large egg" never
 *            qualifies; "bananas" → "banana" does). Safe to adopt silently.
 *   loose  — only matches after dropping words like "shredded". Offered as
 *            a suggestion, never applied, because "shredded carrot" is a
 *            different thing to buy than "carrot".
 */
function matchCatalog(name, catalog) {
  if (!name || !catalog?.length) return null;
  const raw = name.trim().toLowerCase();

  const findIn = (needle) =>
    catalog.find((c) => c.name.toLowerCase() === needle);

  const exact = findIn(raw) || findIn(singularPhrase(raw));
  if (exact) return { hit: exact, exact: true, dropped: [] };

  let stripped = raw;
  const dropped = [];
  for (const word of PREP_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "g");
    if (re.test(stripped)) {
      dropped.push(word);
      stripped = stripped.replace(re, " ");
    }
  }
  stripped = stripped.replace(/\s+/g, " ").trim();

  const loose = stripped && stripped !== raw
    ? (findIn(stripped) || findIn(singularPhrase(stripped)))
    : null;

  return { hit: loose || null, exact: false, dropped, cleaned: stripped };
}

/** Read a quantity box that may hold "1 1/2", "½", ".75", or "2". */
function toNumber(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (!s) return null;
  const { qty } = readNumber(unvulgar(s));
  return qty;
}

/**
 * Parse one written line into editor fields. Returns null if unusable.
 *
 * `cautious` is for single-field boxes where the text is probably just a
 * name. Plenty of groceries open with a number — "90 second rice",
 * "2% milk", "7 grain bread" — and mangling those is far more annoying
 * than failing to split out a quantity that's one box to the right
 * anyway. Bulk paste stays greedy, because recipe lines really do lead
 * with amounts.
 */
function parseLine(line, catalog, opts = {}) {
  if (!line || !line.trim()) return null;
  const cautious = !!opts.cautious;

  let text = unvulgar(line)
    .replace(/^[-–—*•]\s+/, "")
    .trim();

  const notes = [];

  // Trailing or inline parenthetical is a note, not a name
  text = text.replace(/\(([^)]*)\)/g, (_, inner) => {
    notes.push(inner.trim());
    return " ";
  }).replace(/\s+/g, " ").trim();

  // Anything after the first comma is preparation
  const comma = text.indexOf(",");
  let tail = "";
  if (comma > -1) {
    tail = text.slice(comma + 1).trim();
    text = text.slice(0, comma).trim();
  }

  // If the whole thing names something already on the shelf, it's a name.
  // This is what rescues "90 second rice bag" once it exists.
  const whole = matchCatalog(text, catalog);
  if (whole?.exact) {
    if (tail) notes.push(tail);
    return {
      qty: 1,
      unit: whole.hit.canonical_unit || "count",
      name: whole.hit.name,
      note: notes.filter(Boolean).join(", "),
      matched: whole.hit,
      suggest: null,
      guessedQty: true,
    };
  }

  const num = readNumber(text);
  const un = readUnit(num.rest);

  let takeNumber = num.qty !== null;

  // "2% milk" — a percent sign is never a measurement here
  if (takeNumber && /^\s*%/.test(num.rest)) takeNumber = false;

  // In cautious mode a bare number — one with no unit after it — only
  // counts when it's a plausible kitchen count AND what's left names
  // something we already know.
  //
  // The ceiling matters. Without it the rule feeds itself: parse
  // "90 second rice" wrongly once, an ingredient called "second rice"
  // gets created, and from then on that junk entry is the very thing
  // that makes the same wrong parse look correct.
  if (takeNumber && cautious && !un.unit) {
    const rest = num.rest.replace(/^\s*(of)\s+/i, "").trim();
    const known = rest ? matchCatalog(rest, catalog) : null;
    if (!known?.exact || num.qty > MAX_BARE_COUNT) takeNumber = false;
  }

  let rest = takeNumber ? un.rest : text;
  rest = rest.replace(/^\s*(of|de)\s+/i, "").trim();
  if (tail) notes.push(tail);

  if (/\bto taste\b/i.test(rest)) {
    notes.push("to taste");
    rest = rest.replace(/\bto taste\b/i, "").trim();
  }

  rest = rest.replace(/[.;]+$/, "").trim();
  if (!rest) return null;

  const match = matchCatalog(rest, catalog);

  // "2 cloves garlic" should find the existing "garlic clove"
  let unit = takeNumber ? un.unit : null;
  let hit = match?.exact ? match.hit : null;
  let suggest = match?.exact ? null : match?.hit || null;

  if (!hit && (unit === "clove" || unit === "slice")) {
    const alt = matchCatalog(`${rest} ${unit}`, catalog);
    if (alt?.exact) { hit = alt.hit; unit = "count"; suggest = null; }
  }

  // Only an exact match rewrites the name. Anything looser is a suggestion,
  // because dropping a word like "shredded" changes what you buy.
  const name = hit ? hit.name : singularPhrase(rest);

  if (!unit) unit = "count";

  return {
    qty: takeNumber ? num.qty : 1,
    unit,
    name,
    note: notes.filter(Boolean).join(", "),
    matched: hit,
    suggest,
    guessedQty: !takeNumber,
  };
}

/* ============================================================
   Dates
   ============================================================ */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SLOTS = ["breakfast", "lunch", "dinner", "snack"];

function iso(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fromIso(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return addDays(x, -x.getDay());
}
function spanLabel(start) {
  const end = addDays(start, 6);
  const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${f(start)} – ${f(end)}`;
}

/** Full weeks covering a month, so the grid never has a ragged edge. */
function monthCells(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const end = addDays(last, 6 - last.getDay());
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    days.push({ date: d, inMonth: d.getMonth() === cursor.getMonth() });
  }
  return days;
}

/* ============================================================
   Grocery aggregation
   ============================================================ */

function buildList(needs, saved, pantry) {
  const byIngredient = new Map();
  const unconverted = new Map();

  for (const n of needs) {
    if (n.canonical_qty === null || n.canonical_qty === undefined) {
      const key = `${n.ingredient_id}|${n.scaled_unit}`;
      if (!unconverted.has(key)) {
        unconverted.set(key, {
          key, ingredient_id: n.ingredient_id, name: n.ingredient_name,
          aisle: n.aisle, unit: n.scaled_unit, qty: 0,
          sources: new Set(), literal: true,
        });
      }
      const row = unconverted.get(key);
      row.qty += Number(n.scaled_qty);
      row.sources.add(n.recipe_title);
      continue;
    }

    const key = n.ingredient_id;
    if (!byIngredient.has(key)) {
      byIngredient.set(key, {
        key, ingredient_id: key, name: n.ingredient_name, aisle: n.aisle,
        unit: n.canonical_unit, qty: 0, sources: new Set(), literal: false,
      });
    }
    const row = byIngredient.get(key);
    row.qty += Number(n.canonical_qty);
    row.sources.add(n.recipe_title);
  }

  const checked = new Map();
  const manual = [];
  for (const s of saved) {
    if (s.is_manual || !s.ingredient_id) manual.push(s);
    else checked.set(s.ingredient_id, s.checked);
  }

  const generated = [...byIngredient.values(), ...unconverted.values()].map((r) => ({
    ...r,
    sources: [...r.sources],
    checked: !!checked.get(r.ingredient_id),
    have: pantry?.get(r.ingredient_id) || null,
  }));

  const added = manual.map((m) => ({
    key: `manual:${m.id}`,
    id: m.id,
    ingredient_id: null,
    name: m.custom_name,
    aisle: "Added by hand",
    unit: m.unit || "",
    qty: m.quantity,
    sources: [],
    checked: m.checked,
    manual: true,
    have: null,
  }));

  const all = [...generated, ...added];
  const aisles = new Map();
  for (const row of all) {
    if (!aisles.has(row.aisle)) aisles.set(row.aisle, []);
    aisles.get(row.aisle).push(row);
  }
  // Things already in the pantry sink to the bottom of their aisle — still
  // visible, just out of the way of what actually needs picking up.
  for (const rows of aisles.values()) {
    rows.sort((a, b) => {
      const ah = a.have?.status === "plenty" ? 1 : 0;
      const bh = b.have?.status === "plenty" ? 1 : 0;
      if (ah !== bh) return ah - bh;
      return a.name.localeCompare(b.name);
    });
  }
  return aisles;
}

/* ============================================================
   Small shared components
   ============================================================ */

function Sheet({ title, onClose, wide, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  return html`
    <div class="veil" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class=${"sheet" + (wide ? " wide" : "")} role="dialog" aria-modal="true"
        tabindex="-1" ref=${ref}>
        <header>
          <h3>${title}</h3>
          <button class="x" onClick=${onClose} aria-label="Close">×</button>
        </header>
        ${children}
      </div>
    </div>`;
}

function Problem({ text }) {
  if (!text) return null;
  return html`<div class="notice bad">${text}</div>`;
}

/* ============================================================
   Sign in
   ============================================================ */

function Gate() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const here = window.location.href.split("#")[0];

  const google = async () => {
    setErr("");
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: here },
    });
    if (error) setErr(error.message);
  };

  const link = async () => {
    if (!email.trim()) return;
    setBusy(true); setErr("");
    const { error } = await sb.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: here },
    });
    setBusy(false);
    if (error) setErr(error.message);
    else setSent(true);
  };

  return html`
    <div class="gate">
      <div class="mark">Simple<em>Meals</em></div>
      <p class="tag">Plan the week. The shopping list writes itself.</p>
      <div class="card">
        <button class="gbtn" onClick=${google}>Continue with Google</button>
        <div class="or">or</div>
        ${sent
          ? html`<div class="notice">Check ${email} for a sign-in link. It
              opens straight back here.</div>`
          : html`
            <label class="field">
              <span>Email</span>
              <input type="email" value=${email} placeholder="you@example.com"
                onInput=${(e) => setEmail(e.target.value)}
                onKeyDown=${(e) => e.key === "Enter" && link()} />
            </label>
            <button class="btn" style="width:100%" disabled=${busy} onClick=${link}>
              ${busy ? "Sending…" : "Email me a link"}
            </button>`}
        <${Problem} text=${err} />
      </div>
    </div>`;
}

/* ============================================================
   First run: create or join a household
   ============================================================ */

function Onboard({ onReady }) {
  const [mode, setMode] = useState("create");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const go = async () => {
    setBusy(true); setErr("");
    const call = mode === "create"
      ? sb.rpc("create_household", { p_name: name })
      : sb.rpc("join_household", { p_code: code });
    const { data, error } = await call;
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onReady(data);
  };

  return html`
    <div class="gate">
      <div class="mark">Simple<em>Meals</em></div>
      <p class="tag">One more step. A household is the group that shares
        recipes, a calendar, and a list.</p>
      <div class="card">
        <div class="row" style="margin-bottom:16px">
          <button class=${"btn sm " + (mode === "create" ? "" : "ghost")}
            onClick=${() => setMode("create")}>Start one</button>
          <button class=${"btn sm " + (mode === "join" ? "" : "ghost")}
            onClick=${() => setMode("join")}>Join one</button>
        </div>
        ${mode === "create"
          ? html`<label class="field">
              <span>Household name</span>
              <input type="text" value=${name} placeholder="e.g. Home"
                onInput=${(e) => setName(e.target.value)} />
            </label>`
          : html`<label class="field">
              <span>Invite code</span>
              <input type="text" value=${code} placeholder="8 characters"
                onInput=${(e) => setCode(e.target.value)} />
            </label>`}
        <button class="btn" style="width:100%" disabled=${busy} onClick=${go}>
          ${busy ? "Working…" : mode === "create" ? "Create household" : "Join household"}
        </button>
        <${Problem} text=${err} />
      </div>
    </div>`;
}

/**
 * Record a plain-English line in the household's activity log. Fire and
 * forget — a logging failure must never break the action it's attached
 * to, so errors are swallowed rather than surfaced.
 */
function logActivity(household, summary, recipeId = null) {
  sb.from("activity_log")
    .insert({ household_id: household.id, summary, recipe_id: recipeId })
    .then(({ error }) => { if (error) console.warn("activity log:", error.message); });
}

/* ============================================================
   Recent activity
   ============================================================ */

function ActivityPanel({ household, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let dead = false;
    sb.from("activity_log").select("*")
      .eq("household_id", household.id)
      .order("created_at", { ascending: false })
      .limit(60)
      .then(({ data, error }) => {
        if (dead) return;
        if (error) setErr(error.message);
        else setRows(data || []);
      });
    return () => { dead = true; };
  }, [household.id]);

  const when = (iso) => {
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  return html`
    <${Sheet} title="Recent activity" onClose=${onClose}>
      <${Problem} text=${err} />
      ${rows === null
        ? html`<p class="small muted">Loading…</p>`
        : !rows.length
          ? html`<p class="small muted">Nothing logged yet.</p>`
          : html`
            <div class="activity">
              ${rows.map((r) => html`
                <div class="activityrow" key=${r.id}>
                  <span class="activitywho">${r.actor_name || "Someone"}</span>
                  <span class="activitywhat">${r.summary}</span>
                  <span class="activitywhen num">${when(r.created_at)}</span>
                </div>`)}
            </div>`}
    <//>`;
}

/**
 * Find an ingredient by name, creating it if it's genuinely new. Shared by
 * the recipe editor and the per-meal adjuster.
 */
async function resolveIngredient(name, unit, catalog) {
  const clean = name.trim();
  const hit = catalog.find((c) => c.name.toLowerCase() === clean.toLowerCase());
  if (hit) return hit.id;

  const { data, error } = await sb.from("ingredients")
    .insert({
      name: clean.toLowerCase(),
      canonical_unit: canonicalFor(unit),
      aisle: "Other",
    })
    .select().single();

  if (!error) return data.id;

  // Someone else added it a moment ago; take theirs.
  const { data: again } = await sb.from("ingredients")
    .select("id").ilike("name", clean).limit(1);
  if (again?.length) return again[0].id;
  throw error;
}

/* ============================================================
   Reading a recipe while you cook it
   ============================================================ */

function RecipeViewer({ recipe, own, meal, household, catalog, pantry,
                       onClose, onEdit, onChanged }) {
  const [servings, setServings] = useState(meal?.servings || recipe.servings);
  const [stepsDone, setStepsDone] = useState(() => new Set());
  const [added, setAdded] = useState(() => new Set());

  const [tweaks, setTweaks] = useState(() => new Map());
  const [adjusting, setAdjusting] = useState(false);
  const [draft, setDraft] = useState(null);
  const [extra, setExtra] = useState("");
  const [saving, setSaving] = useState("");
  const [err, setErr] = useState("");

  // Keep the screen on — nobody wants to wake a phone with batter on
  // their hands. Unsupported browsers just skip it.
  useEffect(() => {
    let lock = null;
    let cancelled = false;
    (async () => {
      try {
        const l = await navigator.wakeLock?.request("screen");
        if (cancelled) l?.release(); else lock = l;
      } catch { /* denied, or not supported */ }
    })();
    return () => { cancelled = true; try { lock?.release(); } catch {} };
  }, []);

  const loadTweaks = useCallback(async () => {
    if (!meal) { setTweaks(new Map()); return; }
    const { data } = await sb.from("meal_tweaks").select("*").eq("meal_id", meal.id);
    setTweaks(new Map((data || []).map((t) => [t.ingredient_id, t])));
  }, [meal?.id]);

  useEffect(() => { loadTweaks(); }, [loadTweaks]);

  const scale = servings / recipe.servings;

  const base = (recipe.recipe_ingredients || [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);

  /** What this meal actually calls for, once tweaks are applied. */
  const effective = useMemo(() => {
    const out = [];
    for (const l of base) {
      const t = tweaks.get(l.ingredient_id);
      if (t?.removed) continue;
      out.push(t?.quantity != null
        ? { ...l, quantity: t.quantity, unit: t.unit || l.unit, fixed: true }
        : l);
    }
    for (const t of tweaks.values()) {
      if (t.removed || t.quantity == null) continue;
      if (base.some((l) => l.ingredient_id === t.ingredient_id)) continue;
      out.push({
        id: `extra:${t.ingredient_id}`,
        ingredient_id: t.ingredient_id,
        quantity: t.quantity,
        unit: t.unit || "count",
        note: null,
        ingredients: catalog.find((c) => c.id === t.ingredient_id),
        fixed: true,
        isExtra: true,
      });
    }
    return out;
  }, [base, tweaks, catalog]);

  const steps = (recipe.instructions || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const toggle = (set, key, apply) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    apply(next);
  };

  const allDone = steps.length > 0 && stepsDone.size === steps.length;

  /* ---- adjusting ---- */

  const beginAdjust = () => {
    setDraft(effective.map((l) => ({
      ingredient_id: l.ingredient_id,
      name: l.ingredients?.name || "—",
      quantity: String(Number((Number(l.quantity) * (l.fixed ? 1 : scale)).toFixed(3))),
      unit: l.unit,
      removed: false,
      fromRecipe: !l.isExtra,
    })));
    setErr("");
    setAdjusting(true);
  };

  const setDraftRow = (i, patch) =>
    setDraft((d) => d.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const addExtra = async () => {
    const text = extra.trim();
    if (!text) return;
    const parsed = parseLine(text, catalog) || { qty: 1, unit: "count", name: text };
    setDraft((d) => [...d, {
      ingredient_id: null,
      name: parsed.name,
      quantity: String(parsed.qty),
      unit: parsed.unit,
      removed: false,
      fromRecipe: false,
    }]);
    setExtra("");
  };

  const saveForThisMeal = async () => {
    const bad = draft.filter((r) => !r.removed && !(toNumber(r.quantity) > 0));
    if (bad.length) {
      setErr(`Need a quantity for: ${bad.map((r) => r.name).join(", ")}`);
      return;
    }
    setSaving("meal"); setErr("");
    try {
      const rows = [];
      for (const r of draft) {
        const id = r.ingredient_id
          || await resolveIngredient(r.name, r.unit, catalog);
        rows.push({
          meal_id: meal.id,
          ingredient_id: id,
          quantity: r.removed ? null : toNumber(r.quantity),
          unit: r.removed ? null : r.unit,
          removed: r.removed,
        });
      }
      await sb.from("meal_tweaks").delete().eq("meal_id", meal.id);
      if (rows.length) {
        const { error } = await sb.from("meal_tweaks").insert(rows);
        if (error) throw error;
      }
      await loadTweaks();
      logActivity(household, `adjusted ${recipe.title} for this meal`, recipe.id);
      setAdjusting(false);
      onChanged?.();
    } catch (e) {
      setErr(e.message || "Could not save the adjustment.");
    } finally {
      setSaving("");
    }
  };

  const saveAsNewRecipe = async () => {
    const keep = draft.filter((r) => !r.removed);
    if (!keep.length) { setErr("A recipe needs at least one ingredient."); return; }
    const bad = keep.filter((r) => !(toNumber(r.quantity) > 0));
    if (bad.length) {
      setErr(`Need a quantity for: ${bad.map((r) => r.name).join(", ")}`);
      return;
    }
    const title = prompt("Name for the new recipe", `${recipe.title} (our way)`);
    if (!title?.trim()) return;

    setSaving("recipe"); setErr("");
    try {
      const { data: made, error } = await sb.from("recipes").insert({
        household_id: household.id,
        title: title.trim(),
        servings: Number(servings) || recipe.servings,
        instructions: recipe.instructions,
        is_public: false,
        share_photo: true,
        forked_from: recipe.id,
      }).select().single();
      if (error) throw error;

      const lines = [];
      for (let i = 0; i < keep.length; i++) {
        const r = keep[i];
        lines.push({
          recipe_id: made.id,
          ingredient_id: r.ingredient_id
            || await resolveIngredient(r.name, r.unit, catalog),
          quantity: toNumber(r.quantity),
          unit: r.unit,
          sort_order: i,
        });
      }
      const { error: ie } = await sb.from("recipe_ingredients").insert(lines);
      if (ie) throw ie;

      // Point this calendar entry at the new recipe and drop the tweaks,
      // since they're baked into the recipe now.
      if (meal) {
        await sb.from("meal_tweaks").delete().eq("meal_id", meal.id);
        await sb.from("meal_plan")
          .update({ recipe_id: made.id, servings: Number(servings) || recipe.servings })
          .eq("id", meal.id);
      }
      onChanged?.();
      logActivity(household, `created ${made.title} from ${recipe.title}`, made.id);
      onClose();
    } catch (e) {
      setErr(e.message || "Could not create the recipe.");
    } finally {
      setSaving("");
    }
  };

  const tweakCount = [...tweaks.values()].filter((t) => t.removed || t.quantity != null).length;

  /**
   * Knock everything this recipe uses down one level. One button beats
   * per-ingredient bookkeeping, which nobody does twice.
   */
  const [cooked, setCooked] = useState(false);
  const markCooked = async () => {
    setSaving("cooked");
    try {
      const rows = [];
      for (const l of effective) {
        if (!l.ingredient_id) continue;
        const current = pantry?.get(l.ingredient_id);
        if (!current) continue;
        const next = current.status === "plenty" ? "low"
          : current.status === "low" ? "out" : "out";
        rows.push({
          household_id: household.id,
          ingredient_id: l.ingredient_id,
          status: next,
          quantity: current.quantity,
          unit: current.unit,
          updated_at: new Date().toISOString(),
        });
      }
      if (rows.length) {
        await sb.from("pantry_items")
          .upsert(rows, { onConflict: "household_id,ingredient_id" });
      }
      setCooked(true);
      onChanged?.();
    } catch (e) {
      setErr(e.message || "Could not update the pantry.");
    } finally {
      setSaving("");
    }
  };

  const inPantry = effective.filter((l) => pantry?.has(l.ingredient_id)).length;

  return html`
    <${Sheet} title=${recipe.title} onClose=${onClose} wide=${true}>
      <div class="cookhead">
        <label class="row" style="gap:8px">
          <span class="sign muted" style="font-size:12px">Making for</span>
          <input class="servebox" type="number" min="1" value=${servings}
            onInput=${(e) => setServings(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        ${scale !== 1 && html`
          <span class="scaled num">×${trim(scale)} from ${recipe.servings}</span>`}
        ${meal && tweakCount > 0 && !adjusting && html`
          <span class="pill pub">Adjusted for this meal</span>`}
        <span class="spacer"></span>
        ${meal && !adjusting && html`
          <button class="btn ghost sm" onClick=${beginAdjust}>Adjust this meal</button>`}
        ${own && !adjusting && html`
          <button class="btn ghost sm" onClick=${onEdit}>Edit recipe</button>`}
      </div>

      ${recipe.image_path && (own || recipe.share_photo) && !adjusting && html`
        <img class="shot cookshot" src=${photoUrl(recipe.image_path)} alt="" />`}

      ${adjusting
        ? html`
          <div class="adjust">
            <p class="small muted" style="margin:0 0 12px">
              Change amounts, drop what you're skipping, or add something.
              Then keep it just for this meal, or turn it into a recipe of
              its own.
            </p>

            ${draft.map((r, i) => html`
              <div class=${"adjrow" + (r.removed ? " gone" : "")} key=${i}>
                <span class="adjname">
                  ${r.name}
                  ${!r.fromRecipe && html`<em class="prep">added</em>`}
                </span>
                <input type="text" inputmode="text" value=${r.quantity}
                  disabled=${r.removed}
                  onInput=${(e) => setDraftRow(i, { quantity: e.target.value })} />
                <select value=${r.unit} disabled=${r.removed}
                  onChange=${(e) => setDraftRow(i, { unit: e.target.value })}>
                  ${UNITS.map((u) => html`<option value=${u}>${u}</option>`)}
                </select>
                <button class="btn quiet"
                  onClick=${() => r.fromRecipe
                    ? setDraftRow(i, { removed: !r.removed })
                    : setDraft((d) => d.filter((_, j) => j !== i))}>
                  ${r.fromRecipe ? (r.removed ? "put back" : "skip") : "×"}
                </button>
              </div>`)}

            <div class="row" style="margin-top:14px">
              <input type="text" value=${extra}
                placeholder="Add something — “2 avocados”"
                onInput=${(e) => setExtra(e.target.value)}
                onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); addExtra(); } }} />
              <button class="btn ghost sm" onClick=${addExtra}>Add</button>
            </div>

            <${Problem} text=${err} />

            <div class="row wrap" style="margin-top:18px;gap:10px">
              <button class="btn" disabled=${!!saving} onClick=${saveForThisMeal}>
                ${saving === "meal" ? "Saving…" : "Keep for this meal only"}
              </button>
              <button class="btn ghost" disabled=${!!saving} onClick=${saveAsNewRecipe}>
                ${saving === "recipe" ? "Creating…" : "Save as a new recipe"}
              </button>
              <button class="btn quiet" onClick=${() => setAdjusting(false)}>Cancel</button>
            </div>
            <p class="small muted" style="margin-top:10px">
              “This meal only” leaves ${recipe.title} untouched for next time.
              “New recipe” copies it with these changes and points this day at
              the copy.
            </p>
          </div>`
        : html`
      <div class="cook">
        <div class="cookcol">
          <div class="aisle"><span class="name">Ingredients</span>
            <span class="count num">${effective.length}</span></div>
          <div class="inglist">
            ${effective.map((l) => {
              const a = showAmount(Number(l.quantity) * (l.fixed ? 1 : scale), l.unit);
              const got = added.has(l.id);
              const stock = pantry?.get(l.ingredient_id)?.status;
              return html`
                <label class=${"cookline" + (got ? " done" : "")} key=${l.id}>
                  <input type="checkbox" class="tick" checked=${got}
                    onChange=${() => toggle(added, l.id, setAdded)} />
                  <span class="amt num">
                    <b>${qtyNodes(a.n)}</b>${a.u && html`<i>${a.u}</i>`}
                  </span>
                  <span class="ingname">
                    ${l.ingredients?.name || "—"}
                    ${stock === "low" && html`<em class="prep low">running low</em>`}
                    ${stock === "out" && html`<em class="prep out">out</em>`}
                    ${!stock && html`<em class="prep out">not in the pantry</em>`}
                    ${l.fixed && html`<em class="prep">set for this meal</em>`}
                    ${l.note && html`<em class="prep">${l.note}</em>`}
                  </span>
                </label>`;
            })}
            ${!effective.length && html`<p class="muted small">No ingredients listed.</p>`}
            ${inPantry > 0 && html`
              <div class="row" style="margin-top:14px">
                ${cooked
                  ? html`<span class="pill pub">Pantry updated</span>`
                  : html`
                    <button class="btn ghost sm" disabled=${!!saving}
                      onClick=${markCooked}>
                      ${saving === "cooked" ? "Updating…" : "We made this"}
                    </button>`}
                <span class="small muted">
                  ${cooked
                    ? "Everything used here dropped a level."
                    : `Knocks ${inPantry} pantry ${inPantry === 1 ? "item" : "items"} down a level.`}
                </span>
              </div>`}
          </div>
        </div>

        <div class="cookcol">
          <div class="aisle"><span class="name">Method</span>
            ${steps.length > 0 && html`
              <span class="count num">${stepsDone.size}/${steps.length}</span>`}</div>

          ${!steps.length
            ? html`<p class="muted small" style="padding:14px 2px">
                No method written down yet. ${own ? "Add one with Edit recipe." : ""}</p>`
            : html`
              <ol class="steps">
                ${steps.map((text, i) => {
                  const done = stepsDone.has(i);
                  return html`
                    <li class=${"step" + (done ? " done" : "")} key=${i}>
                      <button class="stepno" aria-pressed=${String(done)}
                        onClick=${() => toggle(stepsDone, i, setStepsDone)}>
                        ${done ? "✓" : i + 1}
                      </button>
                      <span class="steptext"
                        onClick=${() => toggle(stepsDone, i, setStepsDone)}>${text}</span>
                    </li>`;
                })}
              </ol>
              <div class="row" style="margin-top:14px">
                ${allDone
                  ? html`<span class="pill pub">All steps done</span>`
                  : html`<span class="small muted">Tap a step to cross it off.</span>`}
                <span class="spacer"></span>
                ${stepsDone.size > 0 && html`
                  <button class="btn quiet" onClick=${() => setStepsDone(new Set())}>
                    Start over
                  </button>`}
              </div>`}
        </div>
      </div>`}
    <//>`;
}

/* ============================================================
   Recipe editor
   ============================================================ */

const blankIng = () => ({ name: "", quantity: "", unit: "count", note: "" });

function RecipeEditor({ household, recipe, catalog, onClose, onSaved }) {
  const [title, setTitle] = useState(recipe?.title || "");
  const [servings, setServings] = useState(recipe?.servings || 4);
  const [isPublic, setIsPublic] = useState(recipe?.is_public || false);
  const [instructions, setInstructions] = useState(recipe?.instructions || "");
  const [rows, setRows] = useState(() =>
    recipe?.recipe_ingredients?.length
      ? recipe.recipe_ingredients
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((r) => ({
            name: r.ingredients?.name || "",
            quantity: String(r.quantity),
            unit: r.unit,
            note: r.note || "",
          }))
      : [blankIng(), blankIng(), blankIng()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [photoFile, setPhotoFile] = useState(null);
  const [preview, setPreview] = useState(
    () => (recipe?.image_path ? photoUrl(recipe.image_path) : null));
  const [dropPhoto, setDropPhoto] = useState(false);
  const [sharePhoto, setSharePhoto] = useState(recipe?.share_photo ?? true);

  const setRow = (i, patch) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const choosePhoto = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setErr("");
    setPhotoFile(file);
    setDropPhoto(false);
    setPreview(URL.createObjectURL(file));
  };

  const clearPhoto = () => {
    setPhotoFile(null);
    setPreview(null);
    setDropPhoto(true);
  };

  const [bulk, setBulk] = useState("");
  const [showBulk, setShowBulk] = useState(false);

  /**
   * Typed "1 tsp sugar" into the name box? Split it into the fields.
   * Only fires when the text actually opens with a quantity — otherwise a
   * plain name like "shredded carrot" would get rewritten, and the words
   * someone chose are the words they meant.
   */
  const tidyRow = (i) => {
    const row = rows[i];
    if (!row.name.trim()) return;
    const parsed = parseLine(row.name, catalog, { cautious: true });
    if (!parsed || !parsed.name || parsed.guessedQty) return;
    setRow(i, {
      name: parsed.name,
      quantity: String(parsed.qty),
      unit: parsed.unit,
      note: [row.note, parsed.note].filter(Boolean).join(", "),
    });
  };

  const applyBulk = () => {
    const parsed = bulk
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => parseLine(l, catalog))
      .filter(Boolean);

    if (!parsed.length) { setErr("Nothing readable in there."); return; }

    setRows(parsed.map((p) => ({
      name: p.name,
      quantity: String(p.qty),
      unit: p.unit,
      note: p.note || "",
    })));
    setBulk("");
    setShowBulk(false);
    setErr("");
  };

  const resolve = (name, unit) => resolveIngredient(name, unit, catalog);

  const save = async () => {
    const named = rows.filter((r) => r.name.trim());
    if (!title.trim()) { setErr("Give the recipe a name."); return; }
    if (!named.length) { setErr("Add at least one ingredient."); return; }

    // Never drop a row quietly. If a quantity can't be read, say which.
    const unreadable = named.filter((r) => !(toNumber(r.quantity) > 0));
    if (unreadable.length) {
      setErr(`Need a quantity for: ${unreadable.map((r) => r.name.trim()).join(", ")}. ` +
             `Fractions are fine — "1 1/2" or "½" both work.`);
      return;
    }
    const usable = named;

    setBusy(true); setErr("");
    try {
      const payload = {
        household_id: household.id,
        title: title.trim(),
        servings: Number(servings) || 4,
        is_public: isPublic,
        share_photo: sharePhoto,
        instructions: instructions.trim() || null,
      };

      let recipeId = recipe?.id;
      const isNew = !recipeId;
      if (recipeId) {
        const { error } = await sb.from("recipes").update(payload).eq("id", recipeId);
        if (error) throw error;
        await sb.from("recipe_ingredients").delete().eq("recipe_id", recipeId);
      } else {
        const { data, error } = await sb.from("recipes")
          .insert(payload).select().single();
        if (error) throw error;
        recipeId = data.id;
      }
      logActivity(household, `${isNew ? "added" : "edited"} ${payload.title}`, recipeId);

      const lines = [];
      for (let i = 0; i < usable.length; i++) {
        const r = usable[i];
        lines.push({
          recipe_id: recipeId,
          ingredient_id: await resolve(r.name, r.unit),
          quantity: toNumber(r.quantity),
          unit: r.unit,
          note: r.note.trim() || null,
          sort_order: i,
        });
      }
      const { error: ie } = await sb.from("recipe_ingredients").insert(lines);
      if (ie) throw ie;

      // Photo last: it needs the recipe id, and a failure here shouldn't
      // cost the person their typing.
      const oldPath = recipe?.image_path || null;
      if (photoFile) {
        const blob = await shrink(photoFile);
        const tag = Math.random().toString(36).slice(2, 10);
        const path = `${household.id}/${recipeId}-${tag}.jpg`;
        const { error: ue } = await sb.storage.from(BUCKET)
          .upload(path, blob, { contentType: "image/jpeg", upsert: true });
        if (ue) throw ue;
        await sb.from("recipes").update({ image_path: path }).eq("id", recipeId);
        if (oldPath && oldPath !== path) {
          await sb.storage.from(BUCKET).remove([oldPath]);
        }
      } else if (dropPhoto && oldPath) {
        await sb.from("recipes").update({ image_path: null }).eq("id", recipeId);
        await sb.storage.from(BUCKET).remove([oldPath]);
      }

      onSaved();
    } catch (e) {
      setErr(e.message || "Could not save the recipe.");
    } finally {
      setBusy(false);
    }
  };

  return html`
    <${Sheet} title=${recipe ? "Edit recipe" : "New recipe"} onClose=${onClose}>
      <datalist id="known-ingredients">
        ${catalog.map((c) => html`<option value=${c.name} />`)}
      </datalist>

      <label class="field">
        <span>Name</span>
        <input type="text" value=${title} placeholder="Sheet-pan chicken"
          onInput=${(e) => setTitle(e.target.value)} />
      </label>

      <label class="field" style="max-width:160px">
        <span>Serves</span>
        <input type="number" min="1" value=${servings}
          onInput=${(e) => setServings(e.target.value)} />
      </label>

      <div class="field">
        <span>Photo</span>
        ${preview && html`
          <div class="shotwrap">
            <img class="shot" src=${preview} alt="" />
            ${busy && photoFile && html`<div class="busy">Uploading…</div>`}
          </div>`}
        <div class="row wrap" style="margin-top:${preview ? "10px" : "0"}">
          <label class="pickphoto">
            ${preview ? "Replace photo" : "Add a photo"}
            <input type="file" accept="image/*" onChange=${choosePhoto} />
          </label>
          ${preview && html`
            <button class="btn quiet" onClick=${clearPhoto}>Remove photo</button>`}
        </div>
        ${isPublic && preview && html`
          <label class="row small" style="margin-top:10px">
            <input type="checkbox" checked=${sharePhoto}
              onChange=${(e) => setSharePhoto(e.target.checked)} />
            <span>Show the photo in the library too</span>
          </label>`}
      </div>

      <div class="row" style="margin:18px 0 8px">
        <p class="sign muted" style="font-size:13px;margin:0">Ingredients</p>
        <span class="spacer"></span>
        <button class="btn quiet" onClick=${() => setShowBulk(!showBulk)}>
          ${showBulk ? "Never mind" : "Paste a list"}
        </button>
      </div>

      ${showBulk && html`
        <div class="paster">
          <p class="small muted" style="margin:0 0 8px">
            Paste ingredients from anywhere, one per line. Write them however
            they're written — “1 1/2 cups flour, sifted” is fine.
          </p>
          <textarea value=${bulk} placeholder=${"2 tbsp olive oil\n1 1/2 cups flour\n3 cloves garlic, minced\n1 lb chicken breast"}
            onInput=${(e) => setBulk(e.target.value)}></textarea>
          <div class="row" style="margin-top:8px">
            <button class="btn sm" onClick=${applyBulk}>Read the list</button>
            <span class="small muted">Replaces what's below. You can fix
              anything after.</span>
          </div>
        </div>`}

      ${rows.map((r, i) => {
        const found = r.name.trim() ? matchCatalog(r.name, catalog) : null;
        const exact = found?.exact ? found.hit : null;
        const nearby = found && !found.exact ? found.hit : null;
        const novel = r.name.trim() && !exact;
        const badQty = r.name.trim() && r.quantity.trim() && !(toNumber(r.quantity) > 0);
        return html`
        <div key=${i}>
          <div class="ing">
            <input class="n" type="text" list="known-ingredients" value=${r.name}
              placeholder="Ingredient, or “1 tsp sugar”"
              title="Names with numbers are kept as written — 90 second rice stays 90 second rice"
              onInput=${(e) => setRow(i, { name: e.target.value })}
              onBlur=${() => tidyRow(i)}
              onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); tidyRow(i); } }} />
            <input class=${"q" + (badQty ? " bad" : "")} type="text"
              inputmode="text" value=${r.quantity} placeholder="1 1/2"
              onInput=${(e) => setRow(i, { quantity: e.target.value })}
              onBlur=${() => {
                const n = toNumber(rows[i].quantity);
                if (n !== null) setRow(i, { quantity: String(n) });
              }} />
            <select class="u" value=${r.unit}
              onChange=${(e) => setRow(i, { unit: e.target.value })}>
              ${UNITS.map((u) => html`<option value=${u}>${u}</option>`)}
            </select>
            <button class="d btn quiet" title="Remove"
              onClick=${() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</button>
          </div>
          ${(exact || nearby || novel || r.note || badQty) && html`
            <div class="hint">
              ${badQty && html`<span class="warn">can't read that quantity</span>`}
              ${exact && exact.name.toLowerCase() !== r.name.trim().toLowerCase()
                && html`<span class="ok">adds up with “${exact.name}”</span>`}
              ${nearby && html`
                <button class="swap"
                  onClick=${() => setRow(i, { name: nearby.name })}>
                  use “${nearby.name}” instead?
                </button>`}
              ${novel && html`<span class="new">new ingredient</span>`}
              ${r.note && html`<span class="muted">${r.note}</span>`}
            </div>`}
        </div>`;
      })}
      <button class="btn ghost sm" onClick=${() => setRows((rs) => [...rs, blankIng()])}>
        Add ingredient
      </button>

      <label class="field" style="margin-top:20px">
        <span>Method</span>
        <textarea value=${instructions} placeholder="Optional. One step per line."
          onInput=${(e) => setInstructions(e.target.value)}></textarea>
      </label>

      <label class="row small" style="margin:4px 0 18px">
        <input type="checkbox" checked=${isPublic}
          onChange=${(e) => setIsPublic(e.target.checked)} />
        <span>Share in the public library. Others can copy it; only your
          household can change it.</span>
      </label>

      <${Problem} text=${err} />
      <div class="row" style="margin-top:14px">
        <button class="btn" disabled=${busy} onClick=${save}>
          ${busy ? "Saving…" : "Save recipe"}
        </button>
        <button class="btn ghost" onClick=${onClose}>Cancel</button>
      </div>
    <//>`;
}

/* ============================================================
   Finding a recipe among many
   ============================================================ */

function scoreRecipe(recipe, query) {
  if (!query) return { rank: 3, why: null };
  const q = query.toLowerCase();
  const title = recipe.title.toLowerCase();

  if (title.startsWith(q)) return { rank: 0, why: null };
  if (title.includes(q)) return { rank: 1, why: null };

  const ing = (recipe.recipe_ingredients || [])
    .map((r) => r.ingredients?.name)
    .filter(Boolean)
    .find((n) => n.toLowerCase().includes(q));
  if (ing) return { rank: 2, why: `has ${ing}` };

  return null;
}

function RecipePicker({ recipes, recency, value, onPick }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  const results = useMemo(() => {
    const scored = [];
    for (const r of recipes) {
      const s = scoreRecipe(r, query.trim());
      if (s) scored.push({ recipe: r, ...s });
    }
    scored.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const ra = recency?.get(a.recipe.id) ?? 9999;
      const rb = recency?.get(b.recipe.id) ?? 9999;
      if (ra !== rb) return ra - rb;
      return a.recipe.title.localeCompare(b.recipe.title);
    });
    return scored;
  }, [recipes, query, recency]);

  useEffect(() => { setActive(0); }, [query]);

  const move = (delta) => {
    if (!results.length) return;
    const next = Math.max(0, Math.min(results.length - 1, active + delta));
    setActive(next);
    const node = listRef.current?.children?.[next];
    node?.scrollIntoView({ block: "nearest" });
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const pick = results[active];
      if (pick) onPick(pick.recipe);
    }
  };

  const showingRecent = !query.trim() && recency?.size > 0;

  return html`
    <div class="picker">
      <input class="picksearch" type="text" value=${query} autofocus
        placeholder=${`Search ${recipes.length} recipes, or an ingredient`}
        onInput=${(e) => setQuery(e.target.value)}
        onKeyDown=${onKey} />

      ${showingRecent && html`
        <p class="sign muted picklabel">Most recent first</p>`}

      ${!results.length
        ? html`<p class="muted small" style="padding:16px 4px">
            Nothing matches “${query}”.</p>`
        : html`
          <div class="picklist" ref=${listRef}>
            ${results.map((res, i) => {
              const r = res.recipe;
              const chosen = r.id === value;
              return html`
                <button type="button" key=${r.id}
                  class=${"pickitem" + (i === active ? " active" : "") + (chosen ? " chosen" : "")}
                  onMouseEnter=${() => setActive(i)}
                  onClick=${() => onPick(r)}>
                  ${r.image_path
                    ? html`<img class="pickthumb" src=${photoUrl(r.image_path)}
                        alt="" loading="lazy" />`
                    : html`<span class="pickthumb blank"></span>`}
                  <span class="pickbody">
                    <span class="picktitle">${r.title}</span>
                    <span class="pickmeta num">
                      serves ${r.servings} ·
                      ${(r.recipe_ingredients || []).length} ingredients
                    </span>
                    ${res.why && html`<span class="pickwhy">${res.why}</span>`}
                  </span>
                  ${chosen && html`<span class="pickcheck">✓</span>`}
                </button>`;
            })}
          </div>`}
    </div>`;
}

/* ============================================================
   Quick pantry edit — status, amount, remove. The full name/aisle/
   conversion editor is one click further, since that's rarer to need.
   ============================================================ */

function PantryQuickEdit({ item, buckets, onClose, onFix, onStatus, onAmount,
                          onUnit, onDrop, onLocation }) {
  const [qty, setQty] = useState(item.quantity ?? "");
  const [unit, setUnit] = useState(item.unit || "");

  return html`
    <${Sheet} title=${item.ing.name} onClose=${onClose}>
      <p class="sign muted" style="font-size:12px;margin:-6px 0 8px">
        ${item.ing.aisle}
      </p>

      <span class="statusgroup" style="width:100%;margin-bottom:16px">
        ${STATUS.map((s) => html`
          <button class=${"statusbtn" + (item.status === s.key ? " on" : "")}
            style="flex:1"
            onClick=${() => onStatus(item, s.key)}>${s.label}</button>`)}
      </span>

      <label class="field">
        <span>Where it lives</span>
        <select value=${item.location || "Other"}
          onChange=${(e) => onLocation(item, e.target.value)}>
          ${buckets.map((b) => html`<option value=${b}>${b}</option>`)}
        </select>
      </label>

      <div class="row wrap" style="gap:10px">
        <label class="field" style="margin:0;flex:1;min-width:120px">
          <span>Amount</span>
          <input type="text" value=${qty} placeholder="optional"
            onInput=${(e) => setQty(e.target.value)}
            onBlur=${() => onAmount(item, qty)}
            onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />
        </label>
        <label class="field" style="margin:0;width:120px">
          <span>Unit</span>
          <select value=${unit}
            onChange=${(e) => { setUnit(e.target.value); onUnit(item, e.target.value || null); }}>
            <option value="">—</option>
            ${UNITS.map((u) => html`<option value=${u}>${u}</option>`)}
          </select>
        </label>
      </div>

      <div class="row" style="margin-top:20px">
        <button class="btn ghost sm" onClick=${() => onFix(item)}>
          Rename, change aisle, or fix conversion
        </button>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn quiet" onClick=${() => { onDrop(item); onClose(); }}>
          Take out of the pantry
        </button>
      </div>
    <//>`;
}

/* ============================================================
   Pantry
   ============================================================ */

const STATUS = [
  { key: "plenty", label: "plenty" },
  { key: "low", label: "low" },
  { key: "out", label: "out" },
];

/**
 * A text box that keeps steering toward names already in the shared
 * registry. Creating something new stays possible — it's just one extra
 * deliberate click, which is enough to stop "bananas", "banana" and
 * "ripe bananas" all existing side by side.
 */
function IngredientBox({ catalog, value, onChange, onPick, onCreate,
                         placeholder, exclude, busy }) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!q) return [];
    return catalog
      .filter((c) => c.id !== exclude && c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const sa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const sbb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (sa !== sbb) return sa - sbb;
        return a.name.length - b.name.length;
      })
      .slice(0, 8);
  }, [catalog, q, exclude]);

  const exact = !!q && catalog.some((c) => c.name.toLowerCase() === q);
  const show = open && !!q;

  return html`
    <div class="sugg">
      <input type="text" value=${value} placeholder=${placeholder}
        onInput=${(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus=${() => setOpen(true)}
        onKeyDown=${(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (matches.length && !exact) onPick(matches[0]);
            else onCreate?.(value);
            setOpen(false);
          } else if (e.key === "Escape") setOpen(false);
        }} />
      ${show && html`
        <div class="sugglist">
          ${matches.map((c) => html`
            <button type="button" class="suggitem" key=${c.id}
              onClick=${() => { onPick(c); setOpen(false); }}>
              <span class="suggname">${c.name}</span>
              <span class="suggaisle">${c.aisle}</span>
            </button>`)}
          ${!exact && html`
            <button type="button" class="suggitem suggnew" disabled=${busy}
              onClick=${() => { onCreate?.(value); setOpen(false); }}>
              <span class="suggname">Add “${value.trim()}” as something new</span>
              <span class="suggaisle">
                ${matches.length ? "not one of the above" : "nothing similar found"}
              </span>
            </button>`}
        </div>`}
    </div>`;
}

/* ============================================================
   Fixing an ingredient
   ============================================================ */

function IngredientEditor({ item, catalog, onClose, onDone }) {
  const ing = item.ing;
  const [name, setName] = useState(ing.name);
  const [aisle, setAisle] = useState(ing.aisle);
  const [canon, setCanon] = useState(ing.canonical_unit);
  const [perMl, setPerMl] = useState(ing.grams_per_ml ?? "");
  const [perCount, setPerCount] = useState(ing.grams_per_count ?? "");
  const [usage, setUsage] = useState(null);
  const [mergeText, setMergeText] = useState("");
  const [mergeTarget, setMergeTarget] = useState(null);
  const [saving, setSaving] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    sb.rpc("ingredient_usage", { p_id: ing.id })
      .then(({ data }) => setUsage(data));
  }, [ing.id]);

  const clash = catalog.find((c) =>
    c.id !== ing.id && c.name.toLowerCase() === name.trim().toLowerCase());

  const saveEdits = async () => {
    if (!name.trim()) { setErr("Needs a name."); return; }
    if (clash) {
      setErr(`“${clash.name}” already exists. Use “Same as something else” ` +
             `below to merge them instead.`);
      return;
    }
    setSaving("edit"); setErr("");
    const { error } = await sb.from("ingredients").update({
      name: name.trim().toLowerCase(),
      aisle,
      canonical_unit: canon,
      grams_per_ml: toNumber(perMl),
      grams_per_count: toNumber(perCount),
    }).eq("id", ing.id);
    setSaving("");
    if (error) { setErr(error.message); return; }
    onDone();
  };

  const doMerge = async () => {
    if (!mergeTarget) return;
    if (!confirm(`Merge “${ing.name}” into “${mergeTarget.name}”? ` +
                 `Every recipe, pantry and list using it will switch over, ` +
                 `and “${ing.name}” will be deleted. This can't be undone.`)) return;
    setSaving("merge"); setErr("");
    const { error } = await sb.rpc("merge_ingredients", {
      p_from: ing.id, p_into: mergeTarget.id,
    });
    setSaving("");
    if (error) { setErr(error.message); return; }
    onDone();
  };

  const shared = usage && (usage.recipes > 1 || usage.households > 1);

  return html`
    <${Sheet} title="Fix ingredient" onClose=${onClose}>
      ${usage && html`
        <div class=${"notice" + (shared ? "" : " quiet")}>
          Ingredients are shared, so this affects everyone using it —
          ${usage.recipes} ${usage.recipes === 1 ? "recipe" : "recipes"},
          ${usage.households} ${usage.households === 1 ? "pantry" : "pantries"}.
        </div>`}

      <label class="field" style="margin-top:14px">
        <span>Name</span>
        <input type="text" value=${name}
          onInput=${(e) => setName(e.target.value)} />
      </label>
      ${clash && html`
        <p class="small" style="margin:-6px 0 12px;color:var(--danger)">
          “${clash.name}” already exists — merge below rather than renaming.
        </p>`}

      <div class="row wrap" style="gap:12px">
        <label class="field" style="margin:0;flex:1;min-width:150px">
          <span>Aisle</span>
          <select value=${aisle} onChange=${(e) => setAisle(e.target.value)}>
            ${[...new Set([aisle, "Produce", "Meat", "Seafood", "Dairy",
              "Bakery", "Frozen", "Pantry", "Baking", "Spices", "Beverages",
              "Household", "Other"])].map((a) =>
              html`<option value=${a}>${a}</option>`)}
          </select>
        </label>
        <label class="field" style="margin:0;width:130px">
          <span>Measured in</span>
          <select value=${canon} onChange=${(e) => setCanon(e.target.value)}>
            <option value="count">count</option>
            <option value="g">grams</option>
            <option value="ml">millilitres</option>
          </select>
        </label>
      </div>

      <p class="small muted" style="margin:6px 0 14px">
        Changing what something's measured in re-reads every existing amount
        for it, so only do that if it's plainly wrong — salt recorded in
        millilitres, say.
      </p>

      <div class="row wrap" style="gap:12px">
        <label class="field" style="margin:0;flex:1;min-width:150px">
          <span>Grams per ml</span>
          <input type="text" value=${perMl} placeholder="e.g. 0.53 for flour"
            onInput=${(e) => setPerMl(e.target.value)} />
        </label>
        <label class="field" style="margin:0;flex:1;min-width:150px">
          <span>Grams each</span>
          <input type="text" value=${perCount} placeholder="e.g. 50 for an egg"
            onInput=${(e) => setPerCount(e.target.value)} />
        </label>
      </div>
      <p class="small muted" style="margin:6px 0 18px">
        Filling these in is what lets cups and tablespoons add up with
        ounces on the shopping list. Leave blank if you don't know.
      </p>

      <${Problem} text=${err} />
      <div class="row" style="margin-bottom:22px">
        <button class="btn" disabled=${!!saving} onClick=${saveEdits}>
          ${saving === "edit" ? "Saving…" : "Save changes"}
        </button>
        <button class="btn ghost" onClick=${onClose}>Cancel</button>
      </div>

      <h2 class="sign" style="font-size:17px;margin:0 0 8px">Same as something else</h2>
      <p class="small muted" style="margin:0 0 10px">
        If this turned out to be a duplicate, merge it. Everything pointing
        here moves across, and this one disappears.
      </p>
      <${IngredientBox} catalog=${catalog} value=${mergeText}
        exclude=${ing.id}
        placeholder="Which one is it really?"
        onChange=${(v) => { setMergeText(v); setMergeTarget(null); }}
        onPick=${(c) => { setMergeTarget(c); setMergeText(c.name); }} />
      ${mergeTarget && html`
        <button class="btn" style="margin-top:12px" disabled=${!!saving}
          onClick=${doMerge}>
          ${saving === "merge"
            ? "Merging…"
            : `Merge into “${mergeTarget.name}”`}
        </button>`}
    <//>`;
}

/** Anything not marked "out" counts as something you can cook with. */
function haveIt(item) {
  return !!item && item.status !== "out";
}

function coverage(recipe, pantry) {
  const lines = recipe.recipe_ingredients || [];
  const missing = [];
  const low = [];
  for (const l of lines) {
    const item = pantry.get(l.ingredient_id);
    if (!haveIt(item)) missing.push(l.ingredients?.name || "something");
    else if (item.status === "low") low.push(l.ingredients?.name || "something");
  }
  return { total: lines.length, missing, low, has: lines.length - missing.length };
}

function PantryTab({ household, pantry, catalog, locations, recipes, recency,
                    reload, onPlan }) {
  const [view, setView] = useState("have");
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const [fixing, setFixing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [editingBuckets, setEditingBuckets] = useState(false);
  const [newBucket, setNewBucket] = useState("");
  const [dragOver, setDragOver] = useState(null);
  const [dragging, setDragging] = useState(null);

  const items = useMemo(() => {
    const list = [...pantry.values()].map((p) => ({
      ...p,
      ing: catalog.find((c) => c.id === p.ingredient_id),
    })).filter((p) => p.ing);
    const q = search.trim().toLowerCase();
    return q ? list.filter((p) => p.ing.name.toLowerCase().includes(q)) : list;
  }, [pantry, catalog, search]);

  // "Other" is never a physical row — it's synthesized so it can never be
  // deleted or duplicated, and it's always the last bucket.
  const bucketNames = useMemo(() =>
    [...locations.map((l) => l.name), "Other"], [locations]);

  const bucketed = useMemo(() => {
    const m = new Map();
    for (const name of bucketNames) m.set(name, []);
    for (const it of items) {
      const loc = m.has(it.location) ? it.location : "Other";
      m.get(loc).push(it);
    }
    for (const rows of m.values()) rows.sort((a, b) => a.ing.name.localeCompare(b.ing.name));
    return m;
  }, [items, bucketNames]);

  const addExisting = async (ing) => {
    setBusy(true); setErr("");
    try {
      const { error } = await sb.from("pantry_items").upsert({
        household_id: household.id,
        ingredient_id: ing.id,
        status: "plenty",
        updated_at: new Date().toISOString(),
      }, { onConflict: "household_id,ingredient_id" });
      if (error) throw error;
      logActivity(household, `added ${ing.name} to the pantry`);
      setAdding("");
      reload();
    } catch (e) {
      setErr(e.message || "Couldn't add that.");
    } finally {
      setBusy(false);
    }
  };

  const add = async (raw) => {
    const text = (raw ?? adding).trim();
    if (!text) return;
    setBusy(true); setErr("");
    try {
      const parsed = parseLine(text, catalog, { cautious: true });
      if (!parsed?.name) throw new Error("Couldn't read that.");
      const id = await resolveIngredient(parsed.name, parsed.unit, catalog);
      const { error } = await sb.from("pantry_items").upsert({
        household_id: household.id,
        ingredient_id: id,
        status: "plenty",
        quantity: parsed.guessedQty ? null : parsed.qty,
        unit: parsed.guessedQty ? null : parsed.unit,
        updated_at: new Date().toISOString(),
      }, { onConflict: "household_id,ingredient_id" });
      if (error) throw error;
      logActivity(household, `added ${parsed.name} to the pantry`);
      setAdding("");
      reload();
    } catch (e) {
      setErr(e.message || "Couldn't add that.");
    } finally {
      setBusy(false);
    }
  };

  // Status, amount, and location are the pantry's high-frequency, routine
  // edits — logging every one would flood the feed with noise nobody
  // wants to scroll through, so only additions and removals are recorded.
  const setStatus = async (item, status) => {
    await sb.from("pantry_items")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", item.id);
    reload();
  };

  const setAmount = async (item, text) => {
    const qty = toNumber(text);
    await sb.from("pantry_items")
      .update({ quantity: qty, updated_at: new Date().toISOString() })
      .eq("id", item.id);
    reload();
  };

  const setUnit = async (item, unit) => {
    await sb.from("pantry_items")
      .update({ unit, updated_at: new Date().toISOString() })
      .eq("id", item.id);
    reload();
  };

  const setLocation = async (item, location) => {
    await sb.from("pantry_items")
      .update({ location, updated_at: new Date().toISOString() })
      .eq("id", item.id);
    reload();
  };

  const drop = async (item) => {
    await sb.from("pantry_items").delete().eq("id", item.id);
    logActivity(household, `removed ${item.ing.name} from the pantry`);
    reload();
  };

  /* ---- buckets ---- */

  const addBucket = async () => {
    const name = newBucket.trim();
    if (!name) return;
    if (name.toLowerCase() === "other") {
      setErr("That's already the default — pick a different name.");
      return;
    }
    setErr("");
    const { error } = await sb.from("pantry_locations")
      .insert({ household_id: household.id, name,
        sort_order: locations.length ? Math.max(...locations.map((l) => l.sort_order)) + 10 : 10 });
    if (error && error.code !== "23505") { setErr(error.message); return; }
    logActivity(household, `created the "${name}" bucket`);
    setNewBucket("");
    reload();
  };

  const renameBucket = async (oldName, newName) => {
    const clean = newName.trim();
    if (!clean || clean === oldName) return;
    const { error } = await sb.rpc("rename_pantry_location", {
      p_household: household.id, p_old: oldName, p_new: clean,
    });
    if (error) { setErr(error.message); return; }
    logActivity(household, `renamed the "${oldName}" bucket to "${clean}"`);
    reload();
  };

  const removeBucket = async (name) => {
    if (!confirm(`Remove "${name}"? Anything in it moves back to Other.`)) return;
    const { error } = await sb.rpc("delete_pantry_location", {
      p_household: household.id, p_name: name,
    });
    if (error) { setErr(error.message); return; }
    logActivity(household, `removed the "${name}" bucket`);
    reload();
  };

  /* ---- drag and drop ----
     Desktop only — iOS and Android Safari/Chrome don't support HTML5
     drag-and-drop on arbitrary elements, only on links and images. On a
     phone, the same move happens through the Location dropdown inside
     the tap-to-open popover instead, so nothing is drag-only. */

  const dragItem = (e, item) => {
    e.dataTransfer.setData("text/plain", item.id);
    e.dataTransfer.effectAllowed = "move";
    setDragging(item.id);
  };

  const dropOnBucket = (e, name) => {
    e.preventDefault();
    setDragOver(null);
    setDragging(null);
    const id = e.dataTransfer.getData("text/plain");
    const item = items.find((i) => i.id === id);
    if (item && item.location !== name) setLocation(item, name);
  };

  const cookable = useMemo(() => {
    return recipes
      .map((r) => ({ recipe: r, ...coverage(r, pantry) }))
      .filter((c) => c.total > 0)
      .sort((a, b) => {
        if (a.missing.length !== b.missing.length) return a.missing.length - b.missing.length;
        const ra = recency?.get(a.recipe.id) ?? 9999;
        const rb = recency?.get(b.recipe.id) ?? 9999;
        return ra - rb;
      });
  }, [recipes, pantry, recency]);

  const ready = cookable.filter((c) => c.missing.length === 0);

  // `detail` is set once, on click; after a status/amount change triggers
  // reload(), the underlying item object is new. Look it up fresh each
  // render so the popover reflects what was just clicked rather than a
  // stale snapshot.
  const liveDetail = detail ? items.find((i) => i.id === detail.id) || detail : null;

  return html`
    <div>
      <div class="row wrap" style="margin-bottom:14px">
        <button class=${"btn sm " + (view === "have" ? "" : "ghost")}
          onClick=${() => setView("have")}>What we have (${pantry.size})</button>
        <button class=${"btn sm " + (view === "make" ? "" : "ghost")}
          onClick=${() => setView("make")}>
          What we can make${ready.length ? ` (${ready.length})` : ""}
        </button>
      </div>

      ${view === "have" ? html`
        <${IngredientBox} catalog=${catalog} value=${adding} busy=${busy}
          placeholder="Add what you've got — “2 lb flour” or just “paprika”"
          onChange=${setAdding}
          onPick=${addExisting}
          onCreate=${(v) => add(v)} />
        <${Problem} text=${err} />

        ${pantry.size > 8 && html`
          <input class="picksearch" type="text" value=${search}
            placeholder="Find something in the pantry"
            onInput=${(e) => setSearch(e.target.value)}
            style="margin:10px 0 4px" />`}

        ${!pantry.size
          ? html`<div class="empty">
              <p>Nothing in the pantry yet. Add a few staples above, or just
                shop — anything you tick off the grocery list lands here
                automatically.</p>
            </div>`
          : html`
            <div class="row wrap" style="margin:2px 0 4px;gap:10px">
              <p class="small muted" style="margin:0">
                Tap anything for status and details. Drag a chip onto a
                bucket to move it — on a phone, use the “where it lives”
                menu inside the popover instead.
              </p>
              <span class="spacer"></span>
              <button class="btn quiet" onClick=${() => setEditingBuckets(!editingBuckets)}>
                ${editingBuckets ? "Done arranging buckets" : "Arrange buckets"}
              </button>
            </div>

            ${editingBuckets && html`
              <div class="bucketedit">
                ${locations.map((b) => html`
                  <div class="bucketeditrow" key=${b.id}>
                    <input type="text" value=${b.name}
                      onBlur=${(e) => renameBucket(b.name, e.target.value)}
                      onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />
                    <button class="btn quiet" onClick=${() => removeBucket(b.name)}>Remove</button>
                  </div>`)}
                <div class="row" style="margin-top:8px">
                  <input type="text" value=${newBucket} placeholder="New bucket — “Fridge door”"
                    onInput=${(e) => setNewBucket(e.target.value)}
                    onKeyDown=${(e) => e.key === "Enter" && addBucket()} />
                  <button class="btn sm" onClick=${addBucket}>Add</button>
                </div>
              </div>`}

            ${bucketNames.map((name) => {
              const rows = bucketed.get(name) || [];
              if (!rows.length && name === "Other" && locations.length) return null;
              return html`
              <div key=${name}
                class=${"bucket" + (dragOver === name ? " over" : "")}
                onDragOver=${(e) => { e.preventDefault(); if (dragOver !== name) setDragOver(name); }}
                onDragLeave=${() => setDragOver((d) => (d === name ? null : d))}
                onDrop=${(e) => dropOnBucket(e, name)}>
                <div class="aisle">
                  <span class="name">${name}</span>
                  <span class="count num">${rows.length}</span>
                </div>
                ${!rows.length
                  ? html`<p class="small muted" style="padding:10px 2px">
                      Nothing here. Drag something in, or move it here from
                      its popover.
                    </p>`
                  : html`
                    <div class="pchips">
                      ${rows.map((it) => html`
                        <button type="button"
                          class=${"pchip status-" + it.status
                            + (dragging === it.id ? " dragging" : "")}
                          key=${it.id} draggable="true"
                          onDragStart=${(e) => dragItem(e, it)}
                          onDragEnd=${() => { setDragging(null); setDragOver(null); }}
                          onClick=${() => setDetail(it)}>
                          <span class="pchipname">${it.ing.name}</span>
                          ${it.status !== "plenty" && html`
                            <span class="pchiptag">${it.status}</span>`}
                        </button>`)}
                    </div>`}
              </div>`;
            })}`}
      ` : html`
        ${!pantry.size
          ? html`<div class="empty">
              <p>Add things to the pantry first and this fills itself in.</p>
            </div>`
          : html`
            <p class="small muted" style="margin:0 0 14px">
              Ranked by how little you're missing. Amounts aren't checked —
              this tells you whether you have the ingredient, not whether
              you have enough of it.
            </p>
            ${cookable.map((c) => html`
              <div class=${"cook-card" + (c.missing.length ? "" : " ready")}
                key=${c.recipe.id}>
                <div class="row wrap" style="gap:10px">
                  <strong style="font-size:16.5px">${c.recipe.title}</strong>
                  <span class="spacer"></span>
                  <span class=${"cov num" + (c.missing.length ? "" : " full")}>
                    ${c.has} of ${c.total}
                  </span>
                  <button class="btn sm" onClick=${() => onPlan(c.recipe)}>Plan it</button>
                </div>
                ${c.missing.length > 0 && html`
                  <p class="small muted" style="margin:8px 0 0">
                    Missing: ${c.missing.join(", ")}
                  </p>`}
                ${c.low.length > 0 && html`
                  <p class="small" style="margin:6px 0 0;color:#7A5B12">
                    Running low: ${c.low.join(", ")}
                  </p>`}
              </div>`)}
          `}
      `}

      ${liveDetail && html`<${PantryQuickEdit} item=${liveDetail} buckets=${bucketNames}
        onClose=${() => setDetail(null)}
        onFix=${(it) => { setDetail(null); setFixing(it); }}
        onStatus=${setStatus} onAmount=${setAmount} onUnit=${setUnit}
        onLocation=${setLocation}
        onDrop=${drop} />`}

      ${fixing && html`<${IngredientEditor} item=${fixing} catalog=${catalog}
        onClose=${() => setFixing(null)}
        onDone=${() => { setFixing(null); reload(); }} />`}
    </div>`;
}

/* ============================================================
   Add a meal to the calendar
   ============================================================ */

/**
 * Pick a recipe at random, leaning away from whatever's been cooked most
 * recently. Not a hard exclusion — "surprise me" should still occasionally
 * land on a favorite — just a nudge toward the pile of recipes nobody's
 * touched in a while.
 */
function pickSurprise(recipes, recency) {
  if (!recipes.length) return null;
  const fresh = recipes.filter((r) => (recency?.get(r.id) ?? 9999) > 4);
  const useFresh = fresh.length > 0 && Math.random() < 0.8;
  const pool = useFresh ? fresh : recipes;
  return pool[Math.floor(Math.random() * pool.length)];
}

function MealPicker({ household, recipes, recency, date, preselect,
                      presetSlot, presetServings, requestId, onClose, onSaved }) {
  const [recipeId, setRecipeId] = useState(preselect || "");
  const [when, setWhen] = useState(date || iso(new Date()));
  const [slot, setSlot] = useState(presetSlot || "dinner");
  const chosen = recipes.find((r) => r.id === recipeId);
  const [servings, setServings] = useState(presetServings || chosen?.servings || 4);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [spinning, setSpinning] = useState(false);
  const [reelText, setReelText] = useState("");
  const [landed, setLanded] = useState(false);
  const spinTimer = useRef(null);

  useEffect(() => () => clearTimeout(spinTimer.current), []);

  const spin = () => {
    if (spinning || !recipes.length) return;
    const target = pickSurprise(recipes, recency);
    if (!target) return;

    setErr("");
    setSpinning(true);
    setLanded(false);

    // A slot-machine tick: fast and random at first, slowing down, landing
    // exactly on the chosen recipe. ~3 seconds end to end.
    const delays = [40, 40, 50, 60, 75, 95, 120, 150, 190, 240, 300, 380, 470, 580];
    let i = 0;
    const tick = () => {
      if (i < delays.length) {
        const r = recipes[Math.floor(Math.random() * recipes.length)];
        setReelText(r.title);
        i++;
        spinTimer.current = setTimeout(tick, delays[i - 1]);
      } else {
        setReelText(target.title);
        setRecipeId(target.id);
        setSpinning(false);
        setLanded(true);
        setTimeout(() => setLanded(false), 550);
      }
    };
    tick();
  };

  useEffect(() => {
    // Don't clobber an explicit ask ("make extra, serves 6") with the
    // recipe's own default the moment it's picked.
    if (presetServings) return;
    const r = recipes.find((x) => x.id === recipeId);
    if (r) setServings(r.servings);
  }, [recipeId]);

  const save = async (thenAdjust) => {
    if (!recipeId) { setErr("Pick a recipe first."); return; }
    setBusy(true); setErr("");
    const { data, error } = await sb.from("meal_plan").insert({
      household_id: household.id,
      recipe_id: recipeId,
      scheduled_on: when,
      meal_slot: slot,
      servings: Number(servings) || 4,
    }).select("*, recipes(id, title, servings)").single();
    if (error) { setBusy(false); setErr(error.message); return; }
    const dayLabel = fromIso(when).toLocaleDateString(
      undefined, { weekday: "short", month: "short", day: "numeric" });
    logActivity(household, `planned ${data.recipes?.title || "a meal"} for ${dayLabel}`,
      recipeId);
    if (requestId) {
      // Fulfilled, so it comes out of the queue. Not fatal if this part
      // fails — the meal itself is already safely saved.
      await sb.from("meal_requests").delete().eq("id", requestId);
    }
    setBusy(false);
    onSaved(thenAdjust ? data : null);
  };

  if (!recipes.length) {
    return html`
      <${Sheet} title="Add a meal" onClose=${onClose}>
        <div class="empty"><p>No recipes yet. Add one on the Recipes tab,
          then it'll show up here.</p></div>
      <//>`;
  }

  return html`
    <${Sheet} title=${requestId ? "Fulfill the request" : "Add a meal"} onClose=${onClose}>
      ${requestId && !preselect && html`
        <div class="notice" style="margin-bottom:14px">
          This request wasn't linked to a recipe. Pick one below, or add it
          on the Recipes tab first if it doesn't exist yet.
        </div>`}
      <label class="field" style="margin-bottom:6px">
        <span>Recipe</span>
      </label>
      <${RecipePicker} recipes=${recipes} recency=${recency} value=${recipeId}
        onPick=${(r) => setRecipeId(r.id)} />

      <div class="surprise">
        <button class="btn ghost sm" disabled=${spinning} onClick=${spin}>
          🎲 ${spinning ? "Spinning…" : "Surprise me"}
        </button>
        ${reelText && html`
          <div class=${"reel" + (spinning ? " spinning" : "") + (landed ? " landed" : "")}>
            ${reelText}
          </div>`}
      </div>
      ${!reelText && html`
        <p class="small muted" style="margin:6px 0 0">
          Leans toward things you haven't had in a while.
        </p>`}

      <div class="row wrap" style="gap:12px;margin-top:18px">
        <label class="field" style="margin:0;flex:1;min-width:150px">
          <span>Date</span>
          <input type="date" value=${when} onInput=${(e) => setWhen(e.target.value)} />
        </label>
        <label class="field" style="margin:0;flex:1;min-width:130px">
          <span>Meal</span>
          <select value=${slot} onChange=${(e) => setSlot(e.target.value)}>
            ${SLOTS.map((s) => html`<option value=${s}>${s}</option>`)}
          </select>
        </label>
        <label class="field" style="margin:0;width:100px">
          <span>Serves</span>
          <input type="number" min="1" value=${servings}
            onInput=${(e) => setServings(e.target.value)} />
        </label>
      </div>

      <p class="small muted">Quantities scale automatically. ${chosen
        ? `This recipe is written for ${chosen.servings}.` : ""}</p>
      <${Problem} text=${err} />
      <div class="row wrap" style="margin-top:14px;gap:10px">
        <button class="btn" disabled=${busy} onClick=${() => save(false)}>
          ${busy ? "Adding…" : "Add to plan"}
        </button>
        <button class="btn ghost" disabled=${busy} onClick=${() => save(true)}>
          Add and adjust
        </button>
        <button class="btn quiet" onClick=${onClose}>Cancel</button>
      </div>
      <p class="small muted" style="margin-top:8px">
        “Add and adjust” opens it straight away so you can change amounts or
        skip something, just for this day.
      </p>
    <//>`;
}

/* ============================================================
   Requesting a meal — lighter than planning one. No recipe required,
   no day required. Sits in a shared queue until someone turns it into
   a real entry on the calendar, at which point the request disappears
   rather than lingering as a second source of truth.
   ============================================================ */

function RequestComposer({ household, recipes, recency, onAdded }) {
  const [title, setTitle] = useState("");
  const [linked, setLinked] = useState(null);
  const [showLink, setShowLink] = useState(false);
  const [showWhen, setShowWhen] = useState(false);
  const [when, setWhen] = useState("");
  const [slot, setSlot] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const reset = () => {
    setTitle(""); setLinked(null); setShowLink(false);
    setShowWhen(false); setWhen(""); setSlot(""); setNote("");
  };

  const submit = async () => {
    const text = (linked?.title || title).trim();
    if (!text) { setErr("Say what you're asking for."); return; }
    setBusy(true); setErr("");
    const { error } = await sb.from("meal_requests").insert({
      household_id: household.id,
      recipe_id: linked?.id || null,
      title: text,
      requested_for: when || null,
      meal_slot: slot || null,
      note: note.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    logActivity(household, `asked for ${text}`, linked?.id || null);
    reset();
    onAdded();
  };

  return html`
    <div class="requester">
      <div class="row wrap" style="gap:10px">
        <input type="text" value=${title} style="flex:1;min-width:200px"
          placeholder="Request something — “tacos”, “grandma's lasagna”…"
          onInput=${(e) => { setTitle(e.target.value); if (linked) setLinked(null); }}
          onKeyDown=${(e) => e.key === "Enter" && !e.shiftKey && submit()} />
        <button class="btn sm" disabled=${busy} onClick=${submit}>
          ${busy ? "Asking…" : "Ask for it"}
        </button>
      </div>

      <div class="row wrap" style="margin-top:8px;gap:14px">
        <button class="btn quiet" onClick=${() => setShowWhen(!showWhen)}>
          ${when || slot ? "Change day / meal" : "For a particular day?"}
        </button>
        <button class="btn quiet" onClick=${() => setShowLink(!showLink)}>
          ${linked ? `Linked: ${linked.title}` : "Already have this recipe?"}
        </button>
      </div>

      ${showWhen && html`
        <div class="row wrap" style="margin-top:10px;gap:12px">
          <label class="field" style="margin:0">
            <span>Day</span>
            <input type="date" value=${when} onInput=${(e) => setWhen(e.target.value)} />
          </label>
          <label class="field" style="margin:0">
            <span>Meal</span>
            <select value=${slot} onChange=${(e) => setSlot(e.target.value)}>
              <option value="">Any</option>
              ${SLOTS.map((s) => html`<option value=${s}>${s}</option>`)}
            </select>
          </label>
          <label class="field" style="margin:0;flex:1;min-width:160px">
            <span>Note</span>
            <input type="text" value=${note} placeholder="no mushrooms please"
              onInput=${(e) => setNote(e.target.value)} />
          </label>
        </div>`}

      ${showLink && html`
        <div style="margin-top:10px;max-width:420px">
          <${RecipePicker} recipes=${recipes} recency=${recency} value=${linked?.id}
            onPick=${(r) => { setLinked(r); setShowLink(false); }} />
        </div>`}

      <${Problem} text=${err} />
    </div>`;
}

function RequestQueue({ requests, onClaim, onDismiss }) {
  if (!requests.length) return null;

  return html`
    <div style="margin-top:26px">
      <h2 class="sign" style="font-size:17px;margin:0 0 10px">
        Requested (${requests.length})
      </h2>
      <div class="stack">
        ${requests.map((r) => html`
          <div class="reqcard" key=${r.id}>
            <div class="row wrap" style="gap:8px">
              <strong style="font-size:15.5px">${r.recipes?.title || r.title}</strong>
              ${r.requested_for && html`
                <span class="pill">${fromIso(r.requested_for).toLocaleDateString(
                  undefined, { weekday: "short", month: "short", day: "numeric" })}</span>`}
              ${r.meal_slot && html`<span class="pill">${r.meal_slot}</span>`}
              <span class="spacer"></span>
              <span class="reqby">asked by ${r.requested_by_name || "someone"}</span>
            </div>
            ${r.note && html`<p class="small muted" style="margin:6px 0 0">${r.note}</p>`}
            <div class="row" style="margin-top:10px">
              <button class="btn sm" onClick=${() => onClaim(r)}>Add to plan</button>
              <button class="btn quiet" onClick=${() => onDismiss(r)}>Dismiss</button>
            </div>
          </div>`)}
      </div>
    </div>`;
}

/** One planned meal, however it's shown — a week card or the day panel. */
function MealRow({ m, recipes, onOpen, onRemove }) {
  return html`
    <div class="meal">
      <button class="kill" title="Remove" onClick=${() => onRemove(m.id)}>×</button>
      <button class="mealopen"
        onClick=${() => onOpen(recipes.find((r) => r.id === m.recipe_id), m)}>
        <span class="slot">${m.meal_slot}</span>
        <span class="mealname">${m.recipes?.title || "—"}</span>
        <span class="srv">${m.servings} servings</span>
      </button>
    </div>`;
}

const DOT_SLOTS = ["breakfast", "lunch", "dinner"];

/* ============================================================
   Plan tab
   ============================================================ */

function PlanTab({ household, recipes, recency, meals, week, setWeek, reload,
                  onOpen, planThis, onPlanned, requests, reloadRequests }) {
  const [picker, setPicker] = useState(null);
  const today = iso(new Date());

  const [calView, setCalView] = useState(
    () => localStorage.getItem("sm-plan-view") || "week");
  const setCalViewSticky = (v) => {
    setCalView(v);
    try { localStorage.setItem("sm-plan-view", v); } catch { /* private mode */ }
  };

  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState(today);
  const [monthMeals, setMonthMeals] = useState([]);
  const [monthLoading, setMonthLoading] = useState(false);

  const cells = useMemo(() => monthCells(monthCursor), [monthCursor]);

  const fetchMonth = useCallback(async () => {
    if (calView !== "month" || !cells.length) return;
    setMonthLoading(true);
    const { data, error } = await sb.from("meal_plan")
      .select("*, recipes(id, title, servings)")
      .eq("household_id", household.id)
      .gte("scheduled_on", iso(cells[0].date))
      .lte("scheduled_on", iso(cells[cells.length - 1].date));
    setMonthLoading(false);
    if (!error) setMonthMeals(data || []);
  }, [household.id, calView, cells]);

  useEffect(() => { fetchMonth(); }, [fetchMonth]);
  // `meals` only changes when the week view's own load() runs, which
  // happens on every realtime meal_plan change for the household — reused
  // here purely as a "something changed, refetch" signal for month view,
  // rather than standing up a second realtime subscription for the same
  // table.
  useEffect(() => { if (calView === "month") fetchMonth(); }, [meals]);

  useEffect(() => {
    if (!planThis) return;
    setPicker({ date: today, recipeId: planThis.id });
    onPlanned?.();
  }, [planThis]);

  const claim = (req) => {
    setPicker({
      date: req.requested_for || today,
      recipeId: req.recipe_id || "",
      slot: req.meal_slot || "dinner",
      servings: req.servings || undefined,
      requestId: req.id,
    });
  };

  const dismiss = async (req) => {
    await sb.from("meal_requests").delete().eq("id", req.id);
    logActivity(household, `dismissed the request for ${req.recipes?.title || req.title}`);
    reloadRequests();
  };

  const byDay = useMemo(() => {
    const m = new Map();
    for (const meal of meals) {
      if (!m.has(meal.scheduled_on)) m.set(meal.scheduled_on, []);
      m.get(meal.scheduled_on).push(meal);
    }
    for (const list of m.values()) {
      list.sort((a, b) => SLOTS.indexOf(a.meal_slot) - SLOTS.indexOf(b.meal_slot));
    }
    return m;
  }, [meals]);

  const byDayMonth = useMemo(() => {
    const m = new Map();
    for (const meal of monthMeals) {
      if (!m.has(meal.scheduled_on)) m.set(meal.scheduled_on, []);
      m.get(meal.scheduled_on).push(meal);
    }
    for (const list of m.values()) {
      list.sort((a, b) => SLOTS.indexOf(a.meal_slot) - SLOTS.indexOf(b.meal_slot));
    }
    return m;
  }, [monthMeals]);

  const remove = async (id) => {
    const m = meals.find((x) => x.id === id) || monthMeals.find((x) => x.id === id);
    await sb.from("meal_plan").delete().eq("id", id);
    if (m) {
      const dayLabel = fromIso(m.scheduled_on).toLocaleDateString(
        undefined, { weekday: "short", month: "short", day: "numeric" });
      logActivity(household, `removed ${m.recipes?.title || "a meal"} from ${dayLabel}`);
    }
    reload();
    if (calView === "month") fetchMonth();
  };

  const pickCell = (cell) => {
    setSelectedDay(iso(cell.date));
    if (!cell.inMonth) {
      setMonthCursor(new Date(cell.date.getFullYear(), cell.date.getMonth(), 1));
    }
  };

  const monthLabel = monthCursor.toLocaleDateString(
    undefined, { month: "long", year: "numeric" });
  const selectedMeals = byDayMonth.get(selectedDay) || [];
  const selectedLabel = fromIso(selectedDay).toLocaleDateString(
    undefined, { weekday: "long", month: "long", day: "numeric" });

  return html`
    <div>
      <div class="weeknav">
        ${calView === "week"
          ? html`
            <button class="navarrow" onClick=${() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button>
            <button class="navarrow" onClick=${() => setWeek(addDays(week, 7))} aria-label="Next week">›</button>
            <span class="label">${spanLabel(week)}</span>`
          : html`
            <button class="navarrow" onClick=${() =>
              setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1))}
              aria-label="Previous month">‹</button>
            <button class="navarrow" onClick=${() =>
              setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1))}
              aria-label="Next month">›</button>
            <span class="label">${monthLabel}</span>`}
        <span class="spacer"></span>
        <button class=${"btn sm " + (calView === "week" ? "" : "ghost")}
          onClick=${() => setCalViewSticky("week")}>Week</button>
        <button class=${"btn sm " + (calView === "month" ? "" : "ghost")}
          onClick=${() => setCalViewSticky("month")}>Month</button>
      </div>

      ${calView === "week" ? html`
        <div class="days">
          ${[0, 1, 2, 3, 4, 5, 6].map((i) => {
            const d = addDays(week, i);
            const key = iso(d);
            const list = byDay.get(key) || [];
            return html`
              <div class=${"day" + (key === today ? " today" : "")} key=${key}>
                <div>
                  <span class="dow">${DOW[d.getDay()]}</span>
                  <span class="dnum">${d.getDate()}</span>
                </div>
                ${list.map((m) => html`<${MealRow} m=${m} recipes=${recipes}
                  onOpen=${onOpen} onRemove=${remove} key=${m.id} />`)}
                <button class="add" onClick=${() => setPicker({ date: key })}>+ meal</button>
              </div>`;
          })}
        </div>`
        : html`
        <div class="monthwrap">
          <div class="monthgrid">
            <div class="monthdow">
              ${DOW.map((d) => html`<span key=${d}>${d}</span>`)}
            </div>
            <div class="monthcells">
              ${cells.map((cell) => {
                const key = iso(cell.date);
                const list = byDayMonth.get(key) || [];
                return html`
                  <button type="button" key=${key}
                    class=${"monthcell"
                      + (cell.inMonth ? "" : " out")
                      + (key === today ? " today" : "")
                      + (key === selectedDay ? " selected" : "")}
                    onClick=${() => pickCell(cell)}>
                    <span class="mnum">${cell.date.getDate()}</span>
                    ${list.length > 0 && html`
                      <span class="mdots">
                        ${DOT_SLOTS.map((s) => html`
                          <i key=${s} class=${list.some((m) => m.meal_slot === s) ? "" : "hollow"}
                            title=${s}></i>`)}
                      </span>`}
                  </button>`;
              })}
            </div>
          </div>

          <div class="daypanel">
            <h3>${selectedLabel}</h3>
            ${monthLoading && !selectedMeals.length
              ? html`<p class="small muted">Loading…</p>`
              : !selectedMeals.length
                ? html`<p class="small muted" style="margin:4px 0 14px">Nothing planned.</p>`
                : selectedMeals.map((m) => html`<${MealRow} m=${m} recipes=${recipes}
                    onOpen=${onOpen} onRemove=${remove} key=${m.id} />`)}
            <button class="add" style="margin-top:10px"
              onClick=${() => setPicker({ date: selectedDay })}>+ meal</button>
          </div>
        </div>`}

      ${picker && html`<${MealPicker} household=${household} recipes=${recipes}
        recency=${recency} date=${picker.date} preselect=${picker.recipeId}
        presetSlot=${picker.slot} presetServings=${picker.servings}
        requestId=${picker.requestId}
        onClose=${() => setPicker(null)}
        onSaved=${(created) => {
          setPicker(null);
          reload();
          reloadRequests();
          if (calView === "month") fetchMonth();
          if (created) {
            onOpen(recipes.find((r) => r.id === created.recipe_id), created, true);
          }
        }} />`}

      <${RequestComposer} household=${household} recipes=${recipes}
        recency=${recency} onAdded=${reloadRequests} />
      <${RequestQueue} requests=${requests} onClaim=${claim} onDismiss=${dismiss} />
    </div>`;
}

/* ============================================================
   Recipes tab
   ============================================================ */

function RecipesTab({ household, mine, library, catalog, reload, onOpen }) {
  const [editing, setEditing] = useState(null);
  const [view, setView] = useState("mine");
  const [busy, setBusy] = useState("");
  const [photosOnly, setPhotosOnly] = useState(false);
  const [search, setSearch] = useState("");

  const remove = async (r) => {
    if (!confirm(`Delete "${r.title}"? Meals already on the calendar will go too.`)) return;
    await sb.from("recipes").delete().eq("id", r.id);
    logActivity(household, `deleted ${r.title}`);
    reload();
  };

  const copy = async (r) => {
    setBusy(r.id);
    const { data: full } = await sb.from("recipes")
      .select("*, recipe_ingredients(*)").eq("id", r.id).single();
    const { data: made, error } = await sb.from("recipes").insert({
      household_id: household.id,
      title: full.title,
      servings: full.servings,
      instructions: full.instructions,
      source_url: full.source_url,
      is_public: false,
      forked_from: full.id,
    }).select().single();
    if (!error && full.recipe_ingredients?.length) {
      await sb.from("recipe_ingredients").insert(
        full.recipe_ingredients.map((i) => ({
          recipe_id: made.id,
          ingredient_id: i.ingredient_id,
          quantity: i.quantity,
          unit: i.unit,
          note: i.note,
          sort_order: i.sort_order,
        })));
    }
    setBusy("");
    setView("mine");
    reload();
  };

  const own = view === "mine";
  const pool = own ? mine : library;
  const searched = search.trim()
    ? pool.filter((r) => scoreRecipe(r, search.trim()))
    : pool;
  const shown = photosOnly
    ? searched.filter((r) => photoVisible(r, own))
    : searched;
  const withPhotos = pool.filter((r) => photoVisible(r, own)).length;

  return html`
    <div>
      <div class="row wrap" style="margin-bottom:12px">
        <button class=${"btn sm " + (own ? "" : "ghost")}
          onClick=${() => setView("mine")}>Ours (${mine.length})</button>
        <button class=${"btn sm " + (!own ? "" : "ghost")}
          onClick=${() => setView("library")}>Library (${library.length})</button>
        <span class="spacer"></span>
        <button class="btn sm" onClick=${() => setEditing({})}>New recipe</button>
      </div>

      ${pool.length > 6 && html`
        <input class="picksearch" type="text" value=${search}
          placeholder=${`Search ${pool.length} recipes, or an ingredient`}
          onInput=${(e) => setSearch(e.target.value)}
          style="margin-bottom:12px" />`}

      ${withPhotos > 0 && html`
        <div class="row small" style="margin:-2px 0 14px">
          <button class=${"btn sm " + (photosOnly ? "" : "ghost")}
            onClick=${() => setPhotosOnly(!photosOnly)}>
            With photos (${withPhotos})
          </button>
          ${photosOnly && html`<span class="muted">Showing only the ones
            somebody has actually cooked.</span>`}
        </div>`}

      ${!shown.length && html`
        <div class="empty">
          <p>${search.trim()
            ? `Nothing matches “${search.trim()}”.`
            : photosOnly
              ? "No photos here yet. Cook something and add one."
              : own
                ? "Nothing here yet. Add a recipe, or copy one from the library."
                : "The library is empty. Share one of yours to start it off."}</p>
        </div>`}

      <div class="recipes">
        ${shown.map((r) => html`
          <div class="recipe" key=${r.id}>
            ${photoVisible(r, own) && html`
              <img class="shot" src=${photoUrl(r.image_path)} alt=""
                loading="lazy" onClick=${() => onOpen(r, own)} />`}
            <h3><button class="titlelink"
              onClick=${() => onOpen(r, own)}>${r.title}</button></h3>
            <div class="meta">Serves ${r.servings} ·
              ${r.recipe_ingredients?.length || 0} ingredients</div>
            <div class="row wrap" style="margin-top:11px">
              ${r.is_public && html`<span class="pill pub">Shared</span>`}
              ${r.forked_from && html`<span class="pill">Copy</span>`}
              <span class="spacer"></span>
              ${view === "mine"
                ? html`
                  <button class="btn ghost sm" onClick=${() => setEditing(r)}>Edit</button>
                  <button class="btn quiet" onClick=${() => remove(r)}>Delete</button>`
                : html`
                  <button class="btn sm" disabled=${busy === r.id}
                    onClick=${() => copy(r)}>
                    ${busy === r.id ? "Copying…" : "Save to ours"}
                  </button>`}
            </div>
          </div>`)}
      </div>

      ${editing && html`<${RecipeEditor} household=${household}
        recipe=${editing.id ? editing : null} catalog=${catalog}
        onClose=${() => setEditing(null)}
        onSaved=${() => { setEditing(null); reload(); }} />`}
    </div>`;
}

/* ============================================================
   List tab
   ============================================================ */

function ListTab({ household, week, setWeek, needs, saved, pantry, aisles, reload }) {
  const [system, setSystem] = useState(
    () => normaliseSystem(localStorage.getItem("sm-units")));
  const [tidy, setTidy] = useState(false);
  const [adding, setAdding] = useState("");

  const setSystemSticky = (v) => {
    setSystem(v);
    try { localStorage.setItem("sm-units", v); } catch { /* private mode */ }
  };

  const grouped = useMemo(
    () => buildList(needs, saved, pantry), [needs, saved, pantry]);

  const order = useMemo(() => {
    const rank = new Map(aisles.map((a) => [a.name, a.sort_order]));
    return [...grouped.keys()].sort((a, b) => {
      if (a === "Added by hand") return 1;
      if (b === "Added by hand") return -1;
      return (rank.get(a) ?? 500) - (rank.get(b) ?? 500);
    });
  }, [grouped, aisles]);

  const total = [...grouped.values()].flat();
  const stocked = total.filter((r) => r.have?.status === "plenty");
  const needed = total.filter((r) => r.have?.status !== "plenty");
  const left = needed.filter((r) => !r.checked).length;

  const tick = async (row, checked) => {
    if (row.manual) {
      await sb.from("list_items").update({ checked }).eq("id", row.id);
    } else {
      await sb.from("list_items").upsert({
        household_id: household.id,
        week_start: iso(week),
        ingredient_id: row.ingredient_id,
        checked,
      }, { onConflict: "household_id,week_start,ingredient_id" });

      // Bought it, so you have it. This is what keeps the pantry current
      // without anyone maintaining it deliberately.
      if (checked && row.ingredient_id) {
        await sb.from("pantry_items").upsert({
          household_id: household.id,
          ingredient_id: row.ingredient_id,
          status: "plenty",
          updated_at: new Date().toISOString(),
        }, { onConflict: "household_id,ingredient_id" });
      }
    }
    reload();
  };

  const addByHand = async () => {
    const text = adding.trim();
    if (!text) return;
    setAdding("");
    await sb.from("list_items").insert({
      household_id: household.id,
      week_start: iso(week),
      custom_name: text,
      is_manual: true,
    });
    reload();
  };

  const dropManual = async (row) => {
    await sb.from("list_items").delete().eq("id", row.id);
    reload();
  };

  const setAisle = async (row, aisle) => {
    await sb.from("ingredients").update({ aisle }).eq("id", row.ingredient_id);
    reload();
  };

  const clearTicks = async () => {
    await sb.from("list_items").delete()
      .eq("household_id", household.id).eq("week_start", iso(week))
      .eq("is_manual", false);
    reload();
  };

  return html`
    <div>
      <div class="weeknav">
        <button class="navarrow" onClick=${() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button>
        <button class="navarrow" onClick=${() => setWeek(addDays(week, 7))} aria-label="Next week">›</button>
        <span class="label">${spanLabel(week)}</span>
      </div>

      ${!total.length
        ? html`<div class="empty">
            <p>Nothing to buy for this week. Put some meals on the plan and
              the list fills in on its own.</p>
          </div>`
        : html`
          <div class="listbar">
            <span class="tally">${left} of ${needed.length} left</span>
            ${stocked.length > 0 && html`
              <span class="tally have">${stocked.length} in the pantry</span>`}
            <span class="spacer"></span>
            <label class="unitpick">
              <span class="sr">Show amounts in</span>
              <select value=${system}
                onChange=${(e) => setSystemSticky(e.target.value)}>
                ${SYSTEMS.map((s) => html`
                  <option value=${s.key}>${s.label}</option>`)}
              </select>
            </label>
            <button class="btn quiet" onClick=${() => setTidy(!tidy)}>
              ${tidy ? "Done tidying" : "Fix aisles"}
            </button>
            <button class="btn quiet" onClick=${clearTicks}>Uncheck all</button>
          </div>

          ${order.map((aisle) => html`
            <div key=${aisle}>
              <div class="aisle">
                <span class="name">${aisle}</span>
                <span class="count num">${grouped.get(aisle).length}</span>
              </div>
              ${grouped.get(aisle).map((row) => {
                const q = row.manual
                  ? { n: row.qty ? trim(row.qty) : "", u: row.unit || "" }
                  : row.literal
                    ? { n: trim(row.qty), u: row.unit }
                    : showQty(row.qty, row.unit, system);
                const stock = row.have?.status;
                return html`
                <div class=${"line" + (row.checked ? " done" : "")
                    + (stock === "plenty" ? " stocked" : "")} key=${row.key}>
                  <input class="tick" type="checkbox" checked=${row.checked}
                    aria-label=${row.name}
                    onChange=${(e) => tick(row, e.target.checked)} />
                  <span class="what">${row.name}</span>
                  ${stock === "plenty" && html`<span class="stocktag">have it</span>`}
                  ${stock === "low" && html`<span class="stocktag low">running low</span>`}
                  <span class="leader"></span>
                  ${tidy && row.ingredient_id
                    ? html`
                      <select style="width:auto;padding:4px 6px;font-size:13px"
                        value=${row.aisle}
                        onChange=${(e) => setAisle(row, e.target.value)}>
                        ${aisles.map((a) => html`<option value=${a.name}>${a.name}</option>`)}
                      </select>`
                    : html`
                      <span class="qty">
                        <b>${qtyNodes(q.n)}</b>${q.u && html`<i>${q.u}</i>`}
                      </span>`}
                  ${row.manual && html`<button class="kill" title="Remove"
                    onClick=${() => dropManual(row)}>×</button>`}
                </div>
                ${row.literal && !tidy && html`
                  <div class="small muted" style="padding:0 4px 8px 33px">
                    Kept as written — “${row.unit}” can't be converted for this
                    ingredient, so it isn't merged with other amounts.
                  </div>`}`;
              })}
            </div>`)}`}

      <div class="row" style="margin-top:26px">
        <input type="text" value=${adding} placeholder="Add something by hand"
          onInput=${(e) => setAdding(e.target.value)}
          onKeyDown=${(e) => e.key === "Enter" && addByHand()} />
        <button class="btn sm" onClick=${addByHand}>Add</button>
      </div>
    </div>`;
}

/* ============================================================
   Root
   ============================================================ */

function App() {
  const [session, setSession] = useState(undefined);
  const [household, setHousehold] = useState(undefined);
  const [tab, setTab] = useState("plan");
  const [week, setWeek] = useState(() => weekStart(new Date()));
  const [viewing, setViewing] = useState(null);
  const [editingFromView, setEditingFromView] = useState(null);
  const [planThis, setPlanThis] = useState(null);
  const [showActivity, setShowActivity] = useState(false);

  const [recipes, setRecipes] = useState([]);
  const [library, setLibrary] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [aisles, setAisles] = useState([]);
  const [meals, setMeals] = useState([]);
  const [needs, setNeeds] = useState([]);
  const [saved, setSaved] = useState([]);
  const [pantry, setPantry] = useState(() => new Map());
  const [locations, setLocations] = useState([]);
  const [recency, setRecency] = useState(() => new Map());
  const [requests, setRequests] = useState([]);
  const [fault, setFault] = useState("");

  /* --- session --- */
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) setHousehold(undefined);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  /* --- household --- */
  useEffect(() => {
    if (!session) return;
    let dead = false;
    (async () => {
      const { data, error } = await sb.from("household_members")
        .select("role, households(*)").eq("user_id", session.user.id);
      if (dead) return;
      if (error) { setFault(error.message); return; }
      setHousehold(data?.[0]?.households || null);
    })();
    return () => { dead = true; };
  }, [session]);

  /* --- data --- */
  const load = useCallback(async () => {
    if (!household) return;
    const from = iso(week);
    const to = iso(addDays(week, 6));

    const [r, l, c, a, m, n, s, p, h, pl, rq] = await Promise.all([
      sb.from("recipes").select("*, recipe_ingredients(*, ingredients(*))")
        .eq("household_id", household.id).order("title"),
      sb.from("recipes").select("*, recipe_ingredients(*, ingredients(*))")
        .eq("is_public", true).neq("household_id", household.id).order("title"),
      sb.from("ingredients").select("id, name, aisle, canonical_unit").order("name"),
      sb.from("aisles").select("*").order("sort_order"),
      sb.from("meal_plan").select("*, recipes(id, title, servings)")
        .eq("household_id", household.id).gte("scheduled_on", from).lte("scheduled_on", to),
      sb.from("grocery_needs").select("*")
        .eq("household_id", household.id).gte("scheduled_on", from).lte("scheduled_on", to),
      sb.from("list_items").select("*")
        .eq("household_id", household.id).eq("week_start", from),
      sb.from("pantry_items").select("*")
        .eq("household_id", household.id),
      sb.from("meal_plan").select("recipe_id, scheduled_on")
        .eq("household_id", household.id)
        .order("scheduled_on", { ascending: false }).limit(120),
      sb.from("pantry_locations").select("*")
        .eq("household_id", household.id).order("sort_order"),
      sb.from("meal_requests").select("*, recipes(id, title, servings)")
        .eq("household_id", household.id)
        .order("requested_for", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true }),
    ]);

    const bad = [r, l, c, a, m, n, s, p, h, pl, rq].find((x) => x.error);
    if (bad) { setFault(bad.error.message); return; }
    setFault("");
    setRecipes(r.data || []);
    setLibrary(l.data || []);
    setCatalog(c.data || []);
    setAisles(a.data || []);
    setMeals(m.data || []);
    setNeeds(n.data || []);
    setSaved(s.data || []);
    setPantry(new Map((p.data || []).map((x) => [x.ingredient_id, x])));
    setLocations(pl.data || []);
    setRequests(rq.data || []);

    // Rank by how recently each recipe was last on the calendar, so the
    // picker opens on what this household actually cooks.
    const seen = new Map();
    for (const row of h.data || []) {
      if (!seen.has(row.recipe_id)) seen.set(row.recipe_id, seen.size);
    }
    setRecency(seen);
  }, [household, week]);

  useEffect(() => { load(); }, [load]);

  /* --- live sync between devices --- */
  useEffect(() => {
    if (!household) return;
    const ch = sb.channel(`household:${household.id}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "list_items",
          filter: `household_id=eq.${household.id}` }, load)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "meal_plan",
          filter: `household_id=eq.${household.id}` }, load)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "meal_tweaks" }, load)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "pantry_items",
          filter: `household_id=eq.${household.id}` }, load)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "pantry_locations",
          filter: `household_id=eq.${household.id}` }, load)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "meal_requests",
          filter: `household_id=eq.${household.id}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [household, load]);

  if (session === undefined) return html`<div class="spin">Loading…</div>`;
  if (!session) return html`<${Gate} />`;
  if (household === undefined) return html`<div class="spin">Loading…</div>`;
  if (household === null) return html`<${Onboard} onReady=${setHousehold} />`;

  const unchecked = (() => {
    const g = buildList(needs, saved, pantry);
    return [...g.values()].flat()
      .filter((r) => !r.checked && r.have?.status !== "plenty").length;
  })();

  return html`
    <div>
      <div class="topbar">
        <span class="wordmark">Simple<em>Meals</em></span>
        <span class="who">
          ${household.name}
          <button onClick=${() => setShowActivity(true)}>Activity</button>
          <button onClick=${() => sb.auth.signOut()}>Sign out</button>
        </span>
      </div>

      ${showActivity && html`<${ActivityPanel} household=${household}
        onClose=${() => setShowActivity(false)} />`}

      <nav class="tabs four">
        <button aria-current=${String(tab === "plan")} onClick=${() => setTab("plan")}>
          Plan${requests.length ? html`<span class="badge">${requests.length}</span>` : null}
        </button>
        <button aria-current=${String(tab === "recipes")} onClick=${() => setTab("recipes")}>Recipes</button>
        <button aria-current=${String(tab === "pantry")} onClick=${() => setTab("pantry")}>Pantry</button>
        <button aria-current=${String(tab === "list")} onClick=${() => setTab("list")}>
          List${unchecked ? html`<span class="badge">${unchecked}</span>` : null}
        </button>
      </nav>

      <main>
        <${Problem} text=${fault} />

        ${tab === "plan" && html`<${PlanTab} household=${household}
          recipes=${recipes} recency=${recency} meals=${meals}
          week=${week} setWeek=${setWeek} reload=${load}
          planThis=${planThis} onPlanned=${() => setPlanThis(null)}
          requests=${requests} reloadRequests=${load}
          onOpen=${(r, m, adjust) => r
            && setViewing({ recipe: r, own: true, meal: m, adjust })} />`}

        ${tab === "recipes" && html`<${RecipesTab} household=${household}
          mine=${recipes} library=${library} catalog=${catalog} reload=${load}
          onOpen=${(r, own) => setViewing({ recipe: r, own })} />`}

        ${tab === "pantry" && html`<${PantryTab} household=${household}
          pantry=${pantry} catalog=${catalog} locations=${locations}
          recipes=${recipes} recency=${recency} reload=${load}
          onPlan=${(r) => { setTab("plan"); setPlanThis(r); }} />`}

        ${tab === "list" && html`<${ListTab} household=${household}
          week=${week} setWeek=${setWeek} needs=${needs} saved=${saved}
          pantry=${pantry} aisles=${aisles} reload=${load} />`}

        ${tab === "recipes" && html`
          <h2 class="sign">Invite someone</h2>
          <div class="card small">
            Share this code so they can join ${household.name}:
            <strong class="num" style="font-size:17px;letter-spacing:.1em">
              ${household.join_code}</strong>
            <div class="muted" style="margin-top:6px">They pick “Join one” when
              they first sign in. Anyone with the code can see and edit your
              recipes, plan, and list.</div>
          </div>`}
      </main>

      ${viewing && html`<${RecipeViewer} recipe=${viewing.recipe}
        own=${viewing.own} meal=${viewing.meal}
        household=${household} catalog=${catalog} pantry=${pantry}
        onClose=${() => setViewing(null)}
        onChanged=${load}
        onEdit=${() => { setEditingFromView(viewing.recipe); setViewing(null); }} />`}

      ${editingFromView && html`<${RecipeEditor} household=${household}
        recipe=${editingFromView} catalog=${catalog}
        onClose=${() => setEditingFromView(null)}
        onSaved=${() => { setEditingFromView(null); load(); }} />`}
    </div>`;
}

render(html`<${App} />`, document.getElementById("root"));