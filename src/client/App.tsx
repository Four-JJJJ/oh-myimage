import {
  AlertCircle,
  CloudDownload,
  CheckCircle2,
  Copy,
  Download,
  Edit3,
  FileText,
  Images,
  Loader2,
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
import { Alert, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Input, type InputProps } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Separator } from "./components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { api, AppConfig, GenerationJob, GenerationRecord, ImageItem, ProviderSettings } from "./api";
import addIcon from "./assets/figma/add.svg";
import figmaLogo from "./assets/figma/logo.png";
import navGalleryActiveIcon from "./assets/figma/nav-gallery-active.svg";
import navGalleryIcon from "./assets/figma/nav-gallery.svg";
import navGenerateActiveIcon from "./assets/figma/nav-generate-active.svg";
import navGenerateIcon from "./assets/figma/nav-generate.svg";
import navSettingsActiveIcon from "./assets/figma/nav-settings-active.svg";
import navSettingsIcon from "./assets/figma/nav-settings.svg";
import openaiIcon from "./assets/figma/openai.svg";
import optimizeIcon from "./assets/figma/optimize.svg";
import referenceDeleteIcon from "./assets/figma/reference-delete.svg";
import { cn } from "./lib/utils";

type View = "generate" | "gallery" | "settings";

interface MeState {
  space: { id: string; name: string };
  providerConfigured: boolean;
  usesTokenFourjProvider?: boolean;
  dailyLimitExempt?: boolean;
  dailyRemaining?: number;
  dailyLimit?: number;
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
const REFERENCE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_EDGE = 3840;
const MAX_IMAGE_PIXELS = 8_294_400;

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
const DOT_MATRIX_COLUMNS = 13;
const DOT_MATRIX_ROWS = 9;
const DOT_MATRIX_DOTS = Array.from({ length: DOT_MATRIX_COLUMNS * DOT_MATRIX_ROWS }, (_, index) => ({
  index,
  column: index % DOT_MATRIX_COLUMNS,
  row: Math.floor(index / DOT_MATRIX_COLUMNS),
}));

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

const viewItems: Array<{ value: View; label: string; helper: string; asset: string; activeAsset: string }> = [
  { value: "generate", label: "生成", helper: "Prompt", asset: navGenerateIcon, activeAsset: navGenerateActiveIcon },
  { value: "gallery", label: "图库", helper: "Assets", asset: navGalleryIcon, activeAsset: navGalleryActiveIcon },
  { value: "settings", label: "设置", helper: "Provider", asset: navSettingsIcon, activeAsset: navSettingsActiveIcon },
];

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
  const [booting, setBooting] = useState(true);

  const effectiveConfig = config ?? fallbackConfig;
  const dailyRemainingLabel = me?.dailyRemaining ?? effectiveConfig.maxDailyImagesPerSpace;
  const hideSmallTokenPromos = Boolean(me?.usesTokenFourjProvider);

  const loadGenerationRecords = useCallback<LoadGenerationRecords>(async (cursor) => {
    setGenerationRecordsError("");
    try {
      const path = cursor ? `/api/generations?cursor=${encodeURIComponent(cursor)}` : "/api/generations";
      const result = await api<{ ok: true; records: GenerationRecord[]; nextCursor: string | null }>(path);
      setGenerationRecords((current) => mergeGenerationRecordList(current, result.records, cursor ? "append" : "replace"));
      setGenerationNextCursor(result.nextCursor);
    } catch (err) {
      setGenerationRecordsError(err instanceof Error ? err.message : "生成记录加载失败。");
    }
  }, []);

