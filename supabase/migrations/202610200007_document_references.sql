-- Allocate new quote/order references under the workspace lock. Historical
-- references remain unchanged; clients cannot silently renumber existing rows.
begin;
alter function public.zp_save_workspace(bigint,jsonb,text) rename to save_workspace_v8_base;
alter function public.save_workspace_v8_base(bigint,jsonb,text) set schema zp_private;
create function public.zp_save_workspace(expected_version bigint,new_state jsonb,client_id text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users:=zp_private.identity(); w public.workspace; field text; ref_key text; seq_key text; prefix text; seq bigint; rows jsonb; item jsonb; prior jsonb; ref text; quote jsonb;
begin
 select * into strict w from public.workspace where id='main' for update;
 if w.version<>expected_version then return jsonb_build_object('conflict',true,'version',w.version);end if;
 if a.role in ('Gérant','Bureau') then
  foreach field in array array['devisDossiers','commandes'] loop
   ref_key:=case when field='devisDossiers' then 'ref' else 'num' end;
   seq_key:=case when field='devisDossiers' then '_devisSeq' else 'cmdSeq' end;
   prefix:=case when field='devisDossiers' then 'D-' else 'C-' end||to_char(now() at time zone 'Europe/Paris','YYYY')||'-';
   seq:=greatest(0,coalesce((w.data#>>array['scal',seq_key])::bigint,0));
   select greatest(seq,coalesce(max(substring(v->>ref_key from length(prefix)+1)::bigint),0)) into seq
    from jsonb_array_elements(coalesce(w.data#>array['arr',field],'[]'))v
    where v->>ref_key ~ ('^'||prefix||'[0-9]{1,12}$');
   rows:='[]';
   for item in select * from jsonb_array_elements(coalesce(new_state#>array['arr',field],'[]')) loop
    select v into prior from jsonb_array_elements(coalesce(w.data#>array['arr',field],'[]'))v where v->>'id'=item->>'id';
    if prior is null then
     if nullif(item->>'id','') is null then raise exception 'ZP_REFERENCE: identifiant requis';end if;
     seq:=seq+1;ref:=prefix||lpad(seq::text,greatest(length(seq::text),case when field='devisDossiers' then 4 else 3 end),'0');
     item:=jsonb_set(item,array[ref_key],to_jsonb(ref));
    elsif item->ref_key is distinct from prior->ref_key then
     raise exception 'ZP_REFERENCE: référence existante non modifiable';
    end if;
    if field='commandes' then
     select q into quote from jsonb_array_elements(coalesce(new_state#>'{arr,devisDossiers}','[]'))q where q->>'id'=item->>'devisId';
     if quote is not null then item:=jsonb_set(item,'{devisRef}',quote->'ref');end if;
    end if;
    rows:=rows||jsonb_build_array(item);
   end loop;
   new_state:=jsonb_set(new_state,array['arr',field],rows);
   new_state:=jsonb_set(new_state,array['scal',seq_key],to_jsonb(seq));
  end loop;
  rows:='[]';
  for item in select * from jsonb_array_elements(coalesce(new_state#>'{arr,carnet}','[]')) loop
   select q into quote from jsonb_array_elements(coalesce(new_state#>'{arr,devisDossiers}','[]'))q where q->>'id'=item->>'devisId';
   if quote is not null then item:=jsonb_set(item,'{ref}',quote->'ref');end if;
   rows:=rows||jsonb_build_array(item);
  end loop;
  new_state:=jsonb_set(new_state,'{arr,carnet}',rows);
 end if;
 return zp_private.save_workspace_v8_base(expected_version,new_state,client_id);
end $$;
revoke all on function zp_private.save_workspace_v8_base(bigint,jsonb,text) from public,anon,authenticated;
revoke all on function public.zp_save_workspace(bigint,jsonb,text) from public,anon;
grant execute on function public.zp_save_workspace(bigint,jsonb,text) to authenticated;
insert into public.zp_audit_events(actor_email,action,entity,entity_id,details)
values('migration','migration','schema','202610200007','{"purpose":"atomic quote and order references"}');
commit;
