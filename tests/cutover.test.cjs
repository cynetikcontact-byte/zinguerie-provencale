const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{PGlite}=require('@electric-sql/pglite');
const sql=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
test('bascule : accès direct fermé, fichiers privés, référence forgée et import contrôlé',async()=>{const db=new PGlite();try{
 await db.exec(sql('tests/fixtures/legacy-schema.sql'));
 await db.exec("create table auth.users(id uuid primary key,email text);insert into app_users(email,nom,role) values('boss@example.test','Boss','Gérant'),('foreman@example.test','Chef','Chef d''équipe');insert into auth.users select gen_random_uuid(),email from app_users;");
 const original={arr:{factures:[],docSections:[{docs:[{img:'zpfile:documents/private.pdf'}]}],catFournitures:[{id:'p1',ft:'zpfile:ft/public.pdf'}],rapports:[],comptes:[]},obj:{pointages:{}},scal:{_devisSeq:5}};
 await db.query('insert into workspace(id,data) values($1,$2)',['main',original]);
 await db.exec("insert into storage.objects(bucket_id,name) values('zp-files','documents/private.pdf'),('zp-files','ft/public.pdf')");
 for(const f of ['202610190001_security_foundation.sql','202610190002_workspace_api.sql','202610190003_authorized_writes.sql','202610190004_business_transactions.sql','202610190005_secure_cutover.sql'])await db.exec(sql('supabase/migrations/'+f));
 async function as(email,fn){const u=(await db.query('select id from auth.users where email=$1',[email])).rows[0];await db.exec('set role authenticated');try{await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email,sub:u.id})]);return await fn(u.id);}finally{await db.exec('reset role');}}
 await as('foreman@example.test',async uid=>{
  await assert.rejects(db.query('select * from workspace'),/permission denied/);await assert.rejects(db.query("update workspace set data='{}'"),/permission denied/);await assert.rejects(db.query("update app_users set role='Gérant'"),/permission denied/);
  assert.deepEqual((await db.query('select name from storage.objects')).rows.map(x=>x.name),['ft/public.pdf']);
  const w=(await db.query('select zp_load_workspace() as w')).rows[0].w;w.data.arr.rapports.push({id:'r1',createdBy:'foreman@example.test',photos:['zpfile:documents/private.pdf']});
  await assert.rejects(db.query('select zp_save_workspace($1,$2)',[w.version,w.data]),/fichier hors périmètre/);
  w.data.arr.rapports[0].photos=['zpfile:'+uid+'/rapports/test.jpg'];await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['zp-files',uid+'/rapports/test.jpg']);await db.query('select zp_save_workspace($1,$2)',[w.version,w.data]);
 });
 await as('boss@example.test',async()=>{
  const w=(await db.query('select zp_load_workspace() as w')).rows[0].w,backup=structuredClone(original);backup.arr.docSections[0].docs[0].img='zpfile:missing.pdf';
  await assert.rejects(db.query('select zp_import_backup($1,$2)',[backup,w.version]),/pièce jointe manquante/);
  const r=(await db.query('select zp_import_backup($1,$2) as w',[original,w.version])).rows[0].w;assert.equal(r.data.scal._devisSeq,5);
  assert.equal((await db.query("select zp_file_unreferenced('documents/private.pdf') as ok")).rows[0].ok,false);
 });
 }finally{await db.close();}});