  const refreshMe = useCallback(async () => {
    const result = await api<{
      ok: true;
      space: MeState["space"];
      providerConfigured: boolean;
      usesTokenFourjProvider?: boolean;
      dailyLimitExempt?: boolean;
      dailyRemaining?: number;
      dailyLimit?: number;
    }>("/api/me");
    setMe({
      space: result.space,
      providerConfigured: result.providerConfigured,
      usesTokenFourjProvider: result.usesTokenFourjProvider,
      dailyLimitExempt: result.dailyLimitExempt,
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
      api<{ ok: true; config: AppConfig }>("/api/config").then((result) => result.config),
      api<{
        ok: true;
        space: MeState["space"];
        providerConfigured: boolean;
        usesTokenFourjProvider?: boolean;
        dailyLimitExempt?: boolean;
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
              usesTokenFourjProvider: user.usesTokenFourjProvider,
              dailyLimitExempt: user.dailyLimitExempt,
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
      return;
    }

    setGenerationRecords([]);
    setGenerationNextCursor(null);
    void loadGenerationRecords();
  }, [loadGenerationRecords, me?.space.id]);

  if (booting) {
    return (
      <main className="app-shell grid min-h-screen place-items-center">
        <div className="entry-fade flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
          <span className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground">
            <Loader2 className="animate-spin" />
          </span>
          <span className="text-sm font-medium text-foreground">正在打开创作台</span>
        </div>
      </main>
    );
  }

  if (!me) {
    return <LoginScreen config={effectiveConfig} onLogin={refreshMe} />;
  }

  const spaceDisplayName = me.space.name.trim() || "Workspace";
  const studioDisplayName = `${spaceDisplayName} Studio`;

  return (
    <TooltipProvider delayDuration={140}>
      <main className="figma-app h-dvh overflow-hidden text-foreground">
        <div className="flex h-dvh overflow-hidden">
          <aside className="figma-left-rail hidden h-dvh w-16 shrink-0 overflow-hidden lg:flex lg:flex-col lg:items-center">
            <div className="grid h-16 w-full place-items-center">
              <img src={figmaLogo} alt={studioDisplayName} className="size-10 object-contain" />
            </div>
            <nav className="mt-3 flex flex-1 flex-col items-center gap-3">
              {viewItems.map((item) => {
                const selected = view === item.value;
                return (
                  <Tooltip key={item.value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn("figma-nav-button", selected && "figma-nav-button-active")}
                        aria-label={item.label}
                        onClick={() => setView(item.value)}
                      >
                        <img src={selected ? item.activeAsset : item.asset} alt="" className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </nav>
            {view !== "settings" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="figma-nav-button mb-4"
                    aria-label="离开空间"
                    onClick={async () => {
                      await api("/api/auth/logout", { method: "POST" });
                      setMe(null);
                    }}
                  >
                    <LogOut className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">离开空间</TooltipContent>
              </Tooltip>
            )}
          </aside>

          <section className="flex h-dvh min-w-0 flex-1 flex-col overflow-hidden">
            <header className="figma-top-bar flex h-16 shrink-0 items-center justify-between overflow-hidden border-b px-4">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <img src={figmaLogo} alt={studioDisplayName} className="mr-3 size-9 shrink-0 object-contain lg:hidden" />
                <span className="truncate text-base font-semibold leading-6 text-white">{spaceDisplayName}</span>
                <span className="shrink-0 text-base leading-6 text-white/60">Studio</span>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs">
                {!hideSmallTokenPromos && (
                  <div className="hidden items-center gap-2 rounded-md border border-white/10 px-2 py-1 text-white/60 md:flex">
                    <span>使用 Small Token 解除张数限制</span>
                    <button type="button" className="font-medium text-[#6eff30]">
                      去购买
                    </button>
                  </div>
                )}
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1",
                    me.dailyLimitExempt ? "border border-white/10 text-white/60" : "bg-[#373737]",
                  )}
                >
                  {me.dailyLimitExempt ? (
                    <>
                      <CheckCircle2 className="size-3" aria-hidden="true" />
                      <span className="text-white/60">已解锁数量限制</span>
                    </>
                  ) : (
                    <>
                      <span className="text-white/60">剩余张数</span>
                      <span className="font-semibold text-[#6eff30]">{dailyRemainingLabel}</span>
                    </>
                  )}
                </div>
              </div>
            </header>

            {view === "generate" && (
              <GenerateView
                config={effectiveConfig}
                providerConfigured={me.providerConfigured}
                records={generationRecords}
                setRecords={setGenerationRecords}
                recordsError={generationRecordsError}
                nextCursor={generationNextCursor}
                loadRecords={loadGenerationRecords}
                onProviderNeeded={() => setView("settings")}
                pendingEditImage={imageToEdit}
                pendingEditForm={imageEditDraft}
                pendingEditMask={imageEditMask}
                pendingGenerateForm={pendingGenerateForm}
                onPendingEditImageConsumed={clearImageToEdit}
                onPendingGenerateFormConsumed={clearPendingGenerateForm}
                onUsageChanged={refreshMe}
              />
            )}
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
                onUsageChanged={refreshMe}
              />
            )}
            {view === "settings" && <SettingsView config={effectiveConfig} onSaved={refreshMe} />}
          </section>
        </div>
      </main>
    </TooltipProvider>
  );
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
    <main className="figma-login-home relative min-h-dvh overflow-hidden bg-[#191919] text-white">
      <header className="h-16 overflow-hidden border-b border-white/10 px-4">
        <div className="flex h-full items-center gap-1 leading-6">
          <span className="text-base font-semibold text-white/90">oh-myimage</span>
          <span className="text-base font-normal text-white/60">Studio</span>
        </div>
      </header>

      <section className="absolute left-1/2 top-[104px] w-[calc(100vw-32px)] max-w-[368px] -translate-x-1/2">
        <img src={figmaLogo} alt="" className="size-10 object-cover" />
        <div className="mt-0.5 flex items-center gap-2 leading-6">
          <span className="text-base font-normal text-white/60">欢迎使用</span>
          <span className="text-base font-semibold text-white/90">oh-myimage</span>
        </div>

        <form className="mt-10" onSubmit={submit}>
          <Label htmlFor="space-name" className="block text-xs font-normal leading-none text-white/90">
            空间名字
          </Label>
          <Input
            id="space-name"
            value={spaceName}
            onChange={(event) => setSpaceName(event.target.value)}
            minLength={2}
            autoComplete="username"
            placeholder="请输入空间名称"
            required
            className="mt-2 h-[34px] rounded-[10px] border-white/15 bg-transparent px-2 py-0 text-xs leading-none text-white/90 placeholder:text-white/40 placeholder:opacity-100 focus-visible:ring-0 focus-visible:ring-offset-0"
          />

          <Label htmlFor="space-password" className="mt-3.5 block text-xs font-normal leading-none text-white/90">
            空间密码
          </Label>
          <Input
            id="space-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            minLength={8}
            autoComplete="current-password"
            placeholder="请输入空间密码"
            required
            className="mt-2 h-[34px] rounded-[10px] border-white/15 bg-transparent px-2 py-0 text-xs leading-none text-white/90 placeholder:text-white/40 placeholder:opacity-100 focus-visible:ring-0 focus-visible:ring-offset-0"
          />

          <Button
            className="mt-[22px] h-[34px] w-full rounded-[10px] border border-[#6eff30] bg-transparent px-2 py-0 text-xs font-semibold leading-none text-[#6eff30] hover:bg-transparent hover:text-[#6eff30] focus-visible:ring-[#6eff30]/40"
            disabled={loading}
          >
            {loading ? "进入中" : "进入空间"}
          </Button>

          <p className="mt-1.5 text-xs font-normal leading-[18px] text-white/40">新空间会自动创建；忘记空间名或密码无法找回</p>

          <div className="mt-3 flex flex-col gap-3">
            {config.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />}
            {config.turnstileRequired && !config.turnstileSiteKey && <Notice tone="warn" text="Turnstile 已启用，请配置站点 Key。" />}
            {error && <Notice tone="error" text={error} />}
          </div>
        </form>
      </section>
    </main>
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
  const [referenceImage, setReferenceImage] = useState<ReferenceImagePreview | null>(null);
  const [referenceMask, setReferenceMask] = useState<ImageSelectionMask | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  const referenceObjectUrlRef = useRef<string | null>(null);

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
  const setReferenceFile = useCallback((file: File) => {
    const mimeType = normalizeImageMime(file.type);
    if (!REFERENCE_IMAGE_MIME_TYPES.has(mimeType)) {
      setError("参考图仅支持 PNG、JPEG 或 WebP 格式。");
      return;
    }
    if (file.size > REFERENCE_IMAGE_MAX_BYTES) {
      setError("参考图不能超过 10MB。");
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    if (referenceObjectUrlRef.current) {
      URL.revokeObjectURL(referenceObjectUrlRef.current);
    }
    referenceObjectUrlRef.current = nextUrl;
    setReferenceImage({
      file,
      url: nextUrl,
      name: file.name || "参考图",
    });
    setReferenceMask(null);
    setError("");
  }, []);
  const loadImageForEditing = useCallback(
    async (image: ImageItem, prompt?: string, mask?: ImageSelectionMask | null) => {
      setError("");
      try {
        const file = await imageItemToFile(image);
        const nextPrompt = prompt ?? image.prompt ?? "";
        setReferenceFile(file);
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
    [setReferenceFile],
  );

  const clearReferenceImage = useCallback(() => {
    if (referenceObjectUrlRef.current) {
      URL.revokeObjectURL(referenceObjectUrlRef.current);
      referenceObjectUrlRef.current = null;
    }
    setReferenceImage(null);
    if (referenceInputRef.current) {
      referenceInputRef.current.value = "";
    }
    setReferenceMask(null);
  }, []);

  useEffect(() => {
    return () => {
      if (referenceObjectUrlRef.current) {
        URL.revokeObjectURL(referenceObjectUrlRef.current);
        referenceObjectUrlRef.current = null;
      }
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
    const file = event.target.files?.[0];
    if (file) setReferenceFile(file);
    event.target.value = "";
  }

  function handlePromptPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = imageFileFromClipboard(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    setReferenceFile(file);
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
        body: generationRequestBody(form, turnstileToken, referenceImage, referenceMask),
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
        body: generationRequestBody(draft, editTurnstileToken, null, selectionMask ?? null, image.id),
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
              <button type="button" className="flex shrink-0 items-center gap-2 text-xs leading-[18px]" onClick={onProviderNeeded}>
                <span className="text-white/60">暂无 Provider 配置</span>
                <span className="text-[#6eff30]">去设置</span>
              </button>
            )}
          </div>

          <section className="mt-4">
            <div className="mb-2 flex h-[18px] items-center justify-between">
              <Label className="text-xs font-semibold leading-[18px] text-white">提示词</Label>
              <button
                type="button"
                className="flex h-[18px] items-center gap-1.5 text-xs leading-[18px] text-[#6eff30] disabled:cursor-not-allowed disabled:opacity-55"
                disabled={optimizingPrompt || loading}
                onClick={() => void optimizeCurrentPrompt()}
              >
                {optimizingPrompt ? <Loader2 className="size-3 animate-spin" /> : <img src={optimizeIcon} alt="" className="size-3" />}
                {optimizingPrompt ? "优化中" : "提示词优化"}
              </button>
            </div>
            <div className="figma-prompt-box relative h-[200px] overflow-hidden rounded-[10px] border border-white/15 p-3">
              <textarea
                ref={promptTextareaRef}
                value={form.prompt}
                onChange={(event) => update("prompt", event.target.value)}
                onPaste={handlePromptPaste}
                placeholder="可以直接描述想生成的图片内容，例如：主体 / 材质 / 构图 / 风格 / 镜头 / 光线等"
                required
                className="figma-prompt-textarea block h-[100px] min-h-0 w-full resize-none rounded-none border-0 bg-transparent p-0 text-xs leading-[18px] text-white/80 outline-none placeholder:text-white/40"
              />
              <input ref={referenceInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleReferenceInputChange} />
              <div className="absolute bottom-3 left-3 h-16 w-12">
                <button
                  type="button"
                  className="absolute inset-0 grid overflow-hidden rounded-[6px] border border-white/10 bg-white/10"
                  aria-label={referenceImage ? "更换参考图" : "添加参考图"}
                  title={referenceImage ? "更换参考图" : "添加参考图"}
                  onClick={() => referenceInputRef.current?.click()}
                >
                  {referenceImage ? (
                    <img src={referenceImage.url} alt={referenceImage.name} className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center">
                      <img src={addIcon} alt="" className="size-4" />
                    </span>
                  )}
                </button>
                {referenceImage && (
                  <button
                    type="button"
                    className="absolute left-[27px] top-[3px] z-10 grid size-4 place-items-center overflow-hidden rounded bg-black/80"
                    aria-label="删除参考图"
                    title="删除参考图"
                    onClick={clearReferenceImage}
                  >
                    <img src={referenceDeleteIcon} alt="" className="size-3" />
                  </button>
                )}
                {referenceImage && referenceMask && <span className="absolute bottom-1 right-1 size-2 rounded-full bg-[#6eff30]" aria-label="已应用选区遮罩" />}
              </div>
            </div>
          </section>

          <section className="mt-4 pb-4">
            <Label className="mb-2 block text-xs font-semibold leading-[18px] text-white">参数</Label>
            <div className="figma-param-panel flex flex-col gap-4 rounded-[10px] border border-white/15 p-3">
              <OptionGroup label="比例">
                {availableRatios.map((ratio) => (
                  <SegmentButton key={ratio} active={form.aspectRatio === ratio} onClick={() => update("aspectRatio", ratio)}>
                    {ratio}
                  </SegmentButton>
                ))}
              </OptionGroup>

              <OptionGroup label="质量">
                {qualityOptions.map((quality) => (
                  <SegmentButton key={quality} active={form.quality === quality} grow onClick={() => update("quality", quality)}>
                    {qualityLabels[quality] ?? quality}
                  </SegmentButton>
                ))}
              </OptionGroup>

              <OptionGroup label="分辨率">
                {RESOLUTIONS.map((resolution) => (
                  <SegmentButton key={resolution} active={form.resolution === resolution} grow onClick={() => update("resolution", resolution)}>
                    {resolution}
                  </SegmentButton>
                ))}
              </OptionGroup>

              <OptionGroup label="数量">
                {Array.from({ length: Math.min(config.maxImagesPerRequest, 4) }, (_, index) => String(index + 1)).map((quantity) => (
                  <SegmentButton key={quantity} active={form.quantity === Number(quantity)} grow onClick={() => update("quantity", Number(quantity))}>
                    {quantity}
                  </SegmentButton>
                ))}
              </OptionGroup>

              <OptionGroup label="格式">
                {formatOptions.map((format) => (
                  <SegmentButton key={format} active={form.outputFormat === format} grow onClick={() => update("outputFormat", format)}>
                    {formatLabels[format] ?? format.toUpperCase()}
                  </SegmentButton>
                ))}
              </OptionGroup>
            </div>

            <div className="mt-4 flex flex-col gap-3">
              {error && <Notice tone="error" text={error} />}
              {config.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />}
            </div>
          </section>
        </div>

        <div className="shrink-0 px-4 pb-4 pt-3">
          <div className="flex items-center justify-between gap-4">
            <p className="truncate text-xs leading-[18px] text-white/40">禁止利用功能从事违法活动</p>
            <button
              type="submit"
              className="figma-generate-button flex h-[34px] w-[120px] shrink-0 items-center justify-center rounded-[10px] border border-[#6eff30] text-xs font-semibold leading-none text-[#6eff30] disabled:cursor-not-allowed disabled:opacity-55"
              disabled={loading}
            >
              {loading ? "生成中" : "生成任务"}
            </button>
          </div>
        </div>
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
            <button type="button" className="mx-auto mb-2 h-8 rounded-md border border-white/15 px-4 text-xs text-white/60" onClick={() => void loadRecords(nextCursor)}>
              加载更多
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function OptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-[18px] text-white/60">{label}</p>
      <div className="flex w-full items-center gap-1">{children}</div>
    </div>
  );
}

function SegmentButton({
  active,
  grow = false,
  children,
  onClick,
}: {
  active: boolean;
  grow?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "figma-segment h-[28px] rounded-md border px-2 text-center text-xs font-semibold leading-[18px] text-white/90",
        grow ? "min-w-0 flex-1" : "w-[44px] shrink-0",
        active ? "border-white/90 bg-white/10" : "border-white/10 bg-transparent",
      )}
      onClick={onClick}
    >
      {children}
    </button>
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
        {Array.from({ length: slotCount }, (_, index) => (
          <GenerationImageSlot
            key={`${record.job.id}-${index}`}
            job={record.job}
            image={record.images[index]}
            loading={isGenerating && !record.images[index]}
            index={index}
            onOpen={(image) => setPreviewImage(image)}
          />
        ))}
        {showEmptyPlaceholder && <GenerationPlaceholderThumbnail job={record.job} />}
      </div>

      <p className="record-prompt min-w-full text-xs leading-[18px] text-white/40">
        {record.job.prompt || statusLabel(record.job.status)}
      </p>
      {recordError && <p className="text-xs leading-[18px] text-destructive">{recordError}</p>}

      <div className="flex min-h-5 items-center gap-10">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <span key={chip} className="rounded-md bg-white/10 px-2 py-1 text-xs leading-none text-white/60">
              {chip}
            </span>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-4 text-white/90">
          <button type="button" className="figma-icon-action" aria-label="删除记录" onClick={onDelete}>
            <Trash2 className="size-[14px]" />
          </button>
          <button type="button" className="figma-icon-action" aria-label="重新生成" onClick={onRegenerate}>
            <RotateCcw className="size-[14px]" />
          </button>
          <button type="button" className="figma-icon-action" aria-label="编辑提示词" onClick={onEditPrompt}>
            <Edit3 className="size-[14px]" />
          </button>
          <button type="button" className="figma-icon-action" aria-label="复制提示词" onClick={() => void copyPrompt(record.job.prompt)}>
            <Copy className="size-[14px]" />
          </button>
          <button
            type="button"
            className="figma-icon-action disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="下载全部图片"
            disabled={record.images.length === 0}
            onClick={() => downloadAllImages(record)}
          >
            <CloudDownload className="size-[14px]" />
          </button>
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
  loading,
  index,
  onOpen,
}: {
  job: GenerationJob;
  image?: ImageItem;
  loading: boolean;
  index: number;
  onOpen: (image: ImageItem) => void;
}) {
  if (image) {
    return <GenerationThumbnail image={image} onOpen={() => onOpen(image)} />;
  }

  return <GenerationPlaceholderThumbnail job={job} loading={loading} loadingIndex={index} />;
}

function GenerationPlaceholderThumbnail({
  job,
  loading = false,
  loadingIndex = 0,
}: {
  job: GenerationJob;
  loading?: boolean;
  loadingIndex?: number;
}) {
  const size = thumbnailSize(job.width, job.height);
  const dotSize = Math.min(3, Math.max(2, Math.min(size.width / 32, size.height / 24)));
  const dotGap = Math.min(
    5,
    Math.max(
      2.6,
      Math.min(
        (size.width - DOT_MATRIX_COLUMNS * dotSize) / Math.max(1, DOT_MATRIX_COLUMNS - 1),
        (size.height - DOT_MATRIX_ROWS * dotSize) / Math.max(1, DOT_MATRIX_ROWS - 1),
      ),
    ),
  );
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-md border border-white/10 bg-white/10 text-white/40",
        loading && "generation-loading-thumbnail",
      )}
      style={
        {
          width: size.width,
          height: size.height,
          "--dot-size": `${dotSize}px`,
          "--dot-gap": `${dotGap}px`,
        } as CSSProperties
      }
      aria-label={loading ? "图片生成中" : "暂无生成图片"}
    >
      {loading ? <GenerationDotMatrixLoader delayIndex={loadingIndex} /> : <FileText className="size-5" />}
    </div>
  );
}

