// Server-only helpers for Autopilot: find a trending topic, write a post, publish it.
import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { publishToLinkedIn, getUserTokens } from "./linkedin-publish.server";

export type AutopilotRow = {
  user_id: string;
  enabled: boolean;
  interval_hours: number;
  niche: string;
  style: string;
  target_chars: number;
  next_run_at: string;
  last_topic: string | null;
};

function toUnicodeBold(input: string): string {
  const boldChar = (ch: string): string => {
    const code = ch.codePointAt(0)!;
    if (code >= 0x41 && code <= 0x5a) return String.fromCodePoint(0x1d5d4 + (code - 0x41));
    if (code >= 0x61 && code <= 0x7a) return String.fromCodePoint(0x1d5ee + (code - 0x61));
    if (code >= 0x30 && code <= 0x39) return String.fromCodePoint(0x1d7ec + (code - 0x30));
    return ch;
  };
  return input.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) =>
    Array.from(inner).map(boldChar).join(""),
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Fetch current trending headlines for a niche from Google News RSS (no API key). */
export async function fetchTrendingHeadlines(niche: string): Promise<string[]> {
  const query = niche.trim() || "technology AI business";
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+when:2d&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; LinkedInAutoPoster/1.0)" } });
  if (!res.ok) throw new Error(`Trending feed failed [${res.status}]`);
  const xml = await res.text();
  const items = xml.split("<item>").slice(1, 26);
  const titles = items
    .map((chunk) => chunk.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "")
    .map(decodeEntities)
    .map((t) => t.replace(/\s+-\s+[^-]{2,40}$/, "").trim()) // strip trailing " - Publisher"
    .filter((t) => t.length > 15 && t.length < 200);
  return Array.from(new Set(titles)).slice(0, 20);
}

const STYLE_HINTS: Record<string, string> = {
  "viral-creator": "punchy hook, high contrast statements, short lines, unexpected angles",
  professional: "measured, credible, executive voice, no hype",
  storytelling: "first-person narrative arc with tension and a clear lesson",
  educational: "teach a concept step by step with concrete examples",
  founder: "builder perspective, lessons from the trenches, honest about tradeoffs",
  "personal-experience": "a specific moment or realization, told vividly",
  "technical-deep-dive": "precise, technically dense but readable, real detail",
  "case-study": "problem → approach → result, with concrete numbers where possible",
};

/** Pick the single best trending headline to post about, avoiding recent repeats. */
export async function pickTrendingTopic(opts: {
  apiKey: string;
  headlines: string[];
  niche: string;
  recentTopics: string[];
}): Promise<string> {
  const gateway = createLovableAiGatewayProvider(opts.apiKey);
  const { text } = await generateText({
    model: gateway("google/gemini-3-flash-preview"),
    prompt: `You choose what a LinkedIn creator should post about today.

NICHE / FOCUS: ${opts.niche || "technology, AI and business"}

TRENDING HEADLINES (last 48h):
${opts.headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

ALREADY POSTED RECENTLY (do not repeat these angles):
${opts.recentTopics.length ? opts.recentTopics.map((t) => `- ${t}`).join("\n") : "- (nothing yet)"}

Pick the ONE headline with the most LinkedIn discussion potential and turn it into a post angle.
Return ONE sentence (12–25 words) describing the topic and angle. No quotes, no preamble, nothing else.`,
  });
  return text.trim().replace(/^["']|["']$/g, "").split("\n")[0].slice(0, 400);
}

/** Write the post body for a topic. */
export async function writeAutopilotPost(opts: {
  apiKey: string;
  topic: string;
  style: string;
  targetChars: number;
  voiceNotes?: string;
}): Promise<string> {
  const gateway = createLovableAiGatewayProvider(opts.apiKey);
  const minChars = Math.max(150, Math.round(opts.targetChars * 0.82));
  const { text } = await generateText({
    model: gateway("google/gemini-3-flash-preview"),
    prompt: `You are a top LinkedIn creator. Write ONE high-quality LinkedIn post that feels human, not AI.

TOPIC (a current trending story): ${opts.topic}
WRITING STYLE: ${STYLE_HINTS[opts.style] ?? STYLE_HINTS.professional}
TARGET LENGTH: between ${minChars} and ${opts.targetChars} characters. NEVER exceed ${opts.targetChars}.
${opts.voiceNotes?.trim() ? `\nUSER'S PERSONAL VOICE (match closely):\n"${opts.voiceNotes.trim()}"\n` : ""}
STRUCTURE:
1. Scroll-stopping hook on line 1, under 210 characters, wrapped in **double asterisks**.
2. Blank line.
3. 2–3 short paragraphs of context on what happened and why it matters.
4. 1–2 short paragraphs of the real lesson or implication.
5. 2–4 concise practical takeaways.
6. A genuine reflective question as a soft CTA.
7. Blank line, then 3–5 niche hashtags (never #motivation #success #inspiration).

RULES:
- Short paragraphs, lots of white space. Use **double asterisks** for 1–2 key phrases only.
- Do not invent fake statistics or fake quotes. Stay factual about the story.
- No links, no emoji spam, no corporate buzzwords.

Output ONLY the post text.`,
  });
  let out = toUnicodeBold(text.trim());
  if (out.length > 3000) out = out.slice(0, 2990).trimEnd() + "…";
  return out;
}

/** Full one-user autopilot cycle: topic → post → publish → record draft. */
export async function runAutopilotForUser(row: AutopilotRow): Promise<{ topic: string; postId?: string; draftId: string }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: recent } = await supabaseAdmin
    .from("drafts")
    .select("topic")
    .eq("user_id", row.user_id)
    .eq("source", "autopilot")
    .order("created_at", { ascending: false })
    .limit(15);
  const recentTopics = (recent ?? []).map((r) => r.topic).filter(Boolean);

  const headlines = await fetchTrendingHeadlines(row.niche);
  if (!headlines.length) throw new Error("No trending headlines found for this focus");
  const topic = await pickTrendingTopic({ apiKey, headlines, niche: row.niche, recentTopics });

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("voice_notes")
    .eq("user_id", row.user_id)
    .maybeSingle();

  const content = await writeAutopilotPost({
    apiKey,
    topic,
    style: row.style,
    targetChars: row.target_chars,
    voiceNotes: profile?.voice_notes ?? undefined,
  });

  const { data: draft, error: draftError } = await supabaseAdmin
    .from("drafts")
    .insert({
      user_id: row.user_id,
      topic,
      style: row.style,
      target_chars: row.target_chars,
      content,
      status: "draft",
      source: "autopilot",
    })
    .select("id")
    .single();
  if (draftError) throw new Error(draftError.message);

  const { accessToken, linkedinSub } = await getUserTokens(row.user_id);
  const { postId } = await publishToLinkedIn({ text: content, images: [], accessToken, linkedinSub });

  await supabaseAdmin
    .from("drafts")
    .update({ status: "published", published_at: new Date().toISOString(), post_id: postId ?? null })
    .eq("id", draft.id);

  return { topic, postId, draftId: draft.id };
}
