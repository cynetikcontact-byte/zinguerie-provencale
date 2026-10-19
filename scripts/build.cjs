const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'dist');
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});fs.cpSync(path.join(root,'assets'),path.join(out,'assets'),{recursive:true});
let html=fs.readFileSync(path.join(root,'index.html'),'utf8'),n=0;
// The deployed page has no executable inline scripts, so CSP needs no unsafe-inline or eval.
html=html.replace(/<script>([\s\S]*?)<\/script>/g,(_,js)=>{const filename='app-'+(++n)+'.js';fs.writeFileSync(path.join(out,'assets',filename),js);return '<script src="/assets/'+filename+'"></script>';});
fs.writeFileSync(path.join(out,'index.html'),html);
fs.writeFileSync(path.join(out,'health.json'),JSON.stringify({app:'zptools',version:require('../package.json').version}));
console.log('Production : '+n+' script externe, '+fs.statSync(path.join(out,'index.html')).size+' octets HTML.');
