const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{JSDOM}=require('jsdom');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m=>m[1].includes('function _cloudPush'))[1].replace('const _renderOrig=render','let _renderOrig=render').replace(/\n_boot\(\);\s*$/,'\n');
function make(){
 const dom=new JSDOM(html,{url:'http://localhost',runScripts:'outside-only'}),document=dom.window.document,storage=new Map();const security=require('../assets/security.js')(dom.window,require('dompurify')(dom.window));
 const ctx={document,console,ZPSecurity:security,window:null,ZPCore:require('../assets/core.js'),ZPBackup:require('../assets/backup.js'),navigator:{userAgent:'zptools-test',onLine:true},location:{search:'',origin:'http://localhost',hash:'',reload(){}},history:{pushState(){},replaceState(){}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k),key:i=>[...storage.keys()][i],get length(){return storage.size}},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},requestAnimationFrame(){},confirm:()=>true,prompt:()=>'',alert(){},URL,URLSearchParams,Blob,File,TextEncoder,TextDecoder,atob,btoa,crypto:require('node:crypto').webcrypto,Date,Image:class{},Chart:class{destroy(){}}};
 ctx.window=ctx;ctx.addEventListener=()=>{};ctx.__toasts=[];ctx.storage=storage;
 vm.createContext(ctx);vm.runInContext(source,ctx,{timeout:5000});
 vm.runInContext("render=()=>{};renderNav=()=>{};_renderOrig=()=>{};closeSidebar=()=>{};applyAvatar=()=>{};_applyRoleUI=()=>{};toast=(...a)=>__toasts.push(a);_logAction=()=>{};",ctx);
 return ctx;
}
const run=(c,s)=>vm.runInContext(s,c,{timeout:5000});
module.exports={make,run,source};
