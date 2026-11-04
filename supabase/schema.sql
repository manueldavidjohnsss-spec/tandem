-- =====================================================================
-- Project Hub: Supabase schema
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run
-- Safe to re-run: it uses "if not exists" / "or replace" where possible.
-- =====================================================================

-- gen_random_uuid() is built into Postgres 13+ (Supabase), no extension needed

-- ---------- Profiles (one per signed-up user) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  name text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Projects & membership ----------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  charter jsonb not null default '{}'::jsonb,
  wip_limit int not null default 3 check (wip_limit between 1 and 20),
  asks text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  added_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create or replace function public.is_member(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.project_members m where m.project_id = pid and m.user_id = auth.uid());
$$;

create or replace function public.is_owner(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.project_members m where m.project_id = pid and m.user_id = auth.uid() and m.role = 'owner');
$$;

-- The creator automatically becomes the owner member
create or replace function public.add_owner_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.project_members (project_id, user_id, role) values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_project_created on public.projects;
create trigger on_project_created after insert on public.projects
  for each row execute function public.add_owner_membership();

-- Owner adds a teammate by email (the teammate must have signed up first)
create or replace function public.add_member_by_email(pid uuid, member_email text)
returns text language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.is_owner(pid) then raise exception 'Only the project owner can add members'; end if;
  select id into uid from public.profiles where email = lower(trim(member_email));
  if uid is null then return 'not_found'; end if;
  insert into public.project_members (project_id, user_id, role) values (pid, uid, 'member')
  on conflict do nothing;
  return 'added';
end $$;

-- ---------- Work items ----------
create table if not exists public.sprints (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  goal text not null default '',
  start_date date not null,
  end_date date not null,
  status text not null default 'Active' check (status in ('Planned','Active','Closed')),
  velocity int,
  created_at timestamptz not null default now()
);

-- sprint ceremonies (added in v1.4; safe to re-run)
alter table public.sprints add column if not exists planning_at timestamptz;
alter table public.sprints add column if not exists retro_at timestamptz;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  description text not null default '',
  acceptance text not null default '',
  status text not null default 'Backlog' check (status in ('Backlog','To Do','In Progress','Review','Done')),
  priority text check (priority in ('Must','Should','Could','Wont')),
  points int check (points in (1,2,3,5,8,13,21)),
  assignee uuid references auth.users(id) on delete set null,
  due date,
  deps uuid[] not null default '{}',
  sprint_id uuid references public.sprints(id) on delete set null,
  done_at date,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.task_comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.stakeholders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  role text not null default '',
  raci text not null default 'I' check (raci in ('R','A','C','I')),
  created_at timestamptz not null default now()
);

create table if not exists public.risks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  prob int not null default 3 check (prob between 1 and 5),
  impact int not null default 3 check (impact between 1 and 5),
  mitigation text not null default '',
  owner_name text not null default '',
  status text not null default 'Open' check (status in ('Open','Mitigated','Happened','Closed')),
  created_at timestamptz not null default now()
);

