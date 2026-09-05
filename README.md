# LinkedIn Auto Poster

An AI content studio for LinkedIn: draft posts in three variants, score them,
build a knowledge base from your own documents, schedule publishing, and let
autopilot post on a fixed cadence.

Built with TanStack Start (SSR), React 19, Tailwind v4, Supabase, and Drizzle.
Deployed to Cloudflare Workers via Nitro.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | TanStack Start + TanStack Router |
| Build | Vite 8, Nitro (`cloudflare-module` preset) |
| UI | React 19, Tailwind CSS v4, shadcn/ui (Radix) |
| Data | Supabase (Postgres + RLS), Drizzle for migrations |
| AI | Google Gemini via the Vercel AI SDK |
| Auth | LinkedIn OAuth, sealed cookie sessions |

## Getting started

Requires Node.js 20+.

```sh
npm install
cp .env.example .env   # then fill it in
npm run dev
```

The app runs at http://localhost:5173.

## Environment

Every variable is documented in [.env.example](.env.example). `.env` is
gitignored; nothing in it should ever be committed.

The app will not boot without `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, and a `SESSION_SECRET` of at least 32 characters.
AI features additionally need `AI_API_KEY`, and LinkedIn sign-in needs the three
`LINKEDIN_*` variables.

### AI provider

Text generation talks to Gemini through its OpenAI-compatible endpoint, so
`AI_BASE_URL` can be repointed at OpenAI, OpenRouter, or any compatible gateway
without touching application code. Image generation and document extraction use
Gemini's native endpoint, which has no OpenAI-compatible equivalent.

> Gemini's **free tier allows zero image-generation requests**. `Generate image`
> will return a 429 until billing is enabled on the Google AI Studio project
> that owns the key.

## Deploying to Cloudflare Workers

```sh
npx wrangler login
npm run deploy
```

`npm run deploy` builds with the Nitro `cloudflare-module` preset into `dist/` and
deploys using the config Nitro generates at `dist/server/wrangler.json` (wrangler
finds it via `.wrangler/deploy/config.json`).

Secrets are not read from `.env` in production — set each one on the Worker:

```sh
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put AI_API_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put LINKEDIN_CLIENT_SECRET
```

After the first deploy, point these at the live origin:

1. `LINKEDIN_REDIRECT_URI`, and the matching redirect URL in your
   [LinkedIn app](https://www.linkedin.com/developers/apps).
2. The autopilot cron. `drizzle/migrations/0000_autopilot_trending_posts.sql`
   scheduled a `pg_cron` job against the old host; it is an applied migration
   and must not be edited. Reschedule it in the Supabase SQL editor instead:

   ```sql
   SELECT cron.unschedule('autopilot-run');
   SELECT cron.schedule(
     'autopilot-run',
     '*/15 * * * *',
     $$ SELECT net.http_post(
          url := 'https://<your-worker-url>/api/public/hooks/autopilot',
          headers := '{"Content-Type": "application/json"}'::jsonb,
          body := '{}'::jsonb
        ) $$
   );
   ```

## Database

Drizzle owns the schema in [drizzle/schema.ts](drizzle/schema.ts). Migrations
need a direct Postgres connection string in `DB_MIGRATION_URL`:

```sh
npx drizzle-kit generate
npx drizzle-kit migrate
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server with HMR |
| `npm run build` | Production build into `dist/` |
| `npm run deploy` | Build, then deploy to Cloudflare Workers |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
