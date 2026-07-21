import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import {
  generatePostVariants,
  generateHooks,
  scorePost,
  applySuggestion,
  publishPost,
  generateImage,
  type WritingStyle,
  type Suggestion,
  type ImageStyle,
} from "@/lib/linkedin.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "LinkedIn Auto Poster — AI content studio for LinkedIn" },
      { name: "description", content: "A professional AI content studio: research-grade drafts, multiple styles, hook picker, content score, preview, and one-click publishing to LinkedIn." },
      { property: "og:title", content: "LinkedIn Auto Poster" },
      { property: "og:description", content: "AI content studio for LinkedIn — from topic to published post." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Status =
  | { kind: "idle" }
  | { kind: "generating" }
  | { kind: "generating-hooks" }
  | { kind: "generating-image" }
  | { kind: "scoring" }
  | { kind: "rewriting" }
  | { kind: "ready" }
  | { kind: "publishing" }
  | { kind: "success"; postId?: string }
  | { kind: "error"; message: string };

const STYLE_OPTIONS: { value: WritingStyle; label: string }[] = [
  { value: "viral-creator", label: "Viral Creator" },
  { value: "professional", label: "Professional" },
  { value: "storytelling", label: "Storytelling" },
  { value: "educational", label: "Educational" },
  { value: "founder", label: "Founder" },
  { value: "personal-experience", label: "Personal Experience" },
  { value: "technical-deep-dive", label: "Technical Deep Dive" },
  { value: "case-study", label: "Case Study" },
];

const LENGTH_PRESETS = [500, 1000, 1500, 2000, 2500, 3000] as const;

const IMAGE_STYLE_OPTIONS: { value: ImageStyle; label: string }[] = [
  { value: "editorial", label: "Editorial" },
  { value: "photo", label: "Photo" },
  { value: "illustration", label: "Illustration" },
  { value: "3d", label: "3D" },
  { value: "icons", label: "Icons" },
  { value: "minimal", label: "Minimal" },
  { value: "corporate", label: "Corporate" },
];

const SUGGESTIONS: { value: Suggestion; label: string }[] = [
  { value: "more-emotional", label: "More emotional" },
  { value: "more-technical", label: "More technical" },
  { value: "add-stats", label: "Add statistics" },
  { value: "add-story", label: "Add storytelling" },
  { value: "shorten", label: "Shorten" },
  { value: "expand", label: "Expand" },
  { value: "more-viral", label: "More viral" },
  { value: "more-personal", label: "More personal" },
];

type PendingImage = {
  id: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
  previewUrl: string;
};

type Score = {
  hook: number;
  readability: number;
  virality: number;
  professionalTone: number;
  cta: number;
  overall: number;
  notes: string;
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TRUNCATION_LIMIT = 210;
const MAX_POST_CHARS = 3000;

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

// Convert **word** spans (any leftover markdown from user edits) into Unicode bold.
function markdownBoldToUnicode(input: string): string {
  const boldChar = (ch: string): string => {
    const code = ch.codePointAt(0)!;
    if (code >= 0x41 && code <= 0x5a) return String.fromCodePoint(0x1d5d4 + (code - 0x41));
    if (code >= 0x61 && code <= 0x7a) return String.fromCodePoint(0x1d5ee + (code - 0x61));
    if (code >= 0x30 && code <= 0x39) return String.fromCodePoint(0x1d7ec + (code - 0x30));
    return ch;
  };
  return input.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) =>
    Array.from(inner).map(boldChar).join(""),
  );
}

