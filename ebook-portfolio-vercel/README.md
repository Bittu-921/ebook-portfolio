# Ebook Portfolio (Vercel version)

Public site at `/`, admin dashboard at `/admin`, ePub reader. Books and covers are stored in **Vercel Blob**
(no local disk needed), so everything works on Vercel.

## Deploy on Vercel
1. Upload this folder to a GitHub repo (do NOT upload node_modules) and import it in Vercel. Framework: Express.
2. In the project: **Storage -> Create Database -> Blob**. Choose **Public** access and connect it to this project.
   This adds `BLOB_READ_WRITE_TOKEN` automatically.
3. **Settings -> Environment Variables**, add:
   - `ADMIN_USER` = your login id
   - `ADMIN_PASS` = a long password (login is disabled until this is set)
   - `ANTHROPIC_API_KEY` = optional, for the "Ask AI" button
4. **Redeploy** (env vars apply only to new deployments). Open `/admin`, log in, upload a book.

## Editing the pages
Edit `views/index.html` / `views/admin.html`, then run `npm install && npm run views` (regenerates `views.js`) and push.
The book cards are injected where `<!--CARDS-->` is. Photos live in `public/img/`.

## Notes
- New books show on the home page within ~30 seconds (page is cached briefly at the edge).
- Files upload straight from the browser to Blob, so large ePubs (up to 60 MB) work.
- Run locally: `vercel env pull .env.local` then `ADMIN_USER=.. ADMIN_PASS=.. BLOB_READ_WRITE_TOKEN=.. npm start`.
