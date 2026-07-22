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
  listKnowledge,
  upsertKnowledge,
  deleteKnowledge,
  suggestTopicsFromKnowledge,
  extractKnowledgeFromFile,
} from "@/lib/knowledge.functions";
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
  | { kind: "suggesting-from-kb" }
  | { kind: "searching-images" }
  | { kind: "fetching-image" }
  | { kind: "extracting-file" }
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

type KnowledgeEntry = {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
};

function Studio() {
  const [userLabel, setUserLabel] = useState<string>("");
  const [voiceNotes, setVoiceNotes] = useState("");
  const [voiceOpen, setVoiceOpen] = useState(false);

  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([]);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [kbEditingId, setKbEditingId] = useState<string | null>(null);
  const [kbTitle, setKbTitle] = useState("");
  const [kbContent, setKbContent] = useState("");

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
  const [imageMode, setImageMode] = useState<"search" | "upload">("search");
  const [imageQuery, setImageQuery] = useState("");
  const [imageResults, setImageResults] = useState<Array<{
    id: string; title: string; url: string; thumbnail: string; creator: string; source: string; license: string; landing: string;
  }>>([]);
  const [ideas, setIdeas] = useState<string[]>([]);
  const [customInstructions, setCustomInstructions] = useState("");
  const [brainstormOpen, setBrainstormOpen] = useState(false);
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
    refreshKnowledge();
    refreshDrafts();
  }, []);

  const refreshDrafts = () => {
    listDrafts().then((r) => setDrafts(r.drafts as DraftRow[])).catch(() => {});
  };

  const refreshKnowledge = () => {
    listKnowledge().then((r) => setKnowledge(r.entries as KnowledgeEntry[])).catch(() => {});
  };

  const resetKbForm = () => { setKbEditingId(null); setKbTitle(""); setKbContent(""); };

  const onSaveKnowledge = async () => {
    if (!kbContent.trim()) return;
    try {
      await upsertKnowledge({ data: { id: kbEditingId ?? undefined, title: kbTitle.trim(), content: kbContent.trim() } });
      resetKbForm();
      refreshKnowledge();
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Save failed" });
    }
  };

  const onEditKnowledge = (k: KnowledgeEntry) => {
    setKbEditingId(k.id); setKbTitle(k.title); setKbContent(k.content);
  };

  const onDeleteKnowledge = async (id: string) => {
    await deleteKnowledge({ data: { id } });
    if (kbEditingId === id) resetKbForm();
    refreshKnowledge();
  };

  const onKnowledgeFileSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.size > 20 * 1024 * 1024) {
      setStatus({ kind: "error", message: `${file.name}: over 20 MB` });
      return;
    }
    setStatus({ kind: "extracting-file" });
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.byteLength; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const dataBase64 = btoa(binary);
      const res = await extractKnowledgeFromFile({
        data: { filename: file.name, mimeType: file.type || "application/octet-stream", dataBase64 },
      });
      const separator = kbContent.trim() ? "\n\n" : "";
      setKbContent((prev) => prev + separator + res.content);
      if (!kbTitle.trim()) setKbTitle(res.title);
      setStatus({ kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Extraction failed" });
    }
  };

  const onSuggestFromKnowledge = async () => {
    setStatus({ kind: "suggesting-from-kb" });
    try {
      const res = await suggestTopicsFromKnowledge({ data: { focus: customInstructions || undefined } });
      setIdeas(res.ideas);
      setBrainstormOpen(true);
      setKnowledgeOpen(false);
      setStatus(post.trim() ? { kind: "ready" } : { kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed" });
    }
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
        data: { topic: topic.trim(), style, targetChars, hookOverride, voiceNotes, customInstructions: customInstructions || undefined },
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

  const onSearchImages = async () => {
    const q = (imageQuery || topic).trim();
    if (!q) { setStatus({ kind: "error", message: "Enter a search query or topic." }); return; }
    setStatus({ kind: "searching-images" });
    try {
      const res = await searchImages({ data: { query: q, page: 1 } });
      setImageResults(res.results);
      setStatus(post.trim() ? { kind: "ready" } : { kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Failed" });
    }
  };

  const onChooseWebImage = async (r: { url: string; title: string; thumbnail: string }) => {
    setStatus({ kind: "fetching-image" });
    try {
      // Try full URL first; if it fails, fall back to thumbnail.
      let res;
      try {
        res = await fetchImageAsBase64({ data: { url: r.url, filename: (r.title || "web-image").slice(0, 60) } });
      } catch {
        res = await fetchImageAsBase64({ data: { url: r.thumbnail, filename: (r.title || "web-image").slice(0, 60) } });
      }
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

  const onBrainstorm = async () => {
    const seed = (topic || customInstructions).trim();
    if (!seed) { setStatus({ kind: "error", message: "Type a niche, seed, or question first." }); return; }
    setStatus({ kind: "brainstorming" });
    try {
      const res = await brainstormTopics({ data: { seed, style, voiceNotes } });
      setIdeas(res.ideas);
      setBrainstormOpen(true);
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
    <div className="min-h-screen text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-40 glass-strong border-b border-border/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl gradient-viral font-bold text-white shadow-lg shadow-primary/30">L</span>
            <div className="min-w-0">
              <p className="truncate font-serif text-base font-bold tracking-tight">
                LinkedIn <span className="text-gradient">Auto Poster</span>
              </p>
              <p className="hidden text-[10px] uppercase tracking-widest text-muted-foreground sm:block">AI content studio</p>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 text-xs">
            <button onClick={() => setVoiceOpen(true)} className="rounded-lg px-3 py-1.5 font-medium text-muted-foreground transition hover:bg-white/5 hover:text-foreground">
              Voice
            </button>
            <button onClick={() => setKnowledgeOpen(true)} className="rounded-lg px-3 py-1.5 font-medium text-muted-foreground transition hover:bg-white/5 hover:text-foreground">
              Knowledge{knowledge.length ? <span className="ml-1 rounded-full gradient-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">{knowledge.length}</span> : ""}
            </button>
            <button onClick={onNewDraft} className="rounded-lg px-3 py-1.5 font-medium text-muted-foreground transition hover:bg-white/5 hover:text-foreground">
              + New
            </button>
            <span className="hidden max-w-[140px] truncate text-muted-foreground md:inline">{userLabel}</span>
            <button onClick={onSignOut} className="rounded-lg border border-border/60 px-3 py-1.5 font-medium text-muted-foreground transition hover:border-destructive/60 hover:text-destructive">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* MAIN */}
          <section className="space-y-8">
            <div className="glass rounded-3xl p-6 sm:p-8">
              <div className="mb-6 flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">Studio</p>
              </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="topic">Topic</Label>
                <input
                  id="topic" type="text" value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. what changed with GPT-5.6 for engineering teams"
                  disabled={busy}
                  className="w-full rounded-xl border border-border bg-background/40 px-4 py-3 text-base placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                  onKeyDown={(e) => { if (e.key === "Enter") onGenerate(); }}
                />
                {companies.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Detected: <span className="text-gradient font-medium">{companies.map((c) => `@${c}`).join(" · ")}</span>
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="style">Writing Style</Label>
                <select
                  id="style" value={style}
                  onChange={(e) => setStyle(e.target.value as WritingStyle)}
                  disabled={busy}
                  className="w-full rounded-xl border border-border bg-background/40 px-4 py-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                >
                  {STYLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>

              <div>
                <Label>Post Length</Label>
                <div className="mt-3 flex flex-wrap gap-2">
                  {LENGTH_PRESETS.map((n) => (
                    <button key={n} type="button" onClick={() => setTargetChars(n)} disabled={busy}
                      className={`rounded-full px-3.5 py-1.5 text-xs font-semibold uppercase tracking-widest transition ${
                        targetChars === n ? "gradient-primary text-primary-foreground shadow-md shadow-primary/30"
                          : "border border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      }`}>{n}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6">
              <Label htmlFor="instructions">Custom Prompt <span className="normal-case tracking-normal text-muted-foreground/70">(optional — extra instructions the AI must follow)</span></Label>
              <textarea
                id="instructions" value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="e.g. Include a real example from fintech. Avoid buzzwords. End with a question about hiring."
                disabled={busy} rows={3}
                className="w-full resize-y rounded-xl border border-border bg-background/40 p-3 text-sm placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
              />
            </div>

            <div className="mt-6 flex flex-wrap gap-2 sm:gap-3">
              <button onClick={() => onGenerate()} disabled={busy || !topic.trim()}
                className="gradient-primary glow-primary rounded-xl px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none">
                {status.kind === "generating" ? "✨ Generating 3 drafts…" : "✨ Generate 3 drafts"}
              </button>
              <button onClick={onBrainstorm} disabled={busy || (!topic.trim() && !customInstructions.trim())}
                className="rounded-xl border border-border bg-white/5 px-4 py-3 text-xs font-semibold uppercase tracking-widest transition hover:border-primary/60 hover:bg-white/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40">
                {status.kind === "brainstorming" ? "Brainstorming…" : "💡 Brainstorm"}
              </button>
              <button onClick={onSuggestFromKnowledge} disabled={busy || knowledge.length === 0}
                title={knowledge.length === 0 ? "Add notes in Knowledge first" : "Suggest topics grounded in your knowledge base"}
                className="rounded-xl border border-border bg-white/5 px-4 py-3 text-xs font-semibold uppercase tracking-widest transition hover:border-primary/60 hover:bg-white/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40">
                {status.kind === "suggesting-from-kb" ? "Reading notes…" : `📚 From Knowledge${knowledge.length ? ` · ${knowledge.length}` : ""}`}
              </button>
              <button onClick={onSuggestHooks} disabled={busy || !topic.trim()}
                className="rounded-xl border border-border bg-white/5 px-4 py-3 text-xs font-semibold uppercase tracking-widest transition hover:border-primary/60 hover:bg-white/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40">
                {status.kind === "generating-hooks" ? "Finding hooks…" : "🎣 Hooks"}
              </button>
            </div>
            </div>

            {brainstormOpen && ideas.length > 0 && (
              <div className="glass rounded-2xl p-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-gradient">💡 Idea board</p>
                  <div className="flex gap-3 text-[10px] uppercase tracking-widest">
                    <button onClick={onBrainstorm} disabled={busy} className="text-muted-foreground hover:text-primary">Regenerate</button>
                    <button onClick={() => setBrainstormOpen(false)} className="text-muted-foreground hover:text-foreground">Close</button>
                  </div>
                </div>
                <ul className="space-y-2">
                  {ideas.map((idea, i) => (
                    <li key={i} className="flex items-start gap-3 rounded-lg p-2 transition hover:bg-white/5">
                      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full gradient-primary text-[10px] font-bold text-primary-foreground">{i + 1}</span>
                      <button type="button" onClick={() => { setTopic(idea); setBrainstormOpen(false); }} disabled={busy}
                        className="flex-1 text-left text-sm hover:text-foreground">
                        {idea}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {hooks.length > 0 && (
              <div className="glass rounded-2xl p-5">
                <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-gradient">🎣 Pick a hook</p>
                <ul className="space-y-2">
                  {hooks.map((h, i) => (
                    <li key={i}>
                      <button type="button" onClick={() => onGenerate(h)} disabled={busy}
                        className="w-full rounded-lg p-2 text-left text-sm transition hover:bg-white/5">
                        <span className="mr-2 inline-grid h-5 w-5 place-items-center rounded-full gradient-primary text-[10px] font-bold text-primary-foreground">{i + 1}</span>{h}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {variants.length > 0 && (
              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Versions</p>
                <div className="grid grid-cols-3 gap-2">
                  {variants.map((_, i) => (
                    <button key={i} type="button" onClick={() => selectVariant(i)} disabled={busy}
                      className={`rounded-xl px-3 py-2.5 text-xs font-semibold uppercase tracking-widest transition ${
                        selectedVariant === i ? "gradient-primary text-primary-foreground shadow-md shadow-primary/30"
                          : "border border-border bg-white/5 text-muted-foreground hover:border-primary/60 hover:text-foreground"
                      }`}>Version {String.fromCharCode(65 + i)}</button>
                  ))}
                </div>
              </div>
            )}

            <div className="glass rounded-3xl p-5 sm:p-6">
              <Label htmlFor="post">Draft {currentDraftId && <span className="normal-case tracking-normal text-primary">· saved</span>}</Label>
              <textarea
                id="post" value={post}
                onChange={(e) => { setPost(e.target.value); setScore(null); }}
                placeholder="Generate drafts, or write directly here."
                disabled={busy} rows={14}
                className="w-full resize-y rounded-2xl border border-border bg-background/50 p-4 text-base leading-relaxed placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                style={{ whiteSpace: "pre-wrap" }}
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
                <span className={overFold ? "font-medium text-accent" : "text-muted-foreground"}>
                  {overFold
                    ? `⚠ ${charCount - TRUNCATION_LIMIT} chars past the "see more" fold`
                    : `${TRUNCATION_LIMIT - charCount} chars until "see more" fold`}
                </span>
                <span className={overMax ? "font-semibold text-destructive" : overTarget ? "font-medium text-accent" : "text-muted-foreground"}>
                  {charCount} / {targetChars}
                  {overMax ? ` · over ${MAX_POST_CHARS} hard limit` : ""}
                </span>
              </div>
            </div>

            {post.trim() && (
              <div className="glass rounded-2xl p-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-gradient">⚡ One-click rewrites</p>
                  <button type="button" onClick={onScore} disabled={busy}
                    className="rounded-lg border border-border px-3 py-1 text-xs font-semibold uppercase tracking-widest text-muted-foreground transition hover:border-primary/60 hover:text-foreground">
                    {status.kind === "scoring" ? "Scoring…" : score ? "↻ Rescore" : "★ Score post"}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s.value} type="button" onClick={() => onSuggestion(s.value)} disabled={busy}
                      className="rounded-full border border-border bg-white/5 px-3 py-1.5 text-xs font-medium transition hover:border-primary/60 hover:bg-white/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40">
                      {s.label}
                    </button>
                  ))}
                </div>
                {score && (
                  <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border/60 pt-5 text-xs sm:grid-cols-3 lg:grid-cols-6">
                    <ScoreCell label="Hook" v={score.hook} />
                    <ScoreCell label="Readability" v={score.readability} />
                    <ScoreCell label="Virality" v={score.virality} />
                    <ScoreCell label="Tone" v={score.professionalTone} />
                    <ScoreCell label="CTA" v={score.cta} />
                    <ScoreCell label="Overall" v={score.overall} bold />
                    {score.notes && <p className="col-span-2 rounded-lg bg-white/5 p-3 text-muted-foreground sm:col-span-3 lg:col-span-6">💬 {score.notes}</p>}
                  </div>
                )}
              </div>
            )}

            {/* Image */}
            <div className="glass rounded-2xl p-5">
              <Label>Image <span className="normal-case tracking-normal text-muted-foreground/70">(optional)</span></Label>
              <div className="mt-3 inline-flex rounded-xl border border-border bg-background/40 p-1">
                {(["search", "upload"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setImageMode(m)} disabled={busy}
                    className={`rounded-lg px-4 py-1.5 text-xs font-semibold uppercase tracking-widest transition ${
                      imageMode === m ? "gradient-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}>{m === "search" ? "🔍 Search web" : "⬆ Upload"}</button>
                ))}
              </div>

              {image && (
                <div className="mt-4 flex flex-wrap items-start gap-4">
                  <div className="relative h-32 w-32 overflow-hidden rounded-xl border border-border">
                    <img src={image.previewUrl} alt={image.filename} className="h-full w-full object-cover" />
                    <button type="button" onClick={removeImage} disabled={busy} aria-label="Remove image"
                      className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-background/90 text-xs hover:bg-destructive hover:text-destructive-foreground">×</button>
                  </div>
                  <p className="text-xs text-muted-foreground">Selected: <span className="text-foreground">{image.filename}</span></p>
                </div>
              )}

              {imageMode === "search" ? (
                <div className="mt-4 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <input type="text" value={imageQuery}
                      onChange={(e) => setImageQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSearchImages(); } }}
                      placeholder={topic ? `Search images (default: "${topic.slice(0, 40)}")` : "Search the web for images…"}
                      disabled={busy}
                      className="flex-1 min-w-[200px] rounded-xl border border-border bg-background/40 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50" />
                    <button type="button" onClick={onSearchImages} disabled={busy || (!imageQuery.trim() && !topic.trim())}
                      className="rounded-xl gradient-primary px-4 py-2 text-xs font-semibold uppercase tracking-widest text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
                      {status.kind === "searching-images" ? "Searching…" : "Search"}
                    </button>
                  </div>
                  {imageResults.length > 0 && (
                    <>
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Click an image to attach it. Results from Openverse (CC-licensed).</p>
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {imageResults.map((r) => (
                          <button key={r.id} type="button" onClick={() => onChooseWebImage(r)} disabled={busy}
                            title={r.title || "image"}
                            className="group relative aspect-square overflow-hidden rounded-xl border border-border transition hover:border-primary hover:shadow-lg hover:shadow-primary/30 disabled:cursor-not-allowed disabled:opacity-40">
                            <img
                              src={r.thumbnail}
                              alt={r.title || ""}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={(e) => {
                                const img = e.currentTarget;
                                if (img.dataset.fallback !== "1" && r.url && r.url !== r.thumbnail) {
                                  img.dataset.fallback = "1";
                                  img.src = r.url;
                                } else {
                                  img.style.display = "none";
                                }
                              }}
                              className="h-full w-full object-cover transition group-hover:opacity-80"
                            />
                          </button>
                        ))}
                      </div>
                      {status.kind === "fetching-image" && <p className="text-xs text-muted-foreground">Attaching image…</p>}
                    </>
                  )}
                  {status.kind === "searching-images" && (
                    <p className="text-xs text-muted-foreground">Searching images…</p>
                  )}
                  {imageResults.length === 0 && status.kind !== "searching-images" && (imageQuery.trim() || topic.trim()) && (
                    <p className="text-[11px] text-muted-foreground">No results yet. Type a query and press Search.</p>
                  )}
                </div>
              ) : (
                <div className="mt-4">
                  <label className={`flex cursor-pointer items-center border border-dashed border-border px-4 py-3 text-xs font-medium uppercase tracking-widest text-muted-foreground hover:border-accent hover:text-accent ${busy ? "pointer-events-none opacity-50" : ""}`}>
                    {image ? "Replace image" : "Choose file"}
                    <input ref={fileInputRef} type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      className="hidden"
                      onChange={(e) => onImageSelected(e.target.files)}
                      disabled={busy}/>
                  </label>
                </div>
              )}
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

      {/* Knowledge base modal */}
      {knowledgeOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/90 p-4"
          onClick={() => { setKnowledgeOpen(false); resetKbForm(); }}>
          <div className="my-8 w-full max-w-3xl border border-border bg-card p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-serif text-2xl">Your knowledge base</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save your expertise, projects, opinions, and lessons. The AI uses these notes to suggest topics you're uniquely qualified to write about.
                </p>
              </div>
              <button onClick={() => { setKnowledgeOpen(false); resetKbForm(); }}
                className="text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground">Close</button>
            </div>

            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <div className="space-y-3">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  {kbEditingId ? "Edit entry" : "Add new entry"}
                </p>
                <label className={`flex cursor-pointer items-center justify-center border border-dashed border-border px-4 py-3 text-xs font-medium uppercase tracking-widest text-muted-foreground hover:border-accent hover:text-accent ${status.kind === "extracting-file" ? "pointer-events-none opacity-50" : ""}`}>
                  {status.kind === "extracting-file" ? "Extracting…" : "Import file (image · PDF · DOCX · PPTX)"}
                  <input
                    type="file"
                    accept="image/*,application/pdf,.pdf,.docx,.pptx,.txt,.md,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                    className="hidden"
                    onChange={(e) => { onKnowledgeFileSelected(e.target.files); e.currentTarget.value = ""; }}
                    disabled={status.kind === "extracting-file"}
                  />
                </label>
                <p className="text-[10px] text-muted-foreground">Drop a slide deck, PDF, Word doc, or image — the AI extracts text into notes you can edit below.</p>
                <input type="text" value={kbTitle} onChange={(e) => setKbTitle(e.target.value)}
                  placeholder="Title (optional) — e.g. Lessons from scaling a fintech to 10M users"
                  maxLength={200}
                  className="w-full border border-border bg-transparent px-3 py-2 text-sm focus:border-accent focus:outline-none" />
                <textarea value={kbContent} onChange={(e) => setKbContent(e.target.value)}
                  rows={10} maxLength={20000}
                  placeholder="Paste notes, project details, opinions, frameworks, mistakes, industry observations… anything you might want to write a post about."
                  className="w-full resize-y border border-border bg-transparent p-3 text-sm focus:border-accent focus:outline-none" />
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">{kbContent.length} / 20000</span>
                  <div className="flex gap-2 uppercase tracking-widest">
                    {kbEditingId && (
                      <button onClick={resetKbForm} className="px-3 py-1.5 text-muted-foreground hover:text-foreground">Cancel</button>
                    )}
                    <button onClick={onSaveKnowledge} disabled={!kbContent.trim()}
                      className="bg-accent px-4 py-1.5 text-accent-foreground hover:opacity-90 disabled:opacity-40">
                      {kbEditingId ? "Update" : "Add"}
                    </button>
                  </div>
                </div>
                <button onClick={onSuggestFromKnowledge} disabled={busy || knowledge.length === 0}
                  className="mt-2 w-full border border-border px-4 py-2 text-xs font-medium uppercase tracking-widest hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40">
                  {status.kind === "suggesting-from-kb" ? "Reading your notes…" : "AI: suggest topics from my knowledge"}
                </button>
              </div>

              <div className="space-y-2 md:max-h-[70vh] md:overflow-y-auto">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  Saved entries · {knowledge.length}
                </p>
                {knowledge.length === 0 && (
                  <p className="text-xs text-muted-foreground">No entries yet. Add your first note on the left.</p>
                )}
                {knowledge.map((k) => (
                  <div key={k.id} className={`border p-3 ${kbEditingId === k.id ? "border-accent" : "border-border"}`}>
                    <p className="line-clamp-1 text-sm font-medium">{k.title || "Untitled"}</p>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{k.content}</p>
                    <div className="mt-2 flex gap-3 text-[10px] uppercase tracking-widest">
                      <button onClick={() => onEditKnowledge(k)} className="text-muted-foreground hover:text-accent">Edit</button>
                      <button onClick={() => onDeleteKnowledge(k.id)} className="text-muted-foreground hover:text-destructive">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
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
  const width = mode === "mobile" ? "w-[320px] max-w-full mx-auto text-[13px]" : "w-full";
  return (
    <div className={`${width} border border-border bg-card overflow-hidden`}>
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
    brainstorming: "Brainstorming ideas…",
    "suggesting-from-kb": "Reading your knowledge base…",
    "searching-images": "Searching images…",
    "fetching-image": "Attaching image…",
    "extracting-file": "Extracting file…",
    scoring: "Scoring…",
    rewriting: "Rewriting…",
    saving: "Saving draft…",
    scheduling: "Scheduling…",
    publishing: "Publishing to LinkedIn…",
  };
  return <p className="text-sm text-muted-foreground">{labels[status.kind]}</p>;
}