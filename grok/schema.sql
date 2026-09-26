-- SecondLife Grok path: Shortcut -> Supabase -> Grok Bot -> Mac worker publishes.
-- Paste into Supabase dashboard > SQL Editor > Run. Safe to re-run.

create table if not exists public.grok_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'new'
    check (status in ('new','researching','ready','publishing','live','drafted','needs_you','failed')),
  size text, condition text, flaws text,
  photo_paths text[] not null default '{}',   -- paths in storage bucket "intake"
  dossier jsonb,        -- Grok Bot: identity, RRP, condition, sources
  ebay jsonb,           -- Grok Bot: title, description, category query, price range, comps
  vinted jsonb,         -- Grok Bot: Vinted title, fields, price
  result jsonb,         -- Mac worker: listing_id, url, draft status
  error text,
  bot_notes text
);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists grok_items_touch on public.grok_items;
create trigger grok_items_touch before update on public.grok_items
  for each row execute function public.touch_updated_at();

alter table public.grok_items enable row level security;

-- The phone (anon key) may only create new items. It cannot read, change or delete anything.
drop policy if exists "phone inserts new items" on public.grok_items;
create policy "phone inserts new items" on public.grok_items
  for insert to anon with check (status = 'new' and dossier is null and ebay is null and vinted is null and result is null);

-- Photos: private bucket; the phone may only upload.
insert into storage.buckets (id, name, public) values ('intake', 'intake', false)
  on conflict (id) do nothing;
drop policy if exists "phone uploads photos" on storage.objects;
create policy "phone uploads photos" on storage.objects
  for insert to anon with check (bucket_id = 'intake');

-- The Grok Bot and the Mac worker use the service role key, which bypasses RLS.
do $$ begin
  alter publication supabase_realtime add table public.grok_items;
exception when duplicate_object then null; end $$;
