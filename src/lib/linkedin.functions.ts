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

export const generatePost = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ topic: z.string().min(1).max(500) }).parse(input))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY is not configured");
    const gateway = createLovableAiGatewayProvider(key);
    const { text } = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      prompt: `Write a professional, engaging LinkedIn post about the following topic. Keep it under 200 words, no hashtag spam, natural tone: ${data.topic}`,
    });
    return { text: text.trim() };
  });

export const publishPost = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ text: z.string().min(1).max(3000) }).parse(input))
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

    const payload = {
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: data.text },
          shareMediaCategory: "NONE",
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