function GenerationDotMatrixLoader({ delayIndex }: { delayIndex: number }) {
  return (
    <div className="generation-dot-matrix-loader" aria-hidden="true">
      {DOT_MATRIX_DOTS.map((dot) => (
        <span
          key={dot.index}
          className="generation-dot-matrix-dot"
          style={
            {
              "--dot-delay": `${delayIndex * 120 + dot.column * 34 - dot.row * 16}ms`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

function GenerationThumbnail({ image, onOpen }: { image: ImageItem; onOpen: () => void }) {
  const size = thumbnailSize(image.width, image.height);
  return (
    <button
      type="button"
      className="block shrink-0 overflow-hidden rounded-md border border-white/10 bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      style={{ width: size.width, height: size.height }}
      aria-label="查看大图"
      onClick={onOpen}
    >
      <img key={image.id} src={image.url} alt={image.prompt ?? "生成图片"} loading="lazy" className="size-full object-cover" />
    </button>
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
            <button type="button" className="image-preview-action" onClick={cancelSelectionEdit}>
              <X />
              <span>取消选区编辑</span>
            </button>
            <div className="flex items-center gap-5">
              <button type="button" className="image-preview-action" disabled={selectionStrokes.length === 0} onClick={undoSelectionStroke}>
                <Undo2 />
                <span>上一步</span>
              </button>
              <button type="button" className="image-preview-action" disabled={redoSelectionStrokes.length === 0} onClick={redoSelectionStroke}>
                <span>下一步</span>
                <Redo2 />
              </button>
            </div>
            <span aria-hidden="true" />
          </div>
        ) : (
          <div className="image-preview-actions">
            {editing ? (
              <button type="button" className="image-preview-action" onClick={beginSelectionEdit}>
                <Edit3 />
                <span>选区编辑</span>
              </button>
            ) : (
              <button type="button" className="image-preview-action" onClick={() => setEditing(true)}>
                <Edit3 />
                <span>编辑图片</span>
              </button>
            )}
            <a className="image-preview-action" href={imageDownloadUrl(image)} download={imageDownloadName(image)}>
              <Download />
              <span>下载图片</span>
            </a>
          </div>
        )}
        <button type="button" className="image-preview-close" aria-label="关闭预览" onClick={onClose}>
          <X />
        </button>
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
  return (
    <form className="image-preview-editor" onSubmit={onSubmit}>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pt-4">
        <section>
          <div className="mb-2 flex h-[18px] items-center justify-between">
            <Label className="text-xs font-semibold leading-[18px] text-white">提示词</Label>
            <button
              type="button"
              className="flex h-[18px] items-center gap-1.5 text-xs leading-[18px] text-[#6eff30] disabled:cursor-not-allowed disabled:opacity-55"
              disabled={optimizing || submitting}
              onClick={onOptimize}
            >
              {optimizing ? <Loader2 className="size-3 animate-spin" /> : <img src={optimizeIcon} alt="" className="size-3" />}
              {optimizing ? "优化中" : "提示词优化"}
            </button>
          </div>
          <div className="figma-prompt-box relative h-[200px] overflow-hidden rounded-[10px] border border-white/15 p-3">
            <textarea
              value={draft.prompt}
              onChange={(event) => onDraftChange("prompt", event.target.value)}
              placeholder="可以直接描述想生成的图片内容，例如：主体 / 材质 / 构图 / 风格 / 镜头 / 光线等"
              required
              className="figma-prompt-textarea block h-[100px] min-h-0 w-full resize-none rounded-none border-0 bg-transparent p-0 text-xs leading-[18px] text-white/80 outline-none placeholder:text-white/40"
            />
            <div className="absolute bottom-3 left-3 grid h-16 w-12 place-items-center overflow-hidden rounded-[6px] bg-white/10">
              <img src={addIcon} alt="" className="size-4" />
            </div>
          </div>
        </section>

        <section className="mt-4 pb-4">
          <Label className="mb-2 block text-xs font-semibold leading-[18px] text-white">参数</Label>
          <div className="figma-param-panel flex flex-col gap-4 rounded-[10px] border border-white/15 p-3">
            <OptionGroup label="比例">
              {availableRatios.map((ratio) => (
                <SegmentButton key={ratio} active={draft.aspectRatio === ratio} onClick={() => onDraftChange("aspectRatio", ratio)}>
                  {ratio}
                </SegmentButton>
              ))}
            </OptionGroup>

            <OptionGroup label="质量">
              {qualityOptions.map((quality) => (
                <SegmentButton key={quality} active={draft.quality === quality} grow onClick={() => onDraftChange("quality", quality)}>
                  {qualityLabels[quality] ?? quality}
                </SegmentButton>
              ))}
            </OptionGroup>

            <OptionGroup label="分辨率">
              {RESOLUTIONS.map((resolution) => (
                <SegmentButton key={resolution} active={draft.resolution === resolution} grow onClick={() => onDraftChange("resolution", resolution)}>
                  {resolution}
                </SegmentButton>
              ))}
            </OptionGroup>

            <OptionGroup label="数量">
              {Array.from({ length: Math.min(maxImagesPerRequest, 4) }, (_, index) => String(index + 1)).map((quantity) => (
                <SegmentButton key={quantity} active={draft.quantity === Number(quantity)} grow onClick={() => onDraftChange("quantity", Number(quantity))}>
                  {quantity}
                </SegmentButton>
              ))}
            </OptionGroup>

            <OptionGroup label="格式">
              {formatOptions.map((format) => (
                <SegmentButton key={format} active={draft.outputFormat === format} grow onClick={() => onDraftChange("outputFormat", format)}>
                  {formatLabels[format] ?? format.toUpperCase()}
                </SegmentButton>
              ))}
            </OptionGroup>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            {turnstileSiteKey && <Turnstile siteKey={turnstileSiteKey} onToken={onTurnstileToken} />}
            {turnstileRequired && !turnstileSiteKey && <Notice tone="warn" text="Turnstile 已启用，请配置站点 Key。" />}
          </div>
          {error && <p className="mt-3 text-xs leading-[18px] text-destructive">{error}</p>}
        </section>
      </div>

      <div className="shrink-0 px-4 pb-4 pt-3">
        <div className="flex items-center justify-between gap-4">
          <p className="truncate text-xs leading-[18px] text-white/40">禁止利用功能从事违法活动</p>
          <button
            type="submit"
            className="figma-generate-button flex h-[34px] w-[120px] shrink-0 items-center justify-center rounded-[10px] border border-[#6eff30] text-xs font-semibold leading-none text-[#6eff30] disabled:cursor-not-allowed disabled:opacity-55"
            disabled={submitting}
          >
            {submitting ? "生成中" : "生成任务"}
          </button>
        </div>
      </div>
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
  onUsageChanged: () => Promise<void>;
}) {
  const [activeJob, setActiveJob] = useState<GenerationJob | null>(null);
  const [activeImages, setActiveImages] = useState<ImageItem[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
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
        body: generationRequestBody(draft, turnstileToken, null, selectionMask ?? null, image.id),
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
    <section className="entry-fade figma-records thin-scrollbar h-[calc(100dvh-64px)] flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto flex w-[800px] max-w-full flex-col gap-3">
        {recordsError && <Notice tone="error" text={recordsError} />}
        {error && <Notice tone="error" text={error} />}
        {records.length === 0 && (
          <div className="figma-record-card grid min-h-[188px] place-items-center rounded-[10px] border border-white/15 p-6 text-center">
            <div className="flex flex-col items-center gap-3 text-white/40">
              <Images className="size-7" />
              <span className="text-xs">生成记录会出现在这里</span>
            </div>
          </div>
        )}
        {records.map((record) => {
          const displayRecord =
            record.job.id === activeJob?.id
              ? { ...record, job: activeJob, images: activeImages, elapsedSeconds: elapsedSeconds || record.elapsedSeconds }
              : record;

          return (
            <GenerationRecordCard
              key={record.job.id}
              record={displayRecord}
              onDelete={() => void deleteRecord(record)}
              onRegenerate={() => void regenerateRecord(record)}
              onEditPrompt={() => onEditPrompt(generationFormFromJob(record.job))}
              onEditImage={(image, draft) => onEditImage(image, draft ?? generationFormFromJob(record.job))}
              editOptions={{
                initialForm: generationFormFromJob(record.job),
                availableRatios,
                qualityOptions,
                formatOptions,
                maxImagesPerRequest: config.maxImagesPerRequest,
                turnstileSiteKey: config.turnstileSiteKey,
                turnstileRequired: config.turnstileRequired,
                submitting: regeneratingId === record.job.id,
                onSubmit: createEditTaskFromImage,
              }}
            />
          );
        })}
        {nextCursor && (
          <button type="button" className="mx-auto mb-2 h-8 rounded-md border border-white/15 px-4 text-xs text-white/60" onClick={() => void loadRecords(nextCursor)}>
            加载更多
          </button>
        )}
      </div>
    </section>
  );
}

function SettingsView({ config, onSaved }: { config: AppConfig; onSaved: () => Promise<void> }) {
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyHint, setApiKeyHint] = useState("");
  const [promptOptimizerModel, setPromptOptimizerModel] = useState(optionOrFallback(config.promptOptimizerModel, PROMPT_OPTIMIZER_MODEL_OPTIONS));
  const [model, setModel] = useState(optionOrFallback(config.model, IMAGE_MODEL_OPTIONS));
  const [usesTokenFourjProvider, setUsesTokenFourjProvider] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    api<{ ok: true; provider: ProviderSettings | null }>("/api/settings/provider").then((result) => {
      if (!mounted) return;
      if (result.provider) {
        setBaseURL(result.provider.baseURL);
        setApiKeyHint(result.provider.apiKeyHint);
        setPromptOptimizerModel(optionOrFallback(result.provider.promptOptimizerModel, PROMPT_OPTIMIZER_MODEL_OPTIONS));
        setModel(optionOrFallback(result.provider.model, IMAGE_MODEL_OPTIONS));
        setUsesTokenFourjProvider(result.provider.usesTokenFourjProvider);
      } else {
        setApiKeyHint("");
        setUsesTokenFourjProvider(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const trimmedApiKey = apiKey.trim();
      const result = await api<{ ok: true; provider: ProviderSettings }>("/api/settings/provider", {
        method: "POST",
        body: JSON.stringify({
          baseURL: baseURL.trim(),
          ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
          model,
          promptOptimizerModel,
        }),
      });
      setUsesTokenFourjProvider(result.provider.usesTokenFourjProvider);
      setBaseURL(result.provider.baseURL);
      setApiKey(trimmedApiKey);
      setApiKeyHint(result.provider.apiKeyHint);
      setMessage("Provider 已保存。");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setError("");
    setMessage("");
    try {
      const trimmedBaseURL = baseURL.trim();
      const trimmedApiKey = apiKey.trim();
      const testsFormProvider = Boolean(trimmedBaseURL);
      const result = await api<{ ok: true; result: { ok: boolean; message: string; status: number } }>("/api/provider/test", {
        method: "POST",
        body: JSON.stringify(
          testsFormProvider
            ? {
                baseURL: trimmedBaseURL,
                ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
                model,
                promptOptimizerModel,
              }
            : {},
        ),
      });
      setMessage(result.result.message);
      if (!testsFormProvider) {
        await onSaved();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "测试失败。");
    }
  }

  return (
    <section className="entry-fade thin-scrollbar h-[calc(100dvh-64px)] flex-1 overflow-y-auto bg-[#191919]">
      <form className="mx-auto flex w-[368px] max-w-[calc(100vw-32px)] flex-col pt-10" onSubmit={save}>
        {!usesTokenFourjProvider && (
          <div className="flex h-10 items-center gap-2 overflow-hidden rounded-[10px] border border-white/15 p-2">
            <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded bg-white/10">
              <img src={openaiIcon} alt="" className="size-4" />
            </span>
            <strong className="min-w-0 flex-1 truncate text-xs font-semibold leading-none text-white">推荐使用 Small Token</strong>
            <button type="button" className="shrink-0 text-xs leading-[18px] text-[#6eff30]">
              去购买
            </button>
          </div>
        )}

        <div className="mt-10 flex flex-col gap-2">
          <SettingsTextField
            id="provider-base-url"
            label="BaseURL"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
            placeholder="请输入 baseURL"
          />
          <SettingsTextField
            id="provider-api-key"
            label="API Key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
            autoComplete="new-password"
            placeholder={apiKeyHint ? `已保存：${apiKeyHint}` : "请输入 API Key"}
          />
          <SettingsSelectField
            label="提示词优化模型"
            value={promptOptimizerModel}
            values={PROMPT_OPTIMIZER_MODEL_OPTIONS}
            onChange={(value) => setPromptOptimizerModel(optionOrFallback(value, PROMPT_OPTIMIZER_MODEL_OPTIONS))}
          />
          <SettingsSelectField
            label="生图模型"
            value={model}
            values={IMAGE_MODEL_OPTIONS}
            onChange={(value) => setModel(optionOrFallback(value, IMAGE_MODEL_OPTIONS))}
          />
        </div>

        <div className="mt-4 flex gap-2">
          <Button
            className="h-10 flex-1 rounded-[10px] border border-[#6eff30] bg-transparent px-2.5 py-0 text-xs font-semibold leading-none text-[#6eff30] hover:bg-[#6eff30]/10 hover:text-[#6eff30]"
            disabled={saving}
          >
            {saving ? "保存中" : "保存"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 flex-1 rounded-[10px] border border-white/90 bg-transparent px-2.5 py-0 text-xs font-semibold leading-none text-white/90 hover:bg-white/10 hover:text-white"
            onClick={test}
          >
            测试
          </Button>
        </div>

        <p className="mt-2 text-xs leading-[18px] text-white/40">所有数据均加密保存</p>
        {message && <p className="mt-2 text-xs leading-[18px] text-[#6eff30]">{message}</p>}
        {error && <p className="mt-2 text-xs leading-[18px] text-destructive">{error}</p>}
      </form>
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
      <Input
        id={id}
        className={cn(
          "figma-settings-input h-10 rounded-[10px] border-white/15 bg-transparent px-2 py-2.5 text-xs font-bold leading-none text-white/90 caret-white/90 placeholder:text-white/40 placeholder:opacity-100 focus-visible:ring-0",
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
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-10 rounded-[10px] border-white/15 bg-transparent px-2 py-2.5 text-xs font-semibold leading-none text-white focus:ring-0 focus:ring-offset-0 [&>svg]:size-3 [&>svg]:opacity-100">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="border-white/15 bg-[#191919] text-white">
          <SelectGroup>
            {values.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  );
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      {children}
    </div>
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
  referenceImage: ReferenceImagePreview | null,
  maskImage?: ImageSelectionMask | null,
  sourceImageId?: string,
): BodyInit {
  if (!referenceImage && !maskImage) {
    return JSON.stringify({ ...form, turnstileToken, ...(sourceImageId ? { sourceImageId } : {}) });
  }

  const body = new FormData();
  for (const [key, value] of Object.entries(form)) {
    body.set(key, String(value));
  }
  if (turnstileToken) body.set("turnstileToken", turnstileToken);
  if (sourceImageId) body.set("sourceImageId", sourceImageId);
  if (referenceImage) body.set("referenceImage", referenceImage.file, referenceImage.name);
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

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("选区遮罩生成失败。"));
    }, type);
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
  return {
    ...next,
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
  return status === "succeeded" || status === "partial_succeeded" || status === "failed" || status === "cancelled";
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