create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  decision text not null,
  why text not null default '',
  alternatives text not null default '',
  decided_by text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.standups (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null default current_date,
  yesterday text not null default '',
  today text not null default '',
  blockers text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.retros (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  sprint_id uuid references public.sprints(id) on delete set null,
  title text not null,
  data jsonb not null default '{"cols":[],"actions":[]}'::jsonb,
  created_at timestamptz not null default now()
);

-- Ideas whiteboard (added in v1.5; safe to re-run)
create table if not exists public.board_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null default 'sticky' check (kind in ('sticky','text','frame','link')),
  x double precision not null default 0,
  y double precision not null default 0,
  w double precision not null default 200,
  h double precision not null default 140,
  text text not null default '',
  color text not null default 'yellow',
  from_id uuid references public.board_items(id) on delete cascade,
  to_id uuid references public.board_items(id) on delete cascade,
  votes int not null default 0,
  task_id uuid references public.tasks(id) on delete set null,
  z int not null default 0,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists board_items_project_idx on public.board_items(project_id);

-- Multiple whiteboards per project + PNG snapshots (added in v2.1; safe to re-run)
create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null default 'Untitled board',
  thumbnail text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists boards_project_idx on public.boards(project_id);
alter table public.board_items add column if not exists board_id uuid references public.boards(id) on delete cascade;
create index if not exists board_items_board_idx on public.board_items(board_id);
create table if not exists public.board_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  board_id uuid not null references public.boards(id) on delete cascade,
  name text not null default '',
  png text not null,
  width int, height int,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists board_snapshots_board_idx on public.board_snapshots(board_id, created_at desc);

-- Rich-text comments with @mentions (added in v2.3; safe to re-run)
alter table public.task_comments add column if not exists mentions uuid[] not null default '{}';
alter table public.task_comments add column if not exists edited_at timestamptz;
create index if not exists task_comments_mentions_idx on public.task_comments using gin (mentions);

create index if not exists tasks_project_idx on public.tasks(project_id);
create index if not exists comments_task_idx on public.task_comments(task_id);
create index if not exists standups_project_idx on public.standups(project_id, day);

-- keep tasks.updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.sprints enable row level security;
alter table public.tasks enable row level security;
alter table public.task_comments enable row level security;
alter table public.stakeholders enable row level security;
alter table public.risks enable row level security;
alter table public.decisions enable row level security;
alter table public.standups enable row level security;
alter table public.retros enable row level security;
alter table public.board_items enable row level security;
alter table public.boards enable row level security;
alter table public.board_snapshots enable row level security;

-- profiles: see yourself and people you share a project with; edit only yourself
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.project_members a join public.project_members b on a.project_id = b.project_id
    where a.user_id = auth.uid() and b.user_id = profiles.id)
);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- projects
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated using (public.is_member(id) or owner_id = auth.uid());
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert to authenticated with check (owner_id = auth.uid());
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated using (public.is_member(id)) with check (public.is_member(id));
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete to authenticated using (public.is_owner(id));

-- members: members can see the team; owner removes people; anyone can leave
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members for select to authenticated using (public.is_member(project_id));
drop policy if exists members_delete on public.project_members;
create policy members_delete on public.project_members for delete to authenticated using (
  (public.is_owner(project_id) and role <> 'owner') or (user_id = auth.uid() and role <> 'owner'));

-- every project-scoped table: full access for members of that project
do $$
declare t text;
begin
  foreach t in array array['sprints','tasks','task_comments','stakeholders','risks','decisions','standups','retros','board_items','boards','board_snapshots'] loop
    execute format('drop policy if exists %I on public.%I', t || '_member_all', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.is_member(project_id)) with check (public.is_member(project_id))', t || '_member_all', t);
  end loop;
end $$;

-- comments & standups: only the author can edit/delete their own
drop policy if exists task_comments_member_all on public.task_comments;
drop policy if exists comments_select on public.task_comments;
create policy comments_select on public.task_comments for select to authenticated using (public.is_member(project_id));
drop policy if exists comments_insert on public.task_comments;
create policy comments_insert on public.task_comments for insert to authenticated with check (public.is_member(project_id) and user_id = auth.uid());
drop policy if exists comments_update on public.task_comments;
create policy comments_update on public.task_comments for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(project_id));
drop policy if exists comments_delete on public.task_comments;
create policy comments_delete on public.task_comments for delete to authenticated using (user_id = auth.uid());

