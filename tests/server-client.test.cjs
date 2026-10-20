const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{PGlite}=require('@electric-sql/pglite'),{make,run}=require('./harness.cjs');
const sql=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
test('intégration client/API : projections, rendu et acquittement réel des écritures',async()=>{const db=new PGlite();try{
 await db.exec(sql('tests/fixtures/legacy-schema.sql'));await db.exec('create table auth.users(id uuid primary key,email text)');
 const roles=['Gérant','Bureau',"Chef d'équipe",'Gestionnaire Stock','Salarié','Client','Comptable'];for(let i=0;i<roles.length;i++){await db.query('insert into app_users(email,nom,role) values($1,$2,$3)',['u'+i+'@example.test','Utilisateur '+i,roles[i]]);}await db.exec('insert into auth.users select gen_random_uuid(),email from app_users');
 const seed=make(),data=run(seed,'ZPCore.clone(_stateObj())');data.arr.factures=[];data.obj.pointages={};data.arr.stockMoves=[];data.arr.devisDossiers=[];data.arr.comptes=[];await db.query('insert into workspace(id,data) values($1,$2)',['main',data]);
 for(const f of ['202610190001_security_foundation.sql','202610190002_workspace_api.sql','202610190003_authorized_writes.sql','202610190004_business_transactions.sql','202610190005_secure_cutover.sql'])await db.exec(sql('supabase/migrations/'+f));
 await db.exec("update app_users set client_id='c1' where role='Client';update app_users set employee_id='km' where role='Chef d''équipe'");
 for(let i=0;i<roles.length;i++){
  const email='u'+i+'@example.test',u=(await db.query('select id from auth.users where email=$1',[email])).rows[0],c=make();
  c.mock={auth:{getUser:async()=>({data:{user:{id:u.id,email}}})},rpc:async(name,args={})=>{await db.exec('set role authenticated');try{await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email,sub:u.id})]);const query=name==='zp_save_workspace'?'select zp_save_workspace($1,$2,$3) as w':'select '+name+'() as w',params=name==='zp_save_workspace'?[args.expected_version,args.new_state,args.client_id]:[];return{data:(await db.query(query,params)).rows[0].w};}catch(e){return{error:{message:e.message,code:e.code}};}finally{await db.exec('reset role');}}};
  run(c,'sb=mock');assert.equal(await run(c,`_afterAuth('${email}')`),true,roles[i]);
  const views=run(c,'NAV.filter(x=>x.id&&x.roles.includes(role)).map(x=>x.id)');for(const view of views){c.targetView=view;try{run(c,"view=targetView;if(views[view])document.getElementById('content').innerHTML=views[view]()");}catch(e){throw Error(roles[i]+' / '+view+': '+e.message);}}
  if(roles[i]==='Bureau'){run(c,"clients[0].tel='0199999999';saveState()");assert.equal(await run(c,'_cloudPush(true)'),true,JSON.stringify(c.__toasts));assert.equal(run(c,'_pendingWrite'),false);assert.equal(run(c,'_syncStatus'),'saved');}
  else if(['Gérant',"Chef d'équipe",'Salarié','Gestionnaire Stock'].includes(roles[i])){run(c,'saveState()');assert.equal(await run(c,'_cloudPush(true)'),true,roles[i]+JSON.stringify(c.__toasts));}
  run(c,'_clearSession(true)');
 }
 }finally{await db.close();}});
