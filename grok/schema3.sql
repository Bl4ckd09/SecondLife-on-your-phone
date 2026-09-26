-- Wake Grok Bots instantly: Postgres triggers POST to each bot's routine webhook via pg_net.
-- Run once. Then fill grok_hooks with each bot's webhook URL and key (grok/README.md). Safe to re-run.
create extension if not exists pg_net with schema extensions;

create table if not exists public.grok_hooks (
  bot text primary key check (bot in ('researcher','ebay_poster','vinted_poster','ebay_buyer','vinted_reply')),
  url text not null,
  key text not null
);
alter table public.grok_hooks enable row level security;  -- no policies: only the service role can read it

create or replace function public.wake_bot(p_bot text, p_table text, p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare h record;
begin
  select url, key into h from public.grok_hooks where bot = p_bot;
  if h.url is null then return; end if;   -- bot not wired yet: its 5-minute schedule still runs
  perform net.http_post(
    url := h.url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || h.key),
    body := jsonb_build_object('table', p_table, 'id', p_id, 'bot', p_bot));
end $$;

create or replace function public.grok_items_wake() returns trigger language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' and new.status = 'new' then perform public.wake_bot('researcher', 'grok_items', new.id); end if;
  if tg_op = 'UPDATE' and new.status = 'researched' and old.status is distinct from 'researched' then
    perform public.wake_bot('ebay_poster', 'grok_items', new.id);
    perform public.wake_bot('vinted_poster', 'grok_items', new.id);
  end if;
  return new;
end $$;
drop trigger if exists grok_items_wake on public.grok_items;
create trigger grok_items_wake after insert or update of status on public.grok_items
  for each row execute function public.grok_items_wake();

create or replace function public.grok_inbox_wake() returns trigger language plpgsql security definer as $$
begin perform public.wake_bot('ebay_buyer', 'grok_inbox', new.id); return new; end $$;
drop trigger if exists grok_inbox_wake on public.grok_inbox;
create trigger grok_inbox_wake after insert on public.grok_inbox
  for each row execute function public.grok_inbox_wake();

create or replace function public.grok_vinted_wake() returns trigger language plpgsql security definer as $$
begin perform public.wake_bot('vinted_reply', 'grok_vinted_messages', new.id); return new; end $$;
drop trigger if exists grok_vinted_wake on public.grok_vinted_messages;
create trigger grok_vinted_wake after insert on public.grok_vinted_messages
  for each row execute function public.grok_vinted_wake();
