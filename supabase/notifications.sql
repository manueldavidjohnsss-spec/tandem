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
