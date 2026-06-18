import {
  AlertCircle,
  CheckCircle2,
  CloudDownload,
  Copy,
  Download,
  Edit3,
  FileText,
  Images,
  LogOut,
  Redo2,
  RotateCcw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  ClipboardEvent,
  CSSProperties,
  Dispatch,
  Fragment,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { BorderBeam } from "border-beam";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Input, type InputProps } from "./components/ui/input";
import { api, AppConfig, GenerationJob, GenerationRecord, ImageItem, ProviderSettings, SettingsProviders } from "./api";
import { EntryField, EntryFormSection, EntryNoticeStack, EntryShell, EntryStatusScreen } from "./features/auth/EntryScreens";
import { GenerateMenuView, HoverImageActionBar, imagePreviewActionKeys, type HoverImageAction } from "./features/generate-menu/GenerateMenuView";
import { AppShell } from "./features/generate-shell/AppShell";
import { GenerationFormFooter, ParameterSection, PromptPlaceholderThumbnail, PromptSection } from "./features/shared/generation-form-sections";
import { GenerationDotMatrixLoader, generationDotMatrixColumns, generationDotMatrixRows } from "./features/shared/generation-loading";
import { CossBadge, CossButton, CossInput, CossSelect, CossSeparator } from "./features/shared/coss";
import { isTerminalGenerationJobStatus, mergePolledJobState } from "./generation-state";
import addIcon from "./assets/figma/add.svg";
import figmaLogo from "./assets/figma/logo.png";
import generationContinueIcon from "./assets/figma/generation-continue.svg";
import generationCopyIcon from "./assets/figma/generation-copy.svg";
import generationDownloadIcon from "./assets/figma/generation-download.svg";
import generationLocalEditIcon from "./assets/figma/generation-local-edit.svg";
import generationRegenerateIcon from "./assets/figma/generation-regenerate.svg";
import openaiIcon from "./assets/figma/openai.svg";
import referenceDeleteIcon from "./assets/figma/reference-delete.svg";
import { cn } from "./lib/utils";

type View = "generate" | "gallery" | "settings" | "inspiration";

interface MeState {
  space: { id: string; name: string };
  providerConfigured: boolean;
  dailyLimitExempt?: boolean;
  dailyRemaining?: number;
  dailyLimit?: number;
}

interface GalleryJumpTarget {
  conversationId: string;
  jobId: string;
}

interface GenerateForm {
  prompt: string;
  aspectRatio: string;
  resolution: string;
  width: number;
  height: number;
  quality: string;
  quantity: number;
  outputFormat: string;
  compression: number;
}

interface ReferenceImagePreview {
  file: File;
  url: string;
  name: string;
  compressed: boolean;
  originalByteSize?: number;
}

interface ImageSelectionMask {
  file: File;
  name: string;
}

interface ImageSelectionPoint {
  x: number;
  y: number;
}

interface ImageSelectionStroke {
  brushRatio: number;
  points: ImageSelectionPoint[];
}

type LoadGenerationRecords = (cursor?: string, options?: { background?: boolean }) => Promise<void>;

const FIGMA_RATIOS = ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1"] as const;
const RESOLUTIONS = ["1K", "2K", "4K"] as const;
const QUALITY_OPTIONS = ["auto", "low", "medium", "high"] as const;
const FORMAT_OPTIONS = ["png", "jpeg", "webp"] as const;
const IMAGE_MODEL_OPTIONS = ["gpt-image-2"] as const;
const PROMPT_OPTIMIZER_MODEL_OPTIONS = ["gpt-5.5", "gpt-5.4"] as const;
const REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 6;
const REFERENCE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FAST_REFERENCE_IMAGE_EDGE = 2048;
const PROMPT_TEXTAREA_MAX_HEIGHT = 400;
const MAX_IMAGE_EDGE = 3840;
const MAX_IMAGE_PIXELS = 8_294_400;

export function galleryImageActionKeys() {
  return imagePreviewActionKeys();
}

const resolutionLongEdge: Record<string, number> = {
  "1K": 1536,
  "2K": 2048,
  "4K": 3840,
};

const baseRatioSizes: Record<string, [number, number]> = {
  "16:9": [1536, 864],
  "9:16": [864, 1536],
  "4:3": [1536, 1152],
  "3:4": [1152, 1536],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "1:1": [1024, 1024],
};

const qualityLabels: Record<string, string> = {
  auto: "自动",
  low: "低",
  medium: "中",
  high: "高",
};

const formatLabels: Record<string, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WEBP",
};

const GENERATION_POLL_INTERVAL_MS = 2000;
const IMAGE_PREVIEW_VIEWPORT_GAP = 24;
const IMAGE_PREVIEW_IMAGE_INSET = 61;
const IMAGE_PREVIEW_EDITOR_WIDTH = 400;
const IMAGE_PREVIEW_MIN_STAGE_SIZE = 120;
const IMAGE_SELECTION_BRUSH_RATIO = 0.08;

const defaultForm: GenerateForm = {
  prompt: "",
  aspectRatio: "16:9",
  resolution: "1K",
  width: 1536,
  height: 864,
  quality: "auto",
  quantity: 1,
  outputFormat: "png",
  compression: 100,
};

const fallbackConfig: AppConfig = {
  model: "gpt-image-2",
  promptOptimizerModel: "gpt-5.5",
  maxImagesPerRequest: 4,
  maxDailyImagesPerSpace: 50,
  generationTimeoutSeconds: 600,
  ratios: [...FIGMA_RATIOS],
  qualities: ["auto", "low", "medium", "high"],
  formats: ["png", "jpeg", "webp"],
  turnstileSiteKey: "",
  turnstileRequired: false,
};

export function currentSpaceId(me: MeState | null): string | undefined {
  return me?.space?.id;
}

export function currentSpaceName(me: MeState | null): string | undefined {
  const name = me?.space?.name?.trim();
  return name || undefined;
}

export function shouldShowGenerateBooting(view: View, me: MeState | null, generationRecordsReady: boolean): boolean {
  return view === "generate" && Boolean(me && currentSpaceId(me)) && !generationRecordsReady;
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [me, setMe] = useState<MeState | null>(null);
  const [view, setView] = useState<View>("generate");
  const [imageToEdit, setImageToEdit] = useState<ImageItem | null>(null);
  const [imageEditDraft, setImageEditDraft] = useState<GenerateForm | null>(null);
  const [imageEditMask, setImageEditMask] = useState<ImageSelectionMask | null>(null);
  const [pendingGenerateForm, setPendingGenerateForm] = useState<GenerateForm | null>(null);
  const [generationRecords, setGenerationRecords] = useState<GenerationRecord[]>([]);
  const [generationRecordsError, setGenerationRecordsError] = useState("");
  const [generationNextCursor, setGenerationNextCursor] = useState<string | null>(null);
  const [generationRecordsReady, setGenerationRecordsReady] = useState(false);
  const [pendingGalleryJumpTarget, setPendingGalleryJumpTarget] = useState<GalleryJumpTarget | null>(null);
  const [booting, setBooting] = useState(true);

  const effectiveConfig = config ?? fallbackConfig;

  useEffect(() => {
    registerImageCacheServiceWorker();
  }, []);

  const loadGenerationRecords = useCallback<LoadGenerationRecords>(async (cursor) => {
    setGenerationRecordsError("");
    try {
      const path = cursor ? `/api/generations?cursor=${encodeURIComponent(cursor)}` : "/api/generations";
      const result = await api<{ ok: true; records: GenerationRecord[]; nextCursor: string | null }>(path);
      setGenerationRecords((current) => mergeGenerationRecordList(current, result.records, cursor ? "append" : "replace"));
      setGenerationNextCursor(result.nextCursor);
    } catch (err) {
      setGenerationRecordsError(err instanceof Error ? err.message : "生成记录加载失败。");
    } finally {
      if (!cursor) setGenerationRecordsReady(true);
    }
  }, []);

  const refreshMe = useCallback(async () => {
    const result = await api<{
      ok: true;
      space: MeState["space"];
      providerConfigured: boolean;
      dailyRemaining?: number;
      dailyLimit?: number;
    }>("/api/me");
    setMe({
      space: result.space,
      providerConfigured: result.providerConfigured,
      dailyRemaining: result.dailyRemaining,
      dailyLimit: result.dailyLimit,
    });
  }, []);
  const editImageFromGallery = useCallback((image: ImageItem, draft?: GenerateForm, mask?: ImageSelectionMask) => {
    setImageToEdit(image);
    setImageEditDraft(draft ?? null);
    setImageEditMask(mask ?? null);
    setView("generate");
  }, []);
  const clearImageToEdit = useCallback(() => {
    setImageToEdit(null);
    setImageEditDraft(null);
    setImageEditMask(null);
  }, []);
  const editPromptFromGallery = useCallback((draft: GenerateForm) => {
    setPendingGenerateForm(draft);
    setView("generate");
  }, []);
  const clearPendingGenerateForm = useCallback(() => {
    setPendingGenerateForm(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      api<{ ok: true; config: AppConfig }>("/api/config")
        .then((result) => result.config)
        .catch(() => fallbackConfig),
      api<{
        ok: true;
        space: MeState["space"];
        providerConfigured: boolean;
        dailyRemaining?: number;
        dailyLimit?: number;
      }>("/api/me").catch(() => null),
    ]).then(([appConfig, user]) => {
      if (!mounted) return;
      setConfig(appConfig);
      setMe(
        user
          ? {
              space: user.space,
              providerConfigured: user.providerConfigured,
              dailyRemaining: user.dailyRemaining,
              dailyLimit: user.dailyLimit,
            }
          : null,
      );
      setBooting(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!me) {
      setGenerationRecords([]);
      setGenerationNextCursor(null);
      setGenerationRecordsError("");
      setGenerationRecordsReady(false);
      return;
    }

    setGenerationRecords([]);
    setGenerationNextCursor(null);
    setGenerationRecordsReady(false);
    void loadGenerationRecords();
  }, [loadGenerationRecords, currentSpaceId(me)]);

  if (booting) {
    return <EntryStatusScreen label="正在打开创作台" detail="正在同步空间信息与创作台配置。" />;
  }

  if (!me || !currentSpaceId(me)) {
    return <LoginScreen config={effectiveConfig} onLogin={refreshMe} />;
  }
  if (shouldShowGenerateBooting(view, me, generationRecordsReady)) {
    return <EntryStatusScreen label="正在加载会话消息" detail="会话记录与生成状态正在进入新的 coss 工作区。" />;
  }
  if (view === "generate") {
    return (
      <GenerateMenuView
        config={effectiveConfig}
        providerConfigured={me.providerConfigured}
        records={generationRecords}
        setRecords={setGenerationRecords}
        recordsError={generationRecordsError}
        nextCursor={generationNextCursor}
        loadRecords={loadGenerationRecords}
        onProviderNeeded={() => setView("settings")}
        onNavigate={setView}
        pendingJumpTarget={pendingGalleryJumpTarget}
        onJumpHandled={() => setPendingGalleryJumpTarget(null)}
        onLogout={async () => {
          await api("/api/auth/logout", { method: "POST" });
          setMe(null);
        }}
        onUsageChanged={refreshMe}
      />
    );
  }

  return (
    <AppShell
      activeView={view}
      sidebar={shouldShowWorkspaceSidebar(view) ? <div /> : undefined}
      onNavigate={setView}
      onLogout={async () => {
        await api("/api/auth/logout", { method: "POST" });
        setMe(null);
      }}
    >
      <section className="flex h-full min-w-0 flex-col overflow-hidden">
        {view === "gallery" && (
          <GalleryView
            config={effectiveConfig}
            providerConfigured={me.providerConfigured}
            records={generationRecords}
            setRecords={setGenerationRecords}
            recordsError={generationRecordsError}
            nextCursor={generationNextCursor}
            loadRecords={loadGenerationRecords}
            onProviderNeeded={() => setView("settings")}
            onEditImage={editImageFromGallery}
            onEditPrompt={editPromptFromGallery}
            onJumpToConversation={(target) => {
              setPendingGalleryJumpTarget(target);
              setView("generate");
            }}
            onUsageChanged={refreshMe}
          />
        )}
        {view === "settings" && <SettingsView config={effectiveConfig} onSaved={refreshMe} />}
        {view === "inspiration" && <InspirationPlaceholderView />}
      </section>
    </AppShell>
  );
}

function registerImageCacheServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (window.location.protocol !== "https:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") return;
  navigator.serviceWorker.register("/image-cache-sw.js").catch(() => {
    // 图片缓存只是性能优化，注册失败不影响生图主流程。
  });
}

