import { createFileRoute } from "@tanstack/react-router";
import { getRequestUrl } from "@tanstack/react-start/server";
import { readSession } from "@/lib/session";

const SCOPES = ["openid", "profile", "email", "w_member_social"];

export const Route = createFileRoute("/api/public/linkedin/login")({
  server: {
    handlers: {
      GET: async () => {
        const clientId = process.env.LINKEDIN_CLIENT_ID;
        if (!clientId) {
          return new Response("LINKEDIN_CLIENT_ID not configured", { status: 500 });
        }
        const reqUrl = getRequestUrl();
        const redirectUri = `${new URL(reqUrl).origin}/api/public/linkedin/callback`;

        const state = crypto.randomUUID();
        const session = await readSession();
        await session.update({ ...session.data, oauthState: state });

        const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("scope", SCOPES.join(" "));

        return new Response(null, {
          status: 302,
          headers: { Location: authUrl.toString() },
        });
      },
    },
  },
});