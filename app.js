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

/** Render a canonical quantity in units a person would shop in. */
function showQty(qty, canonUnit, system) {
  const q = Number(qty);
  if (canonUnit === "count") return { n: String(Math.ceil(q - 0.001)), u: "" };

  if (system === "metric") {
    if (canonUnit === "g") {
      return q >= 1000
        ? { n: trim(q / 1000), u: "kg" }
        : { n: String(Math.round(q)), u: "g" };
    }
    return q >= 1000
      ? { n: trim(q / 1000), u: "L" }
      : { n: String(Math.round(q)), u: "ml" };
  }

  if (canonUnit === "g") {
    const oz = q / MASS.oz;
    if (oz >= 16) return { n: trim(Math.round((oz / 16) * 20) / 20), u: "lb" };
    if (oz >= 1) return { n: frac(oz), u: "oz" };
    return { n: String(Math.round(q)), u: "g" };
  }
  if (q >= VOL.cup * 0.75) return { n: frac(q / VOL.cup), u: "cup" };
  if (q >= VOL.tbsp) return { n: frac(q / VOL.tbsp), u: "tbsp" };
  return { n: frac(q / VOL.tsp), u: "tsp" };
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

/** Parse one written line into editor fields. Returns null if unusable. */
function parseLine(line, catalog) {
  if (!line || !line.trim()) return null;

  let text = unvulgar(line)
    .replace(/^[-–—*•\d]+[.)]?\s+/, (m) => (/^\d/.test(m.trim()) ? m : ""))
    .trim();

  const notes = [];

  // Trailing or inline parenthetical is a note, not a name
  text = text.replace(/\(([^)]*)\)/g, (_, inner) => {
    notes.push(inner.trim());
    return " ";
  }).replace(/\s+/g, " ").trim();

  const num = readNumber(text);
  const un = readUnit(num.rest);

  let rest = un.rest.replace(/^\s*(of|de)\s+/i, "").trim();

  // Anything after the first comma is preparation
  const comma = rest.indexOf(",");
  if (comma > -1) {
    notes.push(rest.slice(comma + 1).trim());
    rest = rest.slice(0, comma).trim();
  }

  if (/\bto taste\b/i.test(rest)) {
    notes.push("to taste");
    rest = rest.replace(/\bto taste\b/i, "").trim();
  }

  rest = rest.replace(/[.;]+$/, "").trim();
  if (!rest) return null;

  const match = matchCatalog(rest, catalog);

  // "2 cloves garlic" should find the existing "garlic clove"
  let unit = un.unit;
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
    qty: num.qty === null ? 1 : num.qty,
    unit,
    name,
    note: notes.filter(Boolean).join(", "),
    matched: hit,
    suggest,
    guessedQty: num.qty === null,
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

/* ============================================================
   Grocery aggregation
   ============================================================ */

function buildList(needs, saved, pantry) {
  const skip = new Set(pantry);
  const byIngredient = new Map();
  const unconverted = new Map();

  for (const n of needs) {
    if (skip.has(n.ingredient_id)) continue;

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
  }));

  const all = [...generated, ...added];
  const aisles = new Map();
  for (const row of all) {
    if (!aisles.has(row.aisle)) aisles.set(row.aisle, []);
    aisles.get(row.aisle).push(row);
  }
  for (const rows of aisles.values()) {
    rows.sort((a, b) => a.name.localeCompare(b.name));
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

function RecipeViewer({ recipe, own, meal, household, catalog, onClose, onEdit, onChanged }) {
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
      onClose();
    } catch (e) {
      setErr(e.message || "Could not create the recipe.");
    } finally {
      setSaving("");
    }
  };

  const tweakCount = [...tweaks.values()].filter((t) => t.removed || t.quantity != null).length;

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
              return html`
                <label class=${"cookline" + (got ? " done" : "")} key=${l.id}>
                  <input type="checkbox" class="tick" checked=${got}
                    onChange=${() => toggle(added, l.id, setAdded)} />
                  <span class="amt num">
                    <b>${qtyNodes(a.n)}</b>${a.u && html`<i>${a.u}</i>`}
                  </span>
                  <span class="ingname">
                    ${l.ingredients?.name || "—"}
                    ${l.fixed && html`<em class="prep">set for this meal</em>`}
                    ${l.note && html`<em class="prep">${l.note}</em>`}
                  </span>
                </label>`;
            })}
            ${!effective.length && html`<p class="muted small">No ingredients listed.</p>`}
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
    const parsed = parseLine(row.name, catalog);
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
   Add a meal to the calendar
   ============================================================ */

