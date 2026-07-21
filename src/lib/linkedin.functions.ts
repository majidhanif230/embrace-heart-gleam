import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { requireLinkedInSession } from "./session.server";

// Convert ASCII letters/digits inside **...** spans into Unicode
// Mathematical Sans-Serif Bold characters (matches "𝗹𝗶𝗸𝗲 𝘁𝗵𝗶𝘀").
function toUnicodeBold(input: string): string {
  const boldChar = (ch: string): string => {
    const code = ch.codePointAt(0)!;
    if (code >= 0x41 && code <= 0x5a) return String.fromCodePoint(0x1d5d4 + (code - 0x41)); // A-Z
    if (code >= 0x61 && code <= 0x7a) return String.fromCodePoint(0x1d5ee + (code - 0x61)); // a-z
    if (code >= 0x30 && code <= 0x39) return String.fromCodePoint(0x1d7ec + (code - 0x30)); // 0-9
    return ch;
  };
  return input.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) =>
    Array.from(inner).map(boldChar).join(""),
  );
}

const WRITING_STYLES = {
  "viral-creator": "Viral Creator — punchy hook, high contrast statements, short lines, unexpected angles that stop the scroll",
  professional: "Professional — measured, credible, executive voice, no hype",
  storytelling: "Storytelling — first-person narrative arc with tension and a clear lesson",
  educational: "Educational — teach a concept step by step with concrete examples",
  founder: "Founder — builder perspective, lessons from the trenches, honest about tradeoffs",
  "personal-experience": "Personal Experience — a specific moment or realization, told vividly",
  "technical-deep-dive": "Technical Deep Dive — precise, technically dense but readable, real detail",
  "case-study": "Case Study — problem → approach → result, with concrete numbers where possible",
} as const;

export type WritingStyle = keyof typeof WRITING_STYLES;

const KNOWN_COMPANIES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "google deepmind": "Google DeepMind",
  deepmind: "Google DeepMind",
  microsoft: "Microsoft",
  nvidia: "NVIDIA",
  meta: "Meta",
  apple: "Apple",
  amazon: "Amazon",
  aws: "AWS",
  tesla: "Tesla",
  stripe: "Stripe",
  figma: "Figma",
  notion: "Notion",
  linear: "Linear",
  vercel: "Vercel",
  cloudflare: "Cloudflare",
  supabase: "Supabase",
  github: "GitHub",
};

