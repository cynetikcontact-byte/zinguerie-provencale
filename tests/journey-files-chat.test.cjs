const test=require('node:test'),assert=require('node:assert/strict');
const {make,run}=require('./harness.cjs'),{setup}=require('./journey-server.cjs');
const zip=require('../assets/backup.js');

test('pièces jointes : fichiers valides, vides, trop gros et types refusés',async()=>{
 const c=make(),uploaded=[];c.mock={auth:{getUser:async()=>({data:{user:{id:'test-user'}}})},storage:{from:()=>({upload:async(...args)=>{uploaded.push(args);return{data:{}};}})}};
 run(c,"sb=mock;sessionEmail='worker@example.test'");
 for(const file of [new File([''],'empty.pdf',{type:'application/pdf'}),new File(['x'],'script.html',{type:'text/html'}),new File([new Uint8Array(15*1024*1024+1)],'big.pdf',{type:'application/pdf'})]){
  c.file=file;assert.equal(await run(c,"zpStore(file,'documents')"),'');
 }
 assert.equal(uploaded.length,0);
 for(const [type,ext] of [['application/pdf','pdf'],['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['image/gif','gif']]){
  c.file=new File(['fixture'],'test.'+ext,{type});const ref=await run(c,"zpStore(file,'documents')");
  assert.match(ref,/^zpfile:test-user\/documents\/\d{4}\/.+/);
 }
 assert.equal(uploaded.length,5);assert.ok(uploaded.every(x=>x[2].upsert===false));c.dom.window.close();
});

test('pièce jointe : déconnexion pendant le transfert, aucun rattachement à une nouvelle session',async()=>{
 const c=make();let release,started;const begun=new Promise(r=>started=r),hold=new Promise(r=>release=r);
 c.mock={auth:{getUser:async()=>({data:{user:{id:'first-user'}}}),signOut:async()=>({})},storage:{from:()=>({upload:async()=>{started();await hold;return{data:{}};}})}};
 c.file=new File(['test'],'test.pdf',{type:'application/pdf'});run(c,"sb=mock;sessionEmail='first@example.test'");
 const pending=run(c,"zpStore(file,'documents')");await begun;await run(c,'logout()');release();
 assert.equal(await pending,'');assert.equal(run(c,'sessionEmail'),null);c.dom.window.close();
});

test('sauvegarde complète métier : export ZIP réel puis import, empreinte du fichier vérifiée',async()=>{
 const s=await setup({seed:d=>{d.arr.clients.push({id:'unbound',nom:'Client sans accès'});d.arr.docSections=[{id:'docs',nom:'Pièces',docs:[{id:'doc1',nom:'Recette',img:'zpfile:documents/test.pdf'}]}];}});try{
  await s.db.query("insert into storage.objects(bucket_id,name) values('zp-files','documents/test.pdf')");
  const c=await s.client('boss');let content=new Blob(['contenu fictif'],{type:'application/pdf'});
  c.mock.storage={from:()=>({download:async()=>({data:content}),upload:async()=>{throw Error('Aucun remplacement attendu');}})};
  run(c,'_downloadBlob=(blob,name)=>{window.exported={blob,name}}');await run(c,'exportData()');
  assert.ok(c.exported);const entries=zip.unpack(await c.exported.blob.arrayBuffer()),manifest=JSON.parse(new TextDecoder().decode(entries.get('backup.json')));
  assert.equal(manifest.files.length,1);assert.equal(manifest.files[0].path,'documents/test.pdf');assert.equal(manifest.files[0].sha256.length,64);
  run(c,"clients[0].nom='Compte lié conservé';clients.find(x=>x.id==='unbound').nom='À restaurer'");await s.push(c);
  c.input={value:'file',files:[new File([c.exported.blob],'recette.zip')]};await run(c,'importData(input)');
  assert.equal(run(c,"clients.find(x=>x.id==='unbound').nom"),'Client sans accès',JSON.stringify(c.__toasts));
  assert.equal(run(c,"clients.find(x=>x.id==='c1').nom"),'Client A');
  assert.equal((await s.rpc('client','zp_load_workspace')).identity.clientId,'c1');
  const before=(await s.rpc('boss','zp_load_workspace')).version;
  content=new Blob(['contenu changé'],{type:'application/pdf'});await run(c,'importData(input)');
  assert.equal((await s.rpc('boss','zp_load_workspace')).version,before);assert.ok(c.__toasts.at(-1)[0].includes('diffère'));
 }finally{await s.close();}
});

test('export : fichier absent, aucune archive présentée comme complète',async()=>{
 const c=make();c.mock={rpc:async()=>({data:{workspace:{arr:{docs:[{img:'zpfile:missing.pdf'}]},obj:{},scal:{}}}}),storage:{from:()=>({download:async()=>({error:{message:'absent'}})})}};
 run(c,"sb=mock;role='patron';sessionEmail='boss@example.test';_cloudReady=true;_lastVersion=1;_syncBase=ZPCore.clone(_stateObj());_downloadBlob=()=>{window.downloaded=true}");
 await run(c,'exportData()');assert.equal(c.downloaded,undefined);assert.ok(c.__toasts.at(-1)[0].includes('inaccessible'));c.dom.window.close();
});

test('messagerie : 205 messages, pagination stable sans perte ni doublon',async()=>{
 const c=make(),messages=Array.from({length:205},(_,i)=>({id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),created_at:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),content:'Message fictif '+i}));
 let cursor=null;
 c.mock={from:()=>({select(){return this;},eq(){return this;},order(){return this;},limit(){return this;},or(s){cursor=s;return this;},then(resolve){let rows=[...messages].reverse();if(cursor){const id=cursor.match(/id\.lt\.([^)]*)/)[1];rows=rows.filter(x=>x.id<id);}cursor=null;return Promise.resolve({data:rows.slice(0,101)}).then(resolve);}})};
 run(c,"sb=mock;sessionEmail='boss@example.test';view='dash'");await run(c,"chatLoad('general')");
 assert.equal(run(c,'chatStore.general.length'),100);assert.equal(run(c,'_chatMore.general'),true);
 await run(c,"chatLoad('general',true)");assert.equal(run(c,'chatStore.general.length'),200);
 await run(c,"chatLoad('general',true)");assert.equal(run(c,'chatStore.general.length'),205);assert.equal(run(c,'_chatMore.general'),false);
 assert.equal(run(c,'new Set(chatStore.general.map(m=>m.id)).size'),205);assert.equal(run(c,'chatStore.general[0].content'),'Message fictif 0');c.dom.window.close();
});