function MealPicker({ household, recipes, date, preselect, onClose, onSaved }) {
  const [recipeId, setRecipeId] = useState(preselect || recipes[0]?.id || "");
  const [when, setWhen] = useState(date || iso(new Date()));
  const [slot, setSlot] = useState("dinner");
  const chosen = recipes.find((r) => r.id === recipeId);
  const [servings, setServings] = useState(chosen?.servings || 4);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
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
    setBusy(false);
    if (error) { setErr(error.message); return; }
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
    <${Sheet} title="Add a meal" onClose=${onClose}>
      <label class="field">
        <span>Recipe</span>
        <select value=${recipeId} onChange=${(e) => setRecipeId(e.target.value)}>
          ${recipes.map((r) => html`<option value=${r.id}>${r.title}</option>`)}
        </select>
      </label>
      <label class="field">
        <span>Date</span>
        <input type="date" value=${when} onInput=${(e) => setWhen(e.target.value)} />
      </label>
      <label class="field">
        <span>Meal</span>
        <select value=${slot} onChange=${(e) => setSlot(e.target.value)}>
          ${SLOTS.map((s) => html`<option value=${s}>${s}</option>`)}
        </select>
      </label>
      <label class="field" style="max-width:160px">
        <span>Serves</span>
        <input type="number" min="1" value=${servings}
          onInput=${(e) => setServings(e.target.value)} />
      </label>
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
   Plan tab
   ============================================================ */

function PlanTab({ household, recipes, meals, week, setWeek, reload, onOpen }) {
  const [picker, setPicker] = useState(null);
  const today = iso(new Date());

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

  const remove = async (id) => {
    await sb.from("meal_plan").delete().eq("id", id);
    reload();
  };

  return html`
    <div>
      <div class="weeknav">
        <button onClick=${() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button>
        <button onClick=${() => setWeek(addDays(week, 7))} aria-label="Next week">›</button>
        <span class="label">${spanLabel(week)}</span>
      </div>

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
              ${list.map((m) => html`
                <div class="meal" key=${m.id}>
                  <button class="kill" title="Remove"
                    onClick=${() => remove(m.id)}>×</button>
                  <button class="mealopen"
                    onClick=${() => onOpen(recipes.find((r) => r.id === m.recipe_id), m)}>
                    <span class="slot">${m.meal_slot}</span>
                    <span class="mealname">${m.recipes?.title || "—"}</span>
                    <span class="srv">${m.servings} servings</span>
                  </button>
                </div>`)}
              <button class="add" onClick=${() => setPicker({ date: key })}>+ meal</button>
            </div>`;
        })}
      </div>

      ${picker && html`<${MealPicker} household=${household} recipes=${recipes}
        date=${picker.date} preselect=${picker.recipeId}
        onClose=${() => setPicker(null)}
        onSaved=${(created) => {
          setPicker(null);
          reload();
          if (created) {
            onOpen(recipes.find((r) => r.id === created.recipe_id), created, true);
          }
        }} />`}
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

  const remove = async (r) => {
    if (!confirm(`Delete "${r.title}"? Meals already on the calendar will go too.`)) return;
    await sb.from("recipes").delete().eq("id", r.id);
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
  const shown = photosOnly
    ? pool.filter((r) => photoVisible(r, own))
    : pool;
  const withPhotos = pool.filter((r) => photoVisible(r, own)).length;

  return html`
    <div>
      <div class="row wrap" style="margin-bottom:16px">
        <button class=${"btn sm " + (own ? "" : "ghost")}
          onClick=${() => setView("mine")}>Ours (${mine.length})</button>
        <button class=${"btn sm " + (!own ? "" : "ghost")}
          onClick=${() => setView("library")}>Library (${library.length})</button>
        <span class="spacer"></span>
        <button class="btn sm" onClick=${() => setEditing({})}>New recipe</button>
      </div>

      ${withPhotos > 0 && html`
        <div class="row small" style="margin:-6px 0 14px">
          <button class=${"btn sm " + (photosOnly ? "" : "ghost")}
            onClick=${() => setPhotosOnly(!photosOnly)}>
            With photos (${withPhotos})
          </button>
          ${photosOnly && html`<span class="muted">Showing only the ones
            somebody has actually cooked.</span>`}
        </div>`}

      ${!shown.length && html`
        <div class="empty">
          <p>${photosOnly
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
    () => localStorage.getItem("sm-units") || "us");
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
  const left = total.filter((r) => !r.checked).length;

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

  const setStaple = async (row, always) => {
    if (always) {
      await sb.from("pantry_staples").insert({
        household_id: household.id, ingredient_id: row.ingredient_id,
      });
    } else {
      await sb.from("pantry_staples").delete()
        .eq("household_id", household.id).eq("ingredient_id", row.ingredient_id);
    }
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
        <button onClick=${() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button>
        <button onClick=${() => setWeek(addDays(week, 7))} aria-label="Next week">›</button>
        <span class="label">${spanLabel(week)}</span>
        <span class="spacer"></span>
        <button class="btn ghost sm"
          onClick=${() => setSystemSticky(system === "us" ? "metric" : "us")}>
          ${system === "us" ? "cups / lb" : "g / ml"}
        </button>
      </div>

      ${!total.length
        ? html`<div class="empty">
            <p>Nothing to buy for this week. Put some meals on the plan and
              the list fills in on its own.</p>
          </div>`
        : html`
          <div class="row small" style="margin-bottom:4px">
            <span class="tally">${left} of ${total.length} left</span>
            <span class="spacer"></span>
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
                return html`
                <div class=${"line" + (row.checked ? " done" : "")} key=${row.key}>
                  <input class="tick" type="checkbox" checked=${row.checked}
                    aria-label=${row.name}
                    onChange=${(e) => tick(row, e.target.checked)} />
                  <span class="what">${row.name}</span>
                  <span class="leader"></span>
                  ${tidy && row.ingredient_id
                    ? html`
                      <select style="width:auto;padding:4px 6px;font-size:13px"
                        value=${row.aisle}
                        onChange=${(e) => setAisle(row, e.target.value)}>
                        ${aisles.map((a) => html`<option value=${a.name}>${a.name}</option>`)}
                      </select>
                      <label class="small muted row" style="gap:4px">
                        <input type="checkbox"
                          onChange=${(e) => setStaple(row, e.target.checked)} />
                        always have
                      </label>`
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

  const [recipes, setRecipes] = useState([]);
  const [library, setLibrary] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [aisles, setAisles] = useState([]);
  const [meals, setMeals] = useState([]);
  const [needs, setNeeds] = useState([]);
  const [saved, setSaved] = useState([]);
  const [pantry, setPantry] = useState([]);
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

    const [r, l, c, a, m, n, s, p] = await Promise.all([
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
      sb.from("pantry_staples").select("ingredient_id")
        .eq("household_id", household.id),
    ]);

    const bad = [r, l, c, a, m, n, s, p].find((x) => x.error);
    if (bad) { setFault(bad.error.message); return; }
    setFault("");
    setRecipes(r.data || []);
    setLibrary(l.data || []);
    setCatalog(c.data || []);
    setAisles(a.data || []);
    setMeals(m.data || []);
    setNeeds(n.data || []);
    setSaved(s.data || []);
    setPantry((p.data || []).map((x) => x.ingredient_id));
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
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [household, load]);

  if (session === undefined) return html`<div class="spin">Loading…</div>`;
  if (!session) return html`<${Gate} />`;
  if (household === undefined) return html`<div class="spin">Loading…</div>`;
  if (household === null) return html`<${Onboard} onReady=${setHousehold} />`;

  const unchecked = (() => {
    const g = buildList(needs, saved, pantry);
    return [...g.values()].flat().filter((r) => !r.checked).length;
  })();

  return html`
    <div>
      <div class="topbar">
        <span class="wordmark">Simple<em>Meals</em></span>
        <span class="who">
          ${household.name}
          <button onClick=${() => sb.auth.signOut()}>Sign out</button>
        </span>
      </div>

      <nav class="tabs">
        <button aria-current=${String(tab === "plan")} onClick=${() => setTab("plan")}>Plan</button>
        <button aria-current=${String(tab === "recipes")} onClick=${() => setTab("recipes")}>Recipes</button>
        <button aria-current=${String(tab === "list")} onClick=${() => setTab("list")}>
          List${unchecked ? html`<span class="badge">${unchecked}</span>` : null}
        </button>
      </nav>

      <main>
        <${Problem} text=${fault} />

        ${tab === "plan" && html`<${PlanTab} household=${household}
          recipes=${recipes} meals=${meals} week=${week} setWeek=${setWeek}
          reload=${load}
          onOpen=${(r, m, adjust) => r
            && setViewing({ recipe: r, own: true, meal: m, adjust })} />`}

        ${tab === "recipes" && html`<${RecipesTab} household=${household}
          mine=${recipes} library=${library} catalog=${catalog} reload=${load}
          onOpen=${(r, own) => setViewing({ recipe: r, own })} />`}

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
        household=${household} catalog=${catalog}
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