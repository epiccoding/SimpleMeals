# SimpleMeals

Plan meals on a shared calendar; the grocery list assembles itself from
whatever's planned, scaled to the servings you actually cooking for, summed
across recipes, and grouped by supermarket aisle.

Built as static files — no build step, no bundler, no `npm install`. Deployed
on GitHub Pages with Supabase for data and sign-in.

## Files

| File | What it is |
|---|---|
| `index.html` | Shell and all styling |
| `app.js` | The whole application (Preact + htm via CDN) |
| `config.js` | Supabase project URL and publishable key |
| `schema.sql` | Tables, RLS policies, unit conversion, aggregation view |
| `patch.sql` | Invite codes, household bootstrap functions, list uniqueness |

## Setup

1. In Supabase → SQL Editor, run `schema.sql`, then `patch.sql`.
2. Authentication → Sign In / Providers: enable **Email**, and **Google** if
   you've created OAuth credentials for it.
3. Authentication → URL Configuration → Redirect URLs: add the Pages URL,
   e.g. `https://epiccoding.github.io/SimpleMeals/`.
4. Push these files to the repo root. Settings → Pages → Deploy from a branch
   → `main` → `/ (root)`.

## How the quantities work

Each ingredient has a canonical unit (`g`, `ml`, or `count`) plus optional
density and per-item weight. `convert_to_canonical()` normalises every recipe
line into that unit, so ¼ cup butter and 2 tbsp butter add up correctly.

When a conversion isn't possible — no density recorded, incompatible unit — the
function returns null rather than guessing, and the list shows that amount as
its own line instead of silently dropping it. Fix it by filling in
`grams_per_ml` or `grams_per_count` on the ingredient.

Ingredients that come in genuinely different forms are separate records with
separate canonical units, which is why garlic cloves never merge with garlic
powder.

## Security notes

The publishable key in `config.js` is public by design; it ships inside the
JavaScript on a public site. Row Level Security is the actual protection:

- Recipes are readable if `is_public` or you're in the owning household.
- Writes are always household-scoped, so browsing the library can't mutate
  anyone else's recipe. "Save to ours" makes a copy.
- Meal plans, lists, and pantry staples are household-only, no public read.

Never put a `service_role` or `secret` key in this repo. Those bypass RLS.

Anyone holding a household's invite code gets full read/write on that
household. Treat it like a password rather than a username.
