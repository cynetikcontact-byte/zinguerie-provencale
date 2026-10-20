-- Stage 1: compatible with v7.8. No business rows are removed or rewritten.
begin;
insert into public.workspace_backups(workspace_id,data,note)
 select id,data,'before v8 security foundation 2026-10-19' from public.workspace
 where not exists(select 1 from public.workspace_backups where note='before v8 security foundation 2026-10-19');
create schema if not exists zp_private;
revoke all on schema zp_private from public,anon,authenticated;
create table if not exists public.zp_audit_events(
 id bigint generated always as identity primary key,
 created_at timestamptz not null default now(), actor_email text,
 action text not null, entity text not null, entity_id text,
 details jsonb not null default '{}'
);
alter table public.zp_audit_events enable row level security;
revoke all on public.zp_audit_events from public,anon,authenticated;
grant select on public.zp_audit_events to authenticated;
create policy audit_read_manager on public.zp_audit_events for select to authenticated using (public.zp_gerant());

-- A private conversation is readable only by its two existing, active staff members.
create or replace function public.zp_can_chat(p_channel text) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare me text:=lower(coalesce(auth.jwt()->>'email','')); parts text[];
begin
 if not public.zp_staff() then return false; end if;
 if p_channel='general' then return true; end if;
 if left(p_channel,3)='dm:' then
  parts:=string_to_array(substring(p_channel from 4),'|');
  return cardinality(parts)=2 and parts[1]<>parts[2] and me=any(parts)
   and p_channel='dm:'||least(parts[1],parts[2])||'|'||greatest(parts[1],parts[2])
   and (select count(*)=2 from public.app_users where email=any(parts) and actif and role<>'Client');
 end if;
 if left(p_channel,3)='ch:' then
  return exists(select 1 from public.workspace w cross join lateral jsonb_array_elements(coalesce(w.data#>'{arr,chantiers}','[]')) c
   where w.id='main' and c->>'id'=substring(p_channel from 4));
 end if;
 return false;
end $$;
revoke all on function public.zp_can_chat(text) from public,anon;
grant execute on function public.zp_can_chat(text) to authenticated;
alter policy msg_select on public.messages using (public.zp_can_chat(channel));
alter policy msg_insert on public.messages with check (
 public.zp_can_chat(channel) and author_email=lower(auth.jwt()->>'email')
 and char_length(btrim(body)) between 1 and 10000
 and author_name=(select nom from public.app_users where email=lower(auth.jwt()->>'email') and actif)
);
alter policy errors_insert_auth on public.errors with check (
 public.zp_member() and user_email=lower(auth.jwt()->>'email')
 and length(coalesce(message,''))<=500 and length(coalesce(stack,''))<=2000
);
-- Preserve all backups; only the manager can read or add snapshots. No client can delete them.
alter policy wb_all_auth on public.workspace_backups using(public.zp_gerant()) with check(public.zp_gerant());
revoke update,delete on public.workspace_backups from authenticated,anon;
revoke all on function public.zp_nightly_snapshot() from public,anon,authenticated;
-- Cron still runs as its existing owner. Browser callers cannot trigger retention cleanup.

create or replace function zp_private.guard_account() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform pg_advisory_xact_lock(20261019,1);
 if TG_OP<>'DELETE' then
  if NEW.email<>lower(btrim(NEW.email)) or NEW.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
   or NEW.role not in ('Gérant','Bureau','Chef d''équipe','Gestionnaire Stock','Salarié','Client','Comptable') then
   raise exception 'Compte invalide';
  end if;
 end if;
 if TG_OP<>'INSERT' and OLD.role='Gérant' and OLD.actif then
  if TG_OP='DELETE' or not NEW.actif or NEW.role<>'Gérant' or NEW.email<>OLD.email then
   if not exists(select 1 from public.app_users where role='Gérant' and actif and email<>OLD.email) then
    raise exception 'Le dernier gérant actif doit être conservé';
   end if;
  end if;
 end if;
 insert into public.zp_audit_events(actor_email,action,entity,entity_id,details)
 values(lower(auth.jwt()->>'email'),lower(TG_OP),'app_users',case when TG_OP='DELETE' then OLD.email else NEW.email end,
  jsonb_build_object('oldRole',case when TG_OP='INSERT' then null else OLD.role end,'newRole',case when TG_OP='DELETE' then null else NEW.role end,'active',case when TG_OP='DELETE' then false else NEW.actif end));
 if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;
create trigger zp_guard_account before insert or update or delete on public.app_users for each row execute function zp_private.guard_account();
revoke all on function zp_private.guard_account() from public,anon,authenticated;
insert into public.zp_audit_events(action,entity,entity_id,details) values('migration','schema','202610190001','{"stage":"security foundation"}');
commit;
