const test=require('node:test'),assert=require('node:assert/strict');
const {setup,roles,run,fields}=require('./journey-server.cjs'),{make}=require('./harness.cjs');

test('accès : chaque rôle refuse toutes les pages hors de son périmètre',()=>{
 const c=make();for(const role of ['patron','bureau','chef','gestion','ouvrier','client','comptable']){
  c.checkRole=role;run(c,"role=checkRole;view='sentinel'");
  const forbidden=run(c,'NAV.filter(n=>n.id&&!n.roles.includes(role)).map(n=>n.id)');
  for(const id of forbidden){c.target=id;run(c,'go(target)');assert.equal(run(c,'view'),'sentinel',role+'/'+id);}
 }c.dom.window.close();
});

test('base vide : toutes les pages autorisées restent utilisables pour les sept rôles',async t=>{
 const s=await setup({seed:d=>{for(const key of Object.keys(d.arr))d.arr[key]=[];for(const key of Object.keys(d.obj))if(key!=='entreprise')d.obj[key]={};}});try{
  for(const name of Object.keys(roles).filter(n=>n!=='otherclient'))await t.test(name,async()=>{
   const c=await s.client(name,{ui:true});
   for(const id of run(c,'NAV.filter(x=>x.id&&x.roles.includes(role)).map(x=>x.id)')){c.target=id;run(c,'go(target)');assert.ok(c.document.querySelector('#content').textContent.trim());}
  });
 }finally{await s.close();}
});

test('créations au même instant sur deux postes : clients et devis restent distincts',()=>{
 const a=make(),b=make(),now=Date.now();
 for(const c of [a,b]){
  c.Date=class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  run(c,"role='bureau';clients.length=0;devisDossiers.length=0;currentDevis=null");
  fields(c,{ncNom:'Client simultané'});run(c,'creerClient();newDevis()');
 }
 assert.notEqual(run(a,'clients[0].id'),run(b,'clients[0].id'));
 assert.notEqual(run(a,'devisDossiers[0].id'),run(b,'devisDossiers[0].id'));
 a.dom.window.close();b.dom.window.close();
});

test('paiement : montant au centime, zéro, trop-perçu et date future refusés avant modification',()=>{
 const c=make();run(c,"role='bureau';factures.length=0;factures.push({num:'F-test',locked:true,type:'Facture',ht:100,tva:20,ttc:120,regl:[]})");
 for(const [amount,date] of [['0','2026-10-19'],['120.01','2026-10-19'],['12abc','2026-10-19'],['10','2099-01-01']]){
  run(c,"marquerPayee('F-test')");fields(c,{encMontant:amount,encDate:date});
  run(c,"_doEncaisser('F-test')");
  assert.equal(run(c,'factures[0].regl.length'),0,amount+' / '+date);
 }
 c.dom.window.close();
});

test('approvisionnement : chef demande, magasin livre partiellement, reliquat conservé sans double débit',async()=>{
 const s=await setup();try{
  const chef=await s.client('foreman');run(chef,"openDemandeAppro({lignes:[{prod:'Produit test',qte:7,u:'u'}]})");fields(chef,{apCh:'ch1',apNote:'Recette fictive',apDue:'2026-11-02'});run(chef,'saveDemandeAppro()');await s.push(chef);
  const magasin=await s.client('store');run(magasin,'traiterDemande(demandesList[0].id)');
  magasin.document.querySelector('.trProd').value='p1';magasin.document.querySelector('.trQte').value='4';run(magasin,'_doTraiterDemande(demandesList[0].id)');
  let w=await s.push(magasin);const d=w.data.arr.demandesList[0];assert.equal(d.statut,'traite');assert.equal(d.lignes[0].reliquat,3);assert.equal(w.data.arr.catFournitures[0].stock,16);
  run(magasin,'_doTraiterDemande(demandesList[0].id)');w=await s.push(magasin);assert.equal(w.data.arr.matConsos.length,1);
  await run(chef,'_pullAndApply(true)');assert.equal(run(chef,'demandesList[0].lignes[0].reliquat'),3);
 }finally{await s.close();}
});

test('mission : affectation explicite, visibilité du salarié et retour terminé au bureau',async()=>{
 const s=await setup();try{
  const office=await s.client('office');run(office,'assignMission()');fields(office,{mPour:'s2',mTitre:'Préparer la gouttière',mCh:'ch1',mDue:'2026-11-03'});
  run(office,"confirmMission(document.querySelector('.overlay .btn.primary'))");await s.push(office);
  const worker=await s.client('worker'),foreman=await s.client('foreman');
  assert.equal(run(worker,'taches.length'),1);assert.equal(run(foreman,'taches.length'),0);
  run(worker,'taches[0].fait=true');const w=await s.push(worker);assert.equal(w.data.arr.taches[0].fait,true);
  await run(office,'_pullAndApply(true)');assert.equal(run(office,'taches[0].fait'),true);
 }finally{await s.close();}
});

test('rapport terrain : publication et avancement relus ; retouche après transmission refusée',async()=>{
 const s=await setup();try{
  const c=await s.client('foreman');
  run(c,"_rapDraft={chantierId:'ch1',date:'2026-10-20',chef:'s1',photos:[]};document.getElementById('content').innerHTML='<input id=\"rapTrav\" value=\"Pose terminée\"><input id=\"rapAv\" value=\"40\">';saveRapport()");
  const w=await s.push(c);assert.equal(w.data.arr.rapports[0].travaux,'Pose terminée');assert.equal(w.data.arr.chantiers[0].av,40);
  run(c,"rapports[0].travaux='Modification après transmission'");assert.equal(await run(c,'_cloudPush(true)'),false);assert.equal(run(c,'_pendingWrite'),true);
  assert.equal((await s.rpc('boss','zp_load_workspace')).data.arr.rapports[0].travaux,'Pose terminée');
 }finally{await s.close();}
});