-- ---------- Realtime (live updates between you and your teammate) ----------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['projects','project_members','sprints','tasks','task_comments','stakeholders','risks','decisions','standups','retros','board_items','boards'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null;
      end;
    end loop;
  end if;
end $$;

-- ---------- Grants ----------
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on function public.add_member_by_email(uuid, text) to authenticated;


-- ============================================================
-- Tandem notifications (v2.5) — safe to run more than once.
-- Creates an inbox per user, filled automatically by the database when:
--   • someone assigns you a task
--   • a task moves to Review (everyone else on the project is asked to review)
--   • someone @mentions you in a comment
--   • someone comments on a task assigned to you
--   • a teammate posts a blocker in their standup
-- Due-date reminders (due tomorrow / today / overdue) are computed live.
-- Phones poll notif_feed() with a private device token so alerts arrive
-- even when the Tandem app is closed.
-- ============================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  kind text not null check (kind in ('assigned','review','mention','comment','blocker','done')),
  title text not null,
  body text not null default '',
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);

alter table public.notifications enable row level security;
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications for delete to authenticated using (user_id = auth.uid());
grant select, update, delete on public.notifications to authenticated;

-- helper: display name of a user
create or replace function public.tandem_name(uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(p.name,''), split_part(p.email,'@',1), 'Someone') from public.profiles p where p.id = uid
$$;

-- tasks: assignment, review, done
create or replace function public.tandem_notify_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor uuid := auth.uid(); who text := coalesce(public.tandem_name(auth.uid()),'Someone');
begin
  if new.assignee is not null and new.assignee is distinct from actor
     and (tg_op = 'INSERT' or new.assignee is distinct from old.assignee) then
    insert into public.notifications(user_id,project_id,task_id,kind,title,body,actor_id)
    values (new.assignee,new.project_id,new.id,'assigned',who||' assigned you a task',new.title,actor);
  end if;
  if tg_op = 'UPDATE' and new.status = 'Review' and old.status is distinct from 'Review' then
    insert into public.notifications(user_id,project_id,task_id,kind,title,body,actor_id)
    select m.user_id,new.project_id,new.id,'review','Ready for your review',new.title||' · from '||who,actor
    from public.project_members m where m.project_id = new.project_id and m.user_id is distinct from actor;
  end if;
  if tg_op = 'UPDATE' and new.status = 'Done' and old.status is distinct from 'Done'
     and new.created_by is not null and new.created_by is distinct from actor and new.created_by is distinct from new.assignee then
    insert into public.notifications(user_id,project_id,task_id,kind,title,body,actor_id)
    values (new.created_by,new.project_id,new.id,'done',who||' finished a task you created',new.title,actor);
  end if;
  return new;
end $$;
drop trigger if exists tasks_notify on public.tasks;
create trigger tasks_notify after insert or update of assignee, status on public.tasks
  for each row execute function public.tandem_notify_task();

-- comments: mentions + comments on your task
create or replace function public.tandem_notify_comment() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor uuid := coalesce(auth.uid(), new.user_id); who text; t record; snippet text; ments uuid[];
begin
  who := coalesce(public.tandem_name(actor),'Someone');
  select id,title,assignee into t from public.tasks where id = new.task_id;
  snippet := left(regexp_replace(regexp_replace(new.body,'<[^>]+>',' ','g'),'\s+',' ','g'),140);
  snippet := replace(replace(replace(replace(snippet,'&nbsp;',' '),'&amp;','&'),'&lt;','<'),'&gt;','>');
  select coalesce(array_agg(x::uuid),'{}') into ments from jsonb_array_elements_text(coalesce(to_jsonb(new)->'mentions','[]'::jsonb)) x;
  insert into public.notifications(user_id,project_id,task_id,kind,title,body,actor_id)
  select distinct u,new.project_id,new.task_id,'mention',who||' mentioned you in “'||coalesce(t.title,'a task')||'”',trim(snippet),actor
  from unnest(ments) u
  where u is distinct from actor and exists(select 1 from public.project_members m where m.project_id=new.project_id and m.user_id=u);
  if t.assignee is not null and t.assignee is distinct from actor and not (t.assignee = any(ments)) then
    insert into public.notifications(user_id,project_id,task_id,kind,title,body,actor_id)
    values (t.assignee,new.project_id,new.task_id,'comment',who||' commented on “'||coalesce(t.title,'your task')||'”',trim(snippet),actor);
  end if;
  return new;
