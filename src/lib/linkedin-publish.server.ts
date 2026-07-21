// Server-only helper that publishes to the linked LinkedIn account.
// Shared between the user's `publishPost` server fn and the pg_cron scheduled endpoint.

const GATEWAY_URL = "https://connector-gateway.lovable.dev/linkedin";

function headers() {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const linkedinKey = process.env.LINKEDIN_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
  if (!linkedinKey) throw new Error("LINKEDIN_API_KEY is not configured");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": linkedinKey,
  };
}

export type PublishImage = {
  filename: string;
  mimeType: string;
  dataBase64: string;
};

export async function publishToLinkedIn(opts: {
  text: string;
  images: PublishImage[];
}): Promise<{ postId?: string }> {
  const h = headers();

  const userinfoRes = await fetch(`${GATEWAY_URL}/v2/userinfo`, { headers: h });
  if (!userinfoRes.ok) {
    throw new Error(`LinkedIn userinfo failed [${userinfoRes.status}]: ${await userinfoRes.text()}`);
  }
  const userinfo = (await userinfoRes.json()) as { sub?: string };
  if (!userinfo.sub) throw new Error("LinkedIn userinfo missing 'sub'");
  const authorUrn = `urn:li:person:${userinfo.sub}`;

  const assetUrns: string[] = [];
  for (const img of opts.images) {
    const regRes = await fetch(`${GATEWAY_URL}/v2/assets?action=registerUpload`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
          owner: authorUrn,
          serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
        },
      }),
    });
    if (!regRes.ok) throw new Error(`LinkedIn registerUpload failed [${regRes.status}]: ${await regRes.text()}`);
    const registered = (await regRes.json()) as {
      value?: {
        asset?: string;
        uploadMechanism?: {
          "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"?: { uploadUrl?: string };
        };
      };
    };
    const uploadUrl = registered.value?.uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]?.uploadUrl;
    const asset = registered.value?.asset;
    if (!uploadUrl || !asset) throw new Error("LinkedIn registerUpload missing uploadUrl/asset");
    const binary = Uint8Array.from(atob(img.dataBase64), (c) => c.charCodeAt(0));
    const upRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": img.mimeType },
      body: binary,
    });
    if (!upRes.ok) throw new Error(`LinkedIn image upload failed [${upRes.status}]: ${await upRes.text().catch(() => "")}`);
    assetUrns.push(asset);
  }

  const hasMedia = assetUrns.length > 0;
  const payload = {
    author: authorUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: opts.text },
        shareMediaCategory: hasMedia ? "IMAGE" : "NONE",
        ...(hasMedia ? { media: assetUrns.map((urn) => ({ status: "READY", media: urn })) } : {}),
      },
    },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  };

  const postRes = await fetch(`${GATEWAY_URL}/v2/ugcPosts`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0" },
    body: JSON.stringify(payload),
  });
  if (!postRes.ok) {
    const body = await postRes.text();
    throw new Error(`LinkedIn publish failed [${postRes.status}]: ${body}`);
  }
  return { postId: postRes.headers.get("x-restli-id") ?? undefined };
}