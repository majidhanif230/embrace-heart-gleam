import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  generatePostVariants,
  generateHooks,
  scorePost,
  applySuggestion,
  publishPost,
  brainstormTopics,
  searchImages,
  fetchImageAsBase64,
  type WritingStyle,
  type Suggestion,
} from "@/lib/linkedin.functions";
import { getProfile, updateProfile } from "@/lib/profile.functions";
import {
  listDrafts,
  upsertDraft,
  deleteDraft,
  scheduleDraft,
  cancelSchedule,
} from "@/lib/drafts.functions";
import { getSessionUser } from "@/lib/linkedin-auth.functions";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "LinkedIn Auto Poster — AI content studio" },
      { name: "description", content: "AI content studio: research-grade drafts, multiple styles, hook picker, content score, preview, scheduling, and one-click publishing to LinkedIn." },
      { property: "og:title", content: "LinkedIn Auto Poster" },
      { property: "og:description", content: "AI content studio for LinkedIn." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Studio,
});

type Status =
  | { kind: "idle" }
  | { kind: "generating" }
  | { kind: "generating-hooks" }
  | { kind: "brainstorming" }
  | { kind: "searching-images" }
  | { kind: "fetching-image" }
  | { kind: "scoring" }
  | { kind: "rewriting" }
  | { kind: "saving" }
  | { kind: "scheduling" }
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
  filename: string;
  mimeType: string;
  dataBase64: string;
  previewUrl: string;
};

type Score = {
  hook: number; readability: number; virality: number;
  professionalTone: number; cta: number; overall: number; notes: string;
};

type DraftRow = {
  id: string;
  topic: string;
  style: string;
  target_chars: number;
  content: string;
  image_filename: string | null;
  status: string;
  scheduled_for: string | null;
  published_at: string | null;
  post_id: string | null;
  error_message: string | null;
  updated_at: string;
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TRUNCATION_LIMIT = 210;
const MAX_POST_CHARS = 3000;

async function fileToPendingImage(file: File): Promise<PendingImage> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return {
    filename: file.name,
    mimeType: file.type || "image/jpeg",
    dataBase64: btoa(binary),
    previewUrl: URL.createObjectURL(file),
  };
}

function base64ToPreviewUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function markdownBoldToUnicode(input: string): string {
  const boldChar = (ch: string): string => {
    const code = ch.codePointAt(0)!;
    if (code >= 0x41 && code <= 0x5a) return String.fromCodePoint(0x1d5d4 + (code - 0x41));
    if (code >= 0x61 && code <= 0x7a) return String.fromCodePoint(0x1d5ee + (code - 0x61));
    if (code >= 0x30 && code <= 0x39) return String.fromCodePoint(0x1d7ec + (code - 0x30));
    return ch;
  };
  return input.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) =>
    Array.from(inner).map(boldChar).join(""));
}

