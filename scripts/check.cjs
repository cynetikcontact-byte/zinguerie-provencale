const fs=require('node:fs'),vm=require('node:vm'),acorn=require('acorn');
const html=fs.readFileSync('index.html','utf8');let count=0;
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){if(m[1].includes('src='))continue;if(!m[2].trim())continue;acorn.parse(m[2],{ecmaVersion:'latest'});count++;}
for(const file of ['assets/core.js','assets/security.js','assets/backup.js','scripts/build.cjs','scripts/preview.cjs','scripts/recette.cjs'])new vm.Script(fs.readFileSync(file,'utf8'));
console.log('Syntaxe valide : '+count+' script(s) inline + modules et scripts de construction');
