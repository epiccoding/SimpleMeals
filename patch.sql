-- ============================================================
-- SimpleMeals — patch 001
-- Run in Supabase SQL Editor after schema.sql.
-- ============================================================

-- ---------- Invite codes ----------

alter table households
  add column if not exists join_code text unique
  default encode(gen_random_bytes(4), 'hex');

update households set join_code = encode(gen_random_bytes(4), 'hex')
where join_code is null;

-- ---------- Bootstrap: create a household ----------
-- Needed because households_read requires membership, so a plain
-- insert().select() from the client returns nothing. This does both
-- writes in one transaction and hands back the row.

create or replace function create_household(p_name text)
returns households
language plpgsql
security definer
set search_path = public
as $$
declare h households;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Household needs a name';
  end if;

  insert into households (name) values (trim(p_name)) returning * into h;
  insert into household_members (household_id, user_id, role)
    values (h.id, auth.uid(), 'owner');
  return h;
end;
$$;

-- ---------- Bootstrap: join by code ----------

create or replace function join_household(p_code text)
returns households
language plpgsql
security definer
set search_path = public
as $$
declare h households;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;

  select * into h from households
    where join_code = lower(trim(p_code));
  if not found then
    raise exception 'No household matches that code';
  end if;

  insert into household_members (household_id, user_id)
    values (h.id, auth.uid())
    on conflict do nothing;
  return h;
end;
$$;

revoke execute on function create_household(text) from anon;
revoke execute on function join_household(text) from anon;

-- ---------- List item uniqueness ----------
-- One row per ingredient per week, so checking a box is an upsert
-- rather than a duplicate. Manual items carry a null ingredient_id
-- and custom_name instead; nulls never collide in a unique index,
-- so hand-added entries are exempt automatically.

create unique index if not exists list_items_generated_key
  on list_items (household_id, week_start, ingredient_id);

-- ---------- Aisle vocabulary ----------
-- Not enforced, just a shared list the UI offers so two people
-- don't type "Produce" and "produce" and get two headings.

create table if not exists aisles (
  name       text primary key,
  sort_order int not null default 100
);

alter table aisles enable row level security;

create policy aisles_read on aisles
  for select using (auth.uid() is not null);

insert into aisles (name, sort_order) values
  ('Produce', 10), ('Meat', 20), ('Seafood', 30), ('Dairy', 40),
  ('Bakery', 50), ('Frozen', 60), ('Pantry', 70), ('Baking', 80),
  ('Spices', 90), ('Beverages', 100), ('Household', 110), ('Other', 999)
on conflict (name) do nothing;
