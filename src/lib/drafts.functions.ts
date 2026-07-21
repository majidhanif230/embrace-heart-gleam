import { createServerFn } from "@tanstack/react-start";
import { requireLinkedInSession } from "./session";
import { z } from "zod";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const DraftInput = z.object({
  id: z.string().uuid().optional(),
  topic: z.string().max(500).default(""),
  style: z.string().max(50).default("professional"),
  target_chars: z.number().int().min(200).max(3000).default(1000),
  content: z.string().max(4000).default(""),
  image_data_base64: z.string().nullable().optional(),
  image_mime: z.string().max(50).nullable().optional(),
  image_filename: z.string().max(200).nullable().optional(),
});

export const listDrafts = createServerFn({ method: "GET" })
  .middleware([requireLinkedInSession])
  .handler(async ({ context }) => {
    const db = await admin();
    const { data, error } = await db
      .from("drafts")
      .select("id, topic, style, target_chars, content, image_filename, status, scheduled_for, published_at, post_id, error_message, updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { drafts: data ?? [] };
  });

export const upsertDraft = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) => DraftInput.parse(input))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const row = {
      user_id: context.userId,
      topic: data.topic,
      style: data.style,
      target_chars: data.target_chars,
      content: data.content,
      image_data_base64: data.image_data_base64 ?? null,
      image_mime: data.image_mime ?? null,
      image_filename: data.image_filename ?? null,
      status: "draft" as const,
    };
    if (data.id) {
      const { data: updated, error } = await db
        .from("drafts")
        .update(row)
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return { id: updated.id };
    }
    const { data: inserted, error } = await db
      .from("drafts")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: inserted.id };
  });

export const deleteDraft = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { error } = await db
      .from("drafts")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const scheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) =>
    DraftInput.extend({ scheduled_for: z.string().datetime() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = await admin();
    const scheduledDate = new Date(data.scheduled_for);
    if (scheduledDate.getTime() < Date.now() - 60_000) {
      throw new Error("Scheduled time must be in the future.");
    }
    const row = {
      user_id: context.userId,
      topic: data.topic,
      style: data.style,
      target_chars: data.target_chars,
      content: data.content,
      image_data_base64: data.image_data_base64 ?? null,
      image_mime: data.image_mime ?? null,
      image_filename: data.image_filename ?? null,
      status: "scheduled" as const,
      scheduled_for: scheduledDate.toISOString(),
      error_message: null,
    };
    if (data.id) {
      const { data: updated, error } = await db
        .from("drafts")
        .update(row)
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return { id: updated.id };
    }
    const { data: inserted, error } = await db
      .from("drafts")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: inserted.id };
  });

export const cancelSchedule = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { error } = await db
      .from("drafts")
      .update({ status: "draft", scheduled_for: null })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });