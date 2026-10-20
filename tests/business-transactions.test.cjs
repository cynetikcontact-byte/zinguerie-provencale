const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{PGlite}=require('@electric-sql/pglite');
const sql=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
test('transactions : numérotation, facture immuable, comptes atomiques et restauration',async()=>{const db=new PGlite();try{
 await db.exec(sql('tests/fixtures/legacy-schema.sql'));
 await db.exec("create table auth.users(id uuid primary key,email text);insert into app_users(email,nom,role) values('boss@example.test','Boss','Gérant'),('office@example.test','Bureau','Bureau'),('foreman@example.test','Chef','Chef d''équipe');insert into auth.users select gen_random_uuid(),email from app_users;");
 const company={raison:'ZP Test',adresse:'1 rue Test',siret:'12345678900001',formeJuridique:'SARL',capital:'1000',rcs:'Test',tvaIntra:'FR00000000000',legalConfirmedAt:'2026-10-19'};
 const draft={num:'draft-1',id:'f1',clientId:'c1',clientNom:'Client',type:'Facture',locked:false,ht:100,tva:20,ttc:120,vent:{20:{ht:100,tva:20}},snapshot:{lignes:[{des:'Test',qte:1,pu:100,ht:100,tva:20}],ht:100,tva:20,ttc:120},regl:[]};
 await db.query('insert into workspace(id,data) values($1,$2)',['main',{arr:{salaries:[{id:'s1',nom:'Chef',cout:42}],clients:[{id:'c1',nom:'Client',adr:'2 rue Test'}],comptes:[],factures:[draft]},obj:{entreprise:company,pointages:{}},scal:{}}]);
 for(const f of ['202610190001_security_foundation.sql','202610190002_workspace_api.sql','202610190003_authorized_writes.sql','202610190004_business_transactions.sql'])await db.exec(sql('supabase/migrations/'+f));
 async function as(email,query,args=[]){const u=(await db.query('select id from auth.users where email=$1',[email])).rows[0];await db.exec('set role authenticated');try{await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email,sub:u.id})]);return (await db.query(query,args)).rows[0]?.w;}finally{await db.exec('reset role');}}
 const load=(email='boss@example.test')=>as(email,'select zp_load_workspace() as w');
 const save=w=>as('boss@example.test','select zp_save_workspace($1,$2) as w',[w.version,w.data]);
 let w=await load();await assert.rejects(as('foreman@example.test','select zp_validate_invoice($1,$2) as w',['draft-1',w.version]),/réservée/);
 await assert.rejects(as('boss@example.test','select zp_validate_invoice($1,$2) as w',['draft-1',w.version+1]),/ZP_CONFLICT/);
 let issued=await as('office@example.test','select zp_validate_invoice($1,$2) as w',['draft-1',w.version]);let f=issued.data.arr.factures[0];assert.match(f.num,/^F-\d{4}-0001$/);assert.equal(f.snapshot.num,f.num);assert.equal(f.snapshot.emetteur.raison,company.raison);assert.equal(f.locked,true);
 assert.equal((await as('office@example.test','select zp_validate_invoice($1,$2) as w',['draft-1',w.version])).data.arr.factures[0].num,f.num);
 w=await load();w.data.arr.factures[0].ht=1;await assert.rejects(save(w),/immuable/);
 w=await load();w.data.arr.factures=[];await assert.rejects(save(w),/immuable/);
 w=await load();w.data.arr.factures[0].regl=[{id:'r1',date:'2026-10-19',montant:60,mode:'Virement'}];w=await save(w);assert.equal(w.data.arr.factures[0].regl[0].montant,60);
 w.data.arr.factures[0].regl.push({id:'r2',date:'2026-10-19',montant:61});await assert.rejects(save(w),/supérieur/);
 w=await load();w.data.obj.entreprise.raison='Autre raison';w=await save(w);assert.equal(w.data.arr.factures[0].snapshot.emetteur.raison,'ZP Test');
 const profile={nom:'Chef mis à jour',role:"Chef d'équipe",actif:true,employeeId:'s1',tel:'0600000000'};
 w=await as('boss@example.test','select zp_manage_account($1,$2,$3) as w',['foreman@example.test',profile,w.version]);assert.equal(w.data.arr.comptes.find(x=>x.email==='foreman@example.test').employeeId,'s1');
 await assert.rejects(as('boss@example.test','select zp_manage_account($1,$2,$3) as w',['missing@example.test',profile,w.version]),/invitez d’abord/);
 assert.equal((await db.query("select count(*)::int as n from app_users where email='missing@example.test'")).rows[0].n,0);
 await assert.rejects(as('foreman@example.test','select zp_update_profile($1,$2) as w',[{role:'Gérant'},w.version]),/interdits/);
 const backup=(await db.query("select id from workspace_backups order by id limit 1")).rows[0].id;
 w=await as('boss@example.test','select zp_restore_backup($1,$2) as w',[backup,w.version]);assert.equal(w.data.arr.factures.find(x=>x.num===f.num).regl[0].montant,60);assert.equal((await db.query('select count(*)::int as n from zp_invoice_register')).rows[0].n,1);
 assert.equal((await db.query("select has_table_privilege('authenticated','zp_invoice_register','update') as ok")).rows[0].ok,false);
 }finally{await db.close();}});

