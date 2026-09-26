-- Five Grok Bots working together. Each bot owns one status column. Safe to re-run.
alter table public.grok_items add column if not exists ebay_status text not null default 'waiting'
  check (ebay_status in ('waiting','pricing','ready','publishing','live','needs_you','failed'));
alter table public.grok_items add column if not exists vinted_status text not null default 'waiting'
  check (vinted_status in ('waiting','pricing','ready','drafting','drafted','needs_you','failed'));
alter table public.grok_items drop constraint if exists grok_items_status_check;
alter table public.grok_items add constraint grok_items_status_check
  check (status in ('new','researching','researched','needs_you','failed','ready','publishing','live','drafted'));

create table if not exists public.grok_inbox (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  kind text not null check (kind in ('question','offer')),
  ebay_ref text not null unique,          -- eBay message id or Best Offer id
  item_id uuid references public.grok_items(id),
  listing_id text, buyer text, text text, amount_gbp numeric,
  listed_gbp numeric, floor_gbp numeric,
  status text not null default 'new' check (status in ('new','working','answered','sent','needs_you','failed')),
  response jsonb,   -- bot: {action: reply|accept|counter|decline, text, counter_gbp}
  result jsonb      -- worker: what eBay returned
);

create table if not exists public.grok_vinted_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  mail_uid text unique, buyer text, listing text, message text, offer_gbp numeric,
  item_id uuid references public.grok_items(id),
  status text not null default 'new' check (status in ('new','working','suggested','pushed','failed')),
  suggestion jsonb  -- bot: {suggested_reply, recommended_action, notes}
);

do $$ declare t text; begin
  foreach t in array array['grok_inbox','grok_vinted_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;
