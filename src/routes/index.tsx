import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { generatePost, publishPost, generateImage } from "@/lib/linkedin.functions";

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
  | { kind: "generating-image" }
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

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per image
const TRUNCATION_LIMIT = 210;
const MAX_POST_CHARS = 3000;
const DEFAULT_TARGET_CHARS = 900;

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

function base64ToPreviewUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

// Trim to `limit` chars while preserving the hook (first line) and hashtags (last line).
function trimToMax(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  const hook = lines[0] ?? "";
  // Find hashtag line (last non-empty line starting with #)
  let tagIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l && l.startsWith("#")) { tagIdx = i; break; }
    if (l) break;
  }
  const tags = tagIdx >= 0 ? lines[tagIdx] : "";
  const bodyLines = lines.slice(1, tagIdx >= 0 ? tagIdx : lines.length);
  const suffix = tags ? `\n\n${tags}` : "";
  const prefix = `${hook}\n\n`;
  const budget = limit - prefix.length - suffix.length;
  let body = bodyLines.join("\n").trim();
  if (body.length > budget) body = body.slice(0, Math.max(0, budget - 1)).trimEnd() + "…";
  return `${prefix}${body}${suffix}`;
}

function Index() {
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState<Goal>("thought-leadership");
  const [post, setPost] = useState("");
  const [image, setImage] = useState<PendingImage | null>(null);
  const [imageMode, setImageMode] = useState<"ai" | "upload">("ai");
  const [targetChars, setTargetChars] = useState<number>(DEFAULT_TARGET_CHARS);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isGenerating = status.kind === "generating";
  const isGeneratingImage = status.kind === "generating-image";
  const isPublishing = status.kind === "publishing";
  const busy = isGenerating || isGeneratingImage || isPublishing;

  const charCount = post.length;
  const overFold = charCount > TRUNCATION_LIMIT;
  const overMax = charCount > MAX_POST_CHARS;
  const overTarget = charCount > targetChars;

  const onGenerate = async () => {
    if (!topic.trim()) return;
    setStatus({ kind: "generating" });
    try {
      const { text } = await generatePost({ data: { topic: topic.trim(), goal, targetChars } });
      setPost(trimToMax(text, targetChars));
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to generate post" });
    }
  };

  const onPublish = async () => {
    if (!post.trim()) return;
    if (post.length > MAX_POST_CHARS) {
      setStatus({ kind: "error", message: `Post exceeds ${MAX_POST_CHARS} characters. Trim it before publishing.` });
      return;
    }
    setStatus({ kind: "publishing" });
    try {
      const result = await publishPost({
        data: {
          text: post.trim(),
          images: image
            ? [{ filename: image.filename, mimeType: image.mimeType, dataBase64: image.dataBase64 }]
            : [],
        },
      });
      setStatus({ kind: "success", postId: result.postId });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to publish" });
    }
  };

  const onImageSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!/^image\/(png|jpeg|jpg|gif|webp)$/.test(file.type)) {
      setStatus({ kind: "error", message: `${file.name}: unsupported type` });
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus({ kind: "error", message: `${file.name}: over 8 MB` });
      return;
    }
    const added = await fileToPendingImage(file);
    if (image) URL.revokeObjectURL(image.previewUrl);
    setImage(added);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeImage = () => {
    if (image) URL.revokeObjectURL(image.previewUrl);
    setImage(null);
  };

  const onGenerateImage = async () => {
    if (!topic.trim()) {
      setStatus({ kind: "error", message: "Enter a topic first to generate an image." });
      return;
    }
    setStatus({ kind: "generating-image" });
    try {
      const res = await generateImage({ data: { topic: topic.trim() } });
      if (image) URL.revokeObjectURL(image.previewUrl);
      const previewUrl = base64ToPreviewUrl(res.dataBase64, res.mimeType);
      setImage({
        id: `ai-${Math.random().toString(36).slice(2)}`,
        filename: res.filename,
        mimeType: res.mimeType,
        dataBase64: res.dataBase64,
        previewUrl,
      });
      setStatus({ kind: post.trim() ? "ready" : "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to generate image" });
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
            <label htmlFor="targetChars" className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-widest text-muted-foreground">
              <span>Target length</span>
              <span className="normal-case tracking-normal text-foreground">
                {targetChars} characters
              </span>
            </label>
            <input
              id="targetChars"
              type="range"
              min={200}
              max={3000}
              step={50}
              value={targetChars}
              onChange={(e) => setTargetChars(Number(e.target.value))}
              disabled={busy}
              className="w-full accent-accent disabled:opacity-50"
            />
            <div className="mt-1 flex justify-between text-[10px] uppercase tracking-widest text-muted-foreground/70">
              <span>Short · 200</span>
              <span>Long · 3000</span>
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
              <span className={overMax ? "text-red-600 font-semibold" : overTarget ? "text-accent" : "text-muted-foreground"}>
                {charCount} / {targetChars} characters
                {overMax ? ` · over ${MAX_POST_CHARS} limit` : ""}
              </span>
            </div>
          </div>

          <div className="border-t border-border pt-8">
            <label className="mb-3 block text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Image <span className="normal-case tracking-normal text-muted-foreground/70">(optional)</span>
            </label>
            <div className="mb-4 inline-flex border border-border">
              <button
                type="button"
                onClick={() => setImageMode("ai")}
                disabled={busy}
                className={`px-4 py-2 text-xs uppercase tracking-widest transition-colors ${
                  imageMode === "ai"
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Generate with AI
              </button>
              <button
                type="button"
                onClick={() => setImageMode("upload")}
                disabled={busy}
                className={`px-4 py-2 text-xs uppercase tracking-widest transition-colors ${
                  imageMode === "upload"
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Upload
              </button>
            </div>

            <div className="flex flex-wrap items-start gap-4">
              {image && (
                <div className="relative h-32 w-32 overflow-hidden border border-border">
                  <img src={image.previewUrl} alt={image.filename} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={removeImage}
                    disabled={busy}
                    aria-label="Remove image"
                    className="absolute right-0 top-0 bg-background/90 px-2 py-0.5 text-xs text-foreground hover:text-accent"
                  >
                    ×
                  </button>
                </div>
              )}

              {imageMode === "ai" ? (
                <button
                  type="button"
                  onClick={onGenerateImage}
                  disabled={busy || !topic.trim()}
                  className="border border-border px-4 py-3 text-xs font-medium uppercase tracking-widest text-foreground hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isGeneratingImage ? "Generating image…" : image ? "Regenerate image" : "Generate image with AI"}
                </button>
              ) : (
                <label
                  className={`flex cursor-pointer items-center border border-dashed border-border px-4 py-3 text-xs font-medium uppercase tracking-widest text-muted-foreground hover:border-accent hover:text-accent ${
                    busy ? "pointer-events-none opacity-50" : ""
                  }`}
                >
                  {image ? "Replace image" : "Choose file"}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="hidden"
                    onChange={(e) => onImageSelected(e.target.files)}
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
              disabled={busy || !post.trim() || overMax}
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
  if (status.kind === "generating-image") {
    return <p className="text-sm text-muted-foreground">Generating image…</p>;
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