export function usesAppShellFrame(view: View) {
  return view === "generate" || view === "gallery" || view === "settings" || view === "inspiration";
}

export function shouldShowWorkspaceSidebar(view: View) {
  return view === "generate";
}

function LoginScreen({ config, onLogin }: { config: AppConfig; onLogin: () => Promise<void> }) {
  const [spaceName, setSpaceName] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("/api/auth/space-login", {
        method: "POST",
        body: JSON.stringify({ spaceName, password, turnstileToken }),
      });
      await onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "进入空间失败。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <EntryShell eyebrow="Workspace Access" title="进入你的创作空间" description="使用空间名称和密码进入创作台。新空间会自动创建，旧的登录布局与按钮体系已统一替换为新的 coss surface。">
      <EntryFormSection title="空间登录">
        <form className="grid gap-5" onSubmit={submit}>
          <EntryField label="空间名字" htmlFor="space-name">
            <Input
              id="space-name"
              type="text"
              value={spaceName}
              onChange={(event) => setSpaceName(event.target.value)}
              minLength={2}
              autoComplete="username"
              placeholder="请输入空间名称"
              className="rounded-[10px] bg-[#1c1c1c]"
              required
            />
          </EntryField>

          <EntryField label="空间密码" htmlFor="space-password" hint="忘记空间名或密码目前无法找回，请妥善保存。">
            <Input
              id="space-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
              placeholder="请输入空间密码"
              className="rounded-[10px] bg-[#1c1c1c]"
              required
            />
          </EntryField>

          <Button
            type="submit"
            size="lg"
            loading={loading}
            className="mt-1 w-full justify-center rounded-[10px] border-white/10 bg-white/90 text-[#181818] shadow-none hover:bg-white/80"
          >
            {loading ? "进入中" : "进入空间"}
          </Button>

          <EntryNoticeStack className="pt-1">
            {config.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />}
            {config.turnstileRequired && !config.turnstileSiteKey && <Notice tone="warn" text="Turnstile 已启用，请配置站点 Key。" />}
            {error && <Notice tone="error" text={error} />}
          </EntryNoticeStack>
        </form>
      </EntryFormSection>
    </EntryShell>
  );
}

