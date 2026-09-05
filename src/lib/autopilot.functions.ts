import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireLinkedInSession } from "./session";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export const getAutopilot = createServerFn({ method: "GET" })
  .middleware([requireLinkedInSession])
  .handler(async ({ context }) => {
    const db = await admin();
    const { data } = await db
      .from("autopilot")
      .select("enabled, interval_hours, niche, style, target_chars, next_run_at, last_run_at, last_topic, last_error, paused_reason")
      .eq("user_id", context.userId)
      .maybeSingle();
    return {
      settings:
        data ?? {
          enabled: false,
          interval_hours: 2,
          niche: "",
          style: "professional",
          target_chars: 1000,
          next_run_at: null,
          last_run_at: null,
          last_topic: null,
          last_error: null,
          paused_reason: null,
        },
    };
  });

export const saveAutopilot = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) =>
    z
      .object({
        enabled: z.boolean(),
        interval_hours: z.number().int().min(1).max(72),
        niche: z.string().max(200).default(""),
        style: z.string().max(50).default("professional"),
        target_chars: z.number().int().min(200).max(3000).default(1000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { error } = await db.from("autopilot").upsert(
      {
        user_id: context.userId,
        enabled: data.enabled,
        interval_hours: data.interval_hours,
        niche: data.niche,
        style: data.style,
        target_chars: data.target_chars,
        // Turning it on starts the clock now; the next run happens on the next check.
        next_run_at: new Date().toISOString(),
        paused_reason: null,
        last_error: null,
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/** Run one autopilot cycle immediately (manual "post now" test). */
export const runAutopilotNow = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .handler(async ({ context }) => {
    const db = await admin();
    const { data } = await db
      .from("autopilot")
      .select("user_id, enabled, interval_hours, niche, style, target_chars, next_run_at, last_topic")
      .eq("user_id", context.userId)
      .maybeSingle();
    const row = data ?? {
      user_id: context.userId,
      enabled: false,
      interval_hours: 2,
      niche: "",
      style: "professional",
      target_chars: 1000,
      next_run_at: new Date().toISOString(),
      last_topic: null,
    };
    const { runAutopilotForUser } = await import("./autopilot.server");
    const { topic, postId } = await runAutopilotForUser(row);
    await db
      .from("autopilot")
      .update({
        last_run_at: new Date().toISOString(),
        next_run_at: new Date(Date.now() + row.interval_hours * 3600_000).toISOString(),
        last_topic: topic,
        last_error: null,
      })
      .eq("user_id", context.userId);
    return { topic, postId };
  });

/** Preview the trending headlines autopilot is currently seeing. */
export const previewTrending = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) => z.object({ niche: z.string().max(200).default("") }).parse(input))
  .handler(async ({ data }) => {
    const { fetchTrendingHeadlines } = await import("./autopilot.server");
    return { headlines: (await fetchTrendingHeadlines(data.niche)).slice(0, 10) };
  });
