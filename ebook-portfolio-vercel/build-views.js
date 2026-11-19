// Packs the HTML templates in /views into views.js so Vercel always bundles them.
// Run `npm run views` after editing views/index.html or views/admin.html.
const fs=require('fs'),path=require('path');
const out={};for(const f of ['index','admin'])out[f]=fs.readFileSync(path.join(__dirname,'views',f+'.html'),'utf8');
fs.writeFileSync(path.join(__dirname,'views.js'),'module.exports='+JSON.stringify(out)+';\n');
console.log('views.js written');
