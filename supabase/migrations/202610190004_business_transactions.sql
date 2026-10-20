begin;
-- A separate immutable register survives workspace restoration. Numbering and validation share one transaction.
create table public.zp_invoice_counters(year integer not null,kind text not null check(kind in ('F','AV')),last_number integer not null check(last_number>=0),primary key(year,kind));
create table public.zp_invoice_register(num text primary key,issued_at timestamptz not null default now(),actor_email text not null,document jsonb not null);
alter table public.zp_invoice_counters enable row level security;
alter table public.zp_invoice_register enable row level security;
revoke all on public.zp_invoice_counters,public.zp_invoice_register from public,anon,authenticated;
insert into public.zp_invoice_register(num,actor_email,document)
 select f->>'num','legacy-import',f from public.workspace w cross join lateral jsonb_array_elements(coalesce(w.data#>'{arr,factures}','[]'))f where w.id='main' and coalesce((f->>'locked')::boolean,false);
insert into public.zp_invoice_counters(year,kind,last_number)
 select substring(num from '^[A-Z]+-(\d{4})-')::integer,split_part(num,'-',1),max(split_part(num,'-',3)::integer)
 from public.zp_invoice_register where num ~ '^(F|AV)-[0-9]{4}-[0-9]+$' group by 1,2;
create or replace function public.zp_validate_invoice(draft_num text,expected_version bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users:=zp_private.identity(); w public.workspace; f jsonb; source_f jsonb; snap jsonb; company jsonb; customer jsonb; line jsonb; v record; k text; idx integer; seq integer; year integer:=(extract(year from now() at time zone 'Europe/Paris'))::integer; kind text; number text; ht numeric:=0; tax numeric:=0; total numeric; credits numeric; line_sum numeric; order_doc jsonb; order_line jsonb; advance_total numeric:=0; deducted numeric; paid_advances numeric; used_advances numeric;
begin
 if a.role not in ('Gérant','Bureau') then raise exception 'ZP_ACCESS: validation réservée au bureau' using errcode='42501';end if;
 select * into strict w from public.workspace where id='main' for update;
 select value,ordinality::integer-1 into f,idx from jsonb_array_elements(coalesce(w.data#>'{arr,factures}','[]')) with ordinality where value->>'num'=draft_num;
 if f is null then if exists(select 1 from public.zp_invoice_register where document->>'draftNum'=draft_num) then return public.zp_load_workspace();end if;raise exception 'ZP_INVOICE: brouillon introuvable';end if;
 if coalesce((f->>'locked')::boolean,false) then return public.zp_load_workspace();end if;
 if w.version<>expected_version then raise exception 'ZP_CONFLICT: rechargez avant de valider';end if;
 company:=w.data#>'{obj,entreprise}';
 foreach k in array array['raison','adresse','siret','formeJuridique','capital','rcs','tvaIntra'] loop
  if nullif(btrim(company->>k),'') is null then raise exception 'ZP_INVOICE: information légale à confirmer : %',k;end if;
 end loop;
 if company->>'legalConfirmedAt' is null then raise exception 'ZP_INVOICE: les informations légales doivent être confirmées dans les réglages';end if;
 select c into customer from jsonb_array_elements(coalesce(w.data#>'{arr,clients}','[]'))c where c->>'id'=f->>'clientId';
 if customer is null or nullif(customer->>'nom','') is null then raise exception 'ZP_INVOICE: rattachement client requis';end if;
 customer:=customer||case when jsonb_typeof(customer->'fact')='object' then customer->'fact' else '{}'::jsonb end;
 if nullif(coalesce(customer->>'adr',customer->>'adresse'),'') is null then raise exception 'ZP_INVOICE: adresse de facturation requise';end if;
 if f->>'type'='Avoir' then kind:='AV';else kind:='F';end if;
 for v in select * from jsonb_each(coalesce(f->'vent','{}')) loop
  if v.key not in ('0','5.5','10','20') then raise exception 'ZP_INVOICE: taux TVA invalide';end if;
  ht:=ht+round(coalesce((v.value->>'ht')::numeric,0)*100);tax:=tax+round(coalesce((v.value->>'tva')::numeric,0)*100);
  if abs(round((v.value->>'ht')::numeric*v.key::numeric)-round((v.value->>'tva')::numeric*100))>1 then raise exception 'ZP_INVOICE: ventilation TVA incohérente';end if;
 end loop;
 total:=ht+tax;
 if jsonb_typeof(f->'ht') is distinct from 'number' or jsonb_typeof(f->'tva') is distinct from 'number' or jsonb_typeof(f->'ttc') is distinct from 'number' then raise exception 'ZP_INVOICE: montants numériques requis';end if;
 if ht<>round((f->>'ht')::numeric*100) or tax<>round((f->>'tva')::numeric*100) or total<>round((f->>'ttc')::numeric*100) or (kind='F' and total<=0) or (kind='AV' and total>=0) then raise exception 'ZP_INVOICE: montants incohérents';end if;
 snap:=f->'snapshot';
 select sum(round((l->>'ht')::numeric*100)) into line_sum from jsonb_array_elements(coalesce(snap->'lignes','[]'))l;
 if line_sum is distinct from ht then raise exception 'ZP_INVOICE: détail des lignes incohérent';end if;
 if kind='AV' then
  select document into source_f from public.zp_invoice_register where num=f->>'avoirDe';
  if source_f is null or source_f->>'type'='Avoir' or source_f->>'clientId' is distinct from f->>'clientId' then raise exception 'ZP_INVOICE: facture d’origine invalide';end if;
  select coalesce(sum(round((document->>'ttc')::numeric*100)),0) into credits from public.zp_invoice_register where document->>'avoirDe'=f->>'avoirDe';
  if -total>round((source_f->>'ttc')::numeric*100)+credits then raise exception 'ZP_INVOICE: avoir supérieur au solde à corriger';end if;
 end if;
 deducted:=round(coalesce((f->>'acDeduit')::numeric,0)*100);
 if deducted<0 or deducted>greatest(total,0) then raise exception 'ZP_INVOICE: déduction d’acompte invalide';end if;
 if deducted>0 then
  select coalesce(sum(round((r->>'montant')::numeric*100)),0) into paid_advances from jsonb_array_elements(w.data#>'{arr,factures}')x cross join lateral jsonb_array_elements(coalesce(x->'regl','[]'))r where x->>'devisId'=f->>'devisId' and x->>'type' ilike '%acompte%' and coalesce((x->>'locked')::boolean,false);
  select coalesce(sum(round(coalesce((document->>'acDeduit')::numeric,0)*100)),0) into used_advances from public.zp_invoice_register where document->>'devisId'=f->>'devisId';
  if deducted>paid_advances-used_advances then raise exception 'ZP_INVOICE: acompte indisponible ou déjà déduit';end if;
 end if;
 -- Check the actual contract lines, not arbitrary identifiers supplied by a browser.
 select q into order_doc from jsonb_array_elements(coalesce(w.data#>'{arr,commandes}','[]'))q where q->>'devisId'=f->>'devisId' limit 1;
 if order_doc is null then select q into order_doc from jsonb_array_elements(coalesce(w.data#>'{arr,devisDossiers}','[]'))q where q->>'id'=f->>'devisId';end if;
 if kind='F' and f->>'type' not ilike '%acompte%' and exists(
  select 1 from jsonb_array_elements(coalesce(w.data#>'{arr,factures}','[]'))x where x->>'devisId'=f->>'devisId' and x->>'type' ilike '%acompte%' and coalesce((x->>'affecte')::boolean,true)
  and round((x->>'ttc')::numeric*100)>coalesce((select sum(round((r->>'montant')::numeric*100)) from jsonb_array_elements(coalesce(x->'regl','[]'))r),0)
 ) then raise exception 'ZP_INVOICE: acompte non réglé';end if;
 if (select count(*) from jsonb_array_elements(coalesce(f->'avancement','[]')))<>(select count(distinct l->>'lineId') from jsonb_array_elements(coalesce(f->'avancement','[]'))l) then raise exception 'ZP_INVOICE: postes de situation dupliqués';end if;
 -- Advancement line ids are required, so reordering the quote cannot alter cumulative billing.
 for line in select * from jsonb_array_elements(coalesce(f->'avancement','[]')) loop
  if nullif(line->>'lineId','') is null then raise exception 'ZP_INVOICE: rattachez les postes de situation à leurs lignes de commande';end if;
  if kind='AV' then select l into order_line from jsonb_array_elements(coalesce(source_f->'avancement','[]'))l where l->>'lineId'=line->>'lineId';
   if order_line is null or (line->>'pct')::numeric>=0 or -(line->>'pct')::numeric>(order_line->>'pct')::numeric or round((line->>'ht')::numeric*100)<>round((order_line->>'ht')::numeric*(line->>'pct')::numeric/(order_line->>'pct')::numeric*100) then raise exception 'ZP_INVOICE: correction de situation incohérente';end if;
  else select l into order_line from jsonb_array_elements(coalesce(order_doc->'lignes','[]'))l where l->>'id'=line->>'lineId';
   if order_line is null or jsonb_typeof(line->'pct') is distinct from 'number' or (line->>'pct')::numeric<=0 or (line->>'pct')::numeric>100 or round((line->>'ht')::numeric*100) is distinct from round((order_line->>'qte')::numeric*(order_line->>'pu')::numeric*(line->>'pct')::numeric) then raise exception 'ZP_INVOICE: poste ou montant de situation incohérent';end if;
  end if;
  advance_total:=advance_total+round((line->>'ht')::numeric*100);
  select coalesce(sum((l->>'pct')::numeric),0) into credits from public.zp_invoice_register r cross join lateral jsonb_array_elements(coalesce(r.document->'avancement','[]'))l where r.document->>'devisId'=f->>'devisId' and l->>'lineId'=line->>'lineId';
  if credits+(line->>'pct')::numeric not between 0 and 100 then raise exception 'ZP_INVOICE: cumul de situation hors de 0 à 100 %%';end if;
 end loop;
 if jsonb_array_length(coalesce(f->'avancement','[]'))>0 and advance_total<>ht then raise exception 'ZP_INVOICE: total de situation incohérent';end if;
 insert into public.zp_invoice_counters(year,kind,last_number) values(year,kind,1)
 on conflict on constraint zp_invoice_counters_pkey do update set last_number=zp_invoice_counters.last_number+1 returning last_number into seq;
 number:=kind||'-'||year||'-'||lpad(seq::text,greatest(4,length(seq::text)),'0');
 snap:=zp_private.pick(snap,array['marche','autoliquidation'])||zp_private.pick(f,array['type','avoirDe','ht','tva','ttc','vent','acDeduit','echeance','dateEcheance'])||jsonb_build_object('lignes',zp_private.pick_rows(snap->'lignes',array['des','qte','u','pu','tva','ht']),'schema',1,'num',number,'date',now(),'clientNom',customer->>'nom','client',zp_private.pick(customer,array['nom','adr','adresse','ville','siret','tvaIntra','email','mail','tel'])||jsonb_build_object('professionnel',nullif(customer->>'siret','') is not null or customer->>'type' in ('Professionnel','Entreprise')),'emetteur',zp_private.pick(company,array['raison','adresse','tel','email','siret','formeJuridique','capital','rcs','tvaIntra','decennale','assureurAdr','decennaleZone']));
 f:=f||jsonb_build_object('draftNum',draft_num,'num',number,'date',now(),'locked',true,'snapshot',snap,'validatedBy',a.email,'validatedAt',now());
 insert into public.zp_invoice_register(num,actor_email,document) values(number,a.email,f);
 update public.workspace set data=jsonb_set(w.data,array['arr','factures',idx::text],f) where id='main';
 insert into public.zp_audit_events(actor_email,action,entity,entity_id,details) values(a.email,'issue','invoice',number,jsonb_build_object('draft',draft_num,'ttc',f->'ttc'));
 return public.zp_load_workspace();
end $$;
create or replace function public.zp_review_pointage(pointage_key text,intervention_id text,seconds integer,reason text,expected_version bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users:=zp_private.identity();w public.workspace;iv jsonb;idx integer;
begin
 if a.role not in ('Gérant','Bureau') then raise exception 'ZP_ACCESS: révision réservée au bureau' using errcode='42501';end if;
 if seconds<0 or seconds>86400 or length(btrim(reason))<5 then raise exception 'ZP_POINTAGE: durée ou motif invalide';end if;
 select * into strict w from public.workspace where id='main' for update;
 if w.version<>expected_version then raise exception 'ZP_CONFLICT: rechargez avant de corriger';end if;
 select value,ordinality::integer-1 into iv,idx from jsonb_array_elements(coalesce(w.data#>array['obj','pointages',pointage_key,'interventions'],'[]')) with ordinality where value->>'id'=intervention_id;
 if iv is null then raise exception 'ZP_POINTAGE: intervention introuvable';end if;
 insert into public.zp_audit_events(actor_email,action,entity,entity_id,details) values(a.email,'review','pointage',pointage_key||'/'||intervention_id,jsonb_build_object('before',iv,'seconds',seconds,'reason',reason));
 iv:=iv||jsonb_build_object('secs',seconds,'needsReview',false,'reviewedBy',a.email,'reviewedAt',now(),'reviewReason',reason);
 update public.workspace set data=jsonb_set(w.data,array['obj','pointages',pointage_key,'interventions',idx::text],iv) where id='main';
 return public.zp_load_workspace();
end $$;
create or replace function public.zp_manage_account(target_email text,profile jsonb,expected_version bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users:=zp_private.identity();w public.workspace;uid uuid;entry jsonb;profiles jsonb;active boolean:=coalesce((profile->>'actif')::boolean,true);emp text:=nullif(profile->>'employeeId','');client text:=nullif(profile->>'clientId','');
begin
 if a.role<>'Gérant' then raise exception 'ZP_ACCESS: gestion des comptes réservée au gérant' using errcode='42501';end if;
 select * into strict w from public.workspace where id='main' for update;
 if w.version<>expected_version then raise exception 'ZP_CONFLICT: rechargez avant de gérer un compte';end if;
 target_email:=lower(btrim(target_email));
 if nullif(btrim(profile->>'nom'),'') is null then raise exception 'ZP_ACCOUNT: nom requis';end if;
 select id into uid from auth.users where lower(email)=target_email;
 if active and uid is null then raise exception 'ZP_ACCOUNT: invitez d’abord cette adresse depuis Supabase Auth, puis activez son profil';end if;
 if emp is not null and not exists(select 1 from jsonb_array_elements(coalesce(w.data#>'{arr,salaries}','[]')||coalesce(w.data#>'{arr,interims}','[]'))s where s->>'id'=emp) then raise exception 'ZP_ACCOUNT: salarié inconnu';end if;
 if emp is not null and exists(select 1 from public.app_users where employee_id=emp and email<>target_email and actif and active) then raise exception 'ZP_ACCOUNT: salarié déjà lié à un compte actif';end if;
 if profile->>'role'='Client' and (client is null or not exists(select 1 from jsonb_array_elements(coalesce(w.data#>'{arr,clients}','[]'))c where c->>'id'=client)) then raise exception 'ZP_ACCOUNT: dossier client explicite obligatoire';end if;
 insert into public.app_users(email,nom,role,actif,auth_user_id,employee_id,client_id) values(target_email,btrim(profile->>'nom'),profile->>'role',active,uid,emp,case when profile->>'role'='Client' then client else null end)
 on conflict(email) do update set nom=excluded.nom,role=excluded.role,actif=excluded.actif,auth_user_id=excluded.auth_user_id,employee_id=excluded.employee_id,client_id=excluded.client_id;
 select coalesce(jsonb_agg(v),'[]') into profiles from jsonb_array_elements(coalesce(w.data#>'{arr,comptes}','[]'))v where lower(v->>'email')<>target_email;
 entry:=zp_private.pick(profile,array['id','tel','photo','poste'])||jsonb_build_object('email',target_email,'nom',profile->>'nom','role',profile->>'role');
 if not(entry ? 'id') then entry:=entry||jsonb_build_object('id',coalesce(uid::text,target_email));end if;
 update public.workspace set data=jsonb_set(w.data,'{arr,comptes}',profiles||jsonb_build_array(entry)) where id='main';
 if target_email=a.email and (not active or profile->>'role'<>'Gérant') then return jsonb_build_object('reauth',true);end if;
 return public.zp_load_workspace();
end $$;
create or replace function public.zp_update_profile(profile jsonb,expected_version bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users:=zp_private.identity();w public.workspace;profiles jsonb;item jsonb;found_profile boolean:=false;
begin
 select * into strict w from public.workspace where id='main' for update;
 if w.version<>expected_version then raise exception 'ZP_CONFLICT: rechargez avant de modifier le profil';end if;
 if profile-array['tel','photo','poste']<>'{}'::jsonb then raise exception 'ZP_ACCOUNT: champs de profil interdits';end if;
 profiles:='[]';for item in select * from jsonb_array_elements(coalesce(w.data#>'{arr,comptes}','[]')) loop
  if lower(item->>'email')=a.email then item:=item||profile;found_profile:=true;end if;profiles:=profiles||jsonb_build_array(item);
 end loop;
 if not found_profile then profiles:=profiles||jsonb_build_array(profile||jsonb_build_object('id',a.auth_user_id,'email',a.email,'nom',a.nom,'role',a.role));end if;
 update public.workspace set data=jsonb_set(w.data,'{arr,comptes}',profiles) where id='main';
 insert into public.zp_audit_events(actor_email,action,entity,entity_id) values(a.email,'update_profile','account',a.email);
 return public.zp_load_workspace();
end $$;
create or replace function public.zp_snapshot(expected_version bigint,note text default 'manuel') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users:=zp_private.identity();w public.workspace;bid bigint;
begin
 if a.role<>'Gérant' then raise exception 'ZP_ACCESS: sauvegarde réservée au gérant' using errcode='42501';end if;
 select * into strict w from public.workspace where id='main' for share;
 if w.version<>expected_version then raise exception 'ZP_CONFLICT: rechargez avant la sauvegarde';end if;
 insert into public.workspace_backups(workspace_id,data,note) values('main',w.data,left(note,200)||' — '||a.email) returning id into bid;
 return jsonb_build_object('id',bid,'version',w.version);
end $$;
create or replace function public.zp_export_workspace() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users:=zp_private.identity();
begin
 if a.role<>'Gérant' then raise exception 'ZP_ACCESS: export complet réservé au gérant' using errcode='42501';end if;
 return (select jsonb_build_object('format','zp-backup-v8','createdAt',now(),'version',version,'workspace',data,'accounts',coalesce((select jsonb_agg(zp_private.pick(to_jsonb(u),array['email','nom','role','actif','employee_id','client_id'])) from public.app_users u),'[]'),'invoices',coalesce((select jsonb_agg(document) from public.zp_invoice_register),'[]')) from public.workspace where id='main');
end $$;
create or replace function public.zp_restore_backup(backup_id bigint,expected_version bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users:=zp_private.identity();w public.workspace;restored jsonb;reg record;f jsonb;parent jsonb;kind text;ident text;
begin
 if a.role<>'Gérant' then raise exception 'ZP_ACCESS: restauration réservée au gérant' using errcode='42501';end if;
 select * into strict w from public.workspace where id='main' for update;
 if w.version<>expected_version then raise exception 'ZP_CONFLICT: données modifiées, rechargez avant de restaurer';end if;
 select data into restored from public.workspace_backups where id=backup_id and workspace_id='main';
 if restored is null then raise exception 'ZP_BACKUP: sauvegarde introuvable';end if;
 -- Retain every issued document and its present receipt history, even in an older snapshot.
 for reg in select * from public.zp_invoice_register loop
  select v into f from jsonb_array_elements(coalesce(w.data#>'{arr,factures}','[]'))v where v->>'num'=reg.num;
  -- Keep the dossiers linked to issued documents when restoring a snapshot predating them.
  foreach kind in array array['clients','devisDossiers','commandes','chantiers'] loop
   for parent in select v from jsonb_array_elements(coalesce(w.data#>array['arr',kind],'[]'))v where (kind='clients' and v->>'id'=reg.document->>'clientId') or (kind='devisDossiers' and v->>'id'=reg.document->>'devisId') or (kind in ('commandes','chantiers') and v->>'devisId'=reg.document->>'devisId') loop
    if not exists(select 1 from jsonb_array_elements(coalesce(restored#>array['arr',kind],'[]'))x where x->>'id'=parent->>'id') then restored:=jsonb_set(restored,array['arr',kind],coalesce(restored#>array['arr',kind],'[]')||jsonb_build_array(parent));end if;
   end loop;
  end loop;
  restored:=jsonb_set(restored,'{arr,factures}',coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(restored#>'{arr,factures}','[]'))v where v->>'num'<>reg.num),'[]')||jsonb_build_array(coalesce(f,reg.document)));
 end loop;
 restored:=jsonb_set(restored,'{scal,_devisSeq}',to_jsonb(greatest(coalesce((restored#>>'{scal,_devisSeq}')::integer,0),coalesce((w.data#>>'{scal,_devisSeq}')::integer,0))));
 -- Preserve the employee/client dossiers of current authoritative account bindings.
 foreach kind in array array['clients','salaries','interims'] loop
  for parent in select v from jsonb_array_elements(coalesce(w.data#>array['arr',kind],'[]'))v where exists(select 1 from public.app_users u where (kind='clients' and u.client_id=v->>'id') or (kind<>'clients' and u.employee_id=v->>'id')) loop
   if not exists(select 1 from jsonb_array_elements(coalesce(restored#>array['arr',kind],'[]'))x where x->>'id'=parent->>'id') then restored:=jsonb_set(restored,array['arr',kind],coalesce(restored#>array['arr',kind],'[]')||jsonb_build_array(parent));end if;
  end loop;
 end loop;
 -- The existing anti-regression trigger remains in force. A rejected restore leaves both states intact.
 insert into public.workspace_backups(workspace_id,data,note) values('main',w.data,'before restore '||backup_id||' by '||a.email);
 update public.workspace set data=restored where id='main';
 insert into public.zp_audit_events(actor_email,action,entity,entity_id,details) values(a.email,'restore','workspace','main',jsonb_build_object('backup',backup_id,'previousVersion',w.version));
 return public.zp_load_workspace();
end $$;
create or replace function public.zp_import_backup(backup_data jsonb,expected_version bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,zp_private as $$
declare a public.app_users:=zp_private.identity();w public.workspace;bid bigint;ref jsonb;entry record;
begin
 if a.role<>'Gérant' then raise exception 'ZP_ACCESS: import réservé au gérant' using errcode='42501';end if;
 select * into strict w from public.workspace where id='main' for update;
 if w.version<>expected_version then raise exception 'ZP_CONFLICT: rechargez avant la restauration';end if;
 if octet_length(backup_data::text)>10000000 or jsonb_typeof(backup_data->'arr') is distinct from 'object' or jsonb_typeof(backup_data->'obj') is distinct from 'object' or jsonb_typeof(backup_data->'scal') is distinct from 'object' then raise exception 'ZP_BACKUP: structure invalide';end if;
 perform zp_private.project_workspace(backup_data,a);
 for ref in select * from jsonb_path_query(backup_data,'$.** ? (@.type() == "string" && @ starts with "zpfile:")') loop
  if not exists(select 1 from storage.objects where bucket_id='zp-files' and name=substring(ref#>>'{}' from 8)) then raise exception 'ZP_BACKUP: pièce jointe manquante';end if;
 end loop;
 insert into public.workspace_backups(workspace_id,data,note) values('main',backup_data,'import vérifié — '||a.email) returning id into bid;
 return public.zp_restore_backup(bid,expected_version);
end $$;
revoke all on function public.zp_validate_invoice(text,bigint),public.zp_review_pointage(text,text,integer,text,bigint),public.zp_manage_account(text,jsonb,bigint),public.zp_update_profile(jsonb,bigint),public.zp_restore_backup(bigint,bigint),public.zp_snapshot(bigint,text),public.zp_export_workspace(),public.zp_import_backup(jsonb,bigint) from public,anon;
grant execute on function public.zp_validate_invoice(text,bigint),public.zp_review_pointage(text,text,integer,text,bigint),public.zp_manage_account(text,jsonb,bigint),public.zp_update_profile(jsonb,bigint),public.zp_restore_backup(bigint,bigint),public.zp_snapshot(bigint,text),public.zp_export_workspace(),public.zp_import_backup(jsonb,bigint) to authenticated;
insert into public.zp_audit_events(action,entity,entity_id,details) values('migration','schema','202610190004','{"stage":"invoices, accounts, review and restore"}');
commit;
