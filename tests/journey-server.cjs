// Runs the real browser application logic against an isolated PostgreSQL database.
// No request, credential or business data from production is used.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {make,run}=require('./harness.cjs');
const roles={boss:'Gérant',office:'Bureau',foreman:"Chef d'équipe",store:'Gestionnaire Stock',worker:'Salarié',client:'Client',accountant:'Comptable',otherclient:'Client'};
const signatures={
 zp_load_workspace:[],zp_workspace_meta:[],zp_save_workspace:['expected_version','new_state','client_id'],
 zp_validate_invoice:['draft_num','expected_version'],zp_manage_account:['target_email','profile','expected_version'],
 zp_update_profile:['profile','expected_version'],zp_review_pointage:['pointage_key','intervention_id','seconds','reason','expected_version'],
 zp_restore_backup:['backup_id','expected_version'],zp_import_backup:['backup_data','expected_version'],
 zp_snapshot:['expected_version','note'],zp_export_workspace:[]
};
async function setup(options={}){
 const db=new PGlite(),contexts=[];let queue=Promise.resolve();
 const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
 await db.exec(read('tests/fixtures/legacy-schema.sql'));
 await db.exec('create table auth.users(id uuid primary key,email text)');
 for(const [name,role] of Object.entries(roles))await db.query('insert into app_users(email,nom,role) values($1,$2,$3)',[name+'@example.test',name,role]);
 await db.exec('insert into auth.users select gen_random_uuid(),email from app_users');
 const c=make(),seed=run(c,'ZPCore.clone(_stateObj())');c.dom.window.close();
 Object.assign(seed.arr,{
  factures:[],commandes:[],devisDossiers:[],stockMoves:[],matConsos:[],rapports:[],demandesList:[],journal:[],taches:[],congesList:[],carnet:[],rdvs:[],comptes:[],
  clients:[{id:'c1',nom:'Client A',adr:'1 rue du Test',mail:'client@example.test'},{id:'c2',nom:'Client B',adr:'2 rue du Test',mail:'otherclient@example.test'}],
  salaries:[{id:'s1',nom:'Chef test',cout:42,email:'foreman@example.test'},{id:'s2',nom:'Salarié test',cout:25,email:'worker@example.test'}],
  chantiers:[{id:'ch1',nom:'Chantier A',clientId:'c1',equipe:['s1','s2'],chef:'s1',av:0,statut:'cours',prix:1000,hEst:20},{id:'ch2',nom:'Chantier B',clientId:'c2',equipe:[],av:0,statut:'venir',prix:2000,hEst:30}],
  catFournitures:[{id:'p1',nom:'Produit test',u:'u',stock:20,reserve:0,reservations:{},achat:5,pu:10,mini:2}]
 });
 Object.assign(seed.obj,{pointages:{},planStore:{},planHrs:{},planNotes:{},congesBalance:{s1:15,s2:15},
  entreprise:{raison:'Entreprise fictive',adresse:'1 rue du Test',siret:'12345678900001',formeJuridique:'SARL',capital:'1000',rcs:'Test',tvaIntra:'FR00000000000',legalConfirmedAt:'2026-10-19'}});
 options.seed?.(seed);
 await db.query('insert into workspace(id,data) values($1,$2)',['main',seed]);
 for(const f of fs.readdirSync(path.join(__dirname,'../supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(read('supabase/migrations/'+f));
 await db.exec("update app_users set employee_id='s1' where email='foreman@example.test';update app_users set employee_id='s2' where email='worker@example.test';update app_users set client_id='c1' where email='client@example.test';update app_users set client_id='c2' where email='otherclient@example.test'");
 const identities=Object.fromEntries((await db.query('select email,id from auth.users')).rows.map(u=>[u.email,u]));
 function as(name,sql,args=[]){
  const email=name.includes('@')?name:name+'@example.test',u=identities[email];
  const task=queue.then(async()=>{
   await db.exec('set role authenticated');
   try{await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email,sub:u.id})]);return(await db.query(sql,args)).rows;}
   finally{await db.exec('reset role');}
  });queue=task.catch(()=>{});return task;
 }
 async function rpc(name,fn,args={}){
  assert.ok(signatures[fn],'Unknown test RPC '+fn);
  const keys=signatures[fn],values=keys.map(k=>args[k]??(k==='client_id'?'journey':null));
  return(await as(name,`select ${fn}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) as w`,values))[0].w;
 }
 async function client(name,opts={}){
  const ctx=make(opts),email=name+'@example.test',u=identities[email];contexts.push(ctx);
  ctx.rpcCalls=[];ctx.network={offline:false,before:null,after:null};
  ctx.mock={auth:{getUser:async()=>({data:{user:{id:u.id,email}}}),signOut:async()=>({error:null})},rpc:async(fn,args={})=>{
   ctx.rpcCalls.push({fn,args:structuredClone(args)});
   if(ctx.network.offline)return{error:{message:'Réseau indisponible',code:'NETWORK'}};
   if(ctx.network.before)await ctx.network.before(fn,args);
   try{const data=await rpc(name,fn,args);if(ctx.network.after)return await ctx.network.after(fn,data);return{data};}
   catch(e){return{error:{message:e.message,code:e.code}};}
  }};
  run(ctx,'sb=mock');assert.equal(await run(ctx,`_afterAuth('${email}')`),true,JSON.stringify(ctx.__toasts)+' '+ctx.document.body.textContent.slice(-1200));return ctx;
 }
 async function push(c){run(c,'saveState()');const ok=await run(c,'_cloudPush(true)');assert.equal(ok,true,JSON.stringify(c.__toasts));assert.equal(run(c,'_pendingWrite'),false);return rpc('boss','zp_load_workspace');}
 async function close(){await queue;for(const c of contexts)c.dom.window.close();await db.close();}
 return{db,seed,as,rpc,client,push,close};
}
function fields(c,values){for(const [id,value] of Object.entries(values)){let el=c.document.getElementById(id);if(!el){el=c.document.createElement('input');el.id=id;c.document.body.appendChild(el);}el.value=String(value);}}
module.exports={setup,roles,run,fields};
