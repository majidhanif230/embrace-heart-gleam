-- lovable-cron-fallback-reviewed: 96 runs/day; autopilot must publish on a fixed 2-hour cadence per user, no row event triggers it
CREATE TABLE public.autopilot (
  user_id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  interval_hours integer NOT NULL DEFAULT 2,
  niche text NOT NULL DEFAULT '',
  style text NOT NULL DEFAULT 'professional',
  target_chars integer NOT NULL DEFAULT 1000,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_topic text,
  last_error text,
  paused_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.autopilot TO service_role;
ALTER TABLE public.autopilot ENABLE ROW LEVEL SECURITY;
-- No policies: server-only access via the service role (same model as linkedin_users).

CREATE INDEX autopilot_due_idx ON public.autopilot (next_run_at) WHERE enabled;

CREATE TRIGGER trg_autopilot_updated_at
BEFORE UPDATE ON public.autopilot
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.job_locks (
  name text PRIMARY KEY,
  locked_until timestamptz NOT NULL
);
GRANT ALL ON public.job_locks TO service_role;
ALTER TABLE public.job_locks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.acquire_job_lock(_name text, _seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ok boolean;
BEGIN
  INSERT INTO public.job_locks (name, locked_until)
  VALUES (_name, now() + make_interval(secs => _seconds))
  ON CONFLICT (name) DO UPDATE
    SET locked_until = EXCLUDED.locked_until
    WHERE public.job_locks.locked_until < now()
  RETURNING true INTO ok;
  RETURN COALESCE(ok, false);
END; $$;
REVOKE EXECUTE ON FUNCTION public.acquire_job_lock(text, integer) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

SELECT cron.schedule(
  'autopilot-run',
  '*/15 * * * *',
  $$ SELECT net.http_post(
       url := 'https://embrace-heart-gleam.lovable.app/api/public/hooks/autopilot',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb
     ) $$
);
