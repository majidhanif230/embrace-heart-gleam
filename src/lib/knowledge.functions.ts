import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { requireLinkedInSession } from "./session";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export const listKnowledge = createServerFn({ method: "GET" })
  .middleware([requireLinkedInSession])
  .handler(async ({ context }) => {
    const db = await admin();
    const { data, error } = await db
      .from("knowledge_base")
      .select("id, title, content, created_at, updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { entries: data ?? [] };
  });

export const upsertKnowledge = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) =>
    z.object({
      id: z.string().uuid().optional(),
      title: z.string().max(200).default(""),
      content: z.string().min(1).max(20000),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = await admin();
    if (data.id) {
      const { error } = await db
        .from("knowledge_base")
        .update({ title: data.title, content: data.content, updated_at: new Date().toISOString() })
        .eq("id", data.id)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await db
      .from("knowledge_base")
      .insert({ user_id: context.userId, title: data.title, content: data.content })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });

export const deleteKnowledge = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { error } = await db
      .from("knowledge_base")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// Suggest 8 LinkedIn post topics grounded in the user's saved knowledge base.
export const suggestTopicsFromKnowledge = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) =>
    z.object({ focus: z.string().max(500).optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { data: rows, error } = await db
      .from("knowledge_base")
      .select("title, content, updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false })
      .limit(40);
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) {
      throw new Error("Your knowledge base is empty. Add some notes first.");
    }

    const corpus = rows
      .map((r, i) => {
        const title = (r.title || `Note ${i + 1}`).slice(0, 120);
        const body = (r.content || "").slice(0, 1500);
        return `## ${title}\n${body}`;
      })
      .join("\n\n---\n\n")
      .slice(0, 24000);

    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY is not configured");
    const gateway = createLovableAiGatewayProvider(key);

    const prompt = `You are a LinkedIn content strategist. Based ONLY on the user's personal knowledge base below, suggest 8 SHARP LinkedIn post topics they are uniquely qualified to write. Each topic must clearly connect to something concrete in their notes — a lesson, project, opinion, framework, mistake, or observation they've captured.

${data.focus && data.focus.trim() ? `FOCUS / CONSTRAINT: ${data.focus.trim()}\n\n` : ""}USER'S KNOWLEDGE BASE:
"""
${corpus}
"""

Rules:
- Each topic is a single sentence (10–22 words) describing a specific angle — not a generic title.
- Mix formats: contrarian take, personal lesson, mini case study, teardown, prediction, tactical guide, mistake, observation.
- Ground every idea in the knowledge base. Do NOT invent facts, companies, or numbers that aren't in the notes.
- No hashtags, no quotes, no numbering in the sentence itself.
- Return as a plain numbered list "1.", "2.", ... one per line. Nothing else.`;

    const { text } = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      prompt,
    });
    const ideas = text
      .split("\n")
      .map((l) => l.replace(/^\s*\d+[.)-]\s*/, "").replace(/^["'"']|["'"']$/g, "").trim())
      .filter((l) => l.length > 5 && l.length < 400)
      .slice(0, 8);
    return { ideas, sourceCount: rows.length };
  });