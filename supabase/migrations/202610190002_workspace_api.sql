-- Stage 2a: additive API. Direct legacy workspace policies are restricted only at the coordinated cutover.
begin;
alter table public.app_users add column if not exists auth_user_id uuid;
alter table public.app_users add column if not exists employee_id text;
alter table public.app_users add column if not exists client_id text;
-- Link only an unambiguous existing Auth identity. Never infer a client's dossier from its name.
update public.app_users a set auth_user_id=u.id from auth.users u
 where a.auth_user_id is null and lower(u.email)=a.email
 and (select count(*) from auth.users x where lower(x.email)=a.email)=1;
create unique index if not exists zp_account_identity on public.app_users(auth_user_id) where auth_user_id is not null;
create or replace function zp_private.pick(o jsonb,keys text[]) returns jsonb
 language sql immutable set search_path=pg_catalog as $$ select coalesce(jsonb_object_agg(key,value),'{}') from jsonb_each(coalesce(o,'{}')) where key=any(keys) $$;
create or replace function zp_private.pick_rows(a jsonb,keys text[]) returns jsonb
 language sql immutable set search_path=pg_catalog,zp_private as $$ select coalesce(jsonb_agg(zp_private.pick(value,keys)),'[]') from jsonb_array_elements(coalesce(a,'[]')) $$;
create or replace function zp_private.pointages_for(d jsonb,owner_email text,show_costs boolean) returns jsonb
 language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_object_agg(key,case when show_costs then value else jsonb_set(value,'{interventions}',coalesce((select jsonb_agg(iv-'coutHoraire') from jsonb_array_elements(coalesce(value->'interventions','[]'))iv),'[]')) end),'{}')
 from jsonb_each(coalesce(d,'{}')) where owner_email is null or split_part(key,'|',1)=owner_email
 $$;
create or replace function zp_private.plan_for(d jsonb,employee text) returns jsonb
 language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_object_agg(key,case when employee is null then value else coalesce(jsonb_build_object(employee,value->employee),'{}') end),'{}')
 from jsonb_each(coalesce(d,'{}')) where employee is null or value ? employee
 $$;
create or replace function zp_private.identity() returns public.app_users
 language plpgsql stable security definer set search_path=pg_catalog,public as $$
 declare a public.app_users;
 begin
  select * into a from public.app_users where auth_user_id=auth.uid() and actif and email=lower(auth.jwt()->>'email');
  if not found then raise exception 'ZP_ACCESS: compte inactif ou identité non liée' using errcode='42501'; end if;
  return a;
 end $$;
