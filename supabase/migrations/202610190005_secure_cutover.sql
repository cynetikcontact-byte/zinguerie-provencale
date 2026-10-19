-- APPLY ONLY WITH THE V8 FRONTEND READY. v7 clients can no longer access or overwrite the workspace.
begin;
insert into public.workspace_backups(workspace_id,data,note) select id,data,'before v8 secure cutover 2026-10-19' from public.workspace where id='main';
create or replace function public.zp_member() returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$ select exists(select 1 from public.app_users where auth_user_id=auth.uid() and email=lower(auth.jwt()->>'email') and actif) $$;
create or replace function public.zp_staff() returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$ select exists(select 1 from public.app_users where auth_user_id=auth.uid() and email=lower(auth.jwt()->>'email') and actif and role<>'Client') $$;
create or replace function public.zp_gerant() returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$ select exists(select 1 from public.app_users where auth_user_id=auth.uid() and email=lower(auth.jwt()->>'email') and actif and role='Gérant') $$;
revoke all on function public.zp_member(),public.zp_staff(),public.zp_gerant() from public,anon;
grant execute on function public.zp_member(),public.zp_staff(),public.zp_gerant() to authenticated;
-- Policies are retained for rollback inspection, but application roles have no table privilege.
revoke all on public.workspace from anon,authenticated;
revoke insert,update,delete on public.app_users from anon,authenticated;
alter policy au_select on public.app_users using (public.zp_gerant() or (auth_user_id=auth.uid() and email=lower(auth.jwt()->>'email')));
revoke insert on public.workspace_backups from anon,authenticated;
create or replace function public.zp_file_readable(object_name text) returns boolean
language plpgsql stable security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users;d jsonb;
begin
 if not public.zp_member() then return false;end if;
 a:=zp_private.identity();
 if a.role='Gérant' then return true;end if;
 if a.role not in ('Client','Comptable') and split_part(object_name,'/',1)=a.auth_user_id::text then return true;end if;
 select zp_private.project_workspace(data,a) into d from public.workspace where id='main';
 return jsonb_path_exists(d,'$.** ? (@ == $ref)',jsonb_build_object('ref','zpfile:'||object_name));
end $$;
create or replace function public.zp_file_unreferenced(object_name text) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select public.zp_gerant() and not exists(select 1 from public.workspace where jsonb_path_exists(data,'$.** ? (@ == $ref)',jsonb_build_object('ref','zpfile:'||object_name)))
 and not exists(select 1 from public.workspace_backups where jsonb_path_exists(data,'$.** ? (@ == $ref)',jsonb_build_object('ref','zpfile:'||object_name)))
 and not exists(select 1 from public.zp_invoice_register where jsonb_path_exists(document,'$.** ? (@ == $ref)',jsonb_build_object('ref','zpfile:'||object_name)))
 $$;
revoke all on function public.zp_file_readable(text),public.zp_file_unreferenced(text) from public,anon;
grant execute on function public.zp_file_readable(text),public.zp_file_unreferenced(text) to authenticated;
alter policy zpfiles_select on storage.objects using (bucket_id='zp-files' and public.zp_file_readable(name));
alter policy zpfiles_insert on storage.objects with check(bucket_id='zp-files' and (public.zp_gerant() or (public.zp_staff() and split_part(name,'/',1)=auth.uid()::text and split_part(name,'/',2) in ('ft','documents','preuves','chantier-docs','rapports','divers') and not exists(select 1 from public.app_users where auth_user_id=auth.uid() and role='Comptable'))));
-- New object versions use new immutable paths; signed documents can never change in place.
alter policy zpfiles_update on storage.objects using(false) with check(false);
alter policy zpfiles_delete on storage.objects using(bucket_id='zp-files' and public.zp_file_unreferenced(name));
-- Adding a guessed private file reference to an otherwise permitted row cannot grant access.
create or replace function zp_private.guard_file_references() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users;ref jsonb;visible jsonb;
begin
 if auth.uid() is null then return NEW;end if;
 a:=zp_private.identity();if a.role='Gérant' then return NEW;end if;
 visible:=zp_private.project_workspace(OLD.data,a);
 for ref in select * from jsonb_path_query(zp_private.project_workspace(NEW.data,a),'$.** ? (@.type() == "string" && @ starts with "zpfile:")') loop
  if split_part(substring(ref#>>'{}' from 8),'/',1)<>a.auth_user_id::text
  and not jsonb_path_exists(visible,'$.** ? (@ == $ref)',jsonb_build_object('ref',ref)) then raise exception 'ZP_ACCESS: fichier hors périmètre';end if;
  if not jsonb_path_exists(visible,'$.** ? (@ == $ref)',jsonb_build_object('ref',ref)) and not exists(select 1 from storage.objects where bucket_id='zp-files' and name=substring(ref#>>'{}' from 8)) then raise exception 'ZP_FILE: fichier non transféré';end if;
 end loop;
 return NEW;
end $$;
create trigger zp_guard_file_references before update on public.workspace for each row execute function zp_private.guard_file_references();
revoke all on function zp_private.guard_file_references() from public,anon,authenticated;
insert into public.zp_audit_events(action,entity,entity_id,details) values('migration','schema','202610190005','{"stage":"legacy access closed; scoped files and RPC writes"}');
commit;