function GenerateView({
  config,
  providerConfigured,
  records,
  setRecords,
  recordsError,
  nextCursor,
  loadRecords,
  onProviderNeeded,
  pendingEditImage,
  pendingEditForm,
  pendingEditMask,
  pendingGenerateForm,
  onPendingEditImageConsumed,
  onPendingGenerateFormConsumed,
  onUsageChanged,
}: {
  config: AppConfig;
  providerConfigured: boolean;
  records: GenerationRecord[];
  setRecords: Dispatch<SetStateAction<GenerationRecord[]>>;
  recordsError: string;
  nextCursor: string | null;
  loadRecords: LoadGenerationRecords;
  onProviderNeeded: () => void;
  pendingEditImage: ImageItem | null;
  pendingEditForm: GenerateForm | null;
  pendingEditMask: ImageSelectionMask | null;
  pendingGenerateForm: GenerateForm | null;
  onPendingEditImageConsumed: () => void;
  onPendingGenerateFormConsumed: () => void;
  onUsageChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState<GenerateForm>(defaultForm);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [referenceImages, setReferenceImages] = useState<ReferenceImagePreview[]>([]);
  const [referenceMask, setReferenceMask] = useState<ImageSelectionMask | null>(null);
  const [fastReferenceUpload, setFastReferenceUpload] = useState(true);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  const referenceObjectUrlsRef = useRef<string[]>([]);

  const availableRatios = useMemo(
    () => FIGMA_RATIOS.filter((ratio) => config.ratios.includes(ratio) || fallbackConfig.ratios.includes(ratio)),
    [config.ratios],
  );
  const qualityOptions = useMemo(
    () => QUALITY_OPTIONS.filter((quality) => config.qualities.includes(quality) || fallbackConfig.qualities.includes(quality)),
    [config.qualities],
  );
  const formatOptions = useMemo(
    () => FORMAT_OPTIONS.filter((format) => config.formats.includes(format) || fallbackConfig.formats.includes(format)),
    [config.formats],
  );
  const refreshUsage = useCallback(() => {
    void onUsageChanged().catch(() => undefined);
  }, [onUsageChanged]);
  useEffect(() => {
    if (promptTextareaRef.current) resizePromptTextarea(promptTextareaRef.current);
  }, [form.prompt]);
  const addReferenceFiles = useCallback(async (files: File[], options?: { replace?: boolean }) => {
    const accepted: ReferenceImagePreview[] = [];
    for (const file of files) {
      const mimeType = normalizeImageMime(file.type);
      if (!REFERENCE_IMAGE_MIME_TYPES.has(mimeType)) {
        setError("参考图仅支持 PNG、JPEG 或 WebP 格式。");
        return;
      }
      if (file.size > REFERENCE_IMAGE_MAX_BYTES) {
        setError("参考图不能超过 10MB。");
        return;
      }

      let preparedFile: { file: File; compressed: boolean };
      try {
        preparedFile = fastReferenceUpload ? await compressReferenceImage(file) : { file, compressed: false };
      } catch (err) {
        setError(err instanceof Error ? err.message : "参考图读取失败。");
        return;
      }
      if (preparedFile.file.size > REFERENCE_IMAGE_MAX_BYTES) {
        setError("参考图不能超过 10MB。");
        return;
      }

      const nextUrl = URL.createObjectURL(preparedFile.file);
      referenceObjectUrlsRef.current.push(nextUrl);
      accepted.push({
        file: preparedFile.file,
        url: nextUrl,
        name: preparedFile.file.name || file.name || "参考图",
        compressed: preparedFile.compressed,
        originalByteSize: preparedFile.compressed ? file.size : undefined,
      });
    }
    setReferenceImages((current) => {
      if (options?.replace) {
        for (const item of current) URL.revokeObjectURL(item.url);
        referenceObjectUrlsRef.current = referenceObjectUrlsRef.current.filter((url) => !current.some((item) => item.url === url));
      }
      const base = options?.replace ? [] : current;
      const remaining = Math.max(0, MAX_REFERENCE_IMAGES - base.length);
      for (const item of accepted.slice(remaining)) {
        URL.revokeObjectURL(item.url);
        referenceObjectUrlsRef.current = referenceObjectUrlsRef.current.filter((url) => url !== item.url);
      }
      const next = [...base, ...accepted.slice(0, remaining)];
      if (accepted.length > remaining) setError(`参考图最多 ${MAX_REFERENCE_IMAGES} 张。`);
      else setError("");
      return next;
    });
    setReferenceMask(null);
  }, [fastReferenceUpload]);
  const loadImageForEditing = useCallback(
    async (image: ImageItem, prompt?: string, mask?: ImageSelectionMask | null) => {
      setError("");
      try {
        const file = await imageItemToFile(image);
        const nextPrompt = prompt ?? image.prompt ?? "";
        await addReferenceFiles([file], { replace: true });
        setReferenceMask(mask ?? null);
        if (nextPrompt) {
          setForm((current) => ({ ...current, prompt: nextPrompt }));
        }
        window.requestAnimationFrame(() => {
          promptTextareaRef.current?.focus();
          if (nextPrompt) promptTextareaRef.current?.setSelectionRange(nextPrompt.length, nextPrompt.length);
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "载入图片编辑失败。");
      }
    },
    [addReferenceFiles],
  );

  const clearReferenceImage = useCallback((index?: number) => {
    if (typeof index === "number") {
      setReferenceImages((current) => {
        const item = current[index];
        if (item) {
          URL.revokeObjectURL(item.url);
          referenceObjectUrlsRef.current = referenceObjectUrlsRef.current.filter((url) => url !== item.url);
        }
        return current.filter((_, itemIndex) => itemIndex !== index);
      });
    } else {
      for (const url of referenceObjectUrlsRef.current) URL.revokeObjectURL(url);
      referenceObjectUrlsRef.current = [];
      setReferenceImages([]);
    }
    if (referenceInputRef.current) {
      referenceInputRef.current.value = "";
    }
    setReferenceMask(null);
  }, []);

  useEffect(() => {
    return () => {
      for (const url of referenceObjectUrlsRef.current) URL.revokeObjectURL(url);
      referenceObjectUrlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!pendingEditImage) return;
    void loadImageForEditing(pendingEditImage, pendingEditForm?.prompt ?? pendingEditImage.prompt, pendingEditMask)
      .then(() => {
        if (pendingEditForm) setForm(pendingEditForm);
      })
      .finally(onPendingEditImageConsumed);
  }, [loadImageForEditing, onPendingEditImageConsumed, pendingEditForm, pendingEditImage, pendingEditMask]);

  useEffect(() => {
    if (!pendingGenerateForm) return;
    setForm(pendingGenerateForm);
    setError("");
    window.requestAnimationFrame(() => {
      promptTextareaRef.current?.focus();
      promptTextareaRef.current?.setSelectionRange(pendingGenerateForm.prompt.length, pendingGenerateForm.prompt.length);
    });
    onPendingGenerateFormConsumed();
  }, [onPendingGenerateFormConsumed, pendingGenerateForm]);

  const upsertRecord = useCallback((nextJob: GenerationJob, nextImages: ImageItem[]) => {
    setRecords((current) => {
      const record: GenerationRecord = {
        job: nextJob,
        images: nextImages,
        elapsedSeconds: estimateJobElapsed(nextJob),
      };
      const existing = current.find((item) => item.job.id === nextJob.id);
      const mergedRecord = existing ? mergeGenerationRecord(existing, record) : record;
      const rest = current.filter((item) => item.job.id !== nextJob.id);
      return [mergedRecord, ...rest];
    });
  }, [setRecords]);

  useEffect(() => {
    if (!job || isTerminalJobStatus(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${job.id}`);
        setJob(result.job);
        setImages(result.images);
        upsertRecord(result.job, result.images);
        if (isTerminalJobStatus(result.job.status)) {
          window.clearInterval(timer);
          refreshUsage();
          void loadRecords(undefined, { background: true });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "刷新任务状态失败。");
      }
    }, GENERATION_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status, loadRecords, refreshUsage, upsertRecord]);

  useEffect(() => {
    if (!job || isTerminalJobStatus(job.status)) {
      if (!job) setElapsedSeconds(0);
      return;
    }
    const startedAt = parseUtcTimestamp(job.created_at);
    const updateElapsed = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.created_at, job?.status]);

  function update<K extends keyof GenerateForm>(key: K, value: GenerateForm[K]) {
    setForm((current) => updateGenerateFormValue(current, key, value));
  }

  function handleReferenceInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length) void addReferenceFiles(files);
    event.target.value = "";
  }

  function handlePromptPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = imageFileFromClipboard(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    void addReferenceFiles([file]);
  }

  async function optimizeCurrentPrompt() {
    if (!providerConfigured) {
      onProviderNeeded();
      return;
    }
    if (!form.prompt.trim()) {
      setError("请输入提示词后再优化。");
      promptTextareaRef.current?.focus();
      return;
    }

    setOptimizingPrompt(true);
    setError("");
    try {
      const result = await api<{ ok: true; optimizedPrompt: string }>("/api/prompts/optimize", {
        method: "POST",
        body: JSON.stringify(promptOptimizationPayload(form)),
      });
      const optimizedPrompt = result.optimizedPrompt.trim();
      update("prompt", optimizedPrompt);
      window.requestAnimationFrame(() => {
        promptTextareaRef.current?.focus();
        promptTextareaRef.current?.setSelectionRange(optimizedPrompt.length, optimizedPrompt.length);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "提示词优化失败。");
    } finally {
      setOptimizingPrompt(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!providerConfigured) {
      onProviderNeeded();
      return;
    }
    setLoading(true);
    setError("");
    setImages([]);
    setElapsedSeconds(0);
    try {
      const submittedPrompt = form.prompt;
      const result = await api<{ ok: true; jobId: string; status: "queued" }>("/api/generations", {
        method: "POST",
        body: generationRequestBody(form, turnstileToken, referenceImages, referenceMask),
      });
      refreshUsage();
      setForm((current) => (current.prompt === submittedPrompt ? { ...current, prompt: "" } : current));
      const firstPoll = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${result.jobId}`);
      setJob(firstPoll.job);
      setImages(firstPoll.images);
      upsertRecord(firstPoll.job, firstPoll.images);
      if (isTerminalJobStatus(firstPoll.job.status)) refreshUsage();
      void loadRecords(undefined, { background: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建任务失败。");
    } finally {
      setLoading(false);
    }
  }

  async function deleteRecord(record: GenerationRecord) {
    setError("");
    try {
      await api<{ ok: true }>(`/api/generations/${record.job.id}`, { method: "DELETE" });
      setRecords((current) => current.filter((item) => item.job.id !== record.job.id));
      if (job?.id === record.job.id) {
        setJob(null);
        setImages([]);
        setElapsedSeconds(0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除记录失败。");
    }
  }

  async function regenerateRecord(record: GenerationRecord) {
    if (!providerConfigured) {
      onProviderNeeded();
      return;
    }
    setLoading(true);
    setError("");
    setImages([]);
    setElapsedSeconds(0);
    try {
      const result = await api<{ ok: true; jobId: string; status: "queued" }>(`/api/generations/${record.job.id}/regenerate`, {
        method: "POST",
      });
      refreshUsage();
      const firstPoll = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${result.jobId}`);
      setJob(firstPoll.job);
      setImages(firstPoll.images);
      upsertRecord(firstPoll.job, firstPoll.images);
      if (isTerminalJobStatus(firstPoll.job.status)) refreshUsage();
      void loadRecords(undefined, { background: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新生成失败。");
    } finally {
      setLoading(false);
    }
  }

  function editRecordPrompt(record: GenerationRecord) {
    update("prompt", record.job.prompt);
    window.requestAnimationFrame(() => {
      promptTextareaRef.current?.focus();
      promptTextareaRef.current?.setSelectionRange(record.job.prompt.length, record.job.prompt.length);
    });
  }

  async function createEditTaskFromImage(
    image: ImageItem,
    draft: GenerateForm,
    maskFactory: ImageSelectionMaskFactory | undefined,
    editTurnstileToken: string,
  ): Promise<void> {
    if (!providerConfigured) {
      const message = "请先配置 Provider 后再生成。";
      setError(message);
      onProviderNeeded();
      throw new Error(message);
    }
    if (!draft.prompt.trim()) {
      const message = "请输入提示词后再生成。";
      setError(message);
      throw new Error(message);
    }

    setLoading(true);
    setError("");
    setImages([]);
    setElapsedSeconds(0);
    try {
      const selectionMask = maskFactory ? await maskFactory() : undefined;
      const result = await api<{ ok: true; jobId: string; status: "queued" }>("/api/generations", {
        method: "POST",
        body: generationRequestBody(draft, editTurnstileToken, [], selectionMask ?? null, image.id),
      });
      if (result.status !== "queued") {
        throw new Error("创建任务未进入队列，请稍后重试。");
      }
      refreshUsage();
      void (async () => {
        try {
          const firstPoll = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${result.jobId}`);
          setJob(firstPoll.job);
          setImages(firstPoll.images);
          upsertRecord(firstPoll.job, firstPoll.images);
          if (isTerminalJobStatus(firstPoll.job.status)) refreshUsage();
          void loadRecords(undefined, { background: true });
        } catch (err) {
          setError(err instanceof Error ? err.message : "刷新任务状态失败。");
        }
      })();
    } catch (err) {
      const message = err instanceof Error ? err.message : "创建任务失败。";
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="entry-fade flex h-[calc(100dvh-64px)] min-h-0 overflow-hidden">
      <form className="figma-composer flex h-full w-full shrink-0 flex-col border-r lg:w-[400px]" onSubmit={submit}>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pt-4">
          <div className="flex h-10 items-center gap-2 overflow-hidden rounded-[10px] border border-white/15 p-2">
            <div className="grid size-6 shrink-0 place-items-center rounded bg-white/10">
              <img src={openaiIcon} alt="" className="size-4" />
            </div>
            <p className="min-w-0 flex-1 truncate text-xs font-semibold leading-none text-white">{config.model || "gpt-image-2"}</p>
            {providerConfigured ? (
              <span className="shrink-0 text-xs leading-[18px] text-white/60">已配置</span>
            ) : (
              <CossButton type="button" variant="ghost" className="h-auto shrink-0 gap-2 rounded-none px-0 py-0 text-xs leading-[18px]" onClick={onProviderNeeded}>
                <span className="text-white/60">暂无 Provider 配置</span>
                <span className="text-white/90">去设置</span>
              </CossButton>
            )}
          </div>

          <section className="mt-4">
            <PromptSection
              textareaRef={promptTextareaRef}
              value={form.prompt}
              onChange={(value) => update("prompt", value)}
              onPaste={handlePromptPaste}
              placeholder="可以直接描述想生成的图片内容，例如：主体 / 材质 / 构图 / 风格 / 镜头 / 光线等"
              required
              optimizing={optimizingPrompt}
              disabled={loading}
              onOptimize={() => void optimizeCurrentPrompt()}
              trailingContent={
                <>
              <input ref={referenceInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={handleReferenceInputChange} />
              <div className="flex flex-col gap-2">
                <div className="flex h-16 gap-2 overflow-hidden">
                  {referenceImages.length < MAX_REFERENCE_IMAGES && (
                    <CossButton
                      type="button"
                      variant="secondary"
                      className="grid h-16 w-12 shrink-0 place-items-center overflow-hidden rounded-[6px] border border-white/10 bg-white/10 p-0 hover:bg-white/10"
                      aria-label="添加参考图"
                      title="添加参考图"
                      onClick={() => referenceInputRef.current?.click()}
                    >
                      <img src={addIcon} alt="" className="size-4" />
                    </CossButton>
                  )}
                  <div className="thin-scrollbar flex min-w-0 flex-1 gap-2 overflow-x-auto">
                    {referenceImages.map((referenceImage, index) => (
                      <div key={`${referenceImage.url}-${index}`} className="relative h-16 w-12 shrink-0 overflow-hidden rounded-[6px] border border-white/10 bg-white/10">
                        <img src={referenceImage.url} alt={referenceImage.name} className="size-full object-cover" />
                        <CossButton
                          type="button"
                          variant="secondary"
                          size="icon-xs"
                          className="absolute right-1 top-1 z-10 grid size-4 place-items-center overflow-hidden rounded bg-black/80 p-0 hover:bg-black/80"
                          aria-label="删除参考图"
                          title="删除参考图"
                          onClick={() => clearReferenceImage(index)}
                        >
                          <img src={referenceDeleteIcon} alt="" className="size-3" />
                        </CossButton>
                        {index === 0 && referenceMask && <span className="absolute bottom-1 right-1 size-2 rounded-full bg-white/80" aria-label="已应用选区遮罩" />}
                      </div>
                    ))}
                  </div>
                </div>
                <FastUploadToggle enabled={fastReferenceUpload} onChange={setFastReferenceUpload} />
              </div>
                </>
              }
            />
          </section>

          <div className="mt-4 pb-4">
            <ParameterSection
              aspectRatios={availableRatios}
              selectedAspectRatio={form.aspectRatio}
              onAspectRatioChange={(value) => update("aspectRatio", value)}
              qualityOptions={qualityOptions}
              selectedQuality={form.quality}
              qualityLabels={qualityLabels}
              onQualityChange={(value) => update("quality", value)}
              resolutions={RESOLUTIONS}
              selectedResolution={form.resolution}
              onResolutionChange={(value) => update("resolution", value)}
              quantities={Array.from({ length: Math.min(config.maxImagesPerRequest, 4) }, (_, index) => String(index + 1))}
              selectedQuantity={form.quantity}
              onQuantityChange={(value) => update("quantity", value)}
              formatOptions={formatOptions}
              selectedFormat={form.outputFormat}
              formatLabels={formatLabels}
              onFormatChange={(value) => update("outputFormat", value)}
            />
            <div className="mt-4 flex flex-col gap-3">
              {error && <Notice tone="error" text={error} />}
              {config.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />}
            </div>
          </div>
        </div>

        <GenerationFormFooter loading={loading} idleLabel="生成任务" />
      </form>

      <section className="figma-records thin-scrollbar h-full min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex w-[800px] max-w-full flex-col gap-3">
          {recordsError && <Notice tone="error" text={recordsError} />}
          {!loading && records.length === 0 && (
            <div className="figma-record-card grid min-h-[188px] place-items-center rounded-[10px] border border-white/15 p-6 text-center">
              <div className="flex flex-col items-center gap-3 text-white/40">
                <Images className="size-7" />
                <span className="text-xs">生成记录会出现在这里</span>
              </div>
            </div>
          )}
          {records.map((record) => (
            <GenerationRecordCard
              key={record.job.id}
              record={record.job.id === job?.id ? { ...record, job, images, elapsedSeconds: elapsedSeconds || record.elapsedSeconds } : record}
              onDelete={() => void deleteRecord(record)}
              onRegenerate={() => void regenerateRecord(record)}
              onEditPrompt={() => editRecordPrompt(record)}
              onEditImage={(image) => void loadImageForEditing(image, record.job.prompt)}
              editOptions={{
                initialForm: generationFormFromJob(record.job),
                availableRatios,
                qualityOptions,
                formatOptions,
                maxImagesPerRequest: config.maxImagesPerRequest,
                turnstileSiteKey: config.turnstileSiteKey,
                turnstileRequired: config.turnstileRequired,
                submitting: loading,
                onSubmit: createEditTaskFromImage,
              }}
            />
          ))}
          {nextCursor && (
            <CossButton type="button" variant="outline" className="mx-auto mb-2 h-8 rounded-md border border-white/15 bg-transparent px-4 text-xs text-white/60 hover:bg-white/10 hover:text-white/80" onClick={() => void loadRecords(nextCursor)}>
              加载更多
            </CossButton>
          )}
        </div>
      </section>
    </div>
  );
}

function GenerationRecordCard({
  record,
  onDelete,
  onRegenerate,
  onEditPrompt,
  onEditImage,
  editOptions,
}: {
  record: GenerationRecord;
  onDelete: () => void;
  onRegenerate: () => void;
  onEditPrompt: () => void;
  onEditImage: (image: ImageItem, draft?: GenerateForm, mask?: ImageSelectionMask) => void;
  editOptions?: ImagePreviewEditOptions;
}) {
  const [previewImage, setPreviewImage] = useState<ImageItem | null>(null);
  const isGenerating = record.job.status === "queued" || record.job.status === "running";
  const slotCount = Math.max(record.job.quantity, record.images.length);
  const showEmptyPlaceholder = slotCount === 0;
  const resultSlots = record.job.results ?? [];
  const recordError =
    record.job.status === "failed" || record.job.status === "partial_succeeded"
      ? generationJobErrorMessage(
          record.job,
          record.job.status === "partial_succeeded" ? `已生成 ${record.images.length}/${record.job.quantity} 张，部分图片生成失败。` : "生成失败。",
        )
      : "";
  const chips = [
    ...(record.job.status === "succeeded" || isGenerating ? [] : [statusLabel(record.job.status)]),
    record.job.aspect_ratio,
    qualityLabels[record.job.quality] ?? record.job.quality,
    formatResolution(record.job.width, record.job.height),
    formatLabels[record.job.output_format] ?? record.job.output_format.toUpperCase(),
    formatRecordElapsed(record.elapsedSeconds),
  ];
  return (
    <article
      className={cn(
        "figma-record-card flex w-full flex-col gap-3 overflow-hidden rounded-[10px] border p-3",
        isGenerating ? "figma-record-card-generating" : "border-white/15",
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        {Array.from({ length: slotCount }, (_, index) => {
          const result = resultSlots.find((item) => item.index === index);
          const image =
            resultSlots.length > 0
              ? result?.imageId
                ? record.images.find((item) => item.id === result.imageId)
                : undefined
              : record.images[index];
          return (
            <GenerationImageSlot
              key={`${record.job.id}-${index}`}
              job={record.job}
              image={image}
              result={result}
              loading={isGenerating && !image}
              index={index}
              onOpen={(nextImage) => setPreviewImage(nextImage)}
            />
          );
        })}
        {showEmptyPlaceholder && <GenerationPlaceholderThumbnail job={record.job} />}
      </div>

      <GenerationReferenceSnapshots job={record.job} />
      <p className="record-prompt min-w-full text-xs leading-[18px] text-white/40">
        {record.job.prompt || statusLabel(record.job.status)}
      </p>
      {recordError && <p className="text-xs leading-[18px] text-destructive">{recordError}</p>}
      <GenerationTaskTimeline job={record.job} />

      <div className="flex min-h-5 items-center gap-10">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <span key={chip} className="rounded-md bg-white/10 px-2 py-1 text-xs leading-none text-white/60">
              {chip}
            </span>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-4 text-white/90">
          <CossButton type="button" variant="ghost" size="icon-sm" className="figma-icon-action" aria-label="删除记录" onClick={onDelete}>
            <Trash2 className="size-[14px]" />
          </CossButton>
          <CossButton type="button" variant="ghost" size="icon-sm" className="figma-icon-action" aria-label="重新生成" onClick={onRegenerate}>
            <RotateCcw className="size-[14px]" />
          </CossButton>
          <CossButton type="button" variant="ghost" size="icon-sm" className="figma-icon-action" aria-label="编辑提示词" onClick={onEditPrompt}>
            <Edit3 className="size-[14px]" />
          </CossButton>
          <CossButton type="button" variant="ghost" size="icon-sm" className="figma-icon-action" aria-label="复制提示词" onClick={() => void copyPrompt(record.job.prompt)}>
            <Copy className="size-[14px]" />
          </CossButton>
          <CossButton
            type="button"
            variant="ghost"
            size="icon-sm"
            className="figma-icon-action disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="下载全部图片"
            disabled={record.images.length === 0}
            onClick={() => downloadAllImages(record)}
          >
            <CloudDownload className="size-[14px]" />
          </CossButton>
        </div>
      </div>
      {previewImage && (
        <ImagePreviewDialog
          image={previewImage}
          onClose={() => setPreviewImage(null)}
          onEdit={(draft, mask) => {
            onEditImage(previewImage, draft, mask);
            setPreviewImage(null);
          }}
          editOptions={editOptions}
        />
      )}
    </article>
  );
}

function GenerationImageSlot({
  job,
  image,
  result,
  loading,
  index,
  onOpen,
}: {
  job: GenerationJob;
  image?: ImageItem;
  result?: NonNullable<GenerationJob["results"]>[number];
  loading: boolean;
  index: number;
  onOpen: (image: ImageItem) => void;
}) {
  if (image) {
    return (
      <div className="relative shrink-0">
        <GenerationThumbnail image={image} onOpen={() => onOpen(image)} />
        <GenerationSlotStatusBadge status="succeeded" />
      </div>
    );
  }

  return (
    <div className="relative shrink-0">
      <GenerationPlaceholderThumbnail job={job} loading={loading} loadingIndex={index} failed={result?.status === "failed"} />
      {result?.status === "failed" && <GenerationSlotStatusBadge status="failed" title={result.errorMessage ?? "生成失败"} />}
    </div>
  );
}

function GenerationPlaceholderThumbnail({
  job,
  loading = false,
  loadingIndex = 0,
  failed = false,
}: {
  job: GenerationJob;
  loading?: boolean;
  loadingIndex?: number;
  failed?: boolean;
}) {
  const size = thumbnailSize(job.width, job.height);
  const idleClassName = cn(
    "grid size-full place-items-center overflow-hidden rounded-md border border-transparent bg-white/10 text-white/40",
    failed && "bg-destructive/10 text-destructive/80",
  );
  const idleThumbnail = (
    <BorderBeam
      className="generation-preview-beam"
      size="md"
      colorVariant="colorful"
      strength={0.8}
      theme="dark"
      borderRadius={6}
      style={{ width: size.width, height: size.height }}
    >
      <div
        className={idleClassName}
        aria-label={loading ? "图片生成中" : "暂无生成图片"}
      >
        <FileText className="size-5" />
      </div>
    </BorderBeam>
  );

  if (!loading) {
    return idleThumbnail;
  }

  const dotSize = Math.min(3, Math.max(2, Math.min(size.width / 32, size.height / 24)));
  const dotGap = Math.min(
    5,
    Math.max(
      2.6,
      Math.min(
        (size.width - generationDotMatrixColumns * dotSize) / Math.max(1, generationDotMatrixColumns - 1),
        (size.height - generationDotMatrixRows * dotSize) / Math.max(1, generationDotMatrixRows - 1),
      ),
    ),
  );

  return (
    <BorderBeam
      className="generation-preview-beam"
      size="md"
      colorVariant="colorful"
      strength={0.8}
      theme="dark"
      borderRadius={6}
      style={{ width: size.width, height: size.height }}
    >
      <div
        className={cn(
          "grid size-full place-items-center overflow-hidden rounded-md border border-transparent bg-white/10 text-white/40",
          loading && "generation-loading-thumbnail",
        )}
        style={
          {
            "--dot-size": `${dotSize}px`,
            "--dot-gap": `${dotGap}px`,
          } as CSSProperties
        }
        aria-label="图片生成中"
      >
        <GenerationDotMatrixLoader delayIndex={loadingIndex} />
      </div>
    </BorderBeam>
  );
}

function GenerationSlotStatusBadge({ status, title }: { status: "succeeded" | "failed"; title?: string }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] leading-none",
        status === "failed" ? "text-destructive" : "text-white/60",
      )}
      title={title}
    >
      {status === "failed" ? "失败" : "完成"}
    </span>
  );
}

function GenerationReferenceSnapshots({ job }: { job: GenerationJob }) {
  const references = job.referenceImages ?? [];
  if (references.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 rounded-md bg-white/10 px-2 py-1 text-xs leading-none text-white/45">参考图</span>
      <div className="thin-scrollbar flex min-w-0 gap-2 overflow-x-auto">
        {references.map((reference, index) => (
          <img
            key={`${reference.url}-${index}`}
            src={reference.url}
            alt={reference.name || `参考图 ${index + 1}`}
            loading="lazy"
            className="h-12 w-9 shrink-0 rounded-[6px] border border-white/10 bg-white/10 object-cover"
          />
        ))}
      </div>
    </div>
  );
}

function GenerationTaskTimeline({ job }: { job: GenerationJob }) {
  const progressCurrent = job.progress_current ?? completedResultCount(job);
  const progressTotal = job.progress_total ?? job.quantity;
  const stage = job.stage ?? stageFromJobStatus(job.status);
  const items = [
    { id: "queued", label: "已提交", active: true },
    { id: "running", label: stageLabel(stage), active: job.status !== "queued" },
    { id: "done", label: terminalTimelineLabel(job), active: isTerminalJobStatus(job.status) },
  ];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs leading-[18px] text-white/40">
      {items.map((item, index) => (
        <Fragment key={item.id}>
          <span className="flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", item.active ? "bg-white/80" : "bg-white/25")} />
            <span>{item.label}</span>
          </span>
          {index < items.length - 1 && <span className="text-white/20">/</span>}
        </Fragment>
      ))}
      <span className="rounded-md bg-white/10 px-2 py-1 leading-none text-white/45">
        {Math.min(progressCurrent, progressTotal)}/{progressTotal}
      </span>
    </div>
  );
}

