-- ============================================================================
-- RANGREZA v4 — Supabase schema (replaces schema.sql from v3)
-- ============================================================================
-- Run ONCE: Supabase Dashboard -> SQL Editor -> New query -> paste all -> Run.
-- Safe to run again, and safe to run on a project that already ran the v3 file.
--
-- Three kinds of account, kept apart by profiles.role:
--   customer  signs up on the Shop portal, places orders, sees own orders
--   vendor    signs up on the Vendor portal, lists stock, sees orders for own shop
--   admin     NEVER self-signs-up. You promote one account by hand (SETUP_GUIDE
--             step 4). Approves vendors, moderates listings, sees every order.
--
-- Security choices worth knowing about (all enforced HERE, not in the browser,
-- because anyone can edit the HTML in their own browser):
--   * A new account can only become 'customer' or 'vendor' — never 'admin'.
--   * Nobody can change their own role, a vendor's approval status, or an
--     order's price. Those columns are not writable from the browser at all.
--   * Orders are created by the place_order() function, which reads the real
--     price from the database. The browser only sends item ids and quantities.
-- ============================================================================

-- ---------- PROFILES ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  role text not null default 'customer' check (role in ('customer','vendor','admin')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text := coalesce(new.raw_user_meta_data->>'role', 'customer');
begin
  -- Whatever the browser asks for, only these two roles can be self-assigned.
  if r not in ('customer','vendor') then r := 'customer'; end if;
  insert into public.profiles (id, full_name, phone, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), new.raw_user_meta_data->>'phone', r)
  on conflict (id) do nothing;
  return new;
end; $$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select
  using (auth.uid() = id or public.is_admin());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update using (auth.uid() = id);

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;   -- NOT role

-- ---------- VENDORS ----------
create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references public.profiles(id) on delete cascade,
  shop_name text not null,
  bazaar text, shop_number text, city text, address text,
  fulfillment text not null default 'pickup' check (fulfillment in ('pickup','online','both')),
  phone text,
  is_pilot boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
do $$ begin
  -- First run only: shops that already existed (from v3) stay visible. After that
  -- every NEW shop starts as 'pending' until an admin approves it.
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='vendors' and column_name='status') then
    alter table public.vendors add column status text not null default 'approved';
    alter table public.vendors alter column status set default 'pending';
  end if;
end $$;
alter table public.vendors drop constraint if exists vendors_status_check;
alter table public.vendors add constraint vendors_status_check check (status in ('pending','approved','suspended'));
alter table public.vendors enable row level security;

drop policy if exists vendors_select_public on public.vendors;
drop policy if exists vendors_select_v4 on public.vendors;
create policy vendors_select_v4 on public.vendors for select
  using ((status = 'approved' and is_active) or auth.uid() = user_id or public.is_admin());

drop policy if exists vendors_insert_own on public.vendors;
create policy vendors_insert_own on public.vendors for insert
  with check (auth.uid() = user_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'vendor'));

drop policy if exists vendors_update_own on public.vendors;
create policy vendors_update_own on public.vendors for update using (auth.uid() = user_id);

revoke all on public.vendors from anon, authenticated;
grant select on public.vendors to anon, authenticated;
grant insert (user_id, shop_name, bazaar, shop_number, city, address, fulfillment, phone)
  on public.vendors to authenticated;
grant update (shop_name, bazaar, shop_number, city, address, fulfillment, phone)
  on public.vendors to authenticated;                                  -- NOT status

