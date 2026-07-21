import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { generatePost, publishPost } from "@/lib/linkedin.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "LinkedIn Auto Poster — AI-drafted posts, one click to publish" },
      { name: "description", content: "Draft a professional LinkedIn post from any topic with AI, edit it, and publish straight to LinkedIn." },
      { property: "og:title", content: "LinkedIn Auto Poster" },
      { property: "og:description", content: "AI-drafted LinkedIn posts, one click to publish." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Status =
  | { kind: "idle" }
  | { kind: "generating" }
  | { kind: "ready" }
  | { kind: "publishing" }
  | { kind: "success"; postId?: string }
  | { kind: "error"; message: string };

function Index() {
  const [topic, setTopic] = useState("");
  const [post, setPost] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const isGenerating = status.kind === "generating";
  const isPublishing = status.kind === "publishing";
  const busy = isGenerating || isPublishing;

  const onGenerate = async () => {
    if (!topic.trim()) return;
    setStatus({ kind: "generating" });
    try {
      const { text } = await generatePost({ data: { topic: topic.trim() } });
      setPost(text);
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to generate post" });
    }
  };

  const onPublish = async () => {
    if (!post.trim()) return;
    setStatus({ kind: "publishing" });
    try {
      const result = await publishPost({ data: { text: post.trim() } });
      setStatus({ kind: "success", postId: result.postId });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to publish" });
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-12 sm:py-20">
        <header className="mb-12 border-b border-border pb-8">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            <span className="text-accent">●</span> Editorial · AI-drafted
          </p>
          <h1 className="mt-3 font-serif text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            LinkedIn Auto Poster
          </h1>
          <p className="mt-3 max-w-lg text-sm text-muted-foreground sm:text-base">
            Type a topic. Get a polished draft. Edit it. Publish it.
          </p>
        </header>

        <section className="space-y-8">
          <div>
            <label htmlFor="topic" className="mb-2 block text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Topic
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                id="topic"
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. lessons from shipping a side project in a weekend"
                disabled={busy}
                className="flex-1 border-b border-border bg-transparent px-0 py-3 text-base text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none disabled:opacity-50"
                onKeyDown={(e) => {
                  if (e.key === "Enter") onGenerate();
                }}
              />
              <button
                onClick={onGenerate}
                disabled={busy || !topic.trim()}
                className="whitespace-nowrap bg-primary px-6 py-3 text-sm font-medium uppercase tracking-widest text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isGenerating ? "Generating…" : "Generate Post"}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="post" className="mb-2 block text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Draft
            </label>
            <textarea
              id="post"
              value={post}
              onChange={(e) => setPost(e.target.value)}
              placeholder="Your AI-generated post will appear here. Feel free to edit it before publishing."
              disabled={busy}
              rows={12}
              className="w-full resize-y border border-border bg-card p-4 text-base leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none disabled:opacity-50"
            />
            <div className="mt-1 text-right text-xs text-muted-foreground">
              {post.length} chars
            </div>
          </div>

          <div className="flex flex-col-reverse items-stretch gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
            <StatusLine status={status} />
            <button
              onClick={onPublish}
              disabled={busy || !post.trim()}
              className="whitespace-nowrap bg-accent px-6 py-3 text-sm font-medium uppercase tracking-widest text-accent-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isPublishing ? "Publishing…" : "Publish to LinkedIn"}
            </button>
          </div>
        </section>

        <footer className="mt-16 border-t border-border pt-6 text-xs text-muted-foreground">
          Connected via Lovable · Posts go to the linked LinkedIn account.
        </footer>
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "idle") {
    return <p className="text-sm text-muted-foreground">Waiting for a topic.</p>;
  }
  if (status.kind === "generating") {
    return <p className="text-sm text-muted-foreground">Generating…</p>;
  }
  if (status.kind === "ready") {
    return <p className="text-sm"><span className="text-accent">●</span> Ready to publish</p>;
  }
  if (status.kind === "publishing") {
    return <p className="text-sm text-muted-foreground">Publishing to LinkedIn…</p>;
  }
  if (status.kind === "success") {
    return (
      <p className="text-sm">
        <span className="text-accent">●</span> Published successfully
        {status.postId ? <span className="text-muted-foreground"> · {status.postId}</span> : null}
      </p>
    );
  }
  return <p className="text-sm text-destructive break-words">Error: {status.message}</p>;
}
