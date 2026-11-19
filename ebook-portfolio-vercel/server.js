const express=require('express'),crypto=require('crypto'),AdmZip=require('adm-zip');
const {put,del,list}=require('@vercel/blob');
const {handleUpload}=require('@vercel/blob/client');
const views=require('./views');

const USER=process.env.ADMIN_USER||'',PASS=process.env.ADMIN_PASS||'';
const SECURE=!!process.env.VERCEL||process.env.COOKIE_SECURE==='1';
const TTL=8*3600; // login lasts 8 hours
const MAX_EPUB=60*1024*1024;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use((q,r,n)=>{r.set('X-Content-Type-Options','nosniff');n()});
app.use(express.json({limit:'1mb'}));

/* ---- auth: stateless signed cookie (works on serverless, no memory needed) ---- */
const KEY=crypto.createHash('sha256').update('sess|'+USER+'|'+PASS+'|'+(process.env.SESSION_SECRET||'')).digest();
const sign=v=>crypto.createHmac('sha256',KEY).update(v).digest('hex');
const h=s=>crypto.createHash('sha256').update(s).digest();
const same=(a,b)=>crypto.timingSafeEqual(h(a),h(b));
const cookie=q=>Object.fromEntries((q.headers.cookie||'').split(';').filter(Boolean).map(c=>{const i=c.indexOf('=');return[c.slice(0,i).trim(),decodeURIComponent(c.slice(i+1))]}));
const authed=q=>{if(!USER||!PASS)return false;const[e,s]=String(cookie(q).sid||'').split('.');
  if(!e||!s||!(Number(e)>Date.now()/1000))return false;const x=sign(e);return s.length===x.length&&crypto.timingSafeEqual(Buffer.from(s),Buffer.from(x))};
const need=(q,r,n)=>authed(q)?n():r.status(401).json({error:'Login required'});
const hits=new Map(); // best-effort rate limit (per server instance)
const limit=(key,max,ms)=>(q,r,n)=>{const k=key+q.ip,now=Date.now(),a=(hits.get(k)||[]).filter(t=>now-t<ms);if(a.length>=max)return r.status(429).json({error:'Too many requests, try again later'});a.push(now);hits.set(k,a);n()};
const setCookie=(r,v,age)=>r.set('Set-Cookie',`sid=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${SECURE?'; Secure':''}`);

app.post('/api/login',limit('login',8,15*60e3),(q,r)=>{
  if(!USER||!PASS)return r.status(500).json({error:'Server not configured: set ADMIN_USER and ADMIN_PASS in Vercel environment variables.'});
  const{user='',pass=''}=q.body||{};
  if(same(String(user),USER)&&same(String(pass),PASS)){const e=String(Math.floor(Date.now()/1000)+TTL);setCookie(r,e+'.'+sign(e),TTL);return r.json({ok:true})}
  r.status(401).json({error:'Wrong ID or password'})});
app.post('/api/logout',(q,r)=>{setCookie(r,'',0);r.json({ok:true})});
app.get('/api/me',(q,r)=>r.json({admin:authed(q)}));

/* ---- storage: Vercel Blob. Each book = meta/<id>.json + uploads/<id>.epub + uploads/<id>-cover.* ---- */
const isBlobUrl=(u,prefix)=>{try{const x=new URL(u);return x.protocol==='https:'&&x.hostname.endsWith('.public.blob.vercel-storage.com')&&x.pathname.startsWith('/'+prefix)}catch{return false}};
async function allBooks(){
  let blobs=[],cursor;
  do{const p=await list({prefix:'meta/',cursor,limit:1000});blobs=blobs.concat(p.blobs);cursor=p.hasMore?p.cursor:undefined}while(cursor);
  const rows=await Promise.all(blobs.map(b=>fetch(b.url).then(r=>r.json()).then(j=>({...j,_url:b.url})).catch(()=>null)));
  return rows.filter(Boolean).sort((a,b)=>String(b.added).localeCompare(String(a.added)));
}
const pub=b=>{const{excerpt,_url,...o}=b;return o};
const safeBooks=()=>allBooks().catch(e=>{console.error('blob list failed:',e.message);return[]});

app.get('/api/books',async(q,r)=>r.json((await safeBooks()).map(pub)));

/* browser uploads files straight to Blob (no 4.5 MB function limit); server only issues a token to the logged-in admin */
app.post('/api/upload',need,async(q,r)=>{
  try{
    const out=await handleUpload({body:q.body,request:q,
      onBeforeGenerateToken:async(pathname)=>{
        if(!/^uploads\/[\w.-]+\.(epub|jpe?g|png|webp)$/i.test(pathname))throw new Error('Bad file name');
        const isEpub=/\.epub$/i.test(pathname);
        return{allowedContentTypes:isEpub?['application/epub+zip','application/octet-stream']:['image/jpeg','image/png','image/webp'],
          maximumSizeInBytes:isEpub?MAX_EPUB:8*1024*1024,addRandomSuffix:true}},
      onUploadCompleted:async()=>{}});
    r.json(out);
  }catch(e){r.status(400).json({error:e.message||'Upload failed'})}});