function autoFormat(text: string): string {
  let t = markdownBoldToUnicode(text);
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n");
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

function Studio() {
  const [userLabel, setUserLabel] = useState<string>("");
  const [voiceNotes, setVoiceNotes] = useState("");
  const [voiceOpen, setVoiceOpen] = useState(false);

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
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [sidePanel, setSidePanel] = useState<"preview" | "drafts" | "calendar">("preview");
  const [scheduleAt, setScheduleAt] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = status.kind !== "idle" && status.kind !== "ready" && status.kind !== "success" && status.kind !== "error";

  useEffect(() => {
    getSessionUser().then((u) => setUserLabel(u?.name || u?.email || "")).catch(() => {});
    getProfile().then((p) => setVoiceNotes(p.voice_notes ?? "")).catch(() => {});
    refreshDrafts();
  }, []);

  const refreshDrafts = () => {
    listDrafts().then((r) => setDrafts(r.drafts as DraftRow[])).catch(() => {});
  };

  const charCount = post.length;
  const overFold = charCount > TRUNCATION_LIMIT;
  const overMax = charCount > MAX_POST_CHARS;
  const overTarget = charCount > targetChars;

  const onSignOut = () => {
    window.location.href = "/api/public/linkedin/logout";
  };

  const saveVoice = async () => {
    await updateProfile({ data: { voice_notes: voiceNotes } });
    setVoiceOpen(false);
  };

  const onGenerate = async (hookOverride?: string) => {
    if (!topic.trim()) return;
    setStatus({ kind: "generating" });
    setScore(null);
    try {
      const res = await generatePostVariants({
        data: { topic: topic.trim(), style, targetChars, hookOverride, voiceNotes },
      });
      const trimmed = res.variants.map((v) => trimToMax(v, targetChars));
      setVariants(trimmed);
      setSelectedVariant(0);
      setPost(trimmed[0] ?? "");
      setCompanies(res.companies);
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed" });
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
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed" });
    }
  };

  const onScore = async () => {
    if (!post.trim()) return;
    setStatus({ kind: "scoring" });
    try {
      setScore(await scorePost({ data: { text: post } }));
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed" });
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
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed" });
    }
  };

  const selectVariant = (idx: number) => { setSelectedVariant(idx); setPost(variants[idx] ?? ""); setScore(null); };

  const buildDraftPayload = () => ({
    id: currentDraftId ?? undefined,
    topic,
    style,
    target_chars: targetChars,
    content: post,
    image_data_base64: image?.dataBase64 ?? null,
    image_mime: image?.mimeType ?? null,
    image_filename: image?.filename ?? null,
  });

  const onSaveDraft = async () => {
    if (!post.trim() && !topic.trim()) return;
    setStatus({ kind: "saving" });
    try {
      const res = await upsertDraft({ data: buildDraftPayload() });
      setCurrentDraftId(res.id);
      refreshDrafts();
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Save failed" });
    }
  };

  const onSchedule = async () => {
    if (!post.trim() || !scheduleAt) return;
    setStatus({ kind: "scheduling" });
    try {
      const iso = new Date(scheduleAt).toISOString();
      const res = await scheduleDraft({ data: { ...buildDraftPayload(), scheduled_for: iso } });
      setCurrentDraftId(res.id);
      setScheduleAt("");
      refreshDrafts();
      setStatus({ kind: "success" });
      setSidePanel("calendar");
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Schedule failed" });
    }
  };

  const onPublish = async () => {
    if (!post.trim()) return;
    const formatted = autoFormat(post);
    if (formatted.length > MAX_POST_CHARS) {
      setStatus({ kind: "error", message: `Post exceeds ${MAX_POST_CHARS} characters.` });
      return;
    }
    setPost(formatted);
    setStatus({ kind: "publishing" });
    try {
      // Save first so we can track it in drafts
      const saved = await upsertDraft({ data: { ...buildDraftPayload(), content: formatted } });
      const result = await publishPost({
        data: {
          text: formatted,
          images: image ? [{ filename: image.filename, mimeType: image.mimeType, dataBase64: image.dataBase64 }] : [],
          draftId: saved.id,
        },
      });
      setCurrentDraftId(saved.id);
      refreshDrafts();
      setStatus({ kind: "success", postId: result.postId });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Publish failed" });
    }
  };

  const openDraft = (d: DraftRow) => {
    setCurrentDraftId(d.id);
    setTopic(d.topic);
    setStyle((d.style as WritingStyle) || "professional");
    setTargetChars(d.target_chars);
    setPost(d.content);
    setVariants([]);
    setHooks([]);
    setScore(null);
    if (image) URL.revokeObjectURL(image.previewUrl);
    setImage(null);
    setStatus({ kind: "ready" });
  };

  const onDeleteDraft = async (id: string) => {
    await deleteDraft({ data: { id } });
    if (currentDraftId === id) setCurrentDraftId(null);
    refreshDrafts();
  };

  const onCancelSchedule = async (id: string) => {
    await cancelSchedule({ data: { id } });
    refreshDrafts();
  };

  const onNewDraft = () => {
    setCurrentDraftId(null);
    setTopic(""); setPost(""); setVariants([]); setHooks([]); setScore(null);
    if (image) URL.revokeObjectURL(image.previewUrl);
    setImage(null);
    setStatus({ kind: "idle" });
  };

  const onImageSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!/^image\/(png|jpeg|jpg|gif|webp)$/.test(file.type)) {
      setStatus({ kind: "error", message: `${file.name}: unsupported type` }); return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus({ kind: "error", message: `${file.name}: over 8 MB` }); return;
    }
    const added = await fileToPendingImage(file);
    if (image) URL.revokeObjectURL(image.previewUrl);
    setImage(added);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeImage = () => { if (image) URL.revokeObjectURL(image.previewUrl); setImage(null); };

  const onGenerateImage = async () => {
    if (!topic.trim()) { setStatus({ kind: "error", message: "Enter a topic first." }); return; }
    setStatus({ kind: "generating-image" });
    try {
      const res = await generateImage({ data: { topic: topic.trim(), style: imageStyle } });
      if (image) URL.revokeObjectURL(image.previewUrl);
      setImage({
        filename: res.filename, mimeType: res.mimeType, dataBase64: res.dataBase64,
        previewUrl: base64ToPreviewUrl(res.dataBase64, res.mimeType),
      });
      setStatus(post.trim() ? { kind: "ready" } : { kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed" });
    }
  };

  const formattedPreview = useMemo(() => autoFormat(post), [post]);

  const scheduledDrafts = drafts.filter((d) => d.status === "scheduled");
  const savedDrafts = drafts.filter((d) => d.status === "draft");
  const publishedDrafts = drafts.filter((d) => d.status === "published" || d.status === "failed");

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <div className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3 text-xs">
          <p className="font-serif text-base font-semibold">LinkedIn Auto Poster</p>
          <div className="flex items-center gap-4">
            <button onClick={() => setVoiceOpen(true)} className="uppercase tracking-widest text-muted-foreground hover:text-accent">
              Voice
            </button>
            <button onClick={onNewDraft} className="uppercase tracking-widest text-muted-foreground hover:text-accent">
              New
            </button>
            <span className="hidden text-muted-foreground sm:inline">{userLabel}</span>
            <button onClick={onSignOut} className="uppercase tracking-widest text-muted-foreground hover:text-accent">
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* MAIN */}
          <section className="space-y-8">
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="topic">Topic</Label>
                <input
                  id="topic" type="text" value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. what changed with GPT-5.6 for engineering teams"
                  disabled={busy}
                  className="w-full border-b border-border bg-transparent px-0 py-3 text-base placeholder:text-muted-foreground focus:border-accent focus:outline-none disabled:opacity-50"
                  onKeyDown={(e) => { if (e.key === "Enter") onGenerate(); }}
                />
                {companies.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Detected: <span className="text-foreground">{companies.map((c) => `@${c}`).join(" · ")}</span>
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="style">Writing Style</Label>
                <select
                  id="style" value={style}
                  onChange={(e) => setStyle(e.target.value as WritingStyle)}
                  disabled={busy}
                  className="w-full border-b border-border bg-transparent px-0 py-3 text-base focus:border-accent focus:outline-none disabled:opacity-50"
                >
                  {STYLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>

              <div>
                <Label>Post Length</Label>
                <div className="mt-3 flex flex-wrap gap-2">
                  {LENGTH_PRESETS.map((n) => (
                    <button key={n} type="button" onClick={() => setTargetChars(n)} disabled={busy}
                      className={`px-3 py-1.5 text-xs uppercase tracking-widest border ${
                        targetChars === n ? "bg-foreground text-background border-foreground"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground"
                      }`}>{n}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button onClick={() => onGenerate()} disabled={busy || !topic.trim()}
                className="bg-primary px-6 py-3 text-sm font-medium uppercase tracking-widest text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
                {status.kind === "generating" ? "Generating 3 drafts…" : "Generate 3 drafts"}
              </button>
              <button onClick={onSuggestHooks} disabled={busy || !topic.trim()}
                className="border border-border px-4 py-3 text-xs font-medium uppercase tracking-widest hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40">
                {status.kind === "generating-hooks" ? "Finding hooks…" : "Suggest hooks"}
              </button>
            </div>

            {hooks.length > 0 && (
              <div className="border border-border p-4">
                <p className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Pick a hook</p>
                <ul className="space-y-2">
                  {hooks.map((h, i) => (
                    <li key={i}>
                      <button type="button" onClick={() => onGenerate(h)} disabled={busy}
                        className="w-full text-left text-sm hover:text-accent">
                        <span className="mr-2 text-muted-foreground">{i + 1}.</span>{h}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {variants.length > 0 && (
              <div>
                <p className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Versions</p>
                <div className="grid grid-cols-3 gap-2">
                  {variants.map((_, i) => (
                    <button key={i} type="button" onClick={() => selectVariant(i)} disabled={busy}
                      className={`border px-3 py-2 text-xs uppercase tracking-widest ${
                        selectedVariant === i ? "bg-foreground text-background border-foreground"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground"
                      }`}>Version {String.fromCharCode(65 + i)}</button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <Label htmlFor="post">Draft {currentDraftId && <span className="normal-case tracking-normal text-muted-foreground/70">· saved</span>}</Label>
              <textarea
                id="post" value={post}
                onChange={(e) => { setPost(e.target.value); setScore(null); }}
                placeholder="Generate drafts, or write directly here."
                disabled={busy} rows={14}
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

            {post.trim() && (
              <div className="border border-border p-4">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground">One-click rewrites</p>
                  <button type="button" onClick={onScore} disabled={busy}
                    className="text-xs uppercase tracking-widest text-muted-foreground hover:text-accent">
                    {status.kind === "scoring" ? "Scoring…" : score ? "Rescore" : "Score post"}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s.value} type="button" onClick={() => onSuggestion(s.value)} disabled={busy}
                      className="border border-border px-3 py-1.5 text-xs uppercase tracking-widest hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40">
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
                    {score.notes && <p className="col-span-3 text-muted-foreground sm:col-span-6">{score.notes}</p>}
                  </div>
                )}
              </div>
            )}

            {/* Image */}
            <div className="border-t border-border pt-8">
              <Label>Image <span className="normal-case tracking-normal text-muted-foreground/70">(optional)</span></Label>
              <div className="mt-3 inline-flex border border-border">
                {(["ai", "upload"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setImageMode(m)} disabled={busy}
                    className={`px-4 py-2 text-xs uppercase tracking-widest ${
                      imageMode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                    }`}>{m === "ai" ? "Generate with AI" : "Upload"}</button>
                ))}
              </div>

              {imageMode === "ai" && (
                <div className="mt-4">
                  <p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Style</p>
                  <div className="flex flex-wrap gap-2">
                    {IMAGE_STYLE_OPTIONS.map((o) => (
                      <button key={o.value} type="button" onClick={() => setImageStyle(o.value)} disabled={busy}
                        className={`px-3 py-1.5 text-xs uppercase tracking-widest border ${
                          imageStyle === o.value ? "bg-foreground text-background border-foreground"
                            : "border-border text-muted-foreground hover:text-foreground"
                        }`}>{o.label}</button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-start gap-4">
                {image && (
                  <div className="relative h-32 w-32 overflow-hidden border border-border">
                    <img src={image.previewUrl} alt={image.filename} className="h-full w-full object-cover" />
                    <button type="button" onClick={removeImage} disabled={busy} aria-label="Remove image"
                      className="absolute right-0 top-0 bg-background/90 px-2 py-0.5 text-xs hover:text-accent">×</button>
                  </div>
                )}
                {imageMode === "ai" ? (
                  <button type="button" onClick={onGenerateImage} disabled={busy || !topic.trim()}
                    className="border border-border px-4 py-3 text-xs font-medium uppercase tracking-widest hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40">
                    {status.kind === "generating-image" ? "Generating image…" : image ? "Regenerate image" : "Generate image"}
                  </button>
                ) : (
                  <label className={`flex cursor-pointer items-center border border-dashed border-border px-4 py-3 text-xs font-medium uppercase tracking-widest text-muted-foreground hover:border-accent hover:text-accent ${busy ? "pointer-events-none opacity-50" : ""}`}>
                    {image ? "Replace image" : "Choose file"}
                    <input ref={fileInputRef} type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      className="hidden"
                      onChange={(e) => onImageSelected(e.target.files)}
                      disabled={busy}/>
                  </label>
                )}
              </div>
            </div>

            {/* Publish / Schedule / Save */}
            <div className="space-y-4 border-t border-border pt-6">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label htmlFor="sched">Schedule for</Label>
                  <input
                    id="sched" type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    disabled={busy}
                    className="border border-border bg-transparent px-3 py-2 text-sm focus:border-accent focus:outline-none"
                  />
                </div>
                <button onClick={onSchedule} disabled={busy || !post.trim() || !scheduleAt || overMax}
                  className="border border-border px-4 py-3 text-xs font-medium uppercase tracking-widest hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40">
                  {status.kind === "scheduling" ? "Scheduling…" : "Schedule"}
                </button>
                <button onClick={onSaveDraft} disabled={busy || (!post.trim() && !topic.trim())}
                  className="border border-border px-4 py-3 text-xs font-medium uppercase tracking-widest hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40">
                  {status.kind === "saving" ? "Saving…" : "Save draft"}
                </button>
                <button onClick={onPublish} disabled={busy || !post.trim() || overMax}
                  className="ml-auto whitespace-nowrap bg-accent px-6 py-3 text-sm font-medium uppercase tracking-widest text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
                  {status.kind === "publishing" ? "Publishing…" : "Publish now"}
                </button>
              </div>
              <StatusLine status={status} />
            </div>
          </section>

          {/* SIDE PANEL */}
          <aside className="lg:sticky lg:top-8 lg:self-start">
            <div className="mb-3 inline-flex border border-border text-xs">
              {(["preview", "drafts", "calendar"] as const).map((m) => (
                <button key={m} onClick={() => setSidePanel(m)}
                  className={`px-3 py-1 uppercase tracking-widest ${
                    sidePanel === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                  }`}>{m === "calendar" ? `Scheduled${scheduledDrafts.length ? ` · ${scheduledDrafts.length}` : ""}` : m}</button>
              ))}
            </div>

            {sidePanel === "preview" && (
              <div>
                <div className="mb-3 flex justify-end">
                  <div className="inline-flex border border-border text-[10px]">
                    {(["desktop", "mobile"] as const).map((m) => (
                      <button key={m} onClick={() => setPreviewMode(m)}
                        className={`px-3 py-1 uppercase tracking-widest ${
                          previewMode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                        }`}>{m}</button>
                    ))}
                  </div>
                </div>
                <LinkedInPreview text={formattedPreview} imageUrl={image?.previewUrl ?? null} mode={previewMode} />
              </div>
            )}

            {sidePanel === "drafts" && (
              <div className="space-y-3">
                {savedDrafts.length === 0 && <p className="text-xs text-muted-foreground">No saved drafts yet.</p>}
                {savedDrafts.map((d) => (
                  <DraftCard key={d.id} draft={d} active={d.id === currentDraftId}
                    onOpen={() => openDraft(d)} onDelete={() => onDeleteDraft(d.id)} />
                ))}
                {publishedDrafts.length > 0 && (
                  <>
                    <p className="pt-4 text-[10px] uppercase tracking-widest text-muted-foreground">History</p>
                    {publishedDrafts.map((d) => (
                      <DraftCard key={d.id} draft={d} active={d.id === currentDraftId}
                        onOpen={() => openDraft(d)} onDelete={() => onDeleteDraft(d.id)} />
                    ))}
                  </>
                )}
              </div>
            )}

            {sidePanel === "calendar" && (
              <div className="space-y-3">
                {scheduledDrafts.length === 0 && <p className="text-xs text-muted-foreground">Nothing scheduled. Pick a date and click Schedule.</p>}
                {scheduledDrafts
                  .slice()
                  .sort((a, b) => (a.scheduled_for ?? "").localeCompare(b.scheduled_for ?? ""))
                  .map((d) => (
                    <div key={d.id} className="border border-border p-3">
                      <p className="text-[10px] uppercase tracking-widest text-accent">
                        {d.scheduled_for ? new Date(d.scheduled_for).toLocaleString() : "—"}
                      </p>
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed">
                        {d.content.slice(0, 200)}
                      </p>
                      <div className="mt-2 flex gap-3 text-[10px] uppercase tracking-widest">
                        <button onClick={() => openDraft(d)} className="text-muted-foreground hover:text-accent">Open</button>
                        <button onClick={() => onCancelSchedule(d.id)} className="text-muted-foreground hover:text-destructive">Cancel</button>
                      </div>
                    </div>
                  ))}
                <p className="pt-2 text-[10px] text-muted-foreground">Scheduler runs every minute.</p>
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* Voice notes modal */}
      {voiceOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4"
          onClick={() => setVoiceOpen(false)}>
          <div className="w-full max-w-lg border border-border bg-card p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-serif text-2xl">Your writing voice</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Describe how you write. The AI matches this style on every post.
            </p>
            <textarea
              value={voiceNotes}
              onChange={(e) => setVoiceNotes(e.target.value)}
              rows={8}
              maxLength={2000}
              placeholder="e.g. Educational, conversational, technical. I rarely use emojis. I prefer clean formatting, short paragraphs, and concrete examples over abstract advice."
              className="mt-4 w-full border border-border bg-transparent p-3 text-sm focus:border-accent focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-2 text-xs uppercase tracking-widest">
              <button onClick={() => setVoiceOpen(false)} className="px-4 py-2 text-muted-foreground hover:text-foreground">Cancel</button>
              <button onClick={saveVoice} className="bg-accent px-4 py-2 text-accent-foreground hover:opacity-90">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DraftCard({ draft, active, onOpen, onDelete }: {
  draft: DraftRow; active: boolean; onOpen: () => void; onDelete: () => void;
}) {
  return (
    <div className={`border p-3 ${active ? "border-accent" : "border-border"}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-1 flex-1 text-xs font-medium">{draft.topic || "Untitled"}</p>
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {draft.status === "published" ? "Sent" : draft.status === "failed" ? "Failed" : ""}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
        {draft.content.slice(0, 140) || "—"}
      </p>
      {draft.error_message && <p className="mt-1 text-xs text-destructive">{draft.error_message}</p>}
      <div className="mt-2 flex gap-3 text-[10px] uppercase tracking-widest">
        <button onClick={onOpen} className="text-muted-foreground hover:text-accent">Open</button>
        <button onClick={onDelete} className="text-muted-foreground hover:text-destructive">Delete</button>
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
  if (status.kind === "idle") return <p className="text-sm text-muted-foreground">Ready.</p>;
  if (status.kind === "error") return <p className="text-sm text-destructive break-words">Error: {status.message}</p>;
  if (status.kind === "success") return (
    <p className="text-sm"><span className="text-accent">●</span> {status.postId ? `Published · ${status.postId}` : "Done"}</p>
  );
  if (status.kind === "ready") return <p className="text-sm"><span className="text-accent">●</span> Ready to publish</p>;
  const labels: Record<string, string> = {
    generating: "Generating 3 drafts…",
    "generating-hooks": "Finding hooks…",
    "generating-image": "Generating image…",
    scoring: "Scoring…",
    rewriting: "Rewriting…",
    saving: "Saving draft…",
    scheduling: "Scheduling…",
    publishing: "Publishing to LinkedIn…",
  };
  return <p className="text-sm text-muted-foreground">{labels[status.kind]}</p>;
}