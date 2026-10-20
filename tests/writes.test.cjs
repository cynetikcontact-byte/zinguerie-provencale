const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{PGlite}=require('@electric-sql/pglite');
const sql=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
test('écritures serveur : CAS, coûts privés, stock, pointage personnel et références',async()=>{const db=new PGlite();try{
 await db.exec(sql('tests/fixtures/legacy-schema.sql'));
 await db.exec("create table auth.users(id uuid primary key,email text);insert into app_users(email,nom,role) values('boss@example.test','Boss','Gérant'),('office@example.test','Bureau','Bureau'),('foreman@example.test','Chef','Chef d''équipe'),('client@example.test','Client','Client');insert into auth.users select gen_random_uuid(),email from app_users;");
 const data={arr:{salaries:[{id:'s1',nom:'Chef',cout:42,visite:'privé'}],clients:[{id:'c1',nom:'Client'}],chantiers:[{id:'ch1',nom:'Toit',clientId:'c1',av:0}],comptes:[],factures:[],catFournitures:[{id:'p1',stock:10,reserve:2,pu:12}]},obj:{pointages:{},entreprise:{}},scal:{coutMO:40}};
 await db.query('insert into workspace(id,data) values($1,$2)',['main',data]);
 for(const f of ['202610190001_security_foundation.sql','202610190002_workspace_api.sql','202610190003_authorized_writes.sql'])await db.exec(sql('supabase/migrations/'+f));
 await db.exec("update app_users set employee_id='s1' where email='foreman@example.test'");
 async function as(email,fn){const u=(await db.query('select id from auth.users where email=$1',[email])).rows[0];await db.exec('set role authenticated');try{await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email,sub:u.id})]);return await fn();}finally{await db.exec('reset role');}}
 const load=email=>as(email,async()=>(await db.query('select zp_load_workspace() as w')).rows[0].w);
 const save=(email,w)=>as(email,async()=>(await db.query('select zp_save_workspace($1,$2,$3) as w',[w.version,w.data,'test'])).rows[0].w);
 let w=await load('office@example.test');w.data.arr.salaries[0].nom='Chef corrigé';let ack=await save('office@example.test',w);assert.equal(ack.data.arr.salaries[0].nom,'Chef corrigé');assert.equal((await load('boss@example.test')).data.arr.salaries[0].cout,42);assert.equal((await save('office@example.test',w)).conflict,true);
 w=await load('office@example.test');w.data.arr.salaries[0].cout=1;await assert.rejects(save('office@example.test',w),/coûts privés/);
 w=await load('office@example.test');w.data.obj.planStore={43:{s1:['ch1',null,null,null,null,null]}};await assert.rejects(save('office@example.test',w),/modification interdite/);
 w=await load('boss@example.test');w.data.arr.catFournitures[0].stock=1;await assert.rejects(save('boss@example.test',w),/ZP_STOCK/);
 w=await load('boss@example.test');w.data.arr.clients=[];await assert.rejects(save('boss@example.test',w),/ZP_REFERENCE/);
 w=await load('foreman@example.test');w.data.arr.factures=[{num:'F-1',locked:true}];await assert.rejects(save('foreman@example.test',w),/modification interdite/);
 w=await load('foreman@example.test');w.data.obj.pointages={'other@example.test|2026-10-19':{day:'2026-10-19',interventions:[]}};await assert.rejects(save('foreman@example.test',w),/personnel/);
 w=await load('foreman@example.test');w.data.obj.pointages={'foreman@example.test|2026-10-19':{day:'2026-10-19',active:false,interventions:[{id:'iv1',chId:'ch1',start:1792396800000,end:1792400400000,secs:3600,coutHoraire:999}]}};
 ack=await save('foreman@example.test',w);assert.equal(ack.data.obj.pointages['foreman@example.test|2026-10-19'].interventions[0].coutHoraire,undefined);assert.equal((await load('boss@example.test')).data.obj.pointages['foreman@example.test|2026-10-19'].interventions[0].coutHoraire,42);
 w=await load('foreman@example.test');w.data.obj.pointages['foreman@example.test|2026-10-19'].interventions[0].secs=7200;await assert.rejects(save('foreman@example.test',w),/révision nécessaire/);
 w=await load('foreman@example.test');w.data.arr.chantiers[0].av=25;ack=await save('foreman@example.test',w);assert.equal(ack.data.arr.chantiers[0].av,25);
 }finally{await db.close();}});
