import { createFileRoute } from "@tanstack/react-router";
import { publishToLinkedIn, getUserTokens } from "@/lib/linkedin-publish.server";

// Cron endpoint: invoked every minute by pg_cron to publish due scheduled posts.
// Uses the shared LinkedIn connector account.
export const Route = createFileRoute("/api/public/hooks/publish-scheduled")({
  server: {
    handlers: {
      POST: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const nowIso = new Date().toISOString();

        const { data: due, error } = await supabaseAdmin
          .from("drafts")
          .select("id, user_id, content, image_data_base64, image_mime, image_filename")
          .eq("status", "scheduled")
          .lte("scheduled_for", nowIso)
          .limit(20);

        if (error) {
          return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const results: Array<{ id: string; ok: boolean; post_id?: string; error?: string }> = [];
        for (const draft of due ?? []) {
          try {
            const images = draft.image_data_base64 && draft.image_mime
              ? [{
                  filename: draft.image_filename ?? "image.png",
                  mimeType: draft.image_mime,
                  dataBase64: draft.image_data_base64,
                }]
              : [];
            const { accessToken, linkedinSub } = await getUserTokens(draft.user_id);
            const { postId } = await publishToLinkedIn({
              text: draft.content,
              images,
              accessToken,
              linkedinSub,
            });
            await supabaseAdmin
              .from("drafts")
              .update({
                status: "published",
                published_at: new Date().toISOString(),
                post_id: postId ?? null,
                error_message: null,
              })
              .eq("id", draft.id);
            results.push({ id: draft.id, ok: true, post_id: postId });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await supabaseAdmin
              .from("drafts")
              .update({ status: "failed", error_message: message })
              .eq("id", draft.id);
            results.push({ id: draft.id, ok: false, error: message });
          }
        }

        return new Response(JSON.stringify({ processed: results.length, results }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});