function FastUploadToggle({ enabled, onChange }: { enabled: boolean; onChange: Dispatch<SetStateAction<boolean>> }) {
  return (
    <label className="flex min-h-7 cursor-pointer items-center gap-2 rounded-[6px] border border-white/10 bg-black/10 px-2 py-1">
      <input
        type="checkbox"
        className="size-3.5 shrink-0 accent-white"
        checked={enabled}
        aria-label="快速上传"
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0 text-xs leading-[18px] text-white/60">
        快速上传 <span className="text-white/40">压缩文件大小提升上传速度</span>
      </span>
    </label>
  );
}

function GenerationThumbnail({ image, onOpen }: { image: ImageItem; onOpen: () => void }) {
  const size = thumbnailSize(image.width, image.height);
  return (
    <CossButton
      type="button"
      variant="ghost"
      className="block shrink-0 overflow-hidden rounded-md border border-white/10 bg-white/10 p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 hover:bg-white/10"
      style={{ width: size.width, height: size.height }}
      aria-label="查看大图"
      onClick={onOpen}
    >
      <img key={image.id} src={image.url} alt={image.prompt ?? "生成图片"} loading="lazy" className="size-full object-cover" />
    </CossButton>
  );
}

interface ImagePreviewEditOptions {
  initialForm: GenerateForm;
  availableRatios: readonly string[];
  qualityOptions: readonly string[];
  formatOptions: readonly string[];
  maxImagesPerRequest: number;
  turnstileSiteKey: string;
  turnstileRequired: boolean;
  submitting: boolean;
  onSubmit?: (image: ImageItem, draft: GenerateForm, maskFactory: ImageSelectionMaskFactory | undefined, turnstileToken: string) => Promise<void>;
}

type ImageSelectionMaskFactory = () => Promise<ImageSelectionMask>;

const fallbackImagePreviewEditOptions = {
  initialForm: defaultForm,
  availableRatios: FIGMA_RATIOS,
  qualityOptions: QUALITY_OPTIONS,
  formatOptions: FORMAT_OPTIONS,
  maxImagesPerRequest: fallbackConfig.maxImagesPerRequest,
  turnstileSiteKey: fallbackConfig.turnstileSiteKey,
  turnstileRequired: fallbackConfig.turnstileRequired,
  submitting: false,
} satisfies ImagePreviewEditOptions;

function ImagePreviewDialog({
  image,
  onClose,
  onEdit,
  editOptions,
}: {
  image: ImageItem;
  onClose: () => void;
  onEdit: (draft?: GenerateForm, mask?: ImageSelectionMask) => void;
  editOptions?: ImagePreviewEditOptions;
}) {
  const panelOptions = editOptions ?? fallbackImagePreviewEditOptions;
  const [viewportSize, setViewportSize] = useState(() => currentViewportSize());
  const [editing, setEditing] = useState(false);
  const [selectionEditing, setSelectionEditing] = useState(false);
  const [selectionStrokes, setSelectionStrokes] = useState<ImageSelectionStroke[]>([]);
  const [redoSelectionStrokes, setRedoSelectionStrokes] = useState<ImageSelectionStroke[]>([]);
  const [draft, setDraft] = useState<GenerateForm>(() => panelOptions.initialForm);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [editError, setEditError] = useState("");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const selectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeSelectionStrokeRef = useRef<ImageSelectionStroke | null>(null);
  const previewSize = useMemo(
    () => imagePreviewSize(image.width, image.height, viewportSize.width, viewportSize.height, editing),
    [editing, image.height, image.width, viewportSize.height, viewportSize.width],
  );
  const previewStyle = {
    "--preview-panel-width": `${previewSize.panelWidth}px`,
    "--preview-panel-height": `${previewSize.panelHeight}px`,
    "--preview-editor-width": `${previewSize.editorWidth}px`,
  } as CSSProperties;

  useEffect(() => {
    setEditing(false);
    setSelectionEditing(false);
    setSelectionStrokes([]);
    setRedoSelectionStrokes([]);
    activeSelectionStrokeRef.current = null;
    setDraft(panelOptions.initialForm);
    setTurnstileToken("");
    setSubmittingEdit(false);
    setEditError("");
  }, [image.id]);

  useEffect(() => {
    setTurnstileToken("");
  }, [panelOptions.turnstileSiteKey]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    function handleResize() {
      setViewportSize(currentViewportSize());
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!selectionEditing) return;
    drawImageSelectionCanvas(selectionCanvasRef.current, stageRef.current, image, selectionStrokes);
  }, [image, previewSize.panelHeight, previewSize.panelWidth, selectionEditing, selectionStrokes, viewportSize.height, viewportSize.width]);

  function updateDraft<K extends keyof GenerateForm>(key: K, value: GenerateForm[K]) {
    setDraft((current) => updateGenerateFormValue(current, key, value));
  }

  function beginSelectionEdit() {
    setEditing(true);
    setSelectionEditing(true);
    setEditError("");
  }

  function cancelSelectionEdit() {
    activeSelectionStrokeRef.current = null;
    setSelectionEditing(false);
    setSelectionStrokes([]);
    setRedoSelectionStrokes([]);
    setEditError("");
  }

  function undoSelectionStroke() {
    setSelectionStrokes((current) => {
      const next = current.slice(0, -1);
      const removed = current[current.length - 1];
      if (removed) setRedoSelectionStrokes((redoCurrent) => [removed, ...redoCurrent]);
      return next;
    });
  }

  function redoSelectionStroke() {
    setRedoSelectionStrokes((current) => {
      const [restored, ...nextRedo] = current;
      if (restored) setSelectionStrokes((strokes) => [...strokes, restored]);
      return nextRedo;
    });
  }

  function startSelectionStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!selectionEditing) return;
    const point = imageSelectionPointFromEvent(event, stageRef.current, image);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: ImageSelectionStroke = {
      brushRatio: IMAGE_SELECTION_BRUSH_RATIO,
      points: [point],
    };
    activeSelectionStrokeRef.current = stroke;
    setRedoSelectionStrokes([]);
    setSelectionStrokes((current) => [...current, stroke]);
  }

  function moveSelectionStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    const activeStroke = activeSelectionStrokeRef.current;
    if (!activeStroke || !selectionEditing) return;
    const point = imageSelectionPointFromEvent(event, stageRef.current, image);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();

    const previous = activeStroke.points[activeStroke.points.length - 1];
    const minDistance = 0.003;
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < minDistance) return;

    const nextStroke = {
      ...activeStroke,
      points: [...activeStroke.points, point],
    };
    activeSelectionStrokeRef.current = nextStroke;
    setSelectionStrokes((current) => {
      if (current.length === 0) return [nextStroke];
      return [...current.slice(0, -1), nextStroke];
    });
  }

  function endSelectionStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!activeSelectionStrokeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activeSelectionStrokeRef.current = null;
  }

  async function optimizeDraftPrompt() {
    if (!draft.prompt.trim()) {
      setEditError("请输入提示词后再优化。");
      return;
    }

    setOptimizing(true);
    setEditError("");
    try {
      const result = await api<{ ok: true; optimizedPrompt: string }>("/api/prompts/optimize", {
        method: "POST",
        body: JSON.stringify(promptOptimizationPayload(draft)),
      });
      updateDraft("prompt", result.optimizedPrompt.trim());
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "提示词优化失败。");
    } finally {
      setOptimizing(false);
    }
  }

  async function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (panelOptions.submitting || submittingEdit) return;
    setEditError("");
    if (!draft.prompt.trim()) {
      setEditError("请输入提示词后再生成。");
      return;
    }

    let maskFactory: ImageSelectionMaskFactory | undefined;
    if (selectionEditing) {
      if (selectionStrokes.length === 0) {
        setEditError("请先涂抹要优化的区域。");
        return;
      }
      const maskStrokes = selectionStrokes.map((stroke) => ({
        ...stroke,
        points: [...stroke.points],
      }));
      maskFactory = () => createSelectionMask(image, maskStrokes);
    }

    if (!editOptions?.onSubmit) {
      let selectionMask: ImageSelectionMask | undefined;
      if (maskFactory) {
        try {
          selectionMask = await maskFactory();
        } catch (err) {
          setEditError(err instanceof Error ? err.message : "选区遮罩生成失败。");
          return;
        }
      }
      onEdit(draft, selectionMask);
      onClose();
      return;
    }
    if (panelOptions.turnstileRequired && !panelOptions.turnstileSiteKey) {
      setEditError("Turnstile 已启用，请先配置站点 Key。");
      return;
    }
    if (panelOptions.turnstileSiteKey && !turnstileToken) {
      setEditError("请先完成人机验证。");
      return;
    }
    const submitEditTask = editOptions.onSubmit;
    setSubmittingEdit(true);
    onClose();
    window.setTimeout(() => {
      try {
        const submitPromise = submitEditTask(image, draft, maskFactory, turnstileToken);
        void submitPromise.catch(() => undefined);
      } catch {
        // The dialog is already closed; submission handlers surface failures in the parent view.
      }
    }, 0);
  }

  return createPortal(
    <div className="image-preview-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={onClose}>
      <div
        className={cn("image-preview-panel", editing && "image-preview-panel-edit")}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "图片编辑" : "图片预览"}
        style={previewStyle}
        onClick={(event) => event.stopPropagation()}
      >
        {editing && (
          <ImagePreviewEditPanel
            draft={draft}
            error={editError}
            optimizing={optimizing}
            submitting={panelOptions.submitting || submittingEdit}
            availableRatios={panelOptions.availableRatios}
            qualityOptions={panelOptions.qualityOptions}
            formatOptions={panelOptions.formatOptions}
            maxImagesPerRequest={panelOptions.maxImagesPerRequest}
            turnstileSiteKey={panelOptions.turnstileSiteKey}
            turnstileRequired={panelOptions.turnstileRequired}
            onDraftChange={updateDraft}
            onTurnstileToken={setTurnstileToken}
            onOptimize={() => void optimizeDraftPrompt()}
            onSubmit={(event) => void submitEdit(event)}
          />
        )}
        {selectionEditing ? (
          <div className="image-preview-selection-toolbar">
            <CossButton type="button" variant="ghost" className="image-preview-action" onClick={cancelSelectionEdit}>
              <X />
              <span>取消选区编辑</span>
            </CossButton>
            <div className="flex items-center gap-5">
              <CossButton type="button" variant="ghost" className="image-preview-action" disabled={selectionStrokes.length === 0} onClick={undoSelectionStroke}>
                <Undo2 />
                <span>上一步</span>
              </CossButton>
              <CossButton type="button" variant="ghost" className="image-preview-action" disabled={redoSelectionStrokes.length === 0} onClick={redoSelectionStroke}>
                <span>下一步</span>
                <Redo2 />
              </CossButton>
            </div>
            <span aria-hidden="true" />
          </div>
        ) : (
          <div className="image-preview-actions">
            {editing ? (
              <CossButton type="button" variant="ghost" className="image-preview-action" onClick={beginSelectionEdit}>
                <Edit3 />
                <span>选区编辑</span>
              </CossButton>
            ) : (
              <CossButton type="button" variant="ghost" className="image-preview-action" onClick={() => setEditing(true)}>
                <Edit3 />
                <span>编辑图片</span>
              </CossButton>
            )}
            <a className="image-preview-action" href={imageDownloadUrl(image)} download={imageDownloadName(image)}>
              <Download />
              <span>下载图片</span>
            </a>
          </div>
        )}
        <CossButton type="button" variant="ghost" size="icon" className="image-preview-close" aria-label="关闭预览" onClick={onClose}>
          <X />
        </CossButton>
        <div ref={stageRef} className={cn("image-preview-stage", selectionEditing && "image-preview-stage-selection")}>
          <img src={image.url} alt={image.prompt ?? "生成图片"} />
          {selectionEditing && (
            <canvas
              ref={selectionCanvasRef}
              className="image-preview-selection-canvas"
              aria-label="涂抹选区"
              onPointerDown={startSelectionStroke}
              onPointerMove={moveSelectionStroke}
              onPointerUp={endSelectionStroke}
              onPointerCancel={endSelectionStroke}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ImagePreviewEditPanel({
  draft,
  error,
  optimizing,
  submitting,
  availableRatios,
  qualityOptions,
  formatOptions,
  maxImagesPerRequest,
  turnstileSiteKey,
  turnstileRequired,
  onDraftChange,
  onTurnstileToken,
  onOptimize,
  onSubmit,
}: {
  draft: GenerateForm;
  error: string;
  optimizing: boolean;
  submitting: boolean;
  availableRatios: readonly string[];
  qualityOptions: readonly string[];
  formatOptions: readonly string[];
  maxImagesPerRequest: number;
  turnstileSiteKey: string;
  turnstileRequired: boolean;
  onDraftChange: <K extends keyof GenerateForm>(key: K, value: GenerateForm[K]) => void;
  onTurnstileToken: (token: string) => void;
  onOptimize: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (promptTextareaRef.current) resizePromptTextarea(promptTextareaRef.current);
  }, [draft.prompt]);

  return (
    <form className="image-preview-editor" onSubmit={onSubmit}>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pt-4">
        <PromptSection
          textareaRef={promptTextareaRef}
          value={draft.prompt}
          onChange={(value) => onDraftChange("prompt", value)}
          placeholder="可以直接描述想生成的图片内容，例如：主体 / 材质 / 构图 / 风格 / 镜头 / 光线等"
          required
          optimizing={optimizing}
          disabled={submitting}
          onOptimize={onOptimize}
          trailingContent={<PromptPlaceholderThumbnail />}
        />

        <div className="mt-4 pb-4">
          <ParameterSection
            aspectRatios={availableRatios}
            selectedAspectRatio={draft.aspectRatio}
            onAspectRatioChange={(value) => onDraftChange("aspectRatio", value)}
            qualityOptions={qualityOptions}
            selectedQuality={draft.quality}
            qualityLabels={qualityLabels}
            onQualityChange={(value) => onDraftChange("quality", value)}
            resolutions={RESOLUTIONS}
            selectedResolution={draft.resolution}
            onResolutionChange={(value) => onDraftChange("resolution", value)}
            quantities={Array.from({ length: Math.min(maxImagesPerRequest, 4) }, (_, index) => String(index + 1))}
            selectedQuantity={draft.quantity}
            onQuantityChange={(value) => onDraftChange("quantity", value)}
            formatOptions={formatOptions}
            selectedFormat={draft.outputFormat}
            formatLabels={formatLabels}
            onFormatChange={(value) => onDraftChange("outputFormat", value)}
          />
          <div className="mt-4 flex flex-col gap-3">
            {turnstileSiteKey && <Turnstile siteKey={turnstileSiteKey} onToken={onTurnstileToken} />}
            {turnstileRequired && !turnstileSiteKey && <Notice tone="warn" text="Turnstile 已启用，请配置站点 Key。" />}
          </div>
          {error && <div className="mt-3"><Notice tone="error" text={error} /></div>}
        </div>
      </div>

      <GenerationFormFooter loading={submitting} idleLabel="生成任务" />
    </form>
  );
}

function GalleryView({
  config,
  providerConfigured,
  records,
  setRecords,
  recordsError,
  nextCursor,
  loadRecords,
  onProviderNeeded,
  onEditImage,
  onEditPrompt,
  onJumpToConversation,
  onUsageChanged,
}: {
  config: AppConfig;
  providerConfigured: boolean;
  records: GenerationRecord[];
  setRecords: Dispatch<SetStateAction<GenerationRecord[]>>;
  recordsError: string;
  nextCursor: string | null;
  loadRecords: LoadGenerationRecords;
  onProviderNeeded: () => void;
  onEditImage: (image: ImageItem, draft?: GenerateForm, mask?: ImageSelectionMask) => void;
  onEditPrompt: (draft: GenerateForm) => void;
  onJumpToConversation: (target: GalleryJumpTarget) => void;
  onUsageChanged: () => Promise<void>;
}) {
  const [activeJob, setActiveJob] = useState<GenerationJob | null>(null);
  const [activeImages, setActiveImages] = useState<ImageItem[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<{ image: ImageItem; job: GenerationJob } | null>(null);
  const [error, setError] = useState("");

  const availableRatios = useMemo(
    () => FIGMA_RATIOS.filter((ratio) => config.ratios.includes(ratio) || fallbackConfig.ratios.includes(ratio)),
    [config.ratios],
  );
  const qualityOptions = useMemo(
    () => QUALITY_OPTIONS.filter((quality) => config.qualities.includes(quality) || fallbackConfig.qualities.includes(quality)),
    [config.qualities],
  );
  const formatOptions = useMemo(
    () => FORMAT_OPTIONS.filter((format) => config.formats.includes(format) || fallbackConfig.formats.includes(format)),
    [config.formats],
  );
  const refreshUsage = useCallback(() => {
    void onUsageChanged().catch(() => undefined);
  }, [onUsageChanged]);
  const galleryGroups = useMemo(() => buildGalleryGroups(records, activeJob, activeImages, elapsedSeconds), [records, activeImages, activeJob, elapsedSeconds]);

  const upsertRecord = useCallback((nextJob: GenerationJob, nextImages: ImageItem[]) => {
    setRecords((current) => {
      const record: GenerationRecord = {
        job: nextJob,
        images: nextImages,
        elapsedSeconds: estimateJobElapsed(nextJob),
      };
      const existing = current.find((item) => item.job.id === nextJob.id);
      const mergedRecord = existing ? mergeGenerationRecord(existing, record) : record;
      const rest = current.filter((item) => item.job.id !== nextJob.id);
      return [mergedRecord, ...rest];
    });
  }, [setRecords]);

  useEffect(() => {
    if (!activeJob || isTerminalJobStatus(activeJob.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${activeJob.id}`);
        setActiveJob(result.job);
        setActiveImages(result.images);
        upsertRecord(result.job, result.images);
        if (isTerminalJobStatus(result.job.status)) {
          window.clearInterval(timer);
          refreshUsage();
          void loadRecords(undefined, { background: true });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "刷新任务状态失败。");
      }
    }, GENERATION_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeJob?.id, activeJob?.status, loadRecords, refreshUsage, upsertRecord]);

  useEffect(() => {
    if (!activeJob || isTerminalJobStatus(activeJob.status)) {
      if (!activeJob) setElapsedSeconds(0);
      return;
    }
    const startedAt = parseUtcTimestamp(activeJob.created_at);
    const updateElapsed = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [activeJob?.id, activeJob?.created_at, activeJob?.status]);

  async function deleteRecord(record: GenerationRecord) {
    setError("");
    try {
      await api<{ ok: true }>(`/api/generations/${record.job.id}`, { method: "DELETE" });
      setRecords((current) => current.filter((item) => item.job.id !== record.job.id));
      if (activeJob?.id === record.job.id) {
        setActiveJob(null);
        setActiveImages([]);
        setElapsedSeconds(0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除记录失败。");
    }
  }

  async function regenerateRecord(record: GenerationRecord) {
    if (!providerConfigured) {
      onProviderNeeded();
      return;
    }
    if (regeneratingId) return;
    setRegeneratingId(record.job.id);
    setError("");
    setActiveJob(null);
    setActiveImages([]);
    setElapsedSeconds(0);
    try {
      const result = await api<{ ok: true; jobId: string; status: "queued" }>(`/api/generations/${record.job.id}/regenerate`, {
        method: "POST",
      });
      refreshUsage();
      const firstPoll = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${result.jobId}`);
      setActiveJob(firstPoll.job);
      setActiveImages(firstPoll.images);
      upsertRecord(firstPoll.job, firstPoll.images);
      if (isTerminalJobStatus(firstPoll.job.status)) refreshUsage();
      void loadRecords(undefined, { background: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新生成失败。");
    } finally {
      setRegeneratingId(null);
    }
  }

  async function createEditTaskFromImage(
    image: ImageItem,
    draft: GenerateForm,
    maskFactory: ImageSelectionMaskFactory | undefined,
    turnstileToken: string,
  ): Promise<void> {
    if (!providerConfigured) {
      setError("请先配置 Provider 后再生成。");
      onProviderNeeded();
      throw new Error("请先配置 Provider 后再生成。");
    }
    if (!draft.prompt.trim()) {
      const message = "请输入提示词后再生成。";
      setError(message);
      throw new Error(message);
    }
    if (regeneratingId) {
      const message = "已有生成任务正在提交，请稍后再试。";
      setError(message);
      throw new Error(message);
    }

    setRegeneratingId(image.jobId);
    setError("");
    setActiveJob(null);
    setActiveImages([]);
    setElapsedSeconds(0);
    try {
      const selectionMask = maskFactory ? await maskFactory() : undefined;
      const result = await api<{ ok: true; jobId: string; status: "queued" }>("/api/generations", {
        method: "POST",
        body: generationRequestBody(draft, turnstileToken, [], selectionMask ?? null, image.id),
      });
      if (result.status !== "queued") {
        throw new Error("创建任务未进入队列，请稍后重试。");
      }
      refreshUsage();
      void (async () => {
        try {
          const firstPoll = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${result.jobId}`);
          setActiveJob(firstPoll.job);
          setActiveImages(firstPoll.images);
          upsertRecord(firstPoll.job, firstPoll.images);
          if (isTerminalJobStatus(firstPoll.job.status)) refreshUsage();
          void loadRecords(undefined, { background: true });
        } catch (err) {
          setError(err instanceof Error ? err.message : "刷新任务状态失败。");
        }
      })();
    } catch (err) {
      const message = err instanceof Error ? err.message : "创建任务失败。";
      setError(message);
      throw new Error(message);
    } finally {
      setRegeneratingId(null);
    }
  }

  return (
    <section className="entry-fade thin-scrollbar h-full flex-1 overflow-y-auto px-5 py-5">
      <div className="mx-auto w-full max-w-[1680px]">
        {recordsError && <Notice tone="error" text={recordsError} />}
        {error && <Notice tone="error" text={error} />}
        {galleryGroups.length === 0 && (
          <div className="grid min-h-[240px] place-items-center rounded-[18px] border border-white/10 bg-white/[0.03] p-6 text-center">
            <div className="flex flex-col items-center gap-3 text-white/40">
              <Images className="size-7" />
              <span className="text-sm">生成成功的图片会出现在这里</span>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-8">
          {galleryGroups.map((group) => (
            <section key={group.key}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-white/88">{group.label}</h2>
                <span className="text-xs text-white/35">{group.items.length} 张</span>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
                {group.items.map((item) => (
                  <GalleryImageCard
                    key={item.key}
                    item={item}
                    onOpen={() => setPreviewItem({ image: item.image, job: item.job })}
                    onEditImage={() => onEditImage(item.image, generationFormFromJob(item.job))}
                    onEditPrompt={() => onEditPrompt(generationFormFromJob(item.job))}
                    onRegenerate={() => void regenerateRecord({ job: item.job, images: item.recordImages, elapsedSeconds: item.elapsedSeconds })}
                    onDelete={() => void deleteRecord({ job: item.job, images: item.recordImages, elapsedSeconds: item.elapsedSeconds })}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
        {nextCursor && (
          <CossButton type="button" variant="outline" className="mx-auto mt-8 block h-9 rounded-md border border-white/15 bg-transparent px-4 text-xs text-white/60 hover:bg-white/10 hover:text-white/80" onClick={() => void loadRecords(nextCursor)}>
            加载更多
          </CossButton>
        )}
      </div>
      {previewItem && (
        <ImagePreviewDialog
          image={previewItem.image}
          onClose={() => setPreviewItem(null)}
          onEdit={(draft, mask) => {
            onEditImage(previewItem.image, draft, mask);
            setPreviewItem(null);
          }}
          editOptions={{
            initialForm: generationFormFromJob(previewItem.job),
            availableRatios,
            qualityOptions,
            formatOptions,
            maxImagesPerRequest: config.maxImagesPerRequest,
            turnstileSiteKey: config.turnstileSiteKey,
            turnstileRequired: config.turnstileRequired,
            submitting: Boolean(regeneratingId),
            onSubmit: createEditTaskFromImage,
          }}
        />
      )}
    </section>
  );
}

function buildGalleryGroups(records: GenerationRecord[], activeJob: GenerationJob | null, activeImages: ImageItem[], elapsedSeconds: number) {
  const normalizedRecords = records.map((record) =>
    record.job.id === activeJob?.id
      ? { ...record, job: activeJob, images: activeImages, elapsedSeconds: elapsedSeconds || record.elapsedSeconds }
      : record,
  );
  const grouped = new Map<
    string,
    {
      label: string;
      items: Array<{ key: string; image: ImageItem; job: GenerationJob; recordImages: ImageItem[]; elapsedSeconds: number | null }>;
    }
  >();

  for (const record of normalizedRecords) {
    for (const image of record.images) {
      const dateKey = galleryDayKey(image.createdAt || record.job.created_at);
      const bucket = grouped.get(dateKey) ?? { label: formatGalleryGroupLabel(dateKey), items: [] };
      bucket.items.push({
        key: image.id,
        image,
        job: record.job,
        recordImages: record.images,
        elapsedSeconds: record.elapsedSeconds,
      });
      grouped.set(dateKey, bucket);
    }
  }

  return Array.from(grouped.entries())
    .sort(([left], [right]) => (left < right ? 1 : -1))
    .map(([key, value]) => ({
      key,
      label: value.label,
      items: value.items.sort((left, right) => (left.image.createdAt < right.image.createdAt ? 1 : -1)),
    }));
}

function galleryDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "older";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatGalleryGroupLabel(key: string): string {
  if (key === "older") return "较早";
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "较早";
  const now = new Date();
  if (isSameLocalDay(date, now)) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameLocalDay(date, yesterday)) return "昨天";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function GalleryHoverActionIcon({ src, className }: { src: string; className?: string }) {
  return <img aria-hidden="true" src={src} alt="" className={cn("size-4 shrink-0", className)} draggable={false} />;
}

function buildGalleryImageActions(
  item: { image: ImageItem; job: GenerationJob },
  onEditImage: () => void,
  onEditPrompt: () => void,
  onRegenerate: () => void,
  onDelete: () => void,
): HoverImageAction[] {
  return [
    { key: "continue", label: "基于这张图片继续创作", icon: <GalleryHoverActionIcon src={generationContinueIcon} />, onSelect: onEditPrompt },
    { key: "local-edit", label: "局部编辑", icon: <GalleryHoverActionIcon src={generationLocalEditIcon} />, onSelect: onEditImage },
    { key: "regenerate", label: "重新生成", icon: <GalleryHoverActionIcon src={generationRegenerateIcon} />, onSelect: onRegenerate },
    { key: "copy", label: "复制提示词", icon: <GalleryHoverActionIcon src={generationCopyIcon} />, onSelect: () => void copyPrompt(item.job.prompt) },
    { key: "download", label: "下载这张图片", icon: <GalleryHoverActionIcon src={generationDownloadIcon} />, href: imageDownloadUrl(item.image) },
    {
      key: "delete",
      label: "删除这次生成",
      icon: <GalleryHoverActionIcon src={referenceDeleteIcon} />,
      onSelect: onDelete,
      confirm: {
        title: "删除这次生成？",
        description: "会删除这次生成的图片、参考图、遮罩和生成使用的提示词记录。此操作不能撤销。",
        confirmLabel: "删除",
      },
    },
  ];
}

function GalleryImageCard({
  item,
  onOpen,
  onEditImage,
  onEditPrompt,
  onRegenerate,
  onDelete,
}: {
  item: { image: ImageItem; job: GenerationJob };
  onOpen: () => void;
  onEditImage: () => void;
  onEditPrompt: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}) {
  const actions = buildGalleryImageActions(item, onEditImage, onEditPrompt, onRegenerate, onDelete);

  return (
    <div className="group relative overflow-hidden rounded-[16px] border border-white/10 bg-white/[0.04]">
      <CossButton type="button" variant="ghost" className="block aspect-square h-auto w-full rounded-none border-0 bg-transparent p-0 hover:bg-transparent" onClick={onOpen}>
        <img src={item.image.url} alt={item.job.prompt || "生成图片"} className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]" />
      </CossButton>
      <div className="pointer-events-none absolute bottom-3 right-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <HoverImageActionBar actions={actions} maxInlineActions={actions.length} />
      </div>
    </div>
  );
}

function InspirationPlaceholderView() {
  return (
    <section className="entry-fade grid h-full flex-1 place-items-center px-6">
      <div className="rounded-[22px] border border-white/10 bg-white/[0.04] px-8 py-10 text-center">
        <p className="text-base font-medium text-white/90">灵感页正在完善·····</p>
      </div>
    </section>
  );
}

function SettingsView({ config, onSaved }: { config: AppConfig; onSaved: () => Promise<void> }) {
  const [imageBaseURL, setImageBaseURL] = useState("");
  const [imageApiKey, setImageApiKey] = useState("");
  const [imageApiKeyHint, setImageApiKeyHint] = useState("");
  const [imageModel, setImageModel] = useState(optionOrFallback(config.model, IMAGE_MODEL_OPTIONS));
  const [promptBaseURL, setPromptBaseURL] = useState("");
  const [promptApiKey, setPromptApiKey] = useState("");
  const [promptApiKeyHint, setPromptApiKeyHint] = useState("");
  const [promptModel, setPromptModel] = useState(optionOrFallback(config.promptOptimizerModel, PROMPT_OPTIMIZER_MODEL_OPTIONS));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [savingKind, setSavingKind] = useState<"image" | "prompt" | null>(null);
  const [testingKind, setTestingKind] = useState<"image" | "prompt" | null>(null);

  useEffect(() => {
    let mounted = true;
    api<{ ok: true } & SettingsProviders>("/api/settings/provider").then((result) => {
      if (!mounted) return;
      if (result.imageProvider) {
        setImageBaseURL(result.imageProvider.baseURL);
        setImageApiKeyHint(result.imageProvider.apiKeyHint);
        setImageModel(optionOrFallback(result.imageProvider.model, IMAGE_MODEL_OPTIONS));
      }
      if (result.promptProvider) {
        setPromptBaseURL(result.promptProvider.baseURL);
        setPromptApiKeyHint(result.promptProvider.apiKeyHint);
        setPromptModel(optionOrFallback(result.promptProvider.model, PROMPT_OPTIMIZER_MODEL_OPTIONS));
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  async function save(kind: "image" | "prompt") {
    setSavingKind(kind);
    setError("");
    setMessage("");
    try {
      const result = await api<{ ok: true } & SettingsProviders>("/api/settings/provider", {
        method: "POST",
        body: JSON.stringify({
          ...(kind === "image"
            ? {
                imageProvider: {
                  baseURL: imageBaseURL.trim(),
                  ...(imageApiKey.trim() ? { apiKey: imageApiKey.trim() } : {}),
                  model: imageModel,
                },
              }
            : {
                promptProvider: {
                  baseURL: promptBaseURL.trim(),
                  ...(promptApiKey.trim() ? { apiKey: promptApiKey.trim() } : {}),
                  model: promptModel,
                },
              }),
        }),
      });
      setImageApiKeyHint(result.imageProvider?.apiKeyHint ?? imageApiKeyHint);
      setPromptApiKeyHint(result.promptProvider?.apiKeyHint ?? promptApiKeyHint);
      setImageBaseURL(result.imageProvider?.baseURL ?? imageBaseURL.trim());
      setPromptBaseURL(result.promptProvider?.baseURL ?? promptBaseURL.trim());
      setImageModel(optionOrFallback(result.imageProvider?.model, IMAGE_MODEL_OPTIONS));
      setPromptModel(optionOrFallback(result.promptProvider?.model, PROMPT_OPTIMIZER_MODEL_OPTIONS));
      if (kind === "image") {
        setImageApiKey("");
      } else {
        setPromptApiKey("");
      }
      setMessage(`${kind === "image" ? "生图" : "提示词"} Provider 配置已保存。`);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败。");
    } finally {
      setSavingKind(null);
    }
  }

  async function test(kind: "image" | "prompt") {
    setTestingKind(kind);
    setError("");
    setMessage("");
    try {
      const result = await api<{ ok: true; result: { ok: boolean; message: string; status: number } }>("/api/provider/test", {
        method: "POST",
        body: JSON.stringify(
          kind === "image"
            ? {
                kind,
                baseURL: imageBaseURL.trim(),
                ...(imageApiKey.trim() ? { apiKey: imageApiKey.trim() } : {}),
              }
            : {
                kind,
                baseURL: promptBaseURL.trim(),
                ...(promptApiKey.trim() ? { apiKey: promptApiKey.trim() } : {}),
              },
        ),
      });
      setMessage(`${kind === "image" ? "生图" : "提示词"} Provider：${result.result.message}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "测试失败。");
    } finally {
      setTestingKind(null);
    }
  }

  return (
    <section className="entry-fade thin-scrollbar h-full flex-1 overflow-y-auto bg-[#191919] px-5 py-6">
      <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5">
        <div className="grid gap-5 xl:grid-cols-2">
          <SettingsProviderSection
            kind="image"
            title="生图 Provider"
            baseURL={imageBaseURL}
            apiKey={imageApiKey}
            apiKeyHint={imageApiKeyHint}
            model={imageModel}
            modelOptions={IMAGE_MODEL_OPTIONS}
            modelLabel="生图模型"
            onBaseURLChange={setImageBaseURL}
            onApiKeyChange={setImageApiKey}
            onModelChange={(value) => setImageModel(optionOrFallback(value, IMAGE_MODEL_OPTIONS))}
            onTest={() => void test("image")}
            onSave={() => void save("image")}
            saving={savingKind === "image"}
            testing={testingKind === "image"}
          />
          <SettingsProviderSection
            kind="prompt"
            title="提示词 Provider"
            baseURL={promptBaseURL}
            apiKey={promptApiKey}
            apiKeyHint={promptApiKeyHint}
            model={promptModel}
            modelOptions={PROMPT_OPTIMIZER_MODEL_OPTIONS}
            modelLabel="提示词模型"
            onBaseURLChange={setPromptBaseURL}
            onApiKeyChange={setPromptApiKey}
            onModelChange={(value) => setPromptModel(optionOrFallback(value, PROMPT_OPTIMIZER_MODEL_OPTIONS))}
            onTest={() => void test("prompt")}
            onSave={() => void save("prompt")}
            saving={savingKind === "prompt"}
            testing={testingKind === "prompt"}
          />
        </div>

        <div className="grid gap-3">
          {message && <Notice tone="success" text={message} />}
          {error && <Notice tone="error" text={error} />}
        </div>
      </div>
    </section>
  );
}

function SettingsProviderSection({
  kind,
  title,
  baseURL,
  apiKey,
  apiKeyHint,
  model,
  modelOptions,
  modelLabel,
  onBaseURLChange,
  onApiKeyChange,
  onModelChange,
  onTest,
  onSave,
  saving,
  testing,
}: {
  kind: "image" | "prompt";
  title: string;
  baseURL: string;
  apiKey: string;
  apiKeyHint: string;
  model: string;
  modelOptions: readonly string[];
  modelLabel: string;
  onBaseURLChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onTest: () => void;
  onSave: () => void;
  saving: boolean;
  testing: boolean;
}) {
  return (
    <section className="rounded-[24px] border border-white/10 bg-white/[0.04] p-5">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white/90">{title}</h2>
        </div>
        <span className="grid size-8 place-items-center rounded-[10px] bg-white/10">
          <img src={openaiIcon} alt="" className="size-4" />
        </span>
      </div>

      <CossSeparator className="mb-5 bg-white/8" />

      <div className="flex flex-col gap-3">
        <SettingsTextField id={`${title}-base-url`} label="BaseURL" value={baseURL} onChange={(event) => onBaseURLChange(event.target.value)} placeholder="请输入 baseURL" />
        <SettingsTextField
          id={`${title}-api-key`}
          label="API Key"
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
          type="password"
          autoComplete="new-password"
          placeholder={apiKeyHint ? `已保存：${apiKeyHint}` : "请输入 API Key"}
        />
        <SettingsSelectField label={modelLabel} value={model} values={modelOptions} onChange={onModelChange} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <CossButton
          type="button"
          variant="outline"
          className="h-10 rounded-[12px] border-white/25 bg-white/[0.08] px-4 py-0 text-xs font-semibold leading-none text-white/90 hover:bg-white/[0.14] hover:text-white"
          loading={saving}
          onClick={onSave}
        >
          {saving ? "保存中" : `保存${kind === "image" ? "生图" : "提示词"} Provider`}
        </CossButton>
        <CossButton
          type="button"
          variant="outline"
          className="h-10 rounded-[12px] border-white/20 bg-transparent px-4 py-0 text-xs font-semibold leading-none text-white/90 hover:bg-white/10 hover:text-white"
          onClick={onTest}
          loading={testing}
        >
          {testing ? "测试中" : "测试连接"}
        </CossButton>
      </div>
    </section>
  );
}

function SettingsTextField({
  id,
  label,
  className,
  ...props
}: InputProps & {
  id: string;
  label: string;
}) {
  return (
    <label className="flex flex-col gap-2" htmlFor={id}>
      <span className="text-xs leading-none text-white/60">{label}</span>
      <CossInput
        id={id}
        className={cn(
          "figma-settings-input text-sm font-semibold caret-white/90 placeholder:opacity-100 focus-visible:ring-white/15",
          className,
        )}
        {...props}
      />
    </label>
  );
}

function SettingsSelectField({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-xs leading-none text-white/60">{label}</span>
      <CossSelect value={value} onChange={(event) => onChange(event.target.value)} className="h-10 justify-start rounded-[10px] border-white/15 bg-transparent px-4 text-sm font-semibold text-white/90">
        {values.map((item) => (
          <option key={item} value={item} className="bg-[#191919] text-white">
            {item}
          </option>
        ))}
      </CossSelect>
    </label>
  );
}

function optionOrFallback<T extends readonly string[]>(value: string | undefined, options: T): T[number] {
  const normalized = value ?? "";
  return options.some((option) => option === normalized) ? (normalized as T[number]) : options[0];
}

function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="empty-state grid min-h-[520px] place-items-center rounded-lg border bg-card/70 p-6 text-center">
      <div className="grid max-w-sm justify-items-center gap-3">
        <div className="grid size-16 place-items-center rounded-full border bg-background text-muted-foreground">{icon}</div>
        <strong className="text-lg font-semibold">{title}</strong>
        <span className="text-sm leading-6 text-muted-foreground">{text}</span>
      </div>
    </div>
  );
}

function Notice({ tone, text }: { tone: "error" | "success" | "warn"; text: string }) {
  const variant = tone === "error" ? "destructive" : tone === "success" ? "success" : "warning";
  const Icon = tone === "success" ? CheckCircle2 : AlertCircle;
  return (
    <Alert variant={variant} className="flex items-start gap-3">
      <Icon className="mt-0.5 shrink-0" />
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

function sizeForRatioResolution(ratio: string, resolution: string): [number, number] {
  if (resolution === "1K" && baseRatioSizes[ratio]) {
    return baseRatioSizes[ratio];
  }

  const [rawWidth, rawHeight] = ratio.split(":").map((item) => Number(item));
  const ratioWidth = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : 1;
  const ratioHeight = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 1;
  const longEdge = Math.min(resolutionLongEdge[resolution] ?? resolutionLongEdge["1K"], maxLongEdgeForRatio(ratioWidth, ratioHeight));
  if (ratioWidth >= ratioHeight) {
    return [longEdge, roundToStep((longEdge * ratioHeight) / ratioWidth, 16)];
  }
  return [roundToStep((longEdge * ratioWidth) / ratioHeight, 16), longEdge];
}

function updateGenerateFormValue<K extends keyof GenerateForm>(current: GenerateForm, key: K, value: GenerateForm[K]): GenerateForm {
  const next = { ...current, [key]: value };
  if (key === "aspectRatio" || key === "resolution") {
    const [width, height] = sizeForRatioResolution(next.aspectRatio, next.resolution);
    next.width = width;
    next.height = height;
  }
  return next;
}

function generationFormFromJob(job: GenerationJob): GenerateForm {
  const aspectRatio = FIGMA_RATIOS.some((ratio) => ratio === job.aspect_ratio) ? job.aspect_ratio : defaultForm.aspectRatio;
  const resolution = formatResolution(job.width, job.height);
  const [width, height] = sizeForRatioResolution(aspectRatio, resolution);
  return {
    ...defaultForm,
    prompt: job.prompt,
    aspectRatio,
    resolution,
    width,
    height,
    quality: QUALITY_OPTIONS.some((quality) => quality === job.quality) ? job.quality : defaultForm.quality,
    quantity: 1,
    outputFormat: FORMAT_OPTIONS.some((format) => format === job.output_format) ? job.output_format : defaultForm.outputFormat,
    compression: job.compression ?? defaultForm.compression,
  };
}

function maxLongEdgeForRatio(ratioWidth: number, ratioHeight: number): number {
  const longRatio = Math.max(ratioWidth, ratioHeight);
  const shortRatio = Math.min(ratioWidth, ratioHeight);
  const maxByPixels = Math.sqrt((MAX_IMAGE_PIXELS * longRatio) / shortRatio);
  return Math.max(16, Math.floor(Math.min(MAX_IMAGE_EDGE, maxByPixels) / 16) * 16);
}

function roundToStep(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

function generationRequestBody(
  form: GenerateForm,
  turnstileToken: string,
  referenceImages: ReferenceImagePreview[],
  maskImage?: ImageSelectionMask | null,
  sourceImageId?: string,
): BodyInit {
  if (referenceImages.length === 0 && !maskImage) {
    return JSON.stringify({ ...form, turnstileToken, ...(sourceImageId ? { sourceImageId } : {}) });
  }

  const body = new FormData();
  for (const [key, value] of Object.entries(form)) {
    body.set(key, String(value));
  }
  if (turnstileToken) body.set("turnstileToken", turnstileToken);
  if (sourceImageId) body.set("sourceImageId", sourceImageId);
  for (const referenceImage of referenceImages.slice(0, MAX_REFERENCE_IMAGES)) {
    body.append("referenceImage", referenceImage.file, referenceImage.name);
  }
  if (maskImage) body.set("maskImage", maskImage.file, maskImage.name);
  return body;
}

function promptOptimizationPayload(form: GenerateForm) {
  return {
    prompt: form.prompt,
    aspectRatio: form.aspectRatio,
    width: form.width,
    height: form.height,
    quality: form.quality,
    outputFormat: form.outputFormat,
  };
}

function imageFileFromClipboard(data: DataTransfer): File | null {
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith("image/")) return file;
  }

  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }

  return null;
}

function normalizeImageMime(value: string): string {
  const mimeType = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

async function imageItemToFile(image: ImageItem): Promise<File> {
  const response = await fetch(`/api/images/${encodeURIComponent(image.id)}/download?raw=1`, { credentials: "include" });
  if (!response.ok) {
    throw new Error("图片文件加载失败，无法进入编辑。");
  }
  const blob = await response.blob();
  const responseMimeType = normalizeImageMime(response.headers.get("content-type") ?? "");
  const blobMimeType = normalizeImageMime(blob.type);
  const fallbackMimeType = normalizeImageMime(`image/${image.format || "png"}`);
  const mimeType = REFERENCE_IMAGE_MIME_TYPES.has(responseMimeType)
    ? responseMimeType
    : REFERENCE_IMAGE_MIME_TYPES.has(blobMimeType)
      ? blobMimeType
      : fallbackMimeType;
  return new File([blob], imageDownloadName(image), { type: mimeType });
}

function imageDownloadName(image: ImageItem): string {
  return `${image.id}.${image.format || "png"}`;
}

function imageDownloadUrl(image: ImageItem): string {
  return `/api/images/${encodeURIComponent(image.id)}/download?raw=1&download=1`;
}

function currentViewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") {
    return { width: 1024, height: 768 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

function imageContainRect(containerWidth: number, containerHeight: number, imageWidth: number, imageHeight: number) {
  const ratio = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 1;
  const containerRatio = containerWidth / containerHeight;
  const width = containerRatio > ratio ? containerHeight * ratio : containerWidth;
  const height = containerRatio > ratio ? containerHeight : containerWidth / ratio;
  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height,
  };
}

function imageSelectionPointFromEvent(
  event: ReactPointerEvent<HTMLCanvasElement>,
  stage: HTMLDivElement | null,
  image: ImageItem,
): ImageSelectionPoint | null {
  if (!stage) return null;
  const bounds = stage.getBoundingClientRect();
  const imageRect = imageContainRect(bounds.width, bounds.height, image.width, image.height);
  const x = event.clientX - bounds.left - imageRect.x;
  const y = event.clientY - bounds.top - imageRect.y;
  if (x < 0 || y < 0 || x > imageRect.width || y > imageRect.height) return null;
  return {
    x: clampNumber(x / imageRect.width, 0, 1),
    y: clampNumber(y / imageRect.height, 0, 1),
  };
}

function drawImageSelectionCanvas(
  canvas: HTMLCanvasElement | null,
  stage: HTMLDivElement | null,
  image: ImageItem,
  strokes: ImageSelectionStroke[],
): void {
  if (!canvas || !stage) return;
  const bounds = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const imageRect = imageContainRect(width, height, image.width, image.height);
  context.save();
  context.beginPath();
  context.rect(imageRect.x, imageRect.y, imageRect.width, imageRect.height);
  context.clip();
  context.strokeStyle = "rgba(110, 255, 48, 0.78)";
  context.fillStyle = "rgba(110, 255, 48, 0.78)";
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    drawSelectionStroke(context, stroke, imageRect);
  }
  context.restore();
}

function drawSelectionStroke(
  context: CanvasRenderingContext2D,
  stroke: ImageSelectionStroke,
  imageRect: { x: number; y: number; width: number; height: number },
): void {
  const points = stroke.points;
  if (points.length === 0) return;
  const lineWidth = Math.max(8, stroke.brushRatio * Math.min(imageRect.width, imageRect.height));
  context.lineWidth = lineWidth;
  const first = points[0];
  if (points.length === 1) {
    context.beginPath();
    context.arc(imageRect.x + first.x * imageRect.width, imageRect.y + first.y * imageRect.height, lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(imageRect.x + first.x * imageRect.width, imageRect.y + first.y * imageRect.height);
  for (const point of points.slice(1)) {
    context.lineTo(imageRect.x + point.x * imageRect.width, imageRect.y + point.y * imageRect.height);
  }
  context.stroke();
}

async function createSelectionMask(image: ImageItem, strokes: ImageSelectionStroke[]): Promise<ImageSelectionMask> {
  if (!image.width || !image.height) {
    throw new Error("图片尺寸无效，无法生成选区遮罩。");
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("浏览器不支持选区遮罩生成。");
  }

  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "destination-out";
  context.strokeStyle = "#000";
  context.fillStyle = "#000";
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    drawSelectionStroke(context, stroke, { x: 0, y: 0, width: canvas.width, height: canvas.height });
  }

  const blob = await canvasToBlob(canvas, "image/png");
  const name = `${image.id}-mask.png`;
  return {
    file: new File([blob], name, { type: "image/png" }),
    name,
  };
}

async function compressReferenceImage(file: File): Promise<{ file: File; compressed: boolean }> {
  const image = await loadBrowserImage(file);
  const scale = Math.min(1, FAST_REFERENCE_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return { file, compressed: false };
  context.drawImage(image, 0, 0, width, height);

  const preferred = await canvasToBlob(canvas, "image/webp", 0.86).catch(() => null);
  const fallback = preferred ?? (await canvasToBlob(canvas, "image/jpeg", 0.88).catch(() => null));
  if (!fallback || fallback.size >= file.size) return { file, compressed: false };

  const type = normalizeImageMime(fallback.type) || "image/jpeg";
  const extension = type === "image/webp" ? "webp" : "jpg";
  return {
    file: new File([fallback], replaceFileExtension(file.name || "reference", extension), { type }),
    compressed: true,
  };
}

function loadBrowserImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("参考图读取失败。"));
    };
    image.src = url;
  });
}

function replaceFileExtension(name: string, extension: string): string {
  const trimmed = name.trim() || "reference";
  return `${trimmed.replace(/\.[^.]+$/, "")}.${extension}`;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("选区遮罩生成失败。"));
    }, type, quality);
  });
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function imagePreviewSize(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  editing: boolean,
): { panelWidth: number; panelHeight: number; editorWidth: number } {
  const ratio = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 1;
  const maxEditorWidth = Math.max(0, viewportWidth - IMAGE_PREVIEW_VIEWPORT_GAP * 2 - IMAGE_PREVIEW_IMAGE_INSET * 2 - IMAGE_PREVIEW_MIN_STAGE_SIZE);
  const editorWidth = editing ? Math.min(IMAGE_PREVIEW_EDITOR_WIDTH, maxEditorWidth) : 0;
  const maxStageWidth = Math.max(
    IMAGE_PREVIEW_MIN_STAGE_SIZE,
    viewportWidth - IMAGE_PREVIEW_VIEWPORT_GAP * 2 - IMAGE_PREVIEW_IMAGE_INSET * 2 - editorWidth,
  );
  const maxStageHeight = Math.max(IMAGE_PREVIEW_MIN_STAGE_SIZE, viewportHeight - IMAGE_PREVIEW_VIEWPORT_GAP * 2 - IMAGE_PREVIEW_IMAGE_INSET * 2);
  const widthLimited = maxStageWidth / maxStageHeight <= ratio;
  const stageWidth = widthLimited ? maxStageWidth : maxStageHeight * ratio;
  const stageHeight = widthLimited ? maxStageWidth / ratio : maxStageHeight;

  return {
    panelWidth: Math.round(editorWidth + stageWidth + IMAGE_PREVIEW_IMAGE_INSET * 2),
    panelHeight: Math.round(stageHeight + IMAGE_PREVIEW_IMAGE_INSET * 2),
    editorWidth: Math.round(editorWidth),
  };
}