// Clean formatting so it renders exactly like LinkedIn shows it.
function autoFormat(text: string): string {
  let t = text;
  t = markdownBoldToUnicode(t);
  // Strip other markdown: leading #, *, -, _ around words
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/(^|\s)[*_](\S[^*_\n]*\S)[*_](?=\s|$)/g, "$1$2");
  // Collapse 3+ blank lines to 2
  t = t.replace(/\n{3,}/g, "\n\n");
  // Trim trailing spaces per line
  t = t.replace(/[ \t]+\n/g, "\n");
  // Ensure hashtags are lowercased-friendly on the tag line, and single-spaced
  t = t.replace(/(^|\n)((?:#\S+\s*){2,})$/g, (_m, pre, tags: string) => pre + tags.trim().replace(/\s+/g, " "));
  return t.trim();
}

function trimToMax(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  const hook = lines[0] ?? "";
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
  const [style, setStyle] = useState<WritingStyle>("professional");
  const [targetChars, setTargetChars] = useState<number>(1000);
  const [variants, setVariants] = useState<string[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<number>(0);
  const [post, setPost] = useState("");
  const [hooks, setHooks] = useState<string[]>([]);
  const [score, setScore] = useState<Score | null>(null);
  const [companies, setCompanies] = useState<string[]>([]);
  const [image, setImage] = useState<PendingImage | null>(null);
  const [imageMode, setImageMode] = useState<"ai" | "upload">("ai");
  const [imageStyle, setImageStyle] = useState<ImageStyle>("editorial");
  const [previewMode, setPreviewMode] = useState<"desktop" | "mobile">("desktop");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy =
    status.kind === "generating" ||
    status.kind === "generating-hooks" ||
    status.kind === "generating-image" ||
    status.kind === "scoring" ||
    status.kind === "rewriting" ||
    status.kind === "publishing";

  const charCount = post.length;
  const overFold = charCount > TRUNCATION_LIMIT;
  const overMax = charCount > MAX_POST_CHARS;
  const overTarget = charCount > targetChars;

  const onGenerate = async (hookOverride?: string) => {
    if (!topic.trim()) return;
    setStatus({ kind: "generating" });
    setScore(null);
    try {
      const res = await generatePostVariants({
        data: { topic: topic.trim(), style, targetChars, hookOverride },
      });
      const trimmed = res.variants.map((v) => trimToMax(v, targetChars));
      setVariants(trimmed);
      setSelectedVariant(0);
      setPost(trimmed[0] ?? "");
      setCompanies(res.companies);
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to generate post" });
    }
  };

  const onSuggestHooks = async () => {
    if (!topic.trim()) return;
    setStatus({ kind: "generating-hooks" });
    try {
      const res = await generateHooks({ data: { topic: topic.trim(), style } });
      setHooks(res.hooks);
      setStatus(post ? { kind: "ready" } : { kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to generate hooks" });
    }
  };

  const onScore = async () => {
    if (!post.trim()) return;
    setStatus({ kind: "scoring" });
    try {
      const s = await scorePost({ data: { text: post } });
      setScore(s);
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to score post" });
    }
  };

  const onSuggestion = async (s: Suggestion) => {
    if (!post.trim()) return;
    setStatus({ kind: "rewriting" });
    try {
      const res = await applySuggestion({ data: { text: post, suggestion: s, targetChars } });
      setPost(trimToMax(res.text, targetChars));
      setScore(null);
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to rewrite" });
    }
  };

  const selectVariant = (idx: number) => {
    setSelectedVariant(idx);
    setPost(variants[idx] ?? "");
    setScore(null);
  };

  const onPublish = async () => {
    if (!post.trim()) return;
    const formatted = autoFormat(post);
    if (formatted.length > MAX_POST_CHARS) {
      setStatus({ kind: "error", message: `Post exceeds ${MAX_POST_CHARS} characters. Trim it before publishing.` });
      return;
    }
    setPost(formatted);
    setStatus({ kind: "publishing" });
    try {
      const result = await publishPost({
        data: {
          text: formatted,
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
      const res = await generateImage({ data: { topic: topic.trim(), style: imageStyle } });
      if (image) URL.revokeObjectURL(image.previewUrl);
      const previewUrl = base64ToPreviewUrl(res.dataBase64, res.mimeType);
      setImage({
        id: `ai-${Math.random().toString(36).slice(2)}`,
        filename: res.filename,
        mimeType: res.mimeType,
        dataBase64: res.dataBase64,
        previewUrl,
      });
      setStatus(post.trim() ? { kind: "ready" } : { kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed to generate image" });
    }
  };

  const formattedPreview = useMemo(() => autoFormat(post), [post]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-10 sm:py-16">
        <header className="mb-10 border-b border-border pb-8">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            <span className="text-accent">●</span> AI Content Studio
          </p>
          <h1 className="mt-3 font-serif text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            LinkedIn Auto Poster
          </h1>
          <p className="mt-3 max-w-xl text-sm text-muted-foreground sm:text-base">
            Topic in. Three high-quality drafts, hooks, image, score, and preview out. Publish when you're ready.
          </p>
        </header>

        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* MAIN COLUMN */}
          <section className="space-y-8">
            {/* Inputs */}
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="topic">Topic</Label>
                <input
                  id="topic"
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. what changed with GPT-5.6 for engineering teams"
                  disabled={busy}
                  className="w-full border-b border-border bg-transparent px-0 py-3 text-base placeholder:text-muted-foreground focus:border-accent focus:outline-none disabled:opacity-50"
                  onKeyDown={(e) => { if (e.key === "Enter") onGenerate(); }}
                />
                {companies.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Detected mentions: <span className="text-foreground">{companies.map((c) => `@${c}`).join(" · ")}</span>
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="style">Writing Style</Label>
                <select
                  id="style"
                  value={style}
                  onChange={(e) => setStyle(e.target.value as WritingStyle)}
                  disabled={busy}
                  className="w-full border-b border-border bg-transparent px-0 py-3 text-base focus:border-accent focus:outline-none disabled:opacity-50"
                >
                  {STYLE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <Label>Post Length</Label>
                <div className="mt-3 flex flex-wrap gap-2">
                  {LENGTH_PRESETS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setTargetChars(n)}
                      disabled={busy}
                      className={`px-3 py-1.5 text-xs uppercase tracking-widest border transition-colors ${
                        targetChars === n
                          ? "bg-foreground text-background border-foreground"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => onGenerate()}
                disabled={busy || !topic.trim()}
                className="bg-primary px-6 py-3 text-sm font-medium uppercase tracking-widest text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {status.kind === "generating" ? "Generating 3 drafts…" : "Generate 3 drafts"}
              </button>
              <button
                onClick={onSuggestHooks}
                disabled={busy || !topic.trim()}
                className="border border-border px-4 py-3 text-xs font-medium uppercase tracking-widest hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {status.kind === "generating-hooks" ? "Finding hooks…" : "Suggest hooks"}
              </button>
            </div>

            {/* Hooks */}
            {hooks.length > 0 && (
              <div className="border border-border p-4">
                <p className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Pick a hook</p>
                <ul className="space-y-2">
                  {hooks.map((h, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => onGenerate(h)}
                        disabled={busy}
                        className="w-full text-left text-sm hover:text-accent"
                      >
                        <span className="mr-2 text-muted-foreground">{i + 1}.</span>{h}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Variants */}
            {variants.length > 0 && (
              <div>
                <p className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Versions</p>
                <div className="grid grid-cols-3 gap-2">
                  {variants.map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => selectVariant(i)}
                      disabled={busy}
                      className={`border px-3 py-2 text-xs uppercase tracking-widest transition-colors ${
                        selectedVariant === i
                          ? "bg-foreground text-background border-foreground"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground"
                      }`}
                    >
                      Version {String.fromCharCode(65 + i)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Draft */}
            <div>
              <Label htmlFor="post">Draft</Label>
              <textarea
                id="post"
                value={post}
                onChange={(e) => { setPost(e.target.value); setScore(null); }}
                placeholder="Generate drafts, or write directly here."
                disabled={busy}
                rows={14}
                className="w-full resize-y border border-border bg-card p-4 text-base leading-relaxed placeholder:text-muted-foreground focus:border-accent focus:outline-none disabled:opacity-50"
                style={{ whiteSpace: "pre-wrap" }}
              />
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
                <span className={overFold ? "text-accent" : "text-muted-foreground"}>
                  {overFold
                    ? `${charCount - TRUNCATION_LIMIT} chars past the "see more" cutoff`
                    : `${TRUNCATION_LIMIT - charCount} chars until the "see more" cutoff`}
                </span>
                <span className={overMax ? "text-red-600 font-semibold" : overTarget ? "text-accent" : "text-muted-foreground"}>
                  {charCount} / {targetChars}
                  {overMax ? ` · over ${MAX_POST_CHARS} hard limit` : ""}
                </span>
              </div>
            </div>

            {/* Suggestions + Score */}
            {post.trim() && (
              <div className="border border-border p-4">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground">One-click rewrites</p>
                  <button
                    type="button"
                    onClick={onScore}
                    disabled={busy}
                    className="text-xs uppercase tracking-widest text-muted-foreground hover:text-accent"
                  >
                    {status.kind === "scoring" ? "Scoring…" : score ? "Rescore" : "Score post"}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => onSuggestion(s.value)}
                      disabled={busy}
                      className="border border-border px-3 py-1.5 text-xs uppercase tracking-widest hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                {score && (
                  <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-4 text-xs sm:grid-cols-6">
                    <ScoreCell label="Hook" v={score.hook} />
                    <ScoreCell label="Readability" v={score.readability} />
                    <ScoreCell label="Virality" v={score.virality} />
                    <ScoreCell label="Tone" v={score.professionalTone} />
                    <ScoreCell label="CTA" v={score.cta} />
                    <ScoreCell label="Overall" v={score.overall} bold />
                    {score.notes && (
                      <p className="col-span-3 text-muted-foreground sm:col-span-6">{score.notes}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Image */}
            <div className="border-t border-border pt-8">
              <Label>Image <span className="normal-case tracking-normal text-muted-foreground/70">(optional)</span></Label>
              <div className="mt-3 inline-flex border border-border">
                {(["ai", "upload"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setImageMode(m)}
                    disabled={busy}
                    className={`px-4 py-2 text-xs uppercase tracking-widest ${
                      imageMode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m === "ai" ? "Generate with AI" : "Upload"}
                  </button>
                ))}
              </div>

              {imageMode === "ai" && (
                <div className="mt-4">
                  <p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Style</p>
                  <div className="flex flex-wrap gap-2">
                    {IMAGE_STYLE_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => setImageStyle(o.value)}
                        disabled={busy}
                        className={`px-3 py-1.5 text-xs uppercase tracking-widest border ${
                          imageStyle === o.value
                            ? "bg-foreground text-background border-foreground"
                            : "border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-start gap-4">
                {image && (
                  <div className="relative h-32 w-32 overflow-hidden border border-border">
                    <img src={image.previewUrl} alt={image.filename} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={removeImage}
                      disabled={busy}
                      aria-label="Remove image"
                      className="absolute right-0 top-0 bg-background/90 px-2 py-0.5 text-xs hover:text-accent"
                    >×</button>
                  </div>
                )}
                {imageMode === "ai" ? (
                  <button
                    type="button"
                    onClick={onGenerateImage}
                    disabled={busy || !topic.trim()}
                    className="border border-border px-4 py-3 text-xs font-medium uppercase tracking-widest hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {status.kind === "generating-image" ? "Generating image…" : image ? "Regenerate image" : "Generate image"}
                  </button>
                ) : (
                  <label className={`flex cursor-pointer items-center border border-dashed border-border px-4 py-3 text-xs font-medium uppercase tracking-widest text-muted-foreground hover:border-accent hover:text-accent ${busy ? "pointer-events-none opacity-50" : ""}`}>
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

            {/* Publish */}
            <div className="flex flex-col-reverse items-stretch gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
              <StatusLine status={status} />
              <button
                onClick={onPublish}
                disabled={busy || !post.trim() || overMax}
                className="whitespace-nowrap bg-accent px-6 py-3 text-sm font-medium uppercase tracking-widest text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {status.kind === "publishing" ? "Publishing…" : "Publish to LinkedIn"}
              </button>
            </div>
          </section>

          {/* PREVIEW COLUMN */}
          <aside className="lg:sticky lg:top-8 lg:self-start">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-muted-foreground">LinkedIn preview</p>
              <div className="inline-flex border border-border text-xs">
                {(["desktop", "mobile"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setPreviewMode(m)}
                    className={`px-3 py-1 uppercase tracking-widest ${
                      previewMode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <LinkedInPreview text={formattedPreview} imageUrl={image?.previewUrl ?? null} mode={previewMode} />
          </aside>
        </div>

        <footer className="mt-16 border-t border-border pt-6 text-xs text-muted-foreground">
          Connected via Lovable · Posts go to the linked LinkedIn account.
        </footer>
      </div>
    </div>
  );
}

function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-2 block text-xs font-medium uppercase tracking-widest text-muted-foreground">
      {children}
    </label>
  );
}

function ScoreCell({ label, v, bold }: { label: string; v: number; bold?: boolean }) {
  const color = v >= 8 ? "text-accent" : v >= 6 ? "text-foreground" : "text-red-600";
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={`${bold ? "font-semibold" : ""} ${color} text-lg`}>{v.toFixed(1)}</p>
    </div>
  );
}

function LinkedInPreview({ text, imageUrl, mode }: { text: string; imageUrl: string | null; mode: "desktop" | "mobile" }) {
  const width = mode === "mobile" ? "max-w-[360px]" : "w-full";
  return (
    <div className={`${width} border border-border bg-card`}>
      <div className="flex items-center gap-3 border-b border-border p-3">
        <div className="h-10 w-10 rounded-full bg-muted" />
        <div className="flex-1">
          <p className="text-sm font-medium">Your Name</p>
          <p className="text-xs text-muted-foreground">Your headline · Now</p>
        </div>
      </div>
      <div className="whitespace-pre-wrap px-3 py-3 text-sm leading-relaxed">
        {text || <span className="text-muted-foreground">Your post preview will appear here.</span>}
      </div>
      {imageUrl && (
        <div className="border-t border-border">
          <img src={imageUrl} alt="" className="w-full object-cover" />
        </div>
      )}
      <div className="flex justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span>👍 Like</span><span>💬 Comment</span><span>↗ Share</span>
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  const map: Record<Status["kind"], string> = {
    idle: "Waiting for a topic.",
    generating: "Generating 3 drafts…",
    "generating-hooks": "Generating hooks…",
    "generating-image": "Generating image…",
    scoring: "Scoring…",
    rewriting: "Rewriting…",
    ready: "Ready to publish",
    publishing: "Publishing to LinkedIn…",
    success: "Published successfully",
    error: "Error",
  };
  if (status.kind === "error") {
    return <p className="text-sm text-destructive break-words">Error: {status.message}</p>;
  }
  if (status.kind === "success") {
    return (
      <p className="text-sm">
        <span className="text-accent">●</span> Published successfully
        {status.postId ? <span className="text-muted-foreground"> · {status.postId}</span> : null}
      </p>
    );
  }
  if (status.kind === "ready") {
    return <p className="text-sm"><span className="text-accent">●</span> {map[status.kind]}</p>;
  }
  return <p className="text-sm text-muted-foreground">{map[status.kind]}</p>;
}