-- ---------- INVENTORY ITEMS ----------
create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  name text not null,
  category text not null,
  price numeric not null check (price >= 0),
  unit text not null default 'yard',
  quantity integer not null default 0 check (quantity >= 0),
  stock_status text not null default 'in_stock'
    check (stock_status in ('in_stock','low_stock','pre_order','out_of_stock')),
  image_path text,
  dominant_hex text,
  palette jsonb,
  texture jsonb,
  analyzed_by text not null default 'client' check (analyzed_by in ('client','server')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- v4: CLIP vector (512 numbers) + style attributes (pattern, formality, ...)
alter table public.inventory_items add column if not exists embedding jsonb;
alter table public.inventory_items add column if not exists attrs jsonb;
alter table public.inventory_items drop constraint if exists inventory_items_category_check;
alter table public.inventory_items add constraint inventory_items_category_check
  check (category in ('Lace','Gota','Dabka','Buttons','Tassels','Trims','Beads','Motifs'));

create index if not exists ix_items_active_category on public.inventory_items (is_active, category);
create index if not exists ix_items_vendor on public.inventory_items (vendor_id);
alter table public.inventory_items enable row level security;

drop policy if exists items_select_public on public.inventory_items;
drop policy if exists items_select_v4 on public.inventory_items;
create policy items_select_v4 on public.inventory_items for select using (
  (is_active and exists (select 1 from public.vendors v
      where v.id = vendor_id and v.status = 'approved' and v.is_active))
  or exists (select 1 from public.vendors v where v.id = vendor_id and v.user_id = auth.uid())
  or public.is_admin());

drop policy if exists items_insert_own_shop on public.inventory_items;
create policy items_insert_own_shop on public.inventory_items for insert with check (
  exists (select 1 from public.vendors v where v.id = vendor_id and v.user_id = auth.uid()));
drop policy if exists items_update_own_shop on public.inventory_items;
create policy items_update_own_shop on public.inventory_items for update using (
  exists (select 1 from public.vendors v where v.id = vendor_id and v.user_id = auth.uid()));

revoke all on public.inventory_items from anon, authenticated;
grant select on public.inventory_items to anon, authenticated;
grant insert (vendor_id, name, category, price, unit, quantity, stock_status, image_path,
              dominant_hex, palette, texture, embedding, attrs, analyzed_by, is_active)
  on public.inventory_items to authenticated;
grant update (name, category, price, unit, quantity, stock_status, image_path,
              dominant_hex, palette, texture, embedding, attrs, analyzed_by, is_active)
  on public.inventory_items to authenticated;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_items_touch on public.inventory_items;
create trigger trg_items_touch before update on public.inventory_items
  for each row execute function public.touch_updated_at();

-- ---------- ORDERS (one per checkout) + ORDER_ITEMS (one per item, per vendor) ----------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.profiles(id) on delete set null,
  buyer_name text not null,
  buyer_phone text not null,
  buyer_email text,
  note text,
  total numeric not null default 0,
  created_at timestamptz not null default now()
);
alter table public.orders add column if not exists customer_id uuid references public.profiles(id) on delete set null;
alter table public.orders add column if not exists note text;
do $$ begin
  -- v3 stored the lines in a jsonb column; v4 uses the order_items table.
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='orders' and column_name='items') then
    alter table public.orders alter column items drop not null;
  end if;