function detectCompanies(topic: string): string[] {
  const lower = topic.toLowerCase();
  const found = new Set<string>();
  for (const [key, name] of Object.entries(KNOWN_COMPANIES)) {
    const re = new RegExp(`\\b${key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) found.add(name);
  }
  return Array.from(found);
}

function buildPostPrompt(opts: {
  topic: string;
  style: WritingStyle;
  targetChars: number;
  variantNote?: string;
  hookOverride?: string;
  companies: string[];
  voiceNotes?: string;
}): string {
  const { topic, style, targetChars, variantNote, hookOverride, companies, voiceNotes } = opts;
  const minChars = Math.max(150, Math.round(targetChars * 0.82));
  return `You are a top LinkedIn creator. Write ONE high-quality LinkedIn post that feels human, not AI.

TOPIC: ${topic}
WRITING STYLE: ${WRITING_STYLES[style]}
TARGET LENGTH: approximately ${targetChars} characters (between ${minChars} and ${targetChars}). NEVER exceed ${targetChars}.
${voiceNotes && voiceNotes.trim() ? `\nUSER'S PERSONAL VOICE (match this style closely):\n"${voiceNotes.trim()}"\n` : ""}
${hookOverride ? `\nHOOK (use this exact line as line 1, wrapped in **double asterisks**):\n"${hookOverride}"\n` : ""}
${variantNote ? `\nVARIANT DIRECTION: ${variantNote}\n` : ""}
${companies.length ? `\nRELEVANT COMPANIES (mention naturally where it fits, no forced tags): ${companies.join(", ")}\n` : ""}
STRUCTURE (follow exactly):
1. Scroll-stopping hook on line 1 (question, bold claim, or relatable problem). Under 210 characters. Wrap in **double asterisks**.
2. Blank line.
3. Story or setup — 2–3 short paragraphs (1–2 sentences each). Concrete detail, not abstract.
4. Lesson — what you learned or what this really means. 1–2 short paragraphs.
5. Practical takeaway — 2–4 concise bullet points OR a short paragraph the reader can act on.
6. Soft CTA — a genuine reflective question. No "drop a comment 👇" spam.
7. Blank line.
8. Last line: 3–5 niche, specific hashtags. Never #motivation #success #inspiration.

FORMATTING RULES:
- Lots of white space. Short paragraphs. Single line breaks between them.
- Wrap 1–2 short key phrases in the body in **double asterisks** for emphasis. Do not overuse.
- Use **double asterisks** for bold — no other markdown. The renderer converts ** to Unicode bold.
- No external links. No emoji spam (at most one, only if it truly fits).
- Natural human tone. No corporate buzzwords ("leverage synergies", "in today's fast-paced world", etc.).
- Total length must fit within ${targetChars} characters.

Output ONLY the post text. No preamble, no explanation, no surrounding quotes.`;
}

const StyleEnum = z.enum([
  "viral-creator",
  "professional",
  "storytelling",
  "educational",
  "founder",
  "personal-experience",
  "technical-deep-dive",
  "case-study",
]);

// Generate THREE variants (A/B/C) in parallel with different framings.
export const generatePostVariants = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        topic: z.string().min(1).max(500),
        style: StyleEnum,
        targetChars: z.number().int().min(200).max(3000),
        hookOverride: z.string().max(300).optional(),
        voiceNotes: z.string().max(2000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY is not configured");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3-flash-preview");
    const companies = detectCompanies(data.topic);

    const variantNotes = [
      "Lead with a bold, contrarian claim. Higher emotional charge.",
      "Lead with a concrete personal moment or specific detail.",
      "Lead with a surprising data point, observation, or reframe.",
    ];

    const results = await Promise.all(
      variantNotes.map(async (variantNote) => {
        const { text } = await generateText({
          model,
          prompt: buildPostPrompt({
            topic: data.topic,
            style: data.style,
            targetChars: data.targetChars,
            variantNote,
            hookOverride: data.hookOverride,
            companies,
            voiceNotes: data.voiceNotes,
          }),
        });
        return toUnicodeBold(text.trim());
      }),
    );
    return { variants: results, companies };
  });

// Generate 5 alternative hooks the user can pick from.
export const generateHooks = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ topic: z.string().min(1).max(500), style: StyleEnum }).parse(input),
  )
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY is not configured");
    const gateway = createLovableAiGatewayProvider(key);
    const prompt = `Generate 5 distinct scroll-stopping LinkedIn post opening lines (hooks) for this topic.

TOPIC: ${data.topic}
STYLE: ${WRITING_STYLES[data.style]}

Rules:
- Each hook: under 210 characters (LinkedIn's "see more" fold).
- Each one uses a different angle: contrarian claim, personal story opener, question, surprising stat/observation, and bold prediction.
- No hashtags, no emojis, no quotes around the text.
- Return as a plain numbered list "1.", "2.", ... — one hook per line, nothing else.`;
    const { text } = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      prompt,
    });
    const hooks = text
      .split("\n")
      .map((l) => l.replace(/^\s*\d+[.)-]\s*/, "").replace(/^["'"']|["'"']$/g, "").trim())
      .filter((l) => l.length > 0 && l.length < 300)
      .slice(0, 5);
    return { hooks };
  });

// Score a draft on 5 dimensions.
export const scorePost = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ text: z.string().min(1).max(4000) }).parse(input))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY is not configured");
    const gateway = createLovableAiGatewayProvider(key);
    const prompt = `Score this LinkedIn post on 5 dimensions from 0 to 10 (one decimal allowed). Be honest, not generous.

POST:
"""
${data.text}
"""

Return ONLY strict JSON, no prose:
{"hook": number, "readability": number, "virality": number, "professionalTone": number, "cta": number, "overall": number, "notes": "one short sentence"}`;
    const { text } = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      prompt,
    });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Score response missing JSON");
    const parsed = JSON.parse(jsonMatch[0]) as {
      hook: number;
      readability: number;
      virality: number;
      professionalTone: number;
      cta: number;
      overall: number;
      notes: string;
    };
    return parsed;
  });

const SUGGESTIONS = {
  "more-emotional": "Rewrite with more emotional resonance — vivid feelings, stakes, human moments. Keep structure and length target.",
  "more-technical": "Rewrite with more technical precision and concrete detail. Assume a technical audience.",
  "add-stats": "Rewrite adding at least 2 realistic, concrete-sounding statistics or numbers where they fit naturally. Do not fabricate specific real-world citations.",
  "add-story": "Rewrite by folding in a specific short first-person story or scene near the top.",
  shorten: "Rewrite significantly shorter and tighter. Keep the hook and hashtags. Cut anything not earning its place.",
  expand: "Rewrite longer with more depth, more examples, and stronger takeaways. Keep structure.",
  "more-viral": "Rewrite in a more viral-creator voice: punchier hook, high-contrast lines, shorter paragraphs, unexpected framing.",
  "more-personal": "Rewrite in a more personal, first-person voice. Add a real-feeling moment or vulnerability.",
} as const;

export type Suggestion = keyof typeof SUGGESTIONS;

export const applySuggestion = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        text: z.string().min(1).max(4000),
        suggestion: z.enum([
          "more-emotional",
          "more-technical",
          "add-stats",
          "add-story",
          "shorten",
          "expand",
          "more-viral",
          "more-personal",
        ]),
        targetChars: z.number().int().min(200).max(3000),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY is not configured");
    const gateway = createLovableAiGatewayProvider(key);
    const prompt = `Rewrite this LinkedIn post following the instruction. Keep the same LinkedIn structure (hook / body / soft CTA / hashtags). Wrap the hook line and 1–2 body key phrases in **double asterisks** for bold. Total length must fit within ${data.targetChars} characters. Output ONLY the rewritten post text.

INSTRUCTION: ${SUGGESTIONS[data.suggestion]}

ORIGINAL POST:
"""
${data.text}
"""`;
    const { text } = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      prompt,
    });
    return { text: toUnicodeBold(text.trim()) };
  });

const MediaSchema = z.object({
  filename: z.string().min(1).max(200),
  mimeType: z.string().regex(/^image\/(png|jpeg|jpg|gif|webp)$/),
  dataBase64: z.string().min(1),
});

const IMAGE_STYLES = {
  photo: "cinematic photograph, natural lighting, shallow depth of field, editorial photography",
  illustration: "modern editorial illustration, clean vector-style lines, soft gradients, generous white space",
  "3d": "modern 3D render, soft studio lighting, matte materials, clean composition",
  icons: "clean iconographic composition, flat geometric shapes, minimal palette",
  minimal: "extreme minimalism, single subject, huge negative space, one accent color",
  corporate: "polished corporate visual, muted palette, professional composition, subtle depth",
  editorial: "editorial magazine cover style, refined typography-free composition, sophisticated color grading",
} as const;

export type ImageStyle = keyof typeof IMAGE_STYLES;

export const generateImage = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        topic: z.string().min(1).max(500),
        style: z
          .enum(["photo", "illustration", "3d", "icons", "minimal", "corporate", "editorial"])
          .default("editorial"),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY is not configured");
    // Improve the raw topic into a detailed image prompt.
    const gateway = createLovableAiGatewayProvider(key);
    const styleHint = IMAGE_STYLES[data.style];
    const { text: improved } = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      prompt: `Write ONE detailed image-generation prompt (2–3 sentences, under 400 chars) for a LinkedIn cover image.

TOPIC: ${data.topic}
STYLE: ${styleHint}

Rules: no text or typography in the image, no logos, no watermarks, no faces of real people, LinkedIn-appropriate, high visual quality. Output only the prompt, no preamble.`,
    });
    const prompt = `${improved.trim()} Style: ${styleHint}. No text overlay. No logos. No watermarks. Suitable for LinkedIn.`;

    const res = await fetch("https://ai.gateway.lovable.dev/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt,
        quality: "low",
        size: "1024x1024",
        n: 1,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Image generation failed [${res.status}]: ${body}`);
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("Image generation returned no image data");
    return { dataBase64: b64, mimeType: "image/png" as const, filename: "ai-generated.png", prompt };
  });

export const publishPost = createServerFn({ method: "POST" })
  .middleware([requireLinkedInSession])
  .inputValidator((input: unknown) =>
    z
      .object({
        text: z.string().min(1).max(3000),
        images: z.array(MediaSchema).max(9).optional().default([]),
        draftId: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { publishToLinkedIn, getUserTokens } = await import("./linkedin-publish.server");
    const { accessToken, linkedinSub } = await getUserTokens(context.userId);
    const { postId } = await publishToLinkedIn({
      text: data.text,
      images: data.images,
      accessToken,
      linkedinSub,
    });
    if (data.draftId) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin
        .from("drafts")
        .update({
          status: "published",
          published_at: new Date().toISOString(),
          post_id: postId ?? null,
          error_message: null,
        })
        .eq("id", data.draftId)
        .eq("user_id", context.userId);
    }
    return { ok: true as const, postId };
  });