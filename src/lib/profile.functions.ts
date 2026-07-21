import { createServerFn } from "@tanstack/react-start";
import { requireLinkedInSession } from "./session.server";
import { z } from "zod";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export const getProfile = createServerFn({ method: "GET" })
  .middleware([requireLinkedInSession])
  .handler(async ({ context }) => {
    const db = await admin();
    const { data, error } = await db
      .from("profiles")
      .select("display_name, voice_notes")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      display_name: data?.display_name ?? "",
      voice_notes: data?.voice_notes ?? "",
    };
  });

export const updateProfile = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) =>
    z.object({
      display_name: z.string().max(200).optional(),
      voice_notes: z.string().max(2000).optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = await admin();
    const patch: { display_name?: string; voice_notes?: string } = {};
    if (data.display_name !== undefined) patch.display_name = data.display_name;
    if (data.voice_notes !== undefined) patch.voice_notes = data.voice_notes;
    // Upsert so first-time users without a profile row still succeed.
    const { error } = await db
      .from("profiles")
      .upsert({ user_id: context.userId, ...patch }, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });