-- A stock operator needs the opaque quote ID to release the reservation attached
-- to a construction site. No quote, sale price or private cost is exposed.
begin;
alter function zp_private.project_workspace(jsonb,public.app_users) rename to project_workspace_v8_base;
create function zp_private.project_workspace(d jsonb,a public.app_users) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,zp_private as $$
declare result jsonb:=zp_private.project_workspace_v8_base(d,a); sites jsonb;
begin
 if a.role='Gestionnaire Stock' then
  select coalesce(jsonb_agg(c || case when original ? 'devisId' then jsonb_build_object('devisId',original->'devisId') else '{}'::jsonb end),'[]')
  into sites from jsonb_array_elements(result#>'{arr,chantiers}') c
  left join lateral (
   select s as original from jsonb_array_elements(coalesce(d#>'{arr,chantiers}','[]')) s where s->>'id'=c->>'id'
  ) source on true;
  result:=jsonb_set(result,'{arr,chantiers}',sites);
 end if;
 return result;
end $$;
revoke all on function zp_private.project_workspace_v8_base(jsonb,public.app_users) from public,anon,authenticated;
revoke all on function zp_private.project_workspace(jsonb,public.app_users) from public,anon,authenticated;
insert into public.zp_audit_events(actor_email,action,entity,entity_id,details)
values('migration','migration','schema','202610200006','{"purpose":"stock reservation scope"}');
commit;