end $$;
drop trigger if exists comments_notify on public.task_comments;
create trigger comments_notify after insert on public.task_comments
  for each row execute function public.tandem_notify_comment();

-- standups: blockers
create or replace function public.tandem_notify_blocker() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce(public.tandem_name(new.user_id),'Your teammate');
begin
  if coalesce(trim(new.blockers),'') <> '' and (tg_op='INSERT' or coalesce(trim(old.blockers),'') is distinct from trim(new.blockers)) then
    insert into public.notifications(user_id,project_id,kind,title,body,actor_id)
    select m.user_id,new.project_id,'blocker',who||' is blocked',left(new.blockers,200),new.user_id
    from public.project_members m where m.project_id=new.project_id and m.user_id <> new.user_id;
  end if;
  return new;
end $$;
drop trigger if exists standups_notify on public.standups;
create trigger standups_notify after insert or update of blockers on public.standups
  for each row execute function public.tandem_notify_blocker();

-- due-date reminders for the signed-in user (computed live, Manila time)
create or replace function public.my_due_reminders() returns table(task_id uuid, project_id uuid, title text, due date, state text)
language sql stable security definer set search_path = public as $$
  select t.id, t.project_id, t.title, t.due,
    case when t.due < (now() at time zone 'Asia/Manila')::date then 'overdue'
         when t.due = (now() at time zone 'Asia/Manila')::date then 'today' else 'tomorrow' end
  from public.tasks t
  where t.assignee = auth.uid() and t.status <> 'Done' and t.due is not null
    and t.due <= (now() at time zone 'Asia/Manila')::date + 1
  order by t.due
$$;
grant execute on function public.my_due_reminders() to authenticated;

-- ---------- phone delivery (works while the app is closed) ----------
create table if not exists public.notify_devices (
  token text primary key check (length(token) >= 32),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen timestamptz
);
alter table public.notify_devices enable row level security;
drop policy if exists notify_devices_own on public.notify_devices;
create policy notify_devices_own on public.notify_devices for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, delete on public.notify_devices to authenticated;

create or replace function public.register_device(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into public.notify_devices(token,user_id) values (p_token, auth.uid())
  on conflict (token) do update set user_id = excluded.user_id, last_seen = now();
end $$;
grant execute on function public.register_device(text) to authenticated;

-- The phone calls this every ~15 minutes with its private token.
-- Returns new notifications since p_since, plus due reminders for today.
create or replace function public.notif_feed(p_token text, p_since timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; d date := (now() at time zone 'Asia/Manila')::date; res jsonb;
begin
  select user_id into uid from public.notify_devices where token = p_token;
  if uid is null then return jsonb_build_object('ok',false); end if;
  update public.notify_devices set last_seen = now() where token = p_token;
  select jsonb_build_object('ok',true,'now',now(),
    'items',coalesce((select jsonb_agg(x order by x->>'at') from (
       select jsonb_build_object('id',n.id::text,'kind',n.kind,'title',n.title,'body',n.body,'project',n.project_id,'task',n.task_id,'at',n.created_at) x
       from public.notifications n
       where n.user_id = uid and n.read_at is null and n.created_at > coalesce(p_since, now() - interval '1 day')
       order by n.created_at desc limit 20) s),'[]'::jsonb),
    'due',coalesce((select jsonb_agg(jsonb_build_object('id','due-'||t.id||'-'||d,'task',t.id,'project',t.project_id,'title',t.title,
         'state',case when t.due < d then 'overdue' when t.due = d then 'today' else 'tomorrow' end))
       from public.tasks t where t.assignee = uid and t.status <> 'Done' and t.due is not null and t.due <= d + 1),'[]'::jsonb))
  into res;
  return res;
end $$;
grant execute on function public.notif_feed(text, timestamptz) to anon, authenticated;

-- live updates for the bell
do $$ begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
