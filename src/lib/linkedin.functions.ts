import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/linkedin";

function linkedInHeaders() {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const linkedinKey = process.env.LINKEDIN_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
  if (!linkedinKey) throw new Error("LINKEDIN_API_KEY is not configured");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": linkedinKey,
  };
}

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

const POST_GOALS = {
  "thought-leadership": "Thought Leadership — share a distinctive perspective backed by experience",
  "personal-story": "Personal Story — a first-person narrative with a lesson",
  "tips-insights": "Tips & Insights — concrete, actionable takeaways",
  announcement: "Announcement — share news with genuine excitement, not hype",
} as const;

export const generatePost = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        topic: z.string().min(1).max(500),
        goal: z.enum(["thought-leadership", "personal-story", "tips-insights", "announcement"]),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY is not configured");
    const gateway = createLovableAiGatewayProvider(key);

    const goalDescription = POST_GOALS[data.goal];
    const prompt = `You are writing a LinkedIn post.

GOAL: ${goalDescription}
TOPIC: ${data.topic}

STRUCTURE (follow exactly):
1. Line 1: a short, scroll-stopping hook — question, bold claim, or relatable problem. MUST be under 210 characters so it shows before the "see more" cutoff. Wrap the hook line in **double asterisks** so it becomes bold.
2. Blank line.
3. Body: 3–5 short paragraphs, each 1–2 sentences. Lots of white space. Never dense blocks.
4. Wrap 1–2 short key phrases inside the body in **double asterisks** for emphasis. Do not overuse.
5. End with a soft, natural reflective question or gentle call-to-action. No "comment below!" spam.
6. Blank line.
7. Last line: 3–5 niche, specific hashtags (mix 1 broad + 2–4 specific). Never generic (#motivation, #success, #inspiration).

RULES:
- Total length 150–300 words.
- No external links.
- Use **double asterisks** for bold — do NOT output any other markdown. The renderer converts ** to Unicode bold.
- Use single line breaks between short paragraphs, matching how LinkedIn renders them.
- Natural human tone. No corporate buzzwords. No emoji spam (at most one, only if it truly fits).

Output only the post text. No preamble, no explanation.`;

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

export const generateImage = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ topic: z.string().min(1).max(500) }).parse(input),
  )
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY is not configured");
    const prompt = `Professional, clean, editorial-style image representing: ${data.topic}. Minimal composition, sophisticated lighting, no text overlay, suitable for LinkedIn.`;
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
    return { dataBase64: b64, mimeType: "image/png" as const, filename: "ai-generated.png" };
  });

export const publishPost = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        text: z.string().min(1).max(3000),
        images: z.array(MediaSchema).max(9).optional().default([]),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const headers = linkedInHeaders();

    // Get the connected member's URN via OIDC userinfo
    const userinfoRes = await fetch(`${GATEWAY_URL}/v2/userinfo`, { headers });
    if (!userinfoRes.ok) {
      const body = await userinfoRes.text();
      throw new Error(`LinkedIn userinfo failed [${userinfoRes.status}]: ${body}`);
    }
    const userinfo = (await userinfoRes.json()) as { sub?: string };
    if (!userinfo.sub) throw new Error("LinkedIn userinfo missing 'sub'");
    const authorUrn = `urn:li:person:${userinfo.sub}`;

    // Upload each image to LinkedIn's asset service and collect the asset URNs.
    const assetUrns: string[] = [];
    for (const img of data.images) {
      const registerRes = await fetch(`${GATEWAY_URL}/v2/assets?action=registerUpload`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          registerUploadRequest: {
            recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
            owner: authorUrn,
            serviceRelationships: [
              { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
            ],
          },
        }),
      });
      if (!registerRes.ok) {
        const body = await registerRes.text();
        throw new Error(`LinkedIn registerUpload failed [${registerRes.status}]: ${body}`);
      }
      const registered = (await registerRes.json()) as {
        value?: {
          asset?: string;
          uploadMechanism?: {
            "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"?: {
              uploadUrl?: string;
            };
          };
        };
      };
      const uploadUrl =
        registered.value?.uploadMechanism?.[
          "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
        ]?.uploadUrl;
      const asset = registered.value?.asset;
      if (!uploadUrl || !asset) throw new Error("LinkedIn registerUpload missing uploadUrl/asset");

      const binary = Uint8Array.from(atob(img.dataBase64), (c) => c.charCodeAt(0));
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": img.mimeType },
        body: binary,
      });
      if (!uploadRes.ok) {
        const body = await uploadRes.text().catch(() => "");
        throw new Error(`LinkedIn image upload failed [${uploadRes.status}]: ${body}`);
      }
      assetUrns.push(asset);
    }

    const hasMedia = assetUrns.length > 0;
    const payload = {
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: data.text },
          shareMediaCategory: hasMedia ? "IMAGE" : "NONE",
          ...(hasMedia
            ? {
                media: assetUrns.map((urn) => ({
                  status: "READY",
                  media: urn,
                })),
              }
            : {}),
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
    };

    const postRes = await fetch(`${GATEWAY_URL}/v2/ugcPosts`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(payload),
    });

    if (!postRes.ok) {
      const body = await postRes.text();
      console.error(`LinkedIn publish failed [${postRes.status}]: ${body}`);
      throw new Error(`LinkedIn publish failed [${postRes.status}]: ${body}`);
    }

    const postId = postRes.headers.get("x-restli-id") ?? undefined;
    return { ok: true as const, postId };
  });