create or replace function zp_private.project_workspace(d jsonb,a public.app_users) returns jsonb
 language plpgsql stable security definer set search_path=pg_catalog,public,zp_private as $$
 declare result jsonb:='{"arr":{},"obj":{},"scal":{},"schemaVersion":8}'; k text; value jsonb; r text:=a.role; arr_allow text[]; obj_allow text[];
 all_arr text[]:=array['salaries','equipes','clients','chantiers','stock','profils','bureau','taches','demandesList','congesList','carnet','rdvs','catFournitures','ouvrages','factures','comptes','prodCats','ouvrCats','devisDossiers','stockMoves','matConsos','_delCats','journal','planResList','interims','docSections','rapports','commandes'];
 all_obj text[]:=array['congesBalance','planStore','planHrs','planNotes','chatMsgs','chantierSteps','profilUser','txtModeles','pointages','entreprise','comptaParams'];
 begin
 if r in ('Gérant','Bureau') then arr_allow:=all_arr;obj_allow:=all_obj;
 elsif r='Comptable' then arr_allow:=array['factures','clients'];obj_allow:=array['entreprise','comptaParams'];
 elsif r='Gestionnaire Stock' then arr_allow:=array['catFournitures','stock','stockMoves','matConsos','demandesList','prodCats','profils','chantiers','salaries','interims','docSections'];obj_allow:=array['entreprise'];
 elsif r='Chef d''équipe' then arr_allow:=array['salaries','equipes','chantiers','clients','taches','demandesList','catFournitures','prodCats','planResList','interims','rapports'];obj_allow:=array['planStore','planHrs','planNotes','pointages','entreprise','chantierSteps'];
 elsif r='Salarié' then arr_allow:=array['salaries','chantiers','taches'];obj_allow:=array['planStore','planHrs','planNotes','pointages','entreprise'];
 elsif r='Client' then arr_allow:=array['clients','chantiers','devisDossiers','factures'];obj_allow:=array['entreprise'];
 else raise exception 'ZP_ACCESS: rôle inconnu' using errcode='42501';end if;
 foreach k in array all_arr loop
  value:=case when k=any(arr_allow) then coalesce(d->'arr'->k,'[]') else '[]'::jsonb end;
  if jsonb_typeof(value)<>'array' then raise exception 'ZP_SCHEMA: tableau % invalide',k;end if;
  if k in ('salaries','interims','bureau') and r<>'Gérant' then
   if r='Bureau' then select coalesce(jsonb_agg(v-'cout'),'[]') into value from jsonb_array_elements(value)v;
   else value:=zp_private.pick_rows(value,array['id','nom','init','role','col','photo']);end if;
  end if;
  if k='chantiers' then
   select coalesce(jsonb_agg(c||jsonb_build_object('hPointes',coalesce((select round(sum(case when jsonb_typeof(iv->'secs')='number' then (iv->>'secs')::numeric else 0 end)/3600,2) from jsonb_each(coalesce(d#>'{obj,pointages}','{}'))p cross join lateral jsonb_array_elements(coalesce(p.value->'interventions','[]'))iv where iv->>'chId'=c->>'id' and not coalesce((iv->>'needsReview')::boolean,false)),0))),'[]') into value from jsonb_array_elements(value)c;
  end if;
  if k='chantiers' and r not in ('Gérant','Bureau') then
   if r='Client' then select coalesce(jsonb_agg(v),'[]') into value from jsonb_array_elements(value)v where v->>'clientId'=a.client_id;end if;
   value:=zp_private.pick_rows(value,array['id','nom','clientId','col','statut','av','hEst','hFaites','hPointes','chef','equipe','fin','adresse','prep','zone']);
  end if;
  if k='clients' and r not in ('Gérant','Bureau') then
   if r='Client' then select coalesce(jsonb_agg(v),'[]') into value from jsonb_array_elements(value)v where v->>'id'=a.client_id;
   elsif r='Comptable' then select coalesce(jsonb_agg(v),'[]') into value from jsonb_array_elements(value)v where exists(select 1 from jsonb_array_elements(coalesce(d#>'{arr,factures}','[]')) f where coalesce((f->>'locked')::boolean,false) and (f->>'clientId'=v->>'id' or (f->>'clientId' is null and f->>'clientNom'=v->>'nom')));
   else select coalesce(jsonb_agg(v),'[]') into value from jsonb_array_elements(value)v where exists(select 1 from jsonb_array_elements(coalesce(d#>'{arr,chantiers}','[]')) c where c->>'clientId'=v->>'id');end if;
   value:=zp_private.pick_rows(value,case when r in ('Client','Comptable') then array['id','nom','type','adr','adresse','ville','mail','email','tel','siret','tvaIntra','fact'] else array['id','nom','ville','tel'] end);
  end if;
  if k='factures' and r not in ('Gérant','Bureau') then
   select coalesce(jsonb_agg(zp_private.pick(v,array['id','num','clientId','clientNom','type','devisId','avoirDe','ht','tva','ttc','vent','locked','statut','date','dateEcheance','datePaiement','echeance','acDeduit','regl','relances','affecte','snapshot'])),'[]') into value from jsonb_array_elements(value)v where coalesce((v->>'locked')::boolean,false) and (r<>'Client' or v->>'clientId'=a.client_id);
  end if;
  if k='devisDossiers' and r='Client' then
   select coalesce(jsonb_agg(zp_private.pick(v,array['id','ref','titre','clientId','statut','version','date','intro','outro','cond','cgv','cgvOn','natProjet','adrChantier','tvaDevis','signeLe','signataire'])||jsonb_build_object('lignes',zp_private.pick_rows(v->'lignes',array['id','des','descr','qte','u','pu','tva']))),'[]') into value
   from jsonb_array_elements(value)v where v->>'clientId'=a.client_id and v->>'statut' in ('envoye','accepte','refuse');
  end if;
  if k='catFournitures' and r in ('Chef d''équipe','Salarié') then value:=zp_private.pick_rows(value,array['id','nom','u','cat','stock','reserve','seuil','photo','ft']);end if;
  if k='taches' and r not in ('Gérant','Bureau') then
   select coalesce(jsonb_agg(v),'[]') into value from jsonb_array_elements(value)v where v->>'assigneeEmail'=a.email or v->>'pour'=a.employee_id or v->>'createdBy'=a.email;
  end if;
  if k='demandesList' and r='Chef d''équipe' then
   select coalesce(jsonb_agg(v),'[]') into value from jsonb_array_elements(value)v where v->>'demandeurEmail'=a.email or v->>'demandeur'=a.nom;
  end if;
  if k='docSections' and r='Gestionnaire Stock' then
   select coalesce(jsonb_agg(v||jsonb_build_object('docs',coalesce((select jsonb_agg(doc) from jsonb_array_elements(coalesce(v->'docs','[]'))doc where (doc->'sharedRoles') ? r),'[]'))),'[]') into value from jsonb_array_elements(value)v;
  end if;
  if k='comptes' then
   -- Names and roles come from the access table; editable workspace profiles are not an authority.
   select coalesce(jsonb_agg(jsonb_build_object('id',coalesce(p->>'id',u.auth_user_id::text,u.email),'email',u.email,'nom',u.nom,'role',u.role,'actif',u.actif,'employeeId',u.employee_id,'clientId',u.client_id,'linked',u.auth_user_id is not null,'photo',coalesce(p->>'photo',''),'tel',coalesce(p->>'tel',''),'poste',coalesce(p->>'poste','')) order by u.nom),'[]') into value
   from public.app_users u left join lateral (select x as p from jsonb_array_elements(coalesce(d#>'{arr,comptes}','[]'))x where lower(x->>'email')=u.email limit 1)q on true
   where r='Gérant' or (u.actif and (r<>'Client' and u.role<>'Client' or u.email=a.email));
  end if;
  result:=jsonb_set(result,array['arr',k],value);
 end loop;
 foreach k in array all_obj loop
  value:=case when k=any(obj_allow) then coalesce(d->'obj'->k,'{}') else '{}'::jsonb end;
  if k in ('chatMsgs','profilUser') then value:='{}';end if;
  if jsonb_typeof(value)<>'object' then raise exception 'ZP_SCHEMA: objet % invalide',k;end if;
  if k='pointages' then value:=zp_private.pointages_for(value,case when r in ('Gérant','Bureau') then null else a.email end,r='Gérant');end if;
  if k in ('planStore','planHrs','planNotes') and r='Salarié' then value:=zp_private.plan_for(value,coalesce(a.employee_id,'__unlinked__'));end if;
  if k='entreprise' and r not in ('Gérant','Bureau','Comptable') then value:=zp_private.pick(value,array['raison','adresse','tel','email','siret','formeJuridique','capital','rcs','tvaIntra','decennale','assureurAdr','decennaleZone']);end if;
  result:=jsonb_set(result,array['obj',k],value);
 end loop;
 foreach k in array array['tauxMO','coutMO','_devisSeq','rdvSeq','coefMargeDefaut','tvaDefaut','margeObjectif','arrondiPU','facSeq','avSeq','cmdSeq'] loop
  value:=case when r in ('Gérant','Bureau') then d->'scal'->k else null end;
  result:=jsonb_set(result,array['scal',k],coalesce(value,case when k='arrondiPU' then '"exact"'::jsonb else '0'::jsonb end));
 end loop;
 return result;
 end $$;
create or replace function public.zp_load_workspace() returns jsonb
 language plpgsql stable security definer set search_path=pg_catalog,public,zp_private as $$
 declare a public.app_users:=zp_private.identity(); w public.workspace;
 begin
  select * into strict w from public.workspace where id='main';
  return jsonb_build_object('data',zp_private.project_workspace(w.data,a),'version',w.version,'updated_at',w.updated_at,'identity',jsonb_build_object('email',a.email,'nom',a.nom,'role',a.role,'employeeId',a.employee_id,'clientId',a.client_id));
 end $$;
create or replace function public.zp_workspace_meta() returns jsonb
 language plpgsql stable security definer set search_path=pg_catalog,public,zp_private as $$
 declare a public.app_users:=zp_private.identity();
 begin return (select jsonb_build_object('version',version,'updated_at',updated_at,'role',a.role,'employeeId',a.employee_id,'clientId',a.client_id) from public.workspace where id='main');end $$;
revoke all on all functions in schema zp_private from public,anon,authenticated;
revoke all on function public.zp_load_workspace() from public,anon;
revoke all on function public.zp_workspace_meta() from public,anon;
grant execute on function public.zp_load_workspace(),public.zp_workspace_meta() to authenticated;
insert into public.zp_audit_events(action,entity,entity_id,details) values('migration','schema','202610190002','{"stage":"additive role projections; cutover pending"}');
commit;