function thumbnailSize(width: number, height: number): { width: number; height: number } {
  if (!width || !height) return { width: 128, height: 128 };
  if (width >= height) return { width: 128, height: Math.max(16, Math.round((128 * height) / width)) };
  return { width: Math.max(16, Math.round((128 * width) / height)), height: 128 };
}

function mergeGenerationRecordList(
  current: GenerationRecord[],
  next: GenerationRecord[],
  mode: "replace" | "append",
): GenerationRecord[] {
  const currentById = new Map(current.map((record) => [record.job.id, record]));
  const mergedNext = next.map((record) => {
    const existing = currentById.get(record.job.id);
    return existing ? mergeGenerationRecord(existing, record) : record;
  });

  if (mode === "replace") return mergedNext;

  const mergedNextById = new Map(mergedNext.map((record) => [record.job.id, record]));
  return [
    ...current.map((record) => mergedNextById.get(record.job.id) ?? record),
    ...mergedNext.filter((record) => !currentById.has(record.job.id)),
  ];
}

function mergeGenerationRecord(current: GenerationRecord, next: GenerationRecord): GenerationRecord {
  const job = mergePolledJobState(current.job, next.job);
  return {
    ...next,
    job,
    images: mergeImageItems(current.images, next.images),
    elapsedSeconds: next.elapsedSeconds ?? current.elapsedSeconds,
  };
}