test('messagerie : chargement tardif après déconnexion, conversation effacée',async()=>{
 const c=make();let release,started;const begun=new Promise(r=>started=r),hold=new Promise(r=>release=r);
 c.mock={auth:{signOut:async()=>({})},from:()=>({select(){return this;},eq(){return this;},order(){return this;},limit(){return this;},async then(resolve){started();await hold;return resolve({data:[{id:'test',created_at:'2026-10-19T10:00:00Z',content:'Ancien compte'}]});}})};
 run(c,"sb=mock;sessionEmail='boss@example.test';view='dash'");const pending=run(c,"chatLoad('general')");await begun;await run(c,'logout()');release();await pending;
 assert.equal(run(c,'Object.keys(chatStore).length'),0);c.dom.window.close();
});

test('saisie hors ligne : reconnexion conserve le brouillon, puis reprise confirmée',async()=>{
 const s=await setup();try{
  const c=await s.client('office');c.network.offline=true;run(c,"clients[0].nom='Brouillon hors ligne';saveState()");await run(c,'_cloudPush(true)');
  c.network.offline=false;assert.equal(await run(c,"_afterAuth('office@example.test')"),true);await s.push(c);
  assert.equal((await s.rpc('boss','zp_load_workspace')).data.arr.clients[0].nom,'Brouillon hors ligne');
 }finally{await s.close();}
});
