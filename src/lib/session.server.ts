import { createMiddleware } from "@tanstack/react-start";
import { useSession } from "@tanstack/react-start/server";

export type LapSession = { userId?: string; oauthState?: string };

export function sessionConfig() {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set (>=32 chars).");
  }
  return {
    password,
    name: "lap_session",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax" as const,
      path: "/",
    },
  };
}

export async function readSession() {
  return useSession<LapSession>(sessionConfig());
}

export const requireLinkedInSession = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const session = await readSession();
    if (!session.data.userId) {
      throw new Error("Unauthorized: not signed in with LinkedIn");
    }
    return next({ context: { userId: session.data.userId } });
  },
);