const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const sql=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
async function as(db,email,query){await db.exec(`set role authenticated;select set_config('request.jwt.claims','${JSON.stringify({email})}',false);`);try{return await db.query(query);}finally{await db.exec('reset role;');}}
test('PostgreSQL : isolation messages, sauvegardes, auteurs et dernier gérant',async()=>{
 const db=new PGlite();try{
 await db.exec(sql('tests/fixtures/legacy-schema.sql'));
 await db.exec("insert into app_users(email,nom,role) values('boss@example.test','Boss','Gérant'),('a@example.test','Alice','Chef d''équipe'),('b@example.test','Bob','Bureau'),('c@example.test','Comptable','Comptable');insert into workspace(id,data) values('main','{\"arr\":{\"chantiers\":[{\"id\":\"ch1\"}]}}');");
 await db.exec(sql('supabase/migrations/202610190001_security_foundation.sql'));
 await as(db,'a@example.test',"insert into messages(channel,author_email,author_name,body) values('dm:a@example.test|b@example.test','a@example.test','Alice','Privé')");
 assert.equal((await as(db,'b@example.test','select * from messages')).rows.length,1);
 assert.equal((await as(db,'c@example.test','select * from messages')).rows.length,0);
 assert.equal((await as(db,'boss@example.test','select * from messages')).rows.length,0);
 await assert.rejects(as(db,'c@example.test',"insert into messages(channel,author_email,author_name,body) values('dm:a@example.test|b@example.test','c@example.test','Comptable','Intrusion')"),/row-level security/);
 await assert.rejects(as(db,'a@example.test',"insert into messages(channel,author_email,author_name,body) values('general','b@example.test','Bob','Usurpation')"),/row-level security/);
 assert.equal((await as(db,'a@example.test','select * from workspace_backups')).rows.length,0);
 assert.equal((await as(db,'boss@example.test','select * from workspace_backups')).rows.length,1);
 await assert.rejects(as(db,'a@example.test','select zp_nightly_snapshot()'),/permission denied/);
 await assert.rejects(as(db,'boss@example.test','delete from workspace_backups'),/permission denied/);
 await assert.rejects(as(db,'boss@example.test',"update app_users set actif=false where email='boss@example.test'"),/dernier gérant/);
 await assert.rejects(as(db,'boss@example.test',"delete from app_users where email='boss@example.test'"),/dernier gérant/);
 await assert.rejects(as(db,'a@example.test',"insert into errors(user_email,message) values('b@example.test','Faux')"),/row-level security/);
 await as(db,'boss@example.test',"update app_users set actif=false where email='a@example.test'");
 assert.equal((await as(db,'a@example.test','select * from messages')).rows.length,0);
 assert.equal((await as(db,'boss@example.test','select * from zp_audit_events')).rows.length,2);
 }finally{await db.close();}
});
