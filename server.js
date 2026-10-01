const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Staging-vs-production is a DATA switch only: it gates the boot-time demo
// seed and nothing else. Every screen, endpoint and code path is identical
// in both environments.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// Graceful shutdown state, declared before the routes that read it.
const DRAIN_MS = 3000;
let shuttingDown = false;
let server = null;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'draining' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---- Jobs API ----

// List jobs. Optional `q` (searches title, company and description) and
// `tag` (exact match on one tag). The response also carries every distinct
// tag in the board so the frontend can render the filter chips in one
// request.
app.get('/api/jobs', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const tag = (req.query.tag || '').toString().trim();
    // Escape the user's % and _ so a search for "50%" doesn't become a
    // wildcard pattern of its own.
    const like = '%' + q.replace(/([%_\\])/g, '\\$1') + '%';
    const { rows } = await pool.query(`
      SELECT id, title, company, tags, created_at
      FROM jobs
      WHERE (title ILIKE $1 OR company ILIKE $1 OR description ILIKE $1)
        AND ($2 = '' OR $2 = ANY(tags))
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `, [like, tag]);
    const { rows: tagRows } = await pool.query(`
      SELECT DISTINCT t AS tag
      FROM (SELECT unnest(tags) AS t FROM jobs) AS all_tags
      ORDER BY tag
    `);
    res.json({ jobs: rows, tags: tagRows.map((r) => r.tag) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One job, for the detail view.
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid job id' });
    }
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    res.json({ job: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post a job. Validation lives here so the API contract holds no matter
// which client talks to it; the form mirrors the same rules for instant
// feedback.
function parseTags(raw) {
  const list = (Array.isArray(raw) ? raw.join(',') : String(raw || ''))
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length <= 30)
    .slice(0, 8);
  return [...new Set(list)];
}

app.post('/api/jobs', async (req, res) => {
  try {
    const body = req.body || {};
    const title = String(body.title || '').trim();
    const company = String(body.company || '').trim();
    const description = String(body.description || '').trim();
    const contact = String(body.contact || '').trim();
    const tags = parseTags(body.tags);

    const errors = [];
    if (title.length < 3) errors.push('Title must be at least 3 characters');
    if (title.length > 200) errors.push('Title must be 200 characters or fewer');
    if (!company) errors.push('Company is required');
    if (company.length > 200) errors.push('Company must be 200 characters or fewer');
    if (!description) errors.push('Description is required');
    if (description.length > 5000) errors.push('Description must be 5000 characters or fewer');
    if (!contact) errors.push('Contact is required');
    if (contact.length > 500) errors.push('Contact must be 500 characters or fewer');
    if (errors.length) return res.status(400).json({ error: errors[0], details: errors });

    const { rows } = await pool.query(`
      INSERT INTO jobs (user_id, username, title, company, description, contact, tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, title, company, tags, created_at
    `, [req.user.id, req.user.username, title, company, description, contact, tags]);
    res.status(201).json({ job: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/loker-board-db5f54/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/loker-board-db5f54/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      title VARCHAR(200) NOT NULL,
      company VARCHAR(200) NOT NULL,
      description TEXT NOT NULL,
      contact VARCHAR(500) NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at DESC)'
  );

  // Staging previews start with an empty `jobs` table (it is new), so seed
  // a handful of obviously fake rows for the board, search, tag filter and
  // detail views to show. Fake identities only; strictly a no-op in
  // production.
  if (IS_STAGING) {
    const seedJobs = [
      {
        id: 900001,
        title: 'Staging demo: Frontend developer',
        company: 'Staging demo studio',
        description: 'Staging demo job. Build and polish web interfaces for a small product team. Two years of experience with modern JavaScript is plenty; bring your portfolio.',
        contact: 'jobs@stagingdemo.example',
        tags: ['Full-time', 'Remote'],
      },
      {
        id: 900002,
        title: 'Staging demo: Social media intern',
        company: 'Staging demo agency',
        description: 'Staging demo job. Schedule posts, draft captions and help with a monthly campaign report. Great first role for a student.',
        contact: 'https://stagingdemo.example/apply',
        tags: ['Part-time', 'Remote'],
      },
      {
        id: 900003,
        title: 'Staging demo: Delivery driver',
        company: 'Staging demo logistics',
        description: 'Staging demo job. Morning shifts, own scooter preferred, fuel allowance included. Immediate start.',
        contact: '+62 812 0000 0000',
        tags: ['Full-time', 'On-site'],
      },
      {
        id: 900004,
        title: 'Staging demo: Copywriter (freelance)',
        company: 'Staging demo print shop',
        description: 'Staging demo job. Short product copy for a seasonal catalogue, about 40 items. Per-project rate, paid weekly.',
        contact: 'hello@stagingdemo.example',
        tags: ['Freelance'],
      },
    ];
    for (const job of seedJobs) {
      await pool.query(`
        INSERT INTO jobs (id, user_id, username, title, company, description, contact, tags)
        VALUES ($1, 0, 'staging-demo-user', $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO NOTHING
      `, [job.id, job.title, job.company, job.description, job.contact, job.tags]);
    }
  }

  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// The container is stopped and replaced on every deploy. Stop accepting
// connections, let in-flight requests finish under a hard deadline, close
// the pool, exit. Idempotent: a repeat SIGTERM/SIGINT during the drain is
// a no-op.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  server.close(() => {});
  server.closeIdleConnections?.();
  const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
  t.unref?.();
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
