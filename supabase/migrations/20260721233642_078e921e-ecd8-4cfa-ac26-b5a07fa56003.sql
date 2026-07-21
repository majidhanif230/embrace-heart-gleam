
-- Remove the legacy auth.users onboarding trigger since LinkedIn is now the identity provider.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- Drop any legacy foreign keys against auth.users so per-user data can live under LinkedIn identities.
ALTER TABLE public.drafts DROP CONSTRAINT IF EXISTS drafts_user_id_fkey;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_user_id_fkey;

-- New table: LinkedIn identities + per-user OAuth tokens.
CREATE TABLE IF NOT EXISTS public.linkedin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  linkedin_sub text NOT NULL UNIQUE,
  name text,
  email text,
  picture text,
  access_token text NOT NULL,
  refresh_token text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.linkedin_users TO service_role;
ALTER TABLE public.linkedin_users ENABLE ROW LEVEL SECURITY;
-- No policies: this table is only touched by server code using the service role.

DROP TRIGGER IF EXISTS trg_linkedin_users_updated_at ON public.linkedin_users;
CREATE TRIGGER trg_linkedin_users_updated_at
BEFORE UPDATE ON public.linkedin_users
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
