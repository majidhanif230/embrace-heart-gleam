import { createFileRoute } from "@tanstack/react-router";
import { getRequestUrl } from "@tanstack/react-start/server";
import { readSession } from "@/lib/session";

export const Route = createFileRoute("/api/public/linkedin/callback")({
  server: {
    handlers: {
      GET: async () => {
        const reqUrl = new URL(getRequestUrl());
        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");
        const err = reqUrl.searchParams.get("error");

        if (err) {
          return redirectTo(`/auth?error=${encodeURIComponent(err)}`);
        }
        if (!code || !state) {
          return redirectTo("/auth?error=missing_code");
        }

        const session = await readSession();
        if (!session.data.oauthState || session.data.oauthState !== state) {
          return redirectTo("/auth?error=bad_state");
        }

        const clientId = process.env.LINKEDIN_CLIENT_ID;
        const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return redirectTo("/auth?error=not_configured");
        }

        const redirectUri = getLinkedInRedirectUri(reqUrl);

        // 1. Exchange code for access token
        const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });
        if (!tokenRes.ok) {
          const body = await tokenRes.text();
          console.error("LinkedIn token exchange failed", tokenRes.status, body);
          return redirectTo("/auth?error=token_exchange_failed");
        }
        const tok = (await tokenRes.json()) as {
          access_token: string;
          expires_in: number;
          refresh_token?: string;
          scope?: string;
        };

        // 2. Fetch profile
        const uiRes = await fetch("https://api.linkedin.com/v2/userinfo", {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        });
        if (!uiRes.ok) {
          const body = await uiRes.text();
          console.error("LinkedIn userinfo failed", uiRes.status, body);
          return redirectTo("/auth?error=userinfo_failed");
        }
        const ui = (await uiRes.json()) as {
          sub: string;
          name?: string;
          email?: string;
          picture?: string;
        };

        // 3. Upsert user + profile
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const expiresAt = new Date(Date.now() + tok.expires_in * 1000).toISOString();
        const { data: upserted, error: upErr } = await supabaseAdmin
          .from("linkedin_users")
          .upsert(
            {
              linkedin_sub: ui.sub,
              name: ui.name ?? null,
              email: ui.email ?? null,
              picture: ui.picture ?? null,
              access_token: tok.access_token,
              refresh_token: tok.refresh_token ?? null,
              expires_at: expiresAt,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "linkedin_sub" },
          )
          .select("id")
          .single();

        if (upErr || !upserted) {
          console.error("linkedin_users upsert failed", upErr);
          return redirectTo("/auth?error=user_upsert_failed");
        }

        // Ensure a profiles row exists for voice notes.
        await supabaseAdmin
          .from("profiles")
          .upsert(
            { user_id: upserted.id, display_name: ui.name ?? null },
            { onConflict: "user_id" },
          );

        // 4. Set session
        await session.update({ userId: upserted.id, oauthState: undefined });

        return redirectTo("/");
      },
    },
  },
});

function redirectTo(path: string) {
  return new Response(null, {
    status: 302,
    headers: { Location: path },
  });
}

function getLinkedInRedirectUri(requestUrl: URL) {
  return (
    process.env.LINKEDIN_REDIRECT_URI ||
    `${requestUrl.origin}/api/public/linkedin/callback`
  );
}