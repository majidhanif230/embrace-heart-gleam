import { createFileRoute } from "@tanstack/react-router";
import { readSession } from "@/lib/session.server";

export const Route = createFileRoute("/api/public/linkedin/logout")({
  server: {
    handlers: {
      GET: async () => {
        const session = await readSession();
        await session.clear();
        return new Response(null, {
          status: 302,
          headers: { Location: "/auth" },
        });
      },
    },
  },
});