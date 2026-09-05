import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig(({ command, mode }) => {
  // TanStack Start renders on the server too, where Vite's automatic
  // import.meta.env replacement doesn't apply, so inline VITE_* explicitly.
  const env = loadEnv(mode, process.cwd(), "VITE_");

  return {
    define: Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        `import.meta.env.${key}`,
        JSON.stringify(value),
      ]),
    ),
    resolve: {
      alias: { "@": srcDir },
      // A second copy of React or the query client silently breaks hooks and
      // cache identity across the SSR/client boundary.
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
    },
    plugins: [
      tailwindcss(),
      tsConfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        // Keep server-only modules out of the client bundle; these files read
        // service-role keys and OAuth secrets.
        importProtection: {
          behavior: "error",
          client: {
            files: ["**/server/**"],
            specifiers: ["server-only"],
          },
        },
        // Redirect TanStack Start's bundled server entry to src/server.ts (our
        // SSR error wrapper). nitro builds from this.
        server: { entry: "server" },
      }),
      // Nitro only participates in builds; `vite dev` uses Start's own server.
      ...(command === "build"
        ? [
            nitro({
              preset: "cloudflare-module",
              output: {
                dir: "dist",
                serverDir: "dist/server",
                publicDir: "dist/client",
              },
              cloudflare: {
                nodeCompat: true,
                deployConfig: true,
              },
            }),
          ]
        : []),
      react(),
    ],
  };
});
