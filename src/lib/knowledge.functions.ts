import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { requireLinkedInSession } from "./session";
import { createAiProvider, requireAiApiKey, AI_TEXT_MODEL, AI_NATIVE_BASE_URL } from "./ai-gateway.server";

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

// Extract text from an uploaded file (image / pdf / docx / pptx) so it can
// be stored in the user's knowledge base. Runs entirely server-side.
const FileInput = z.object({
  filename: z.string().min(1).max(300),
  mimeType: z.string().min(1).max(200),
  dataBase64: z.string().min(1),
});

function b64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function stripXmlToText(xml: string): string {
  return xml
    .replace(/<a:br\s*\/>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  // mammoth accepts a Buffer via arrayBuffer
  const { value } = await (mammoth as { extractRawText: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> })
    .extractRawText({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
  return (value ?? "").trim();
}

async function extractPptx(bytes: Uint8Array): Promise<string> {
  const JSZipMod = await import("jszip");
  const JSZip = (JSZipMod as { default?: typeof import("jszip") }).default ?? (JSZipMod as unknown as typeof import("jszip"));
  const zip = await JSZip.loadAsync(bytes);
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      return na - nb;
    });
  const parts: string[] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async("string");
    const text = stripXmlToText(xml);
    if (text) parts.push(`--- Slide ${i + 1} ---\n${text}`);
  }
  return parts.join("\n\n").trim();
}

async function extractViaGeminiFile(opts: {
  key: string;
  mimeType: string;
  dataBase64: string;
  filename: string;
  kind: "image" | "pdf";
}): Promise<string> {
  const instruction = opts.kind === "image"
    ? "Extract all text visible in this image and then describe the key concepts, data, and takeaways in structured notes. Preserve any lists, tables, quotes, or numbers verbatim. Output plain text only."
    : "Read this document and produce a thorough, faithful extract as structured notes: key ideas, definitions, arguments, data points, quotes, and takeaways. Preserve numbers and lists verbatim. Output plain text only, no preamble.";
  // Gemini's OpenAI-compatible endpoint does not accept image or file parts, so
  // this call goes to the native API with the bytes inlined instead.
  const res = await fetch(`${AI_NATIVE_BASE_URL}/models/${AI_TEXT_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": opts.key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: instruction },
            { inline_data: { mime_type: opts.mimeType, data: opts.dataBase64 } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Extraction failed [${res.status}]: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

export const extractKnowledgeFromFile = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) => FileInput.parse(input))
  .handler(async ({ data }) => {
    const bytes = b64ToUint8(data.dataBase64);
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("File is over 20 MB.");
    const name = data.filename.toLowerCase();
    const mime = data.mimeType.toLowerCase();

    let text = "";
    let kind = "";
    if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/.test(name)) {
      kind = "image";
      const key = requireAiApiKey();
      text = await extractViaGeminiFile({ key, mimeType: mime || "image/jpeg", dataBase64: data.dataBase64, filename: data.filename, kind: "image" });
    } else if (mime === "application/pdf" || name.endsWith(".pdf")) {
      kind = "pdf";
      const key = requireAiApiKey();
      text = await extractViaGeminiFile({ key, mimeType: "application/pdf", dataBase64: data.dataBase64, filename: data.filename, kind: "pdf" });
    } else if (name.endsWith(".docx") || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      kind = "docx";
      text = await extractDocx(bytes);
    } else if (name.endsWith(".pptx") || mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
      kind = "pptx";
      text = await extractPptx(bytes);
    } else if (mime.startsWith("text/") || /\.(txt|md|markdown|csv)$/.test(name)) {
      kind = "text";
      text = new TextDecoder("utf-8").decode(bytes);
    } else {
      throw new Error(`Unsupported file type: ${data.mimeType || data.filename}. Try image, PDF, DOCX, or PPTX.`);
    }

    text = text.trim();
    if (!text) throw new Error("No readable content found in file.");
    if (text.length > 20000) text = text.slice(0, 20000);
    const title = data.filename.replace(/\.[^.]+$/, "").slice(0, 200);
    return { title, content: text, kind };
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

    const key = requireAiApiKey();
    const gateway = createAiProvider(key);

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
      model: gateway(AI_TEXT_MODEL),
      prompt,
    });
    const ideas = text
      .split("\n")
      .map((l) => l.replace(/^\s*\d+[.)-]\s*/, "").replace(/^["'"']|["'"']$/g, "").trim())
      .filter((l) => l.length > 5 && l.length < 400)
      .slice(0, 8);
    return { ideas, sourceCount: rows.length };
  });