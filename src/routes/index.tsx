import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
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

type Goal = "thought-leadership" | "personal-story" | "tips-insights" | "announcement";
const GOAL_OPTIONS: { value: Goal; label: string }[] = [
  { value: "thought-leadership", label: "Thought Leadership" },
  { value: "personal-story", label: "Personal Story" },
  { value: "tips-insights", label: "Tips & Insights" },
  { value: "announcement", label: "Announcement" },
];

type PendingImage = {
  id: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
  previewUrl: string;
};

const MAX_IMAGES = 9;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per image
const TRUNCATION_LIMIT = 210;

async function fileToPendingImage(file: File): Promise<PendingImage> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const dataBase64 = btoa(binary);
  return {
    id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
    filename: file.name,
    mimeType: file.type || "image/jpeg",
    dataBase64,
    previewUrl: URL.createObjectURL(file),
  };
}

function Index() {
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState<Goal>("thought-leadership");
  const [post, setPost] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isGenerating = status.kind === "generating";
  const isPublishing = status.kind === "publishing";
  const busy = isGenerating || isPublishing;

  const charCount = post.length;
  const overFold = charCount > TRUNCATION_LIMIT;

  const onGenerate = async () => {
    if (!topic.trim()) return;
    setStatus({ kind: "generating" });
    try {
      const { text } = await generatePost({ data: { topic: topic.trim(), goal } });
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
      const result = await publishPost({
        data: {
          text: post.trim(),
          images: images.map(({ filename, mimeType, dataBase64 }) => ({
            filename,
            mimeType,
            dataBase64,
          })),
        },
      });
      setStatus({ kind: "success", postId: result.postId });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to publish" });
    }
  };

  const onImagesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = MAX_IMAGES - images.length;
    const picked = Array.from(files).slice(0, room);
    const errors: string[] = [];
    const accepted: File[] = [];
    for (const file of picked) {
      if (!/^image\/(png|jpeg|jpg|gif|webp)$/.test(file.type)) {
        errors.push(`${file.name}: unsupported type`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        errors.push(`${file.name}: over 8 MB`);
        continue;
      }
      accepted.push(file);
    }
    const added = await Promise.all(accepted.map(fileToPendingImage));
    setImages((prev) => [...prev, ...added]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (errors.length) {
      setStatus({ kind: "error", message: errors.join("; ") });
    }
  };

  const removeImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
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
          <div className="grid gap-6 sm:grid-cols-[1fr_auto] sm:items-end">
            <div>
              <label htmlFor="topic" className="mb-2 block text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Topic
              </label>
              <input
                id="topic"
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. lessons from shipping a side project in a weekend"
                disabled={busy}
                className="w-full border-b border-border bg-transparent px-0 py-3 text-base text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none disabled:opacity-50"
                onKeyDown={(e) => {
                  if (e.key === "Enter") onGenerate();
                }}
              />
            </div>
            <div>
              <label htmlFor="goal" className="mb-2 block text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Post Goal
              </label>
              <select
                id="goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value as Goal)}
                disabled={busy}
                className="w-full border-b border-border bg-transparent px-0 py-3 text-base text-foreground focus:border-accent focus:outline-none disabled:opacity-50"
              >
                {GOAL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <button
              onClick={onGenerate}
              disabled={busy || !topic.trim()}
              className="w-full whitespace-nowrap bg-primary px-6 py-3 text-sm font-medium uppercase tracking-widest text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
            >
              {isGenerating ? "Generating…" : "Generate Post"}
            </button>
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
              style={{ whiteSpace: "pre-wrap" }}
            />
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className={overFold ? "text-accent" : "text-muted-foreground"}>
                {overFold
                  ? `${charCount - TRUNCATION_LIMIT} chars after the "see more" cutoff`
                  : `${TRUNCATION_LIMIT - charCount} chars until the "see more" cutoff`}
              </span>
              <span className="text-muted-foreground">{charCount} chars</span>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Images{" "}
              <span className="normal-case tracking-normal text-muted-foreground/70">
                (optional · up to {MAX_IMAGES})
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-3">
              {images.map((img) => (
                <div key={img.id} className="relative h-20 w-20 overflow-hidden border border-border">
                  <img src={img.previewUrl} alt={img.filename} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    disabled={busy}
                    aria-label={`Remove ${img.filename}`}
                    className="absolute right-0 top-0 bg-background/90 px-1.5 py-0.5 text-xs text-foreground hover:text-accent"
                  >
                    ×
                  </button>
                </div>
              ))}
              {images.length < MAX_IMAGES && (
                <label
                  className={`flex h-20 w-20 cursor-pointer items-center justify-center border border-dashed border-border text-2xl text-muted-foreground hover:border-accent hover:text-accent ${
                    busy ? "pointer-events-none opacity-50" : ""
                  }`}
                >
                  +
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    multiple
                    className="hidden"
                    onChange={(e) => onImagesSelected(e.target.files)}
                    disabled={busy}
                  />
                </label>
              )}
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
