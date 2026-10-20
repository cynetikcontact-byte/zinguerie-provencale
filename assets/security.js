/* All dynamic HTML is sanitized. Actions are compiled closures, never strings evaluated as code. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory;else root.ZPSecurity=factory(root,root.DOMPurify);})(typeof window!=='undefined'?window:this,function(win,purify){
 'use strict';if(!purify||!purify.isSupported)throw new Error('Le filtre de sécurité HTML est indisponible.');
 const pending=new Map();let serial=0,depth=0;
 const prefix=win.crypto.randomUUID();
 function evt(type,callback){if(!/^[a-z]+$/.test(type)||typeof callback!=='function')throw Error('Action invalide');const id=prefix+'-'+(++serial);pending.set(id,{type,callback});if(pending.size>20000)pending.delete(pending.keys().next().value);return 'data-zp-action-'+type+'="'+id+'"';}
 function bind(root){for(const el of [root,...(root.querySelectorAll?.('*')||[])]){for(const a of [...(el.attributes||[])]){if(!a.name.startsWith('data-zp-action-'))continue;const entry=pending.get(a.value);el.removeAttribute(a.name);if(!entry||a.name!=='data-zp-action-'+entry.type)continue;pending.delete(a.value);el.addEventListener(entry.type,function(event){const result=entry.callback.call(this,event);if(result===false){event.preventDefault();event.stopPropagation();}});}}}
 const config={ADD_TAGS:['embed'],ADD_ATTR:['target'],ADD_DATA_URI_TAGS:['embed'],FORBID_TAGS:['iframe','object','script','base','meta'],FORBID_ATTR:['srcdoc'],ALLOW_UNKNOWN_PROTOCOLS:false,ALLOWED_URI_REGEXP:/^(?:(?:https?|mailto|tel|blob|zpfile):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i};
 purify.addHook('afterSanitizeAttributes',el=>{if(el.getAttribute?.('target')==='_blank')el.setAttribute('rel','noopener noreferrer');if(el.tagName==='EMBED'){const src=el.getAttribute('src')||'';if(!/^(https:\/\/|blob:|data:application\/pdf;base64,|zpfile:)/i.test(src))el.removeAttribute('src');}});
 function clean(value){depth++;try{return purify.sanitize(String(value??''),config);}finally{depth--;}}
 const descriptor=Object.getOwnPropertyDescriptor(win.Element.prototype,'innerHTML');
 Object.defineProperty(win.Element.prototype,'innerHTML',{...descriptor,set(value){if(depth){descriptor.set.call(this,value);return;}const html=clean(value);descriptor.set.call(this,html);bind(this);}});
 const insert=win.Element.prototype.insertAdjacentHTML;if(insert)win.Element.prototype.insertAdjacentHTML=function(position,value){insert.call(this,position,clean(value));bind(this.parentElement||this);};
 return {evt,clean,bind};
});
