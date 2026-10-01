# Loker Board

A job and gig board on Homeroom. Anyone signed in can browse posted
jobs, search them by keyword, filter by tag, and post a job of their
own with a contact link.

## What's in the app

- **Board** (`/`) — job cards with title, company, tags and posted
  date. Search (`/?q=...`) matches title, company and description;
  the tag chips (`/?tag=...`) filter to one tag. Filters sync into
  the URL, so a filtered view is a shareable deep link.
- **Job detail** (`/job/<id>`) — full description plus a contact
  button. The contact the poster typed (email, phone or link) is
  turned into a mailto, tel or https link automatically.
- **Post a job** (`/post`) — validated form: title at least 3
  characters, company, contact and description required, tags
  optional (comma separated, max 8).

## How it's built

- Express + Postgres. One table, `jobs` (public by default — job
  posts are meant to be seen by everyone). Schema is applied
  idempotently on boot.
- Frontend is a single vanilla-JS page (`public/app.js`) with a
  client-side router over real paths, styled with the precompiled
  Tailwind stylesheet. Navigation is intercepted in-page so the
  platform-issued token from the iframe's first load keeps working.
- Light and dark theme follow the platform viewer's choice via the
  bridge, with the OS preference as the standalone fallback.
- In staging, four obviously-fake "Staging demo" jobs are seeded on
  boot so the board, search, tag filter and detail views are
  testable on an empty database. Production is never seeded.

## Development

- `npm ci --include=dev` then `npm run build` compiles
  `public/tailwind.css` (the image build does this on every deploy).
- `node server.js` runs the app on port 3000. Platform auth env
  vars (`USERNODE_JWT_PUBLIC_KEY`, `USERNODE_APP_ID`) are injected
  by the platform; without them the API answers 401 and the shell
  shows the sign-in prompt, which is expected outside the platform.