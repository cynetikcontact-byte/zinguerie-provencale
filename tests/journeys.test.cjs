const test=require('node:test'),assert=require('node:assert/strict');
const {setup,roles,run,fields}=require('./journey-server.cjs');
const {make}=require('./harness.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function tickClock(c){const clock={now:Date.now()-3*3600000};c.Date=class extends Date{constructor(...a){super(...(a.length?a:[clock.now]));}static now(){return clock.now;}};return clock;}

test('parcours commercial : nouveau client → devis accepté → commande et chantier, puis relecture serveur',async()=>{
 const s=await setup();try{
  const c=await s.client('office');
  run(c,'newDevis();quickNewClient()');
  fields(c,{qcNom:'Client de recette',qcType:'Particulier',qcTel:'0100000000',qcMail:'recette@example.test',qcVille:'Ville fictive'});
  run(c,"_saveQuickClient();devisLignes.push({id:'line-test',des:'Pose de gouttière',qte:2,pu:125.5,tva:20,four:[],mo:2});_syncCurDevis();setDevisStatut(currentDevis,'accepte')");
  let w=await s.push(c);
  const d=w.data.arr.devisDossiers[0],cl=w.data.arr.clients.find(x=>x.id===d.clientId),cm=w.data.arr.commandes.find(x=>x.devisId===d.id),ch=w.data.arr.chantiers.find(x=>x.devisId===d.id);
  assert.equal(cl.nom,'Client de recette');assert.equal(cm.lignes[0].pu,125.5);assert.equal(ch.clientId,cl.id);
  assert.equal(ch.prix,251);assert.equal(w.data.arr.carnet.filter(x=>x.devisId===d.id).length,1);
  run(c,"setDevisStatut(currentDevis,'accepte')");w=await s.push(c);
  assert.equal(w.data.arr.commandes.filter(x=>x.devisId===d.id).length,1);
  const reader=await s.client('boss');reader.id=d.id;run(reader,'openDevisDossier(id)');
  assert.equal(run(reader,'devisTotals().ttc'),301.2);
 }finally{await s.close();}
});

test('parcours facturation : acompte réglé → situations 40/60 % → solde exact et compte client isolé',async()=>{
 const s=await setup({seed:d=>{d.arr.devisDossiers=[{id:'d1',ref:'D-TEST',statut:'accepte',clientId:'c1',lignes:[{id:'l1',des:'Ouvrage',qte:1,pu:100,tva:20,four:[],mo:0}]}];}});try{
  const c=await s.client('office');
  run(c,"openDevisDossier('d1');devisToFacture()");
  let w=await s.push(c);assert.equal(w.data.arr.factures[0].ttc,36);
  await run(c,'validerFacture(factures[0].num)');
  assert.equal(run(c,'factures[0].locked'),true,JSON.stringify(c.__toasts));
  run(c,"factures[0].regl=[{id:'receipt-advance',date:ZPCore.dateKey(new Date()),montant:36,mode:'Virement'}];_facStatutSync(factures[0])");await s.push(c);
  for(const pct of [40,60]){
   run(c,"openDevisDossier('d1');openFacturerTravaux()");assert.equal(c.document.querySelectorAll('.situPct').length,1);
   c.document.querySelector('.situPct').value=String(pct);run(c,'saveFactureSituation()');await s.push(c);
   await run(c,'validerFacture(factures[0].num)');assert.equal(run(c,'factures[0].locked'),true,JSON.stringify(c.__toasts));
   run(c,"factures[0].regl=[{id:_zpUuid(),date:ZPCore.dateKey(new Date()),montant:_facNet(factures[0]),mode:'Virement'}];_facStatutSync(factures[0])");w=await s.push(c);
  }
  assert.equal(w.data.arr.factures.reduce((sum,f)=>sum+f.regl.reduce((n,r)=>n+r.montant,0),0),120);
  assert.equal(w.data.arr.factures.reduce((sum,f)=>sum+(f.acDeduit||0),0),36);
  const own=await s.rpc('client','zp_load_workspace'),other=await s.rpc('otherclient','zp_load_workspace');
  assert.equal(own.data.arr.factures.length,3);assert.equal(other.data.arr.factures.length,0);
  assert.equal((await s.db.query('select count(*)::int n from zp_invoice_register')).rows[0].n,3);
 }finally{await s.close();}
});

test('parcours terrain : démarrage → pause → reprise → clôture → lecture bureau sans coût privé',async()=>{
 const s=await setup();try{
  const c=await s.client('worker'),clock=tickClock(c);
  run(c,'openStartPointage()');fields(c,{ptCh:'ch1'});run(c,'_doStartIntervention()');await s.push(c);
  clock.now+=3600000;run(c,'pauseIntervention()');await s.push(c);
  clock.now+=1800000;run(c,'reprendreIntervention()');await s.push(c);
  clock.now+=1800000;run(c,'terminerJournee()');const w=await s.push(c);
  const pt=Object.values(w.data.obj.pointages)[0];assert.equal(pt.active,false);assert.equal(pt.interventions.length,1);assert.equal(pt.interventions[0].secs,5400);assert.equal(pt.interventions[0].coutHoraire,25);
  const office=await s.rpc('office','zp_load_workspace');assert.equal(Object.values(office.data.obj.pointages)[0].interventions[0].coutHoraire,undefined);
  assert.equal(office.data.arr.chantiers.find(x=>x.id==='ch1').hPointes,1.5);
 }finally{await s.close();}
});

test('clôture de journée : heures enregistrées avant la remarque, note durable et visible au bureau',async()=>{
 const s=await setup();try{
  const c=await s.client('worker'),clock=tickClock(c);c.prompt=()=>{throw Error('Aucun dialogue bloquant ne doit précéder la sauvegarde');};
  run(c,'openStartPointage()');fields(c,{ptCh:'ch1'});run(c,'_doStartIntervention()');await s.push(c);
  clock.now+=3600000;await run(c,'terminerJournee()');
  let w=await s.rpc('boss','zp_load_workspace'),key=Object.keys(w.data.obj.pointages)[0];
  assert.equal(w.data.obj.pointages[key].active,false);assert.equal(w.data.obj.pointages[key].interventions[0].secs,3600);
  fields(c,{ptEndNote:'Matériel manquant, signalement fictif'});c.key=key;await run(c,'_savePointageNote(key)');
  const office=await s.client('office');assert.equal(run(office,'_pointageRows()[0].note'),'Matériel manquant, signalement fictif');
  assert.match(run(office,'_hoursView()'),/Matériel manquant/);
 }finally{await s.close();}
});

test('parcours congés : création → validation → annulation → revalidation et relecture',async()=>{
 const s=await setup();try{
  const c=await s.client('boss');fields(c,{cgSal:'s2',cgFrom:'2026-11-02',cgTo:'2026-11-04',cgMotif:'Congés payés'});
  run(c,'creerConge()');await s.push(c);run(c,'validateConge(congesList[0].id)');let w=await s.push(c);assert.equal(w.data.obj.congesBalance.s2,12);
  run(c,'refuseConge(congesList[0].id)');w=await s.push(c);assert.equal(w.data.obj.congesBalance.s2,15);
  run(c,'validateConge(congesList[0].id)');w=await s.push(c);assert.equal(w.data.obj.congesBalance.s2,12);
  assert.equal(w.data.arr.congesList[0].statut,'valide');
 }finally{await s.close();}
});

test('parcours stock : réservation → consommation → réouverture et refus de la sortie excessive',async()=>{
 const s=await setup({seed:d=>{d.arr.devisDossiers=[{id:'d1',ref:'D-1',clientId:'c1',lignes:[{id:'l1',qte:1,pu:100,tva:20,four:[{fid:'p1',qte:6}]}]}];d.arr.chantiers[0].devisId='d1';}});try{
  const office=await s.client('office');run(office,"openDevisDossier('d1');_applyReserve()");await s.push(office);
  const store=await s.client('store');fields(store,{ccProd:'p1',ccQte:'4'});run(store,"_saveConso('ch1')");let w=await s.push(store);
  assert.equal(w.data.arr.catFournitures[0].stock,16);assert.equal(w.data.arr.catFournitures[0].reserve,2);
  assert.equal(w.data.arr.matConsos[0].achatUnitaire,5);assert.equal(w.data.arr.stockMoves.reduce((n,m)=>n+m.delta,0),-4);
  fields(store,{ccProd:'p1',ccQte:'21'});run(store,"_saveConso('ch1')");w=await s.push(store);assert.equal(w.data.arr.catFournitures[0].stock,16);assert.equal(w.data.arr.matConsos.length,1);
 }finally{await s.close();}
});

test('deux bureaux : modifications indépendantes fusionnées, modification du même champ arrêtée',async()=>{
 const s=await setup();try{
  const a=await s.client('office'),b=await s.client('office');
  run(a,"clients[0].tel='0101010101'");run(b,"clients[0].ville='Ville B'");await s.push(a);let w=await s.push(b);
  assert.equal(w.data.arr.clients[0].tel,'0101010101');assert.equal(w.data.arr.clients[0].ville,'Ville B');
  await run(a,'_pullAndApply(true)');run(a,"clients[0].tel='0202020202'");run(b,"clients[0].tel='0303030303'");await s.push(a);
  assert.equal(await run(b,'_cloudPush(true)'),false);assert.equal(run(b,'_syncStatus'),'conflict');assert.ok(run(b,'_syncConflicts.length')>0);
  assert.equal((await s.rpc('boss','zp_load_workspace')).data.arr.clients[0].tel,'0202020202');
  assert.equal(run(b,'clients[0].tel'),'0303030303');
 }finally{await s.close();}
});

test('coupure réseau : modification conservée, reprise persistée une seule fois',async()=>{
 const s=await setup();try{
  const c=await s.client('office');c.network.offline=true;
  run(c,"clients[0].tel='0199999999';saveState()");assert.equal(await run(c,'_cloudPush(true)'),false);assert.equal(run(c,'_pendingWrite'),true);
  assert.equal((await s.rpc('boss','zp_load_workspace')).data.arr.clients[0].tel,undefined);
  c.network.offline=false;const w=await s.push(c);assert.equal(w.data.arr.clients[0].tel,'0199999999');const before=w.version;
  assert.equal((await s.push(c)).version,before);
 }finally{await s.close();}
});

test('accusé réseau perdu après écriture : nouvelle tentative sans duplication',async()=>{
 const s=await setup();try{
  const c=await s.client('office');let lost=false;
  c.network.after=async(fn,data)=>{if(fn==='zp_save_workspace'&&!lost){lost=true;return{error:{message:'Réponse perdue'}};}return{data};};
  run(c,"clients.push({id:'once',nom:'Client unique'});saveState()");assert.equal(await run(c,'_cloudPush(true)'),false);
  const w=await s.push(c);assert.equal(w.data.arr.clients.filter(x=>x.id==='once').length,1);assert.equal(run(c,'_pendingWrite'),false);
 }finally{await s.close();}
});

test('réponse retardée après déconnexion : aucune donnée du compte réinjectée',async()=>{
 const s=await setup();try{
  const c=await s.client('office');let resolve,started;const start=new Promise(r=>started=r),hold=new Promise(r=>resolve=r);
  c.network.after=async(fn,data)=>{if(fn==='zp_save_workspace'){started();await hold;}return{data};};
  run(c,"clients[0].tel='0100000000'");const pending=run(c,'_cloudPush(true)');await start;await run(c,'logout()');resolve();assert.equal(await pending,false);
  assert.equal(run(c,'clients.length'),0);assert.equal(run(c,'sessionEmail'),null);assert.equal(c.storage.size,0);
 }finally{await s.close();}
});

test('révocation en cours de session : refus serveur, effacement local et retour connexion',async()=>{
 const s=await setup();try{
  const c=await s.client('office');let w=await s.rpc('boss','zp_load_workspace');
  await s.rpc('boss','zp_manage_account',{target_email:'office@example.test',profile:{nom:'Bureau',role:'Bureau',actif:false},expected_version:w.version});
  run(c,"clients[0].tel='0199999999'");assert.equal(await run(c,'_cloudPush(true)'),false);assert.equal(run(c,'clients.length'),0);assert.equal(run(c,'_cloudReady'),false);assert.ok(c.document.getElementById('loginEmail'));
 }finally{await s.close();}
});

test('action métier : une réponse vide du serveur ne doit jamais annoncer une réussite',async()=>{
 const c=make();run(c,"sessionEmail='office@example.test';_cloudReady=true;_lastVersion=1;_syncBase=ZPCore.clone(_stateObj())");
 c.mock={rpc:async()=>({data:null,error:null})};run(c,'sb=mock');
 assert.equal(await run(c,"_serverAction('zp_update_profile',{profile:{tel:'0100000000'}})"),false);
 assert.ok(c.__toasts.some(x=>x[1]==='error'));c.dom.window.close();
});

test('parcours des sept rôles : navigation réelle, formulaires et boutons liés au DOM',async t=>{
 const s=await setup();try{
  for(const name of Object.keys(roles).filter(x=>x!=='otherclient'))await t.test(name,async()=>{
   const c=await s.client(name,{ui:true});
   const ids=run(c,'NAV.filter(x=>x.id&&x.roles.includes(role)).map(x=>x.id)');
   for(const id of ids){c.target=id;run(c,'go(target)');assert.equal(run(c,'view'),id);assert.ok(c.document.querySelector('#content').textContent.trim(),name+'/'+id);assert.doesNotMatch(c.document.querySelector('#content').textContent,/\bundefined\b|\bNaN\b/,name+'/'+id);}
   if(['foreman','store','worker','client','accountant'].includes(name))assert.equal(run(c,'ZPCore.equal(_stateObj(),_syncBase)'),true,'La navigation ne doit pas créer de modifications métier pour '+name);
  });
 }finally{await s.close();}
});
