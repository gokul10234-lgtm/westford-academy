# Westford Sports - Indian Academy — Flat Deploy Package

Every file in this package sits in **one folder, with no subfolders at all**. This is
deliberately different from a normal Node.js project layout - it exists specifically
so that uploading this to GitHub from a tablet browser can't lose its folder
structure. There's nothing for an upload to flatten, because it's already flat.

## What's in here

- **Backend**: `index.js`, `db.js`, `utils.js`, `asyncHandler.js`,
  `auth-middleware.js`, `auth-routes.js`, `trainers.js`, `fees.js`, `schedule.js`,
  `students.js`, `reports.js`, `upload.js`, `public-status-routes.js`
- **Frontend** (prefixed `web-` so it can't collide with a backend filename):
  `web-index.html`, `web-login.html`, `web-change-password.html`, `web-status.html`,
  `web-styles.css`, `web-api.js`, `web-app.js`
- `package.json`, `.env.example`

`index.js` maps clean public URLs to these renamed files - e.g. a visitor requesting
`/login.html` is served `web-login.html`. You'll never see the `web-` prefix in a
browser. The server does NOT serve this folder wholesale as static files (that would
expose `db.js`, `.env`, etc. over HTTP) - only 8 specific URL paths are whitelisted.

## Step 1: Upload this to GitHub

1. Create a fresh empty repo at github.com → **New repository**.
2. On the empty repo page, tap **uploading an existing file**.
3. Select every file in this package at once and upload.
4. Commit. Refresh - you should see a flat list of ~22 files, no folders.

## Step 2: Create your free Turso database

Go to turso.tech → sign up → create a database named `westford-academy` → find its
**connection URL** and generate a **token** → save both.

## Step 3: Deploy on Render

1. render.com → **New +** → **Web Service** → connect your GitHub repo.
2. Build Command: `npm install` · Start Command: `npm start` · Instance: **Free**
3. Add Environment Variables: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `JWT_SECRET`
   (any long random string), `ADMIN_USERNAME`, `ADMIN_PASSWORD`,
   `DEFAULT_TRAINER_PASSWORD`.
4. **Create Web Service**, wait for **Live**.

## Step 4: Test it

Open your Render URL, log in with your admin credentials. Visit `/status.html` on
the same URL to see the public, no-login attendance lookup page.

## What's new in this version

- **Trainer accounts** can no longer see the Registration tab, can no longer renew
  students (Renew button removed, and the server rejects it even if called
  directly), and only ever see their own students everywhere in the app. Only the
  main admin account can register students and process renewals.
- **Renewals** no longer charge the one-time registration fee or apply any
  discount-card waiver - those only ever applied to a first-time registration. The
  Renew screen now shows just Session Fee + VAT + Total.
- **Public status page** (`/status.html`) lets a student or parent check attendance
  by phone number, student ID, or name, with no login - showing only name, student
  ID, photo, and attendance, never a phone number or any other student's details.

## Making changes later

Edit files directly on GitHub (pencil icon → edit → commit). Render redeploys
automatically within a minute or two. Your data on Turso is untouched by every
redeploy - only the app code changes.