function mergeImageItems(current: ImageItem[], next: ImageItem[]): ImageItem[] {
  if (current.length === 0) return next;
  if (next.length === 0) return current;

  const nextIds = new Set(next.map((image) => image.id));
  return [...next, ...current.filter((image) => !nextIds.has(image.id))];
}

function formatResolution(width: number, height: number): string {
  const longEdge = Math.max(width, height);
  for (const resolution of RESOLUTIONS) {
    for (const ratio of FIGMA_RATIOS) {
      const [presetWidth, presetHeight] = sizeForRatioResolution(ratio, resolution);
      if (width === presetWidth && height === presetHeight) return resolution;
    }
  }
  if (longEdge >= 3584) return "4K";
  if (longEdge >= 2048) return "2K";
  return "1K";
}

function estimateJobElapsed(job: GenerationJob): number | null {
  const start = parseUtcTimestamp(job.started_at ?? job.created_at);
  const end = job.completed_at ? parseUtcTimestamp(job.completed_at) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function formatRecordElapsed(seconds: number | null): string {
  if (seconds === null) return "耗时：--";
  return `耗时：${seconds.toFixed(1)}s`;
}

function statusLabel(status: GenerationJob["status"]): string {
  return {
    queued: "任务排队中",
    running: "正在生成",
    succeeded: "生成完成",
    partial_succeeded: "部分完成",
    failed: "生成失败",
    cancelled: "已取消",
  }[status];
}

function stageFromJobStatus(status: GenerationJob["status"]): NonNullable<GenerationJob["stage"]> {
  if (status === "queued") return "queued";
  if (status === "running") return "waiting_provider";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  return "completed";
}

function stageLabel(stage: NonNullable<GenerationJob["stage"]>): string {
  return {
    queued: "排队",
    submitting: "提交上游",
    waiting_provider: "等待模型",
    saving: "保存图片",
    completed: "完成",
    failed: "失败",
    cancelled: "取消",
  }[stage];
}

function terminalTimelineLabel(job: GenerationJob): string {
  if (!isTerminalJobStatus(job.status)) return "待完成";
  if (job.status === "partial_succeeded") return "部分完成";
  return statusText(job.status).replace("任务", "");
}

function completedResultCount(job: GenerationJob): number {
  const results = job.results ?? [];
  if (results.length > 0) return results.filter((result) => result.status === "succeeded" || result.status === "failed").length;
  if (isTerminalJobStatus(job.status)) return job.quantity;
  return 0;
}

function resizePromptTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, PROMPT_TEXTAREA_MAX_HEIGHT);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > PROMPT_TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
}

