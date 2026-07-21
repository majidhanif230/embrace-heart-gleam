import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const getProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
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
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      display_name: z.string().max(200).optional(),
      voice_notes: z.string().max(2000).optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: { display_name?: string; voice_notes?: string } = {};
    if (data.display_name !== undefined) patch.display_name = data.display_name;
    if (data.voice_notes !== undefined) patch.voice_notes = data.voice_notes;
    const { error } = await context.supabase
      .from("profiles")
      .update(patch)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });