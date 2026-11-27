// Disposable, loopback-only acceptance environment. All accounts and data are fictional.
// Uses the production client and migrations against PGlite, with simulated authentication.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {setup,roles}=require('../tests/journey-server.cjs');
const root=path.resolve(__dirname,'../dist'),port=8766;
async function main(){
 const simulation=await setup({seed:d=>{
  d.arr.equipes=[{nom:'Équipe de recette',chef:'s1',membres:['s2']}];
  d.arr.salaries.forEach(s=>Object.assign(s,{role:'Couvreur',habil:[],visite:'À renseigner',ok:false}));
  d.arr.bureau=[];d.arr.interims=[];d.arr.docSections=[];d.arr.ouvrages=[];d.arr.stock=[];d.arr.profils=[];
  d.arr.planResList=[];d.arr.prodCats=['Autres'];d.arr.ouvrCats=['Autres'];
 }});
 const users=Object.fromEntries((await simulation.db.query('select email,id from auth.users')).rows.map(x=>[x.email,x]));
 const csp=fs.readFileSync(path.resolve(__dirname,'../nginx.conf'),'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1]
  .replace('; upgrade-insecure-requests','').replace(/connect-src [^;]+/,"connect-src 'self'");
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1:'+port);
  if(url.pathname==='/api/invite'&&req.method==='POST'){
   // Simulation locale de la fonction Edge zp-invite : crée l'identité fictive et renvoie un jeton factice.
   if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:'+port){res.writeHead(403).end();return;}
   try{let body='';for await(const part of req){body+=part;if(body.length>10_000)throw Error('Requête trop volumineuse');}
    const {actor,email}=JSON.parse(body);if(actor!=='boss'){res.writeHead(403,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Invitation réservée au gérant.'}));return;}
    const mail=String(email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))throw Error('Adresse email invalide.');
    const found=await simulation.db.query('select id from auth.users where lower(email)=$1',[mail]);let created=false;
    if(!found.rows.length){await simulation.db.query('insert into auth.users(id,email) values(gen_random_uuid(),$1)',[mail]);created=true;}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({token:'recette-'+require('node:crypto').randomBytes(24).toString('hex'),created}));
   }catch(e){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message}));}return;
  }
  if(url.pathname==='/api/rpc'&&req.method==='POST'){
   if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:'+port){res.writeHead(403).end();return;}
   try{
    let body='';for await(const part of req){body+=part;if(body.length>11_000_000)throw Error('Requête trop volumineuse');}
    const {actor,fn,args}=JSON.parse(body);if(!roles[actor])throw Error('Profil de recette inconnu');
    let result;try{result={data:await simulation.rpc(actor,fn,args)};}catch(e){result={error:{message:e.message,code:e.code}};}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(result));
   }catch(e){res.writeHead(400).end(JSON.stringify({error:{message:e.message}}));}return;
  }
  const relative=decodeURIComponent(url.pathname).replace(/^\/+/,''),file=path.resolve(root,relative||'index.html');
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  try{
   let body=fs.readFileSync(file);
   if(relative==='assets/app-1.js'){
    body=Buffer.from(body.toString().replace('window.supabase.createClient(SUPA_URL,SUPA_KEY)','null').replace(/\n_boot\(\);\s*$/,'\n'+`
const qaRoles=${JSON.stringify(roles)},qaUsers=${JSON.stringify(users)};
const qaActor=new URLSearchParams(location.search).get('acteur')||'boss';
if(!qaRoles[qaActor])throw Error('Profil de recette inconnu');
let qaOffline=false;
const qaMsgs=[];sb={from:()=>({insert:row=>({select:()=>({single:async()=>{if(qaOffline)return {data:null,error:{message:'Coupure réseau simulée'}};const m={...row,id:crypto.randomUUID(),created_at:new Date().toISOString()};qaMsgs.push(m);return {data:m,error:null};}})}),select:()=>{const q={c:null,eq(k,v){q.c=v;return q;},gt(){return q;},neq(k,v){q.n=v;return q;},order(){return q;},limit(){return q;},or(){return q;},then(ok){ok({data:qaMsgs.filter(m=>(q.c==null||m.channel===q.c)&&(q.n==null||m.author_email!==q.n)).slice().reverse(),error:null});}};return q;}}),functions:{invoke:async(name,opts)=>{const r=await fetch('/api/invite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor:qaActor,email:opts?.body?.email})});const j=await r.json();return r.ok?{data:j,error:null}:{data:null,error:{message:j.error||'refus',context:{json:async()=>j}}};}},auth:{getUser:async()=>({data:{user:qaUsers[qaActor+'@example.test']}}),signOut:async()=>({error:null})},
rpc:async(fn,args={})=>qaOffline?{error:{message:'Coupure réseau simulée',code:'NETWORK'}}:fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor:qaActor,fn,args})}).then(r=>r.json())};
const qaBar=document.createElement('div');qaBar.id='qaBar';qaBar.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:100000;background:#252e35;color:white;padding:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font:12px system-ui';
const qaLabel=document.createElement('strong');qaLabel.textContent='RECETTE LOCALE · DONNÉES FICTIVES';qaBar.appendChild(qaLabel);
const qaSelect=document.createElement('select');qaSelect.setAttribute('aria-label','Profil de recette');
for(const [key,label] of Object.entries(qaRoles)){const o=document.createElement('option');o.value=key;o.textContent=label+(key==='otherclient'?' B':'');o.selected=key===qaActor;qaSelect.appendChild(o);}
qaSelect.addEventListener('change',()=>{location.href='/?acteur='+encodeURIComponent(qaSelect.value);});qaBar.appendChild(qaSelect);
const qaNetwork=document.createElement('button');qaNetwork.textContent='Simuler une coupure réseau';qaNetwork.addEventListener('click',()=>{qaOffline=!qaOffline;qaNetwork.textContent=qaOffline?'Rétablir le réseau':'Simuler une coupure réseau';if(!qaOffline)_cloudPush(true);});qaBar.appendChild(qaNetwork);
const qaErrors=document.createElement('span');qaErrors.id='qaErrors';qaErrors.textContent='0 erreur JavaScript';let qaErrorCount=0;for(const eventName of ['error','unhandledrejection'])window.addEventListener(eventName,()=>{qaErrors.textContent=(++qaErrorCount)+' erreur(s) JavaScript';});qaBar.appendChild(qaErrors);
document.body.appendChild(qaBar);document.body.style.paddingBottom='70px';_afterAuth(qaActor+'@example.test');
`));
   }
   const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json'};
   res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff'}).end(body);
  }catch{res.writeHead(404).end('Not found');}
 });
 server.listen(port,'127.0.0.1',()=>console.log(`Recette isolée : http://127.0.0.1:${port} — base éphémère, aucun accès à Supabase.`));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(async()=>{await simulation.close();process.exit(0);}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