async function excerpt(url){
  try{
    const head=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(4000)});
    if(Number(head.headers.get('content-length')||0)>25*1024*1024)return'';
    const buf=Buffer.from(await(await fetch(url,{signal:AbortSignal.timeout(7000)})).arrayBuffer());
    return new AdmZip(buf).getEntries().filter(e=>/\.x?html?$/i.test(e.entryName)).sort((a,b)=>a.entryName.localeCompare(b.entryName))
      .map(e=>e.getData().toString('utf8').replace(/<(script|style)[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ')).join(' ').replace(/\s+/g,' ').slice(0,14000);
  }catch{return''}}

app.post('/api/books',need,async(q,r)=>{
  const f=(k,n)=>String(q.body?.[k]||'').trim().slice(0,n),epub=f('epubUrl',600),cover=f('coverUrl',600);
  if(!f('title',200)||!isBlobUrl(epub,'uploads/')||!isBlobUrl(cover,'uploads/'))return r.status(400).json({error:'Title, an ePub file and a cover image are required'});
  try{
    const book={id:crypto.randomUUID(),title:f('title',200),author:f('author',120),genre:f('genre',60),description:f('description',2000),epub,cover,added:new Date().toISOString(),excerpt:await excerpt(epub)};
    await put(`meta/${book.id}.json`,JSON.stringify(book),{access:'public',contentType:'application/json',addRandomSuffix:false,cacheControlMaxAge:60});
    r.json(pub(book));
  }catch(e){r.status(500).json({error:'Could not save the book: '+e.message})}});

app.delete('/api/books/:id',need,async(q,r)=>{
  try{
    const b=(await allBooks()).find(x=>x.id===q.params.id);if(!b)return r.status(404).json({error:'Not found'});
    await del([b.epub,b.cover,b._url].filter(Boolean));r.json({ok:true});
  }catch(e){r.status(500).json({error:'Delete failed: '+e.message})}});

/* ---- "Ask AI" ---- */
app.post('/api/ask',limit('ask',12,3600e3),async(q,r)=>{
  const Q=String(q.body?.q||'').slice(0,500),b=(await safeBooks()).find(x=>x.id===q.body?.id);
  if(!b||!Q)return r.status(400).json({error:'Bad request'});
  if(!process.env.ANTHROPIC_API_KEY)return r.json({error:'AI is not configured. Set ANTHROPIC_API_KEY on the server.'});
  try{const x=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
    body:JSON.stringify({model:process.env.LLM_MODEL||'claude-sonnet-5-5',max_tokens:500,system:"You are a reading assistant on an author's website. Answer the reader's question using only the book details and excerpt provided. If the answer is not there, say so. Be concise.",
    messages:[{role:'user',content:`Title: ${b.title}\nAuthor: ${b.author}\nGenre: ${b.genre}\nDescription: ${b.description}\nExcerpt:\n${b.excerpt}\n\nQuestion: ${Q}`}]})});
    const d=await x.json();r.json({answer:d.content?.[0]?.text||null,error:d.content?undefined:(d.error?.message||'No answer')})}catch{r.status(502).json({error:'AI request failed'})}});

/* ---- pages ---- */
const card=b=>`<div class="card" tabindex="0" onclick="openBook('${esc(b.epub)}','${esc(b.id)}')" style="background:linear-gradient(to top,#000c,transparent 55%),#1b1f6b url('${esc(b.cover)}') center/cover"><div class="t"><b>${esc(b.title)}</b><span>${esc([b.author,b.genre].filter(Boolean).join(' · '))}</span></div></div>`;
const empty='<div class="card" style="background:linear-gradient(135deg,#3a4bff,#1b1f6b)"><div class="t"><b>Coming soon</b><span>New ebooks are on the way</span></div></div>';
app.get('/',async(q,r)=>{const books=await safeBooks();r.set('Cache-Control','public, max-age=0, s-maxage=30, stale-while-revalidate=300');r.type('html').send(views.index.replace('<!--CARDS-->',books.map(card).join('')||empty))});
app.get('/admin',(q,r)=>r.set('Cache-Control','no-store').type('html').send(views.admin));
app.use(express.static('public',{index:false}));
app.use((e,q,r,n)=>r.status(400).json({error:e.message||'Error'}));

module.exports=app;
if(require.main===module)app.listen(process.env.PORT||3000,()=>console.log('Running on http://localhost:'+(process.env.PORT||3000)));
