/* Pure domain helpers. No DOM, credentials, network or mutable application state. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ZPCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cents=v=>{const n=Number(v);if(!Number.isFinite(n))throw new Error('Montant invalide');return Math.round((n+Math.sign(n)*Number.EPSILON)*100);};
  const money=v=>cents(v)/100;
  function allocate(total,weights){
    if(!weights.length)return [];const sign=total<0?-1:1,n=Math.abs(Math.round(total));
    const w=weights.map(x=>Math.max(0,Number(x)||0)),sum=w.reduce((a,b)=>a+b,0);
    if(!sum)return w.map((_,i)=>i===0?sign*n:0);
    const raw=w.map(x=>n*x/sum),out=raw.map(Math.floor);let remaining=n-out.reduce((a,b)=>a+b,0);
    const order=raw.map((x,i)=>({i,r:x-out[i]})).sort((a,b)=>b.r-a.r||a.i-b.i);
    for(let i=0;i<remaining;i++)out[order[i%order.length].i]++;
    return out.map(x=>sign*x);
  }
  function scaleVent(vent,total){
    const entries=Object.entries(vent||{});if(!entries.length)throw new Error('Ventilation TVA manquante');
    const amounts=allocate(cents(total),entries.map(([,v])=>Math.abs(cents(v.ht)+cents(v.tva))));
    const out={};entries.forEach(([rate,v],i)=>{const r=Number(rate)||0;const ht=Math.round(amounts[i]/(1+r/100));out[rate]={ht:ht/100,tva:(amounts[i]-ht)/100};});return out;
  }
  function ventTotals(vent){const a=Object.values(vent||{});const ht=a.reduce((s,v)=>s+cents(v.ht||0),0),tva=a.reduce((s,v)=>s+cents(v.tva||0),0);return {ht:ht/100,tva:tva/100,ttc:(ht+tva)/100};}
  function entityKey(a){for(const key of ['id','num','ref','email'])if(a.length&&a.every(v=>object(v)&&v[key]!=null)&&new Set(a.map(v=>String(v[key]))).size===a.length)return key;return null;}
  function merge(base,local,remote){
    const conflicts=[];
    function walk(b,l,r,path){
      if(equal(l,b))return clone(r);if(equal(r,b)||equal(l,r))return clone(l);
      if(object(b)&&object(l)&&object(r)){
        const out={};for(const k of new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])){
          if(['__proto__','prototype','constructor'].includes(k))continue;
          const v=walk(b[k],l[k],r[k],path.concat(k));if(v!==undefined)out[k]=v;
        }return out;
      }
      if(Array.isArray(b)&&Array.isArray(l)&&Array.isArray(r)){
        const sample=[...b,...l,...r];let key=null;
        for(const k of ['id','num','ref','email'])if(sample.length&&sample.every(v=>object(v)&&v[k]!=null)&&[b,l,r].every(a=>new Set(a.map(v=>String(v[k]))).size===a.length)){key=k;break;}
        if(key){const maps=[b,l,r].map(a=>new Map(a.map(v=>[String(v[key]),v]))),order=[...new Set([...r,...l,...b].map(v=>String(v[key])))];
          return order.map(k=>walk(maps[0].get(k),maps[1].get(k),maps[2].get(k),path.concat(k))).filter(v=>v!==undefined);
        }
      }
      conflicts.push({parts:path.slice(),path:path.join('.'),base:clone(b),local:clone(l),remote:clone(r)});return clone(l);
    }
    return {value:walk(base,local,remote,[]),conflicts};
  }
  const dateKey=d=>{d=d instanceof Date?d:new Date(d);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
  function dayNumber(d){return Math.round(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/86400000);}
  function isoWeek(d){const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));t.setUTCDate(t.getUTCDate()+4-(t.getUTCDay()||7));const y=t.getUTCFullYear();return {year:y,week:Math.ceil((((t-new Date(Date.UTC(y,0,1)))/86400000)+1)/7)};}
  function planningDate(index,day=0){return new Date(2026,5,22+(Number(index)-26)*7+day,12);}
  function planningPosition(d){const diff=dayNumber(d)-dayNumber(new Date(2026,5,22));return {week:26+Math.floor(diff/7),day:((diff%7)+7)%7,...Object.fromEntries(Object.entries(isoWeek(d)).map(([k,v])=>['iso'+k[0].toUpperCase()+k.slice(1),v]))};}
  function safeURL(value){const s=String(value||'').trim();if(/^(https?:|mailto:|tel:|zpfile:|blob:|data:image\/(png|jpe?g|gif|webp);base64,|data:application\/pdf;base64,)/i.test(s))return s;if(s.startsWith('#')||s.startsWith('/')&&!s.startsWith('//'))return s;return '';}
  return {clone,equal,escape,cents,money,allocate,scaleVent,ventTotals,merge,dateKey,dayNumber,isoWeek,planningDate,planningPosition,safeURL};
});
