-- The Shortcut sends photo paths as newline-separated text; split them into photo_paths. Safe to re-run.
alter table public.grok_items add column if not exists photo_list text;
create or replace function public.grok_items_split_photos() returns trigger language plpgsql as $$
begin
  if new.photo_list is not null and coalesce(array_length(new.photo_paths, 1), 0) = 0 then
    new.photo_paths := array_remove(string_to_array(trim(both E'\n ' from new.photo_list), E'\n'), '');
  end if;
  return new;
end $$;
drop trigger if exists grok_items_split_photos on public.grok_items;
create trigger grok_items_split_photos before insert on public.grok_items
  for each row execute function public.grok_items_split_photos();
