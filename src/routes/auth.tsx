import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getSessionUser } from "@/lib/linkedin-auth.functions";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — LinkedIn Auto Poster" },
      { name: "description", content: "Sign in with LinkedIn to draft, schedule, and publish posts with AI." },
      { property: "og:title", content: "Sign in — LinkedIn Auto Poster" },
      { property: "og:description", content: "AI content studio for LinkedIn." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-destructive">Auth error: {error.message}</div>
  ),
});

function AuthPage() {
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err) setErrorMsg(prettyError(err));

    // If already signed in, bounce home.
    getSessionUser().then((u) => {
      if (u) window.location.replace("/");
    }).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
        <Link to="/" className="mb-10 text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground">
          ← LinkedIn Auto Poster
        </Link>
        <h1 className="font-serif text-4xl font-semibold tracking-tight">
          Sign in
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Connect your LinkedIn account to start drafting, scheduling, and publishing posts directly to your own profile.
        </p>

        <a
          href="/api/public/linkedin/login"
          className="mt-8 flex w-full items-center justify-center gap-3 bg-[#0A66C2] px-4 py-3 text-sm font-medium uppercase tracking-widest text-white hover:opacity-90"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M20.447 20.452H16.89v-5.569c0-1.328-.026-3.037-1.851-3.037-1.851 0-2.135 1.445-2.135 2.939v5.667H9.35V9h3.414v1.561h.05c.476-.9 1.637-1.85 3.37-1.85 3.6 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125zM7.116 20.452H3.554V9h3.562v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.226.792 24 1.771 24h20.451C23.2 24 24 23.226 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
          </svg>
          Continue with LinkedIn
        </a>

        {errorMsg && (
          <p className="mt-6 text-sm text-destructive">{errorMsg}</p>
        )}

        <p className="mt-10 text-xs leading-relaxed text-muted-foreground">
          By continuing, you allow this app to read your basic LinkedIn profile and post on your behalf. You can disconnect anytime by signing out.
        </p>
      </div>
    </div>
  );
}

function prettyError(code: string): string {
  switch (code) {
    case "missing_code": return "LinkedIn didn't return an authorization code. Please try again.";
    case "bad_state": return "Your sign-in session expired. Please try again.";
    case "token_exchange_failed": return "LinkedIn refused the sign-in. Check that this app's redirect URL is authorized.";
    case "userinfo_failed": return "Couldn't read your LinkedIn profile.";
    case "user_upsert_failed": return "Something went wrong saving your account. Please try again.";
    case "not_configured": return "LinkedIn credentials aren't configured on the server.";
    default: return `Sign-in failed: ${code}`;
  }
}