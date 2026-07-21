// Server-only helper that publishes to a specific user's LinkedIn account
// using their own OAuth access token (per-user auth).

const LI_API = "https://api.linkedin.com";

export async function getUserTokens(userId: string): Promise<{ accessToken: string; linkedinSub: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("linkedin_users")
    .select("access_token, linkedin_sub, expires_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load LinkedIn user: ${error.message}`);
  if (!data) throw new Error("LinkedIn account not connected");
  if (new Date(data.expires_at).getTime() < Date.now()) {
    throw new Error("Your LinkedIn session expired. Please sign in again.");
  }
  return { accessToken: data.access_token, linkedinSub: data.linkedin_sub };
}

export type PublishImage = {
  filename: string;
  mimeType: string;
  dataBase64: string;
};

export async function publishToLinkedIn(opts: {
  text: string;
  images: PublishImage[];
  accessToken: string;
  linkedinSub: string;
}): Promise<{ postId?: string }> {
  const h = { Authorization: `Bearer ${opts.accessToken}` };
  const authorUrn = `urn:li:person:${opts.linkedinSub}`;

  const assetUrns: string[] = [];
  for (const img of opts.images) {
    const regRes = await fetch(`${LI_API}/v2/assets?action=registerUpload`, {
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
      headers: { "Content-Type": img.mimeType, Authorization: `Bearer ${opts.accessToken}` },
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

  const postRes = await fetch(`${LI_API}/v2/ugcPosts`, {
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