function generationJobErrorMessage(job: Pick<GenerationJob, "error_code" | "error_message">, fallback: string): string {
  const message = job.error_message?.trim();
  const cloudflareTimeoutMatch = message?.match(/\berror code:\s*(522|524)\b/i);
  if (cloudflareTimeoutMatch) {
    return `模型服务返回 ${cloudflareTimeoutMatch[1]}，上游网关等待模型服务超时。请检查 baseURL 前面的 Cloudflare、反向代理、负载均衡或模型服务超时设置。`;
  }
  if (message) return message;
  if (job.error_code === "provider_timeout") {
    return "模型服务等待超时，请稍后重试，或检查 baseURL 的网关与模型服务超时设置。";
  }
  return fallback;
}

function isTerminalJobStatus(status: GenerationJob["status"]): boolean {
  return isTerminalGenerationJobStatus(status);
}

async function copyPrompt(prompt: string): Promise<void> {
  if (!navigator.clipboard) return;
  await navigator.clipboard.writeText(prompt);
}

function downloadAllImages(record: GenerationRecord): void {
  record.images.forEach((image, index) => {
    const anchor = document.createElement("a");
    anchor.href = imageDownloadUrl(image);
    anchor.download = `${record.job.id}-${index + 1}.${image.format}`;
    anchor.rel = "noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  });
}

function statusText(status: GenerationJob["status"]): string {
  return {
    queued: "任务排队中",
    running: "正在生成",
    succeeded: "生成完成",
    partial_succeeded: "部分完成",
    failed: "生成失败",
    cancelled: "已取消",
  }[status];
}

function parseUtcTimestamp(value: string): number {
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) return Date.parse(value);
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback": () => void;
          theme: "light" | "dark";
        },
      ) => string;
      remove?: (widgetId: string) => void;
    };
  }
}

function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let cancelled = false;
    let widgetId = "";

    function render() {
      if (cancelled || !ref.current || !window.turnstile) return;
      widgetId = window.turnstile.render(ref.current, {
        sitekey: siteKey,
        callback: onToken,
        "expired-callback": () => onToken(""),
        theme: "dark",
      });
    }

    if (!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      script.async = true;
      script.defer = true;
      script.onload = render;
      document.head.appendChild(script);
    } else {
      render();
    }

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile?.remove) window.turnstile.remove(widgetId);
    };
  }, [onToken, siteKey]);

  return <div ref={ref} />;
}
