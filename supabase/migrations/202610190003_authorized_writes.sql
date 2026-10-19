-- Additive, transactional write API. The legacy table is closed in migration 005.
begin;
create or replace function zp_private.normalized(d jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare result jsonb:=d; field text; wk record; person record; weeks jsonb; people jsonb;
begin
 foreach field in array array['planStore','planHrs','planNotes'] loop
  weeks:='{}';
  for wk in select * from jsonb_each(coalesce(d#>array['obj',field],'{}')) loop
   people:='{}';
   for person in select * from jsonb_each(wk.value) loop
    if (field='planStore' and exists(select 1 from jsonb_array_elements(person.value) v where v<>'null'::jsonb))
     or (field<>'planStore' and person.value<>'{}'::jsonb) then people:=people||jsonb_build_object(person.key,person.value);end if;
   end loop;
   if people<>'{}'::jsonb then weeks:=weeks||jsonb_build_object(wk.key,people);end if;
  end loop;
  result:=jsonb_set(result,array['obj',field],weeks);
 end loop;
 return result;
end $$;
-- Merge a visible entity list into its full source without deleting concealed fields or rows.
create or replace function zp_private.merge_rows(original jsonb,visible jsonb,incoming jsonb,id_key text) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare result jsonb:='[]'; item jsonb; old_item jsonb; shown jsonb; keys text[];
begin
 if exists(select 1 from jsonb_array_elements(incoming)v where nullif(v->>id_key,'') is null)
 or (select count(*) from jsonb_array_elements(incoming))<>(select count(distinct v->>id_key) from jsonb_array_elements(incoming)v) then raise exception 'ZP_SCHEMA: identifiants manquants ou dupliqués';end if;
 for item in select * from jsonb_array_elements(incoming) loop
  select v into old_item from jsonb_array_elements(original)v where v->>id_key=item->>id_key;
  select v into shown from jsonb_array_elements(visible)v where v->>id_key=item->>id_key;
  if old_item is not null and shown is null then raise exception 'ZP_ACCESS: identifiant hors périmètre';end if;
  select array_agg(key) into keys from jsonb_object_keys(coalesce(shown,'{}'))key;
  result:=result||jsonb_build_array((coalesce(old_item,'{}')-coalesce(keys,array[]::text[]))||item);
 end loop;
 for item in select * from jsonb_array_elements(original)v where not exists(select 1 from jsonb_array_elements(visible)x where x->>id_key=v->>id_key) loop result:=result||jsonb_build_array(item);end loop;
 return result;
end $$;
create or replace function zp_private.check_references(old_data jsonb,new_data jsonb) returns void
language plpgsql stable security definer set search_path=pg_catalog,public,zp_private as $$
declare kind text; item jsonb; ident text; related boolean;
begin
 foreach kind in array array['clients','chantiers','salaries','interims','devisDossiers','catFournitures'] loop
  for item in select v from jsonb_array_elements(coalesce(old_data#>array['arr',kind],'[]'))v where not exists(select 1 from jsonb_array_elements(coalesce(new_data#>array['arr',kind],'[]'))x where x->>'id'=v->>'id') loop
   ident:=item->>'id';related:=false;
   if kind='clients' then
    select exists(select 1 from jsonb_array_elements(coalesce(new_data#>'{arr,chantiers}','[]')||coalesce(new_data#>'{arr,devisDossiers}','[]')||coalesce(new_data#>'{arr,factures}','[]'))x where x->>'clientId'=ident) into related;
   elsif kind='devisDossiers' then
    select exists(select 1 from jsonb_array_elements(coalesce(new_data#>'{arr,chantiers}','[]')||coalesce(new_data#>'{arr,commandes}','[]')||coalesce(new_data#>'{arr,factures}','[]'))x where x->>'devisId'=ident) into related;
   elsif kind='chantiers' then
    select exists(select 1 from jsonb_array_elements(coalesce(new_data#>'{arr,rapports}','[]')||coalesce(new_data#>'{arr,matConsos}','[]')||coalesce(new_data#>'{arr,demandesList}','[]'))x where x->>'chantierId'=ident or x->>'chId'=ident)
    or exists(select 1 from jsonb_each(coalesce(new_data#>'{obj,pointages}','{}'))p cross join lateral jsonb_array_elements(coalesce(p.value->'interventions','[]'))iv where iv->>'chId'=ident) into related;
   elsif kind='catFournitures' then
    select exists(select 1 from jsonb_array_elements(coalesce(new_data#>'{arr,matConsos}','[]')||coalesce(new_data#>'{arr,stockMoves}','[]'))x where x->>'pid'=ident or x->>'fid'=ident)
    or exists(select 1 from jsonb_array_elements(coalesce(new_data#>'{arr,devisDossiers}','[]'))q cross join lateral jsonb_array_elements(coalesce(q->'lignes','[]'))l cross join lateral jsonb_array_elements(coalesce(l->'four','[]'))f where f->>'fid'=ident) into related;
   else
    select exists(select 1 from jsonb_array_elements(coalesce(new_data#>'{arr,chantiers}','[]'))c where (c->'equipe') ? ident or c->>'chef'=ident) into related;
   end if;
   if not related then
    select exists(select 1 from jsonb_path_query(new_data,'$.** ? (@.type() == "object")')o cross join lateral jsonb_each(o)e where e.value=to_jsonb(ident) and e.key=any(case kind when 'clients' then array['clientId'] when 'devisDossiers' then array['devisId'] when 'chantiers' then array['chantierId','chId','k'] when 'catFournitures' then array['pid','fid'] else array['sal','pour','chef','employeeId'] end)) into related;
   end if;
   if kind='clients' then related:=related or exists(select 1 from public.app_users where client_id=ident);end if;
   if kind in ('salaries','interims') then related:=related or exists(select 1 from public.app_users where employee_id=ident) or exists(select 1 from jsonb_each(coalesce(new_data#>'{obj,planStore}','{}'))wk where wk.value ? ident);end if;
   if kind='chantiers' then related:=related or exists(select 1 from jsonb_path_query(coalesce(new_data#>'{obj,planStore}','{}'),'$.** ? (@.type() == "string")')v where v=to_jsonb(ident));end if;
   if related then raise exception 'ZP_REFERENCE: % % est utilisé. Archivez la fiche au lieu de la supprimer.',kind,ident;end if;
  end loop;
 end loop;
end $$;
create or replace function zp_private.check_invoices(old_data jsonb,new_data jsonb) returns void
language plpgsql immutable set search_path=pg_catalog as $$
declare old_f jsonb; new_f jsonb; receipt jsonb; paid numeric; net numeric;
begin
 if (select count(*) from jsonb_array_elements(coalesce(new_data#>'{arr,factures}','[]')))<>(select count(distinct v->>'num') from jsonb_array_elements(coalesce(new_data#>'{arr,factures}','[]'))v) then raise exception 'ZP_INVOICE: numéro dupliqué';end if;
 for old_f in select * from jsonb_array_elements(coalesce(old_data#>'{arr,factures}','[]')) where coalesce((value->>'locked')::boolean,false) loop
  select v into new_f from jsonb_array_elements(coalesce(new_data#>'{arr,factures}','[]'))v where v->>'num'=old_f->>'num';
  if new_f is null or (old_f-array['statut','regl','datePaiement','modePaiement','relances']) is distinct from (new_f-array['statut','regl','datePaiement','modePaiement','relances']) then raise exception 'ZP_INVOICE: pièce validée immuable, correction par avoir';end if;
 end loop;
 for new_f in select * from jsonb_array_elements(coalesce(new_data#>'{arr,factures}','[]')) loop
  select v into old_f from jsonb_array_elements(coalesce(old_data#>'{arr,factures}','[]'))v where v->>'num'=new_f->>'num';
  if new_f=old_f then continue;end if;
  if coalesce((new_f->>'locked')::boolean,false) and not coalesce((old_f->>'locked')::boolean,false) then raise exception 'ZP_INVOICE: utiliser la validation serveur';end if;
  paid:=0;
  for receipt in select * from jsonb_array_elements(coalesce(new_f->'regl','[]')) loop
   if not coalesce((new_f->>'locked')::boolean,false) or new_f->>'type'='Avoir' then raise exception 'ZP_INVOICE: règlement sur facture validée uniquement';end if;
   if jsonb_typeof(receipt->'montant') is distinct from 'number' or coalesce((receipt->>'montant')::numeric,0)<=0 or coalesce(receipt->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' or (receipt->>'date')::date>current_date then raise exception 'ZP_INVOICE: règlement invalide';end if;
   paid:=paid+round((receipt->>'montant')::numeric*100);
  end loop;
  net:=round(coalesce((new_f->>'ttc')::numeric,0)*100)-round(coalesce((new_f->>'acDeduit')::numeric,0)*100);
  if paid>greatest(net,0) then raise exception 'ZP_INVOICE: règlement supérieur au net à payer';end if;
 end loop;
end $$;
create or replace function zp_private.save_pointages(old_points jsonb,new_points jsonb,a public.app_users,d jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,zp_private as $$
declare entry record; old_pt jsonb; iv jsonb; old_iv jsonb; rows jsonb; result jsonb:=old_points; owner public.app_users; rate numeric; seconds numeric;
begin
 for entry in select * from jsonb_each(new_points) loop
  old_pt:=old_points->entry.key;
  if old_pt is not null and zp_private.pointages_for(jsonb_build_object(entry.key,old_pt),null,a.role='Gérant')->entry.key=entry.value then continue;end if;
  if split_part(entry.key,'|',1)<>a.email then raise exception 'ZP_ACCESS: pointage personnel uniquement, utilisez la révision pour corriger';end if;
  if split_part(entry.key,'|',2) !~ '^\d{4}-\d{2}-\d{2}$' or entry.value->>'day'<>split_part(entry.key,'|',2) then raise exception 'ZP_POINTAGE: date invalide';end if;
  if (select count(v->>'id') from jsonb_array_elements(coalesce(entry.value->'interventions','[]'))v)<>(select count(distinct v->>'id') from jsonb_array_elements(coalesce(entry.value->'interventions','[]'))v) then raise exception 'ZP_POINTAGE: identifiant dupliqué';end if;
  if exists(select 1 from jsonb_array_elements(coalesce(old_pt->'interventions','[]'))x where not exists(select 1 from jsonb_array_elements(coalesce(entry.value->'interventions','[]'))y where y->>'id'=x->>'id' or (x->>'id' is null and y-'coutHoraire'=x-'coutHoraire'))) then raise exception 'ZP_POINTAGE: intervention enregistrée non supprimable';end if;
  rows:='[]';
  for iv in select * from jsonb_array_elements(coalesce(entry.value->'interventions','[]')) loop
   select v into old_iv from jsonb_array_elements(coalesce(old_pt->'interventions','[]'))v where v->>'id'=iv->>'id' or (iv->>'id' is null and v-'coutHoraire'=iv-'coutHoraire');
   if old_iv is not null then
    if (old_iv-'coutHoraire') is distinct from (iv-'coutHoraire') then raise exception 'ZP_POINTAGE: intervention enregistrée, révision nécessaire';end if;
    rows:=rows||jsonb_build_array(old_iv);continue;
   end if;
   seconds:=coalesce((iv->>'secs')::numeric,-1);
   if nullif(iv->>'id','') is null or seconds<0 or seconds>172800 or not exists(select 1 from jsonb_array_elements(coalesce(d#>'{arr,chantiers}','[]'))c where c->>'id'=iv->>'chId') then raise exception 'ZP_POINTAGE: intervention invalide';end if;
   select (s->>'cout')::numeric into rate from jsonb_array_elements(coalesce(d#>'{arr,salaries}','[]')||coalesce(d#>'{arr,interims}','[]'))s where s->>'id'=a.employee_id;
   iv:=iv-array['coutHoraire','reviewedBy','reviewedAt','costVerified'];
   iv:=iv||jsonb_build_object('coutHoraire',rate,'costVerified',rate is not null,'recordedAt',now());
   if nullif(iv->>'start','') is null or nullif(iv->>'end','') is null or (iv->>'end')::numeric<(iv->>'start')::numeric then raise exception 'ZP_POINTAGE: horaires invalides';end if;
   if seconds>57600 or seconds>((iv->>'end')::numeric-(iv->>'start')::numeric)/1000+5 or (iv->>'end')::numeric>extract(epoch from now())*1000+300000 or to_char(to_timestamp((iv->>'start')::numeric/1000) at time zone 'Europe/Paris','YYYY-MM-DD')<>to_char(to_timestamp((iv->>'end')::numeric/1000) at time zone 'Europe/Paris','YYYY-MM-DD') then iv:=iv||'{"needsReview":true}'::jsonb;end if;
   rows:=rows||jsonb_build_array(iv);
  end loop;
  result:=result||jsonb_build_object(entry.key,entry.value||jsonb_build_object('interventions',rows));
 end loop;
 return result;
end $$;
create or replace function public.zp_save_workspace(expected_version bigint,new_state jsonb,client_id text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users:=zp_private.identity(); w public.workspace; old_view jsonb; incoming jsonb; result jsonb; field text; group_name text; allow_arr text[]; allow_obj text[]; allow_scal boolean; before_value jsonb; after_value jsonb; item jsonb; prior jsonb; changes jsonb:='[]'; moves jsonb; delta numeric; product_index integer;
begin
 select * into strict w from public.workspace where id='main' for update;
 if w.version<>expected_version then return jsonb_build_object('conflict',true,'version',w.version);end if;
 if new_state->>'schemaVersion'<>'8' or octet_length(new_state::text)>10000000 then raise exception 'ZP_SCHEMA: format ou taille invalide';end if;
 old_view:=zp_private.normalized(zp_private.project_workspace(w.data,a));incoming:=zp_private.normalized(new_state);result:=w.data;
 if a.role='Gérant' then allow_arr:=array(select jsonb_object_keys(old_view->'arr'));allow_obj:=array(select jsonb_object_keys(old_view->'obj'));allow_scal:=true;
 elsif a.role='Bureau' then allow_arr:=array['salaries','equipes','clients','chantiers','stock','profils','bureau','taches','demandesList','congesList','carnet','rdvs','catFournitures','ouvrages','factures','prodCats','ouvrCats','devisDossiers','stockMoves','matConsos','_delCats','journal','interims','docSections','rapports','commandes'];allow_obj:=array['congesBalance','chantierSteps','txtModeles','pointages'];allow_scal:=true;
 elsif a.role='Gestionnaire Stock' then allow_arr:=array['catFournitures','stock','stockMoves','matConsos','demandesList','prodCats','profils'];allow_obj:=array[]::text[];allow_scal:=false;
 elsif a.role='Chef d''équipe' then allow_arr:=array['taches','demandesList','rapports','chantiers'];allow_obj:=array['pointages'];allow_scal:=false;
 elsif a.role='Salarié' then allow_arr:=array['taches'];allow_obj:=array['pointages'];allow_scal:=false;
 else allow_arr:=array[]::text[];allow_obj:=array[]::text[];allow_scal:=false;end if;
 foreach group_name in array array['arr','obj','scal'] loop
  if (select array_agg(key order by key) from jsonb_object_keys(old_view->group_name)key) is distinct from (select array_agg(key order by key) from jsonb_object_keys(incoming->group_name)key) then raise exception 'ZP_SCHEMA: structure inconnue';end if;
  for field in select jsonb_object_keys(old_view->group_name) loop
   before_value:=old_view#>array[group_name,field];after_value:=incoming#>array[group_name,field];
   if before_value=after_value then continue;end if;
   if field in ('comptes','profilUser','chatMsgs') or (group_name='arr' and not(field=any(allow_arr))) or (group_name='obj' and not(field=any(allow_obj))) or (group_name='scal' and not allow_scal) then raise exception 'ZP_ACCESS: modification interdite de %',field using errcode='42501';end if;
   if jsonb_typeof(after_value)<>jsonb_typeof(before_value) then raise exception 'ZP_SCHEMA: type invalide %',field;end if;
   if field='pointages' then after_value:=zp_private.save_pointages(coalesce(w.data#>'{obj,pointages}','{}'),after_value,a,w.data);
   elsif field in ('salaries','interims','bureau') and a.role='Bureau' then
    if exists(select 1 from jsonb_array_elements(after_value)x where x ? 'cout') then raise exception 'ZP_ACCESS: coûts privés';end if;
    after_value:=zp_private.merge_rows(coalesce(w.data#>array['arr',field],'[]'),before_value,after_value,'id');
   elsif group_name='arr' and a.role in ('Chef d''équipe','Salarié') then
    -- Existing tasks are immutable except completion (or scheduling by their creator).
    if field='taches' then
     for item in select * from jsonb_array_elements(after_value) loop
      select v into prior from jsonb_array_elements(before_value)v where v->>'id'=item->>'id';
      if prior is null then
       if a.role<>'Chef d''équipe' or item->>'createdBy' is distinct from a.email then raise exception 'ZP_ACCESS: auteur de mission invalide';end if;
      elsif (prior-case when prior->>'createdBy'=a.email then array['fait','due','prio'] else array['fait'] end) is distinct from (item-case when prior->>'createdBy'=a.email then array['fait','due','prio'] else array['fait'] end) then raise exception 'ZP_ACCESS: modification de mission interdite';end if;
     end loop;
    elsif field in ('demandesList','rapports') then
     for item in select * from jsonb_array_elements(after_value) loop
      select v into prior from jsonb_array_elements(before_value)v where v->>'id'=item->>'id';
      if prior is not null and prior<>item then raise exception 'ZP_ACCESS: document déjà transmis';end if;
      if prior is null and item->>'createdBy' is distinct from a.email then raise exception 'ZP_ACCESS: auteur invalide';end if;
      if prior is null and field='demandesList' and item->>'statut'<>'attente' then raise exception 'ZP_ACCESS: statut invalide';end if;
     end loop;
    elsif field='chantiers' then
     for item in select * from jsonb_array_elements(after_value) loop
      select v into prior from jsonb_array_elements(before_value)v where v->>'id'=item->>'id';
      if prior is null or prior-'av' is distinct from item-'av' or coalesce((item->>'av')::numeric,-1) not between 0 and 100 then raise exception 'ZP_ACCESS: seul l’avancement chantier est modifiable';end if;
     end loop;
    end if;
    if exists(select 1 from jsonb_array_elements(before_value)x where not exists(select 1 from jsonb_array_elements(after_value)y where y->>'id'=x->>'id' or (x->>'id' is null and y-'coutHoraire'=x-'coutHoraire'))) then raise exception 'ZP_ACCESS: suppression interdite';end if;
    after_value:=zp_private.merge_rows(coalesce(w.data#>array[group_name,field],'[]'),before_value,after_value,'id');
   end if;
   if field='chantiers' then
    for item in select * from jsonb_array_elements(after_value) loop
     select v into prior from jsonb_array_elements(before_value)v where v->>'id'=item->>'id';
     if item->'hPointes' is distinct from prior->'hPointes' and item ? 'hPointes' then raise exception 'ZP_POINTAGE: total calculé non modifiable';end if;
    end loop;
    select coalesce(jsonb_agg(v-'hPointes'),'[]') into after_value from jsonb_array_elements(after_value)v;
   end if;
   result:=jsonb_set(result,array[group_name,field],after_value,true);changes:=changes||to_jsonb(group_name||'.'||field);
  end loop;
 end loop;
 -- Historical movements are append-only; a stock change always has a matching movement.
 for item in select * from jsonb_array_elements(coalesce(w.data#>'{arr,stockMoves}','[]')) loop
  if not exists(select 1 from jsonb_array_elements(coalesce(result#>'{arr,stockMoves}','[]'))x where x=item) then raise exception 'ZP_STOCK: historique des mouvements non modifiable';end if;
 end loop;
 select coalesce(jsonb_agg(x),'[]') into moves from jsonb_array_elements(coalesce(result#>'{arr,stockMoves}','[]'))x where not exists(select 1 from jsonb_array_elements(coalesce(w.data#>'{arr,stockMoves}','[]'))y where y->>'id'=x->>'id');
 if exists(select 1 from jsonb_array_elements(moves)m where jsonb_typeof(m->'delta') is distinct from 'number' or coalesce((m->>'delta')::numeric,0)=0 or not exists(select 1 from jsonb_array_elements(coalesce(result#>'{arr,catFournitures}','[]'))p where p->>'id'=m->>'pid')) then raise exception 'ZP_STOCK: mouvement invalide';end if;
 if (select count(*) from jsonb_array_elements(coalesce(result#>'{arr,stockMoves}','[]')))<>(select count(distinct x->>'id') from jsonb_array_elements(coalesce(result#>'{arr,stockMoves}','[]'))x) then raise exception 'ZP_STOCK: mouvement sans identifiant unique';end if;
 for item,product_index in select value,ordinality::int-1 from jsonb_array_elements(coalesce(result#>'{arr,catFournitures}','[]')) with ordinality loop
  select v into prior from jsonb_array_elements(coalesce(w.data#>'{arr,catFournitures}','[]'))v where v->>'id'=item->>'id';
  select coalesce(sum((m->>'delta')::numeric),0) into delta from jsonb_array_elements(moves)m where m->>'pid'=item->>'id';
  if prior is not distinct from item and delta=0 then continue;end if;
  if exists(select 1 from jsonb_each(item)v where v.key in ('stock','reserve','achat','seuil') and jsonb_typeof(v.value) not in ('number','null')) then raise exception 'ZP_STOCK: nombre invalide';end if;
  if prior is not null and coalesce((item->>'stock')::numeric,0)<>coalesce((prior->>'stock')::numeric,0)+delta then raise exception 'ZP_STOCK: quantité et mouvements incohérents';end if;
  if coalesce((item->>'stock')::numeric,0)<0 or coalesce((item->>'reserve')::numeric,0)<0 or coalesce((item->>'reserve')::numeric,0)>coalesce((item->>'stock')::numeric,0) or coalesce((item->>'achat')::numeric,0)<0 then raise exception 'ZP_STOCK: quantité, réservation ou prix invalide';end if;
 end loop;
 perform zp_private.check_references(w.data,result);perform zp_private.check_invoices(w.data,result);
 if result=w.data then return public.zp_load_workspace();end if;
 result:=result||jsonb_build_object('schemaVersion',8,'_src',left(client_id,100),'_ts',extract(epoch from clock_timestamp())*1000);
 -- Keep receipt corrections in the append-only server audit, independently of the browser journal.
 for item in select * from jsonb_array_elements(coalesce(result#>'{arr,factures}','[]')) loop
  select f into prior from jsonb_array_elements(coalesce(w.data#>'{arr,factures}','[]'))f where f->>'num'=item->>'num';
  if coalesce(prior->'regl','[]') is distinct from coalesce(item->'regl','[]') then insert into public.zp_audit_events(actor_email,action,entity,entity_id,details) values(a.email,'receipts','invoice',item->>'num',jsonb_build_object('before',coalesce(prior->'regl','[]'),'after',coalesce(item->'regl','[]')));end if;
 end loop;
 update public.workspace set data=result where id='main';
 insert into public.zp_audit_events(actor_email,action,entity,entity_id,details) values(a.email,'save','workspace','main',jsonb_build_object('previousVersion',w.version,'fields',changes,'stockMoves',moves));
 return public.zp_load_workspace();
end $$;
revoke all on all functions in schema zp_private from public,anon,authenticated;
revoke all on function public.zp_save_workspace(bigint,jsonb,text) from public,anon;
grant execute on function public.zp_save_workspace(bigint,jsonb,text) to authenticated;
insert into public.zp_audit_events(action,entity,entity_id,details) values('migration','schema','202610190003','{"stage":"authorized transactional writes; cutover pending"}');
commit;
