import { createServerFn } from "@tanstack/react-start";
import { readSession } from "./session.server";

export type SessionUser = {
  id: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  linkedin_sub: string;
} | null;

export const getSessionUser = createServerFn({ method: "GET" }).handler(async (): Promise<SessionUser> => {
  const session = await readSession();
  if (!session.data.userId) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("linkedin_users")
    .select("id, name, email, picture, linkedin_sub")
    .eq("id", session.data.userId)
    .maybeSingle();
  return (data as SessionUser) ?? null;
});

export const signOut = createServerFn({ method: "POST" }).handler(async () => {
  const session = await readSession();
  await session.clear();
  return { ok: true as const };
});