end $$;
drop policy if exists orders_insert_anyone on public.orders;
alter table public.orders enable row level security;

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  item_id uuid references public.inventory_items(id) on delete set null,
  vendor_id uuid not null references public.vendors(id) on delete restrict,
  name text not null,
  unit text,
  qty integer not null check (qty > 0),
  price numeric not null check (price >= 0),
  status text not null default 'new' check (status in ('new','confirmed','ready','fulfilled','cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists ix_oi_order on public.order_items (order_id);
create index if not exists ix_oi_vendor on public.order_items (vendor_id);
alter table public.order_items enable row level security;

create or replace function public.owns_vendor(v uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.vendors where id = v and user_id = auth.uid());
$$;

-- orders and order_items each need to look at the other in their policies. Doing
-- that directly makes Postgres loop forever ("infinite recursion in policy"), so
-- the cross-table checks live in these two security-definer helpers instead.
create or replace function public.is_order_customer(o uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.orders where id = o and customer_id = auth.uid());
$$;
create or replace function public.vendor_has_line_in_order(o uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.order_items oi
                  join public.vendors v on v.id = oi.vendor_id
                 where oi.order_id = o and v.user_id = auth.uid());
$$;
revoke all on function public.is_order_customer(uuid), public.vendor_has_line_in_order(uuid) from public, anon;
grant execute on function public.is_order_customer(uuid), public.vendor_has_line_in_order(uuid) to authenticated;

drop policy if exists orders_select_v4 on public.orders;
create policy orders_select_v4 on public.orders for select using (
  customer_id = auth.uid() or public.is_admin() or public.vendor_has_line_in_order(id));

drop policy if exists oi_select_v4 on public.order_items;
create policy oi_select_v4 on public.order_items for select using (
  public.owns_vendor(vendor_id) or public.is_admin() or public.is_order_customer(order_id));

drop policy if exists oi_update_vendor on public.order_items;
create policy oi_update_vendor on public.order_items for update
  using (public.owns_vendor(vendor_id)) with check (public.owns_vendor(vendor_id));

revoke all on public.orders, public.order_items from anon, authenticated;
grant select on public.orders, public.order_items to authenticated;
grant update (status) on public.order_items to authenticated;

-- ---------- FUNCTIONS the browser is allowed to call ----------
-- Place an order. The browser sends [{item_id, qty}] only; price, vendor and
-- availability all come from the database.
create or replace function public.place_order(p_name text, p_phone text, p_email text, p_note text, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  oid uuid := gen_random_uuid(); rec jsonb; it record; q int; tot numeric := 0; n int := 0;
begin
  if auth.uid() is null then raise exception 'Please sign in to place an order.'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'customer') then
    raise exception 'Only customer accounts can place orders.'; end if;
  if coalesce(trim(p_name),'') = '' or coalesce(trim(p_phone),'') = '' then
    raise exception 'Name and phone are required.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your order is empty.'; end if;

  insert into public.orders (id, customer_id, buyer_name, buyer_phone, buyer_email, note, total)
  values (oid, auth.uid(), trim(p_name), trim(p_phone), nullif(trim(coalesce(p_email,'')),''), nullif(trim(coalesce(p_note,'')),''), 0);

  for rec in select * from jsonb_array_elements(p_items) loop
    q := greatest(1, least(99, coalesce((rec->>'qty')::int, 1)));
    select i.id, i.name, i.unit, i.price, i.vendor_id into it
      from public.inventory_items i join public.vendors v on v.id = i.vendor_id
     where i.id = (rec->>'item_id')::uuid and i.is_active and v.status = 'approved' and v.is_active
       and i.stock_status <> 'out_of_stock';
    if not found then raise exception 'An item in your order is no longer available.'; end if;
    insert into public.order_items (order_id, item_id, vendor_id, name, unit, qty, price)
    values (oid, it.id, it.vendor_id, it.name, it.unit, q, it.price);
    tot := tot + it.price * q; n := n + 1;
  end loop;

  update public.orders set total = tot where id = oid;
  return oid;
end; $$;

create or replace function public.customer_cancel_order_item(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.order_items oi set status = 'cancelled'
   where oi.id = p_id and oi.status = 'new'
     and exists (select 1 from public.orders o where o.id = oi.order_id and o.customer_id = auth.uid());
  if not found then raise exception 'This item can no longer be cancelled.'; end if;
end; $$;

-- Admin-only actions. Each re-checks is_admin() itself.
create or replace function public.admin_set_vendor_status(p_vendor uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_status not in ('pending','approved','suspended') then raise exception 'Bad status.'; end if;
  update public.vendors set status = p_status where id = p_vendor;
end; $$;

create or replace function public.admin_set_item_active(p_item uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  update public.inventory_items set is_active = p_active where id = p_item;
end; $$;

create or replace function public.admin_set_item_index(p_item uuid, p_embedding jsonb, p_attrs jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  update public.inventory_items set embedding = p_embedding, attrs = p_attrs where id = p_item;
end; $$;

create or replace function public.admin_set_order_item_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_status not in ('new','confirmed','ready','fulfilled','cancelled') then raise exception 'Bad status.'; end if;
  update public.order_items set status = p_status where id = p_id;
end; $$;

revoke all on function public.place_order(text,text,text,text,jsonb) from public, anon;
revoke all on function public.customer_cancel_order_item(uuid) from public, anon;
revoke all on function public.admin_set_vendor_status(uuid,text) from public, anon;
revoke all on function public.admin_set_item_active(uuid,boolean) from public, anon;
revoke all on function public.admin_set_item_index(uuid,jsonb,jsonb) from public, anon;
revoke all on function public.admin_set_order_item_status(uuid,text) from public, anon;
grant execute on function public.place_order(text,text,text,text,jsonb) to authenticated;
grant execute on function public.customer_cancel_order_item(uuid) to authenticated;
grant execute on function public.admin_set_vendor_status(uuid,text) to authenticated;
grant execute on function public.admin_set_item_active(uuid,boolean) to authenticated;
grant execute on function public.admin_set_item_index(uuid,jsonb,jsonb) to authenticated;
grant execute on function public.admin_set_order_item_status(uuid,text) to authenticated;


-- ---------- APP CONFIG (shared values, e.g. the CLIP label vectors) ----------
-- Everyone can read; only an admin can write (through the function below).
create table if not exists public.app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;
drop policy if exists config_read on public.app_config;
create policy config_read on public.app_config for select using (true);
revoke all on public.app_config from anon, authenticated;
grant select on public.app_config to anon, authenticated;

create or replace function public.admin_set_config(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  insert into public.app_config (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now();
end; $$;
revoke all on function public.admin_set_config(text,jsonb) from public, anon;
grant execute on function public.admin_set_config(text,jsonb) to authenticated;

-- ---------- STORAGE: vendor item photos ----------
insert into storage.buckets (id, name, public) values ('vendor-photos','vendor-photos', true)
on conflict (id) do nothing;
drop policy if exists vendor_photos_read on storage.objects;
create policy vendor_photos_read on storage.objects for select using (bucket_id = 'vendor-photos');
drop policy if exists vendor_photos_insert on storage.objects;
create policy vendor_photos_insert on storage.objects for insert with check (
  bucket_id = 'vendor-photos' and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Realtime ----------
do $$ declare t text; begin
  foreach t in array array['inventory_items','vendors','order_items'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

notify pgrst, 'reload schema';
