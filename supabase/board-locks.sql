-- Tandem v2.7: lets you lock sticky notes, text and sections in place (shared with your teammate).
-- Safe to run more than once.
alter table public.board_items add column if not exists locked boolean not null default false;
notify pgrst, 'reload schema';
