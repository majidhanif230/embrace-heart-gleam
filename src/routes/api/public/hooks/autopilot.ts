import { createFileRoute } from "@tanstack/react-router";

// Cron endpoint: called every 15 minutes. Publishes an AI post about a trending
// topic for every user whose autopilot interval is due.
export const Route = createFileRoute("/api/public/hooks/autopilot")({
  server: {
    handlers: {
      POST: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runAutopilotForUser } = await import("@/lib/autopilot.server");

        // Single-flight: a second overlapping run exits immediately.
        const { data: gotLock } = await supabaseAdmin.rpc("acquire_job_lock", {
          _name: "autopilot-run",
          _seconds: 600,
        });
        if (!gotLock) {
          return Response.json({ skipped: "locked" });
        }

        const nowIso = new Date().toISOString();
        const { data: due, error } = await supabaseAdmin
          .from("autopilot")
          .select("user_id, enabled, interval_hours, niche, style, target_chars, next_run_at, last_topic")
          .eq("enabled", true)
          .is("paused_reason", null)
          .lte("next_run_at", nowIso)
          .limit(10);

        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const results: Array<{ user_id: string; ok: boolean; topic?: string; error?: string }> = [];
        for (const row of due ?? []) {
          const nextRun = new Date(Date.now() + row.interval_hours * 3600_000).toISOString();
          try {
            const { topic } = await runAutopilotForUser(row);
            await supabaseAdmin
              .from("autopilot")
              .update({ last_run_at: nowIso, next_run_at: nextRun, last_topic: topic, last_error: null })
              .eq("user_id", row.user_id);
            results.push({ user_id: row.user_id, ok: true, topic });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Credit / policy failures pause autopilot until the owner resumes.
            const blocked = /\[40[23]\]|credit|Unauthorized|expired|not connected/i.test(message);
            await supabaseAdmin
              .from("autopilot")
              .update({
                last_run_at: nowIso,
                next_run_at: nextRun,
                last_error: message.slice(0, 500),
                ...(blocked ? { paused_reason: message.slice(0, 300) } : {}),
              })
              .eq("user_id", row.user_id);
            results.push({ user_id: row.user_id, ok: false, error: message });
          }
        }

        await supabaseAdmin
          .from("job_locks")
          .update({ locked_until: new Date().toISOString() })
          .eq("name", "autopilot-run");

        return Response.json({ processed: results.length, results });
      },
    },
  },
});
