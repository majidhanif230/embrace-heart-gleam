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
    <div className="min-h-screen text-foreground">
      <div className="mx-auto grid min-h-screen max-w-6xl gap-12 px-6 py-12 md:grid-cols-2 md:items-center">
        {/* Left — pitch */}
        <div className="hidden flex-col justify-center md:flex">
          <Link to="/" className="mb-8 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.25em] text-muted-foreground hover:text-foreground">
            <span className="inline-block h-2 w-2 rounded-full gradient-primary" />
            LinkedIn Auto Poster
          </Link>
          <h1 className="font-serif text-5xl font-bold leading-[1.05] tracking-tight">
            Write LinkedIn posts that <span className="text-gradient">actually go viral.</span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
            An AI content studio that drafts, scores, schedules, and publishes posts to your own LinkedIn — grounded in your voice and your knowledge base.
          </p>
          <ul className="mt-8 space-y-3 text-sm">
            {[
              "3 draft variants, hook picker & content score",
              "Knowledge base: import PDF, DOCX, PPTX, images",
              "Web image search + LinkedIn feed preview",
              "Schedule posts, auto-publish while you sleep",
            ].map((f) => (
              <li key={f} className="flex items-center gap-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full gradient-primary text-xs font-bold text-primary-foreground">✓</span>
                <span className="text-foreground/90">{f}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Right — sign-in card */}
        <div className="flex flex-col justify-center">
          <Link to="/" className="mb-8 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.25em] text-muted-foreground hover:text-foreground md:hidden">
            <span className="inline-block h-2 w-2 rounded-full gradient-primary" />
            LinkedIn Auto Poster
          </Link>
          <div className="glass-strong glow-primary relative overflow-hidden rounded-3xl p-8 sm:p-10">
            <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full gradient-primary opacity-30 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-20 -left-10 h-56 w-56 rounded-full gradient-viral opacity-25 blur-3xl" />

            <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">Get started · free</p>
            <h2 className="mt-3 font-serif text-3xl font-bold tracking-tight">Sign in to your studio</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Connect your LinkedIn account to draft, schedule and publish posts directly to your profile.
            </p>

            <a
              href="/api/public/linkedin/login"
              className="mt-8 flex w-full items-center justify-center gap-3 rounded-xl bg-[#0A66C2] px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[#0A66C2]/30 transition hover:shadow-xl hover:shadow-[#0A66C2]/50 hover:brightness-110"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20.447 20.452H16.89v-5.569c0-1.328-.026-3.037-1.851-3.037-1.851 0-2.135 1.445-2.135 2.939v5.667H9.35V9h3.414v1.561h.05c.476-.9 1.637-1.85 3.37-1.85 3.6 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125zM7.116 20.452H3.554V9h3.562v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.226.792 24 1.771 24h20.451C23.2 24 24 23.226 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
              </svg>
              Continue with LinkedIn
            </a>

            {errorMsg && (
              <p className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{errorMsg}</p>
            )}

            <p className="mt-8 text-xs leading-relaxed text-muted-foreground">
              By continuing, you allow this app to read your basic LinkedIn profile and post on your behalf. Disconnect any time from Settings.
            </p>
          </div>
        </div>
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