test('facturation : vrai poste de commande, cumul, acompte et numérotation après 9999',async()=>{const db=new PGlite();try{
 await db.exec(sql('tests/fixtures/legacy-schema.sql'));await db.exec("create table auth.users(id uuid primary key,email text);insert into app_users(email,nom,role) values('boss@example.test','Boss','Gérant');insert into auth.users select gen_random_uuid(),email from app_users;");
 const company={raison:'Test',adresse:'1 rue',siret:'12345678900001',formeJuridique:'SARL',capital:'1000',rcs:'Test',tvaIntra:'FR00000000000',legalConfirmedAt:'2026-10-19'};
 const makeDraft=(num,pct=50)=>({num,clientId:'c1',devisId:'d1',type:'Situation',locked:false,ht:pct,tva:pct/5,ttc:pct*1.2,vent:{20:{ht:pct,tva:pct/5}},avancement:[{lineId:'line-a',pct,ht:pct}],snapshot:{lignes:[{des:'Poste A',qte:pct/100,pu:100,ht:pct,tva:20}]},regl:[]});
 await db.query('insert into workspace(id,data) values($1,$2)',['main',{arr:{clients:[{id:'c1',nom:'Client',adr:'2 rue'}],devisDossiers:[{id:'d1',clientId:'c1',lignes:[{id:'line-a',qte:1,pu:100}]}],factures:[makeDraft('d-1')]},obj:{entreprise:company},scal:{}}]);
 for(const f of ['202610190001_security_foundation.sql','202610190002_workspace_api.sql','202610190003_authorized_writes.sql','202610190004_business_transactions.sql'])await db.exec(sql('supabase/migrations/'+f));
 const u=(await db.query('select id from auth.users')).rows[0];async function call(q,args=[]){await db.exec('set role authenticated');try{await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'boss@example.test',sub:u.id})]);return(await db.query(q,args)).rows[0]?.w;}finally{await db.exec('reset role');}}
 const load=()=>call('select zp_load_workspace() as w');const save=w=>call('select zp_save_workspace($1,$2) as w',[w.version,w.data]);const validate=(num,w)=>call('select zp_validate_invoice($1,$2) as w',[num,w.version]);
 let w=await load();w.data.arr.factures[0].avancement[0].lineId='made-up';w=await save(w);await assert.rejects(validate('d-1',w),/poste ou montant/);
 w.data.arr.factures[0].avancement[0].lineId='line-a';w.data.arr.factures[0].avancement[0].ht=49;w=await save(w);await assert.rejects(validate('d-1',w),/poste ou montant/);
 w.data.arr.factures[0]=makeDraft('d-1');w.data.arr.factures.push({...makeDraft('advance'),type:'Acompte 1',avancement:[]});w=await save(w);await assert.rejects(validate('d-1',w),/acompte non réglé/);
 w.data.arr.factures.pop();w=await save(w);await db.exec("insert into zp_invoice_counters values(extract(year from now() at time zone 'Europe/Paris')::integer,'F',9999)");w=await validate('d-1',w);assert.match(w.data.arr.factures[0].num,/-10000$/);
 w.data.arr.factures.push(makeDraft('d-2',60));w=await save(w);await assert.rejects(validate('d-2',w),/cumul/);
 w.data.arr.factures[1]=makeDraft('d-2');w=await save(w);w=await validate('d-2',w);assert.match(w.data.arr.factures[1].num,/-10001$/);
 w.data.arr.factures[0].regl=[{id:'r1',date:'2026-02-30',montant:10}];await assert.rejects(save(w),/out of range|date/i);
 w=await load();w.data.arr.factures[0].regl=[{id:'r1',date:'2026-10-19',montant:10}];w=await save(w);w.data.arr.factures[0].regl=[];w=await save(w);assert.equal((await db.query("select count(*)::int n from zp_audit_events where action='receipts' and jsonb_array_length(details->'before')=1 and jsonb_array_length(details->'after')=0")).rows[0].n,1);
 const old=(await db.query('select data from workspace_backups order by id limit 1')).rows[0].data;old.arr.clients=[];old.arr.devisDossiers=[];old.arr.factures=[];const b=(await db.query("insert into workspace_backups(workspace_id,data,note) values('main',$1,'ancient') returning id",[old])).rows[0].id;
 w=await call('select zp_restore_backup($1,$2) as w',[b,w.version]);assert.equal(w.data.arr.clients[0].id,'c1');assert.equal(w.data.arr.devisDossiers[0].id,'d1');assert.equal(w.data.arr.factures.length,2);
 }finally{await db.close();}});
