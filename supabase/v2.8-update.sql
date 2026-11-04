-- ============================================================
-- Tandem v2.8 update. Safe to run more than once.
--  1. Task IDs: every task gets a short ID like PM-12 (prefix per project)
--  2. Boards: lock items in place, flowchart shapes, connector styles
-- ============================================================

-- ---------- 1. Task IDs ----------
alter table public.projects add column if not exists task_prefix text;
alter table public.projects add column if not exists task_seq int not null default 0;
alter table public.tasks add column if not exists num int;

-- default prefix from the project name: "Project Management" -> "PM", "Tandem" -> "TAN"
create or replace function public.tandem_prefix(n text) returns text
language sql immutable as $$
  select case
    when array_length(regexp_split_to_array(trim(regexp_replace(coalesce(n,''),'[^A-Za-z0-9 ]','','g')),'\s+'),1) >= 2
      then upper(left(string_agg(left(w,1),''),4))
    else upper(left(regexp_replace(coalesce(n,'T'),'[^A-Za-z0-9]','','g'),3)) end
  from unnest(regexp_split_to_array(trim(regexp_replace(coalesce(n,''),'[^A-Za-z0-9 ]','','g')),'\s+')) w
$$;

update public.projects set task_prefix = coalesce(nullif(public.tandem_prefix(name),''),'T') where task_prefix is null or task_prefix = '';

-- number existing tasks in the order they were created
with numbered as (
  select id, row_number() over (partition by project_id order by created_at, id) as n
  from public.tasks where num is null
), base as (
  select project_id, coalesce(max(num),0) as m from public.tasks group by project_id
)
update public.tasks t set num = b.m + nb.n
from numbered nb join public.tasks t2 on t2.id = nb.id join base b on b.project_id = t2.project_id
where t.id = nb.id;

update public.projects p set task_seq = greatest(p.task_seq, coalesce((select max(num) from public.tasks t where t.project_id = p.id),0));

create or replace function public.tandem_task_num() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if new.num is null then
    update public.projects set task_seq = task_seq + 1 where id = new.project_id returning task_seq into n;
    new.num := n;
  end if;
  return new;
end $$;
drop trigger if exists tasks_num on public.tasks;
create trigger tasks_num before insert on public.tasks for each row execute function public.tandem_task_num();

create or replace function public.tandem_project_prefix() returns trigger
language plpgsql as $$
begin
  if new.task_prefix is null or new.task_prefix = '' then new.task_prefix := coalesce(nullif(public.tandem_prefix(new.name),''),'T'); end if;
  new.task_prefix := upper(left(regexp_replace(new.task_prefix,'[^A-Za-z0-9]','','g'),6));
  return new;
end $$;
drop trigger if exists projects_prefix on public.projects;
create trigger projects_prefix before insert or update of task_prefix on public.projects for each row execute function public.tandem_project_prefix();

create unique index if not exists tasks_project_num_idx on public.tasks(project_id, num);

-- ---------- 2. Boards ----------
alter table public.board_items add column if not exists locked boolean not null default false;
alter table public.board_items add column if not exists style jsonb not null default '{}'::jsonb;
alter table public.board_items drop constraint if exists board_items_kind_check;
alter table public.board_items add constraint board_items_kind_check check (kind in ('sticky','text','frame','link','shape'));

notify pgrst, 'reload schema';
