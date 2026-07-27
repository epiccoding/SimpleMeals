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
  if (canonUnit === "count") return String(Math.ceil(q - 0.001));

  if (system === "metric") {
    if (canonUnit === "g") {
      return q >= 1000 ? `${trim(q / 1000)} kg` : `${Math.round(q)} g`;
    }
    return q >= 1000 ? `${trim(q / 1000)} L` : `${Math.round(q)} ml`;
  }

  if (canonUnit === "g") {
    const oz = q / MASS.oz;
    if (oz >= 16) return `${trim(Math.round((oz / 16) * 20) / 20)} lb`;
    if (oz >= 1) return `${frac(oz)} oz`;
    return `${Math.round(q)} g`;
  }
  if (q >= VOL.cup * 0.75) return `${frac(q / VOL.cup)} cup`;
  if (q >= VOL.tbsp) return `${frac(q / VOL.tbsp)} tbsp`;
  return `${frac(q / VOL.tsp)} tsp`;
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

function Sheet({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  return html`
    <div class="veil" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" tabindex="-1" ref=${ref}>
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

  const resolve = async (name, unit) => {
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
  };

  const save = async () => {
    const usable = rows.filter((r) => r.name.trim() && Number(r.quantity) > 0);
    if (!title.trim()) { setErr("Give the recipe a name."); return; }
    if (!usable.length) { setErr("Add at least one ingredient with a quantity."); return; }

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
          quantity: Number(r.quantity),
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

      <p class="sign muted" style="font-size:13px;margin:18px 0 8px">Ingredients</p>
      ${rows.map((r, i) => html`
        <div class="ing" key=${i}>
          <input class="n" type="text" list="known-ingredients" value=${r.name}
            placeholder="Ingredient"
            onInput=${(e) => setRow(i, { name: e.target.value })} />
          <input class="q" type="number" step="any" min="0" value=${r.quantity}
            placeholder="Qty"
            onInput=${(e) => setRow(i, { quantity: e.target.value })} />
          <select class="u" value=${r.unit}
            onChange=${(e) => setRow(i, { unit: e.target.value })}>
            ${UNITS.map((u) => html`<option value=${u}>${u}</option>`)}
          </select>
          <button class="d btn quiet" title="Remove"
            onClick=${() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</button>
        </div>`)}
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

  const save = async () => {
    if (!recipeId) { setErr("Pick a recipe first."); return; }
    setBusy(true); setErr("");
    const { error } = await sb.from("meal_plan").insert({
      household_id: household.id,
      recipe_id: recipeId,
      scheduled_on: when,
      meal_slot: slot,
      servings: Number(servings) || 4,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onSaved();
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
      <div class="row" style="margin-top:14px">
        <button class="btn" disabled=${busy} onClick=${save}>
          ${busy ? "Adding…" : "Add to plan"}
        </button>
        <button class="btn ghost" onClick=${onClose}>Cancel</button>
      </div>
    <//>`;
}

/* ============================================================
   Plan tab
   ============================================================ */

function PlanTab({ household, recipes, meals, week, setWeek, reload }) {
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
        <span class="spacer"></span>
        <button class="btn sm" onClick=${() => setPicker({ date: today })}>Add meal</button>
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
                  <div class="slot">${m.meal_slot}</div>
                  <div>${m.recipes?.title || "—"}</div>
                  <div class="srv">${m.servings} servings</div>
                </div>`)}
              <button class="add" onClick=${() => setPicker({ date: key })}>+ meal</button>
            </div>`;
        })}
      </div>

      ${picker && html`<${MealPicker} household=${household} recipes=${recipes}
        date=${picker.date} preselect=${picker.recipeId}
        onClose=${() => setPicker(null)}
        onSaved=${() => { setPicker(null); reload(); }} />`}
    </div>`;
}

/* ============================================================
   Recipes tab
   ============================================================ */

function RecipesTab({ household, mine, library, catalog, reload }) {
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
                loading="lazy" />`}
            <h3>${r.title}</h3>
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
          <div class="row small muted" style="margin-bottom:4px">
            <span class="num">${left} of ${total.length} left</span>
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
              ${grouped.get(aisle).map((row) => html`
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
                      <span class="qty">${row.manual
                        ? (row.qty ? `${trim(row.qty)} ${row.unit}` : "")
                        : row.literal
                          ? `${trim(row.qty)} ${row.unit}`
                          : showQty(row.qty, row.unit, system)}</span>`}
                  ${row.manual && html`<button class="kill" title="Remove"
                    onClick=${() => dropManual(row)}>×</button>`}
                </div>
                ${row.literal && !tidy && html`
                  <div class="small muted" style="padding:0 4px 8px 33px">
                    Kept as written — “${row.unit}” can't be converted for this
                    ingredient, so it isn't merged with other amounts.
                  </div>`}`)}
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
      sb.from("recipes").select("*, recipe_ingredients(id)")
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
          reload=${load} />`}

        ${tab === "recipes" && html`<${RecipesTab} household=${household}
          mine=${recipes} library=${library} catalog=${catalog} reload=${load} />`}

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
    </div>`;
}

render(html`<${App} />`, document.getElementById("root"));