test('restauration : sauvegarde, changement, reprise puis refus avec version périmée',async()=>{
 const s=await setup();try{
  const c=await s.client('boss');
  const snapshot=await run(c,"_serverAction('zp_snapshot',{note:'recette fictive'})");assert.ok(snapshot.id);
  run(c,"clients[0].nom='Changement à annuler'");await s.push(c);
  c.backupId=snapshot.id;assert.ok(await run(c,"_serverAction('zp_restore_backup',{backup_id:backupId})"));assert.equal(run(c,'clients[0].nom'),'Client A');
  await assert.rejects(s.rpc('boss','zp_restore_backup',{backup_id:snapshot.id,expected_version:snapshot.version}),/ZP_CONFLICT/);
  const denied=await s.client('office');denied.backupId=snapshot.id;assert.equal(await run(denied,"_serverAction('zp_restore_backup',{backup_id:backupId})"),false);assert.equal(run(denied,'_cloudReady'),true);
 }finally{await s.close();}
});

test('compte client déplacé : cache du dossier précédent écarté à la reconnexion',async()=>{
 const s=await setup();try{
  const c=await s.client('client');assert.equal(run(c,'clients[0].id'),'c1');
  const w=await s.rpc('boss','zp_load_workspace');
  await s.rpc('boss','zp_manage_account',{target_email:'client@example.test',profile:{nom:'Client déplacé',role:'Client',actif:true,clientId:'c2'},expected_version:w.version});
  await run(c,'_pullAndApply(true)');assert.equal(run(c,'clients.length'),1);assert.equal(run(c,'clients[0].id'),'c2');assert.equal(run(c,"JSON.stringify(_stateObj()).includes('Client A')"),false);
 }finally{await s.close();}
});

test('magasin : liaison de réservation visible sans prix de vente ni devis complet',async()=>{
 const s=await setup({seed:d=>{d.arr.chantiers[0].devisId='private-quote';}});try{
  const store=await s.rpc('store','zp_load_workspace'),worker=await s.rpc('worker','zp_load_workspace');
  assert.equal(store.data.arr.chantiers[0].devisId,'private-quote');assert.equal(store.data.arr.chantiers[0].prix,undefined);assert.equal(store.data.arr.devisDossiers.length,0);
  assert.equal(worker.data.arr.chantiers[0].devisId,undefined);
  assert.equal((await s.db.query("select has_function_privilege('authenticated','zp_private.project_workspace(jsonb,app_users)','execute') ok")).rows[0].ok,false);
 }finally{await s.close();}
});

test('créations concurrentes : références devis/commandes attribuées par le serveur et liens conservés',async()=>{
 const s=await setup({seed:d=>{d.arr.carnet=[{ref:'DE-HISTORIQUE',client:'Client historique',st:'avenir',ht:100,h:1,steps:[]}];}});try{
  const a=await s.client('office'),b=await s.client('office');
  for(const c of [a,b])run(c,"newDevis();devisClient='c1';devisLignes.push({id:_zpUuid(),des:'Ouvrage test',qte:1,pu:100,tva:20,four:[],mo:0});_syncCurDevis();setDevisStatut(currentDevis,'accepte')");
  await s.push(a);const w=await s.push(b),quotes=w.data.arr.devisDossiers,orders=w.data.arr.commandes;
  assert.equal(quotes.length,2);assert.equal(new Set(quotes.map(x=>x.ref)).size,2);assert.equal(new Set(orders.map(x=>x.num)).size,2);
  for(const q of quotes){assert.equal(orders.find(x=>x.devisId===q.id).devisRef,q.ref);assert.equal(w.data.arr.carnet.find(x=>x.devisId===q.id).ref,q.ref);assert.ok(w.data.arr.chantiers.some(x=>x.devisId===q.id));}
  run(b,"devisDossiers[0].ref='D-FAUX'");assert.equal(await run(b,'_cloudPush(true)'),false);
  assert.equal((await s.rpc('boss','zp_load_workspace')).data.arr.devisDossiers[0].ref,quotes[0].ref);
  await assert.rejects(s.as('office','select zp_private.save_workspace_v8_base(1,$1,$2)',[{},'bypass']),/permission denied/);
 }finally{await s.close();}
});

test('export devis : attente de la référence serveur, aucun PDF trompeur pendant une panne',async()=>{
 const s=await setup();try{
  const c=await s.client('office');c.prints=[];run(c,"printDoc=(html,name)=>prints.push({html,name});newDevis()");
  c.network.offline=true;await run(c,'exportDevisPDF()');assert.equal(c.prints.length,0);
  c.network.offline=false;await run(c,'exportDevisPDF()');assert.equal(c.prints.length,1);
  const w=await s.rpc('boss','zp_load_workspace');assert.match(c.prints[0].name,new RegExp(w.data.arr.devisDossiers[0].ref));assert.ok(c.prints[0].html.includes(w.data.arr.devisDossiers[0].ref));
 }finally{await s.close();}
});
