import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Download,
  GalleryHorizontalEnd,
  Heart,
  ImagePlus,
  Images,
  KeyRound,
  LibraryBig,
  LinkIcon,
  Loader2,
  LogOut,
  RefreshCcw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wand2,
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Separator } from "./components/ui/separator";
import { Slider } from "./components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Textarea } from "./components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { cn } from "./lib/utils";
import { api, AppConfig, formatBytes, GenerationJob, ImageItem, InspirationItem, ProviderSettings } from "./api";

type View = "generate" | "inspiration" | "gallery" | "settings";

interface MeState {
  space: { id: string; name: string };
  providerConfigured: boolean;
}

interface GenerateForm {
  prompt: string;
  aspectRatio: string;
  width: number;
  height: number;
  quality: string;
  quantity: number;
  outputFormat: string;
  background: string;
  compression: number;
}

interface PromptDraft {
  id: string;
  prompt: string;
  aspectRatio: string | null;
  nonce: number;
}

const ratioSizes: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "16:9": [1536, 864],
  "9:16": [864, 1536],
};

const GENERATION_POLL_INTERVAL_MS = 6000;

const defaultForm: GenerateForm = {
  prompt: "",
  aspectRatio: "1:1",
  width: 1024,
  height: 1024,
  quality: "auto",
  quantity: 1,
  outputFormat: "png",
  background: "auto",
  compression: 100,
};

const viewItems: Array<{ value: View; label: string; icon: typeof Wand2 }> = [
  { value: "generate", label: "生成", icon: Wand2 },
  { value: "inspiration", label: "灵感", icon: LibraryBig },
  { value: "gallery", label: "图库", icon: GalleryHorizontalEnd },
  { value: "settings", label: "设置", icon: Settings },
];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [me, setMe] = useState<MeState | null>(null);
  const [view, setView] = useState<View>("generate");
  const [booting, setBooting] = useState(true);
  const [promptDraft, setPromptDraft] = useState<PromptDraft | null>(null);

  const refreshMe = useCallback(async () => {
    const result = await api<{ ok: true; space: MeState["space"]; providerConfigured: boolean }>("/api/me");
    setMe({ space: result.space, providerConfigured: result.providerConfigured });
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      api<{ ok: true; config: AppConfig }>("/api/config").then((result) => result.config),
      api<{ ok: true; space: MeState["space"]; providerConfigured: boolean }>("/api/me").catch(() => null),
    ]).then(([appConfig, user]) => {
      if (!mounted) return;
      setConfig(appConfig);
      setMe(user ? { space: user.space, providerConfigured: user.providerConfigured } : null);
      setBooting(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (booting) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-muted-foreground">
        <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 shadow-panel">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-sm font-medium">正在进入工作台</span>
        </div>
      </main>
    );
  }

  if (!me) {
    return <LoginScreen config={config} onLogin={refreshMe} />;
  }

  return (
    <TooltipProvider delayDuration={180}>
      <main className="min-h-screen bg-background text-foreground">
        <div className="flex min-h-screen">
          <aside className="hidden w-20 shrink-0 border-r bg-card/80 px-3 py-4 lg:flex lg:flex-col lg:items-center">
            <div className="mb-8 grid size-11 place-items-center rounded-lg bg-foreground text-background">
              <Sparkles className="size-5" />
            </div>
            <nav className="flex flex-1 flex-col items-center gap-2">
              {viewItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Tooltip key={item.value}>
                    <TooltipTrigger asChild>
                      <Button
                        variant={view === item.value ? "default" : "ghost"}
                        size="icon"
                        className="rounded-lg"
                        onClick={() => setView(item.value)}
                      >
                        <Icon className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </nav>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-lg text-muted-foreground"
                  onClick={async () => {
                    await api("/api/auth/logout", { method: "POST" });
                    setMe(null);
                  }}
                >
                  <LogOut className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">离开空间</TooltipContent>
            </Tooltip>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-20 border-b bg-background/90 px-4 py-3 backdrop-blur md:px-6">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <span>Image-2 Studio</span>
                    <Badge variant={me.providerConfigured ? "secondary" : "outline"} className="shrink-0">
                      {me.providerConfigured ? "Provider ready" : "Need provider"}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">空间：{me.space.name}</p>
                </div>
                <Tabs value={view} onValueChange={(value) => setView(value as View)} className="w-full md:w-auto">
                  <TabsList className="grid w-full grid-cols-4 md:w-auto">
                    {viewItems.map((item) => (
                      <MainTabTrigger key={item.value} value={item.value} label={item.label} icon={item.icon} />
                    ))}
                  </TabsList>
                </Tabs>
              </div>
            </header>

            <div className="flex-1 p-4 md:p-6">
              {view === "generate" && (
                <GenerateView
                  config={config}
                  providerConfigured={me.providerConfigured}
                  incomingPrompt={promptDraft}
                  onProviderNeeded={() => setView("settings")}
                  onOpenInspirations={() => setView("inspiration")}
                />
              )}
              {view === "inspiration" && (
                <InspirationView
                  onUse={(item) => {
                    setPromptDraft({ id: item.id, prompt: item.prompt, aspectRatio: item.aspectRatio, nonce: Date.now() });
                    setView("generate");
                  }}
                />
              )}
              {view === "gallery" && <GalleryView />}
              {view === "settings" && <SettingsView defaultModel={config?.model ?? "gpt-image-2"} onSaved={refreshMe} />}
            </div>
          </section>
        </div>
      </main>
    </TooltipProvider>
  );
}

function LoginScreen({ config, onLogin }: { config: AppConfig | null; onLogin: () => Promise<void> }) {
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
    <main className="min-h-screen bg-[radial-gradient(circle_at_18%_18%,hsl(199_82%_92%),transparent_30%),linear-gradient(135deg,hsl(216_32%_98%),hsl(190_28%_96%))] p-4 text-foreground md:p-8">
      <section className="mx-auto grid min-h-[calc(100vh-2rem)] max-w-6xl items-center gap-8 md:min-h-[calc(100vh-4rem)] lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="max-w-2xl">
          <Badge variant="outline" className="mb-5 bg-background/70">
            Cloudflare Worker / D1 / R2
          </Badge>
          <h1 className="text-5xl font-semibold leading-tight tracking-normal text-foreground md:text-7xl">
            进入你的轻量生图工作台
          </h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground">
            用空间名和密码进入同一个创作空间，配置自己的 OpenAI 兼容 API Key 后即可生成、浏览和下载图片。
          </p>
          <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-3">
            {["空间隔离", "Key 加密", "图库留存"].map((item) => (
              <div key={item} className="rounded-lg border bg-background/70 px-4 py-3 text-sm font-medium shadow-panel">
                {item}
              </div>
            ))}
          </div>
        </div>

        <Card className="bg-card/92 shadow-canvas backdrop-blur">
          <CardHeader>
            <div className="mb-3 grid size-11 place-items-center rounded-lg bg-primary text-primary-foreground">
              <KeyRound className="size-5" />
            </div>
            <CardTitle>空间登录</CardTitle>
            <CardDescription>新空间名会自动创建；忘记空间名或密码无法找回。</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-5" onSubmit={submit}>
              <Field label="空间名">
                <Input value={spaceName} onChange={(event) => setSpaceName(event.target.value)} minLength={2} autoComplete="username" required />
              </Field>
              <Field label="密码">
                <Input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  minLength={8}
                  autoComplete="current-password"
                  required
                />
              </Field>
              {config?.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />}
              {config?.turnstileRequired && !config.turnstileSiteKey && (
                <Notice tone="warn" text="Turnstile 已启用，请配置站点 Key。" />
              )}
              {error && <Notice tone="error" text={error} />}
              <Button className="h-11" disabled={loading}>
                {loading ? <Loader2 className="animate-spin" /> : <Sparkles />}
                进入空间
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

function GenerateView({
  config,
  providerConfigured,
  incomingPrompt,
  onProviderNeeded,
  onOpenInspirations,
}: {
  config: AppConfig | null;
  providerConfigured: boolean;
  incomingPrompt: PromptDraft | null;
  onProviderNeeded: () => void;
  onOpenInspirations: () => void;
}) {
  const [form, setForm] = useState<GenerateForm>(defaultForm);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!incomingPrompt?.prompt) return;
    setForm((current) => {
      const next = { ...current, prompt: incomingPrompt.prompt };
      if (incomingPrompt.aspectRatio && ratioSizes[incomingPrompt.aspectRatio]) {
        const [width, height] = ratioSizes[incomingPrompt.aspectRatio];
        next.aspectRatio = incomingPrompt.aspectRatio;
        next.width = width;
        next.height = height;
      }
      return next;
    });
  }, [incomingPrompt?.nonce]);

  useEffect(() => {
    if (!job || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${job.id}`);
        setJob(result.job);
        setImages(result.images);
        if (result.job.status === "succeeded" || result.job.status === "failed" || result.job.status === "cancelled") window.clearInterval(timer);
      } catch (err) {
        setError(err instanceof Error ? err.message : "刷新任务状态失败。");
      }
    }, GENERATION_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [job]);

  useEffect(() => {
    if (!job || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      if (!job) setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.parse(job.created_at);
    const updateElapsed = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.created_at, job?.status]);

  function update<K extends keyof GenerateForm>(key: K, value: GenerateForm[K]) {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "aspectRatio" && typeof value === "string" && ratioSizes[value]) {
        const [width, height] = ratioSizes[value];
        next.width = width;
        next.height = height;
      }
      if (key === "background" && value === "transparent" && next.outputFormat === "jpeg") {
        next.outputFormat = "png";
      }
      if (key === "outputFormat" && value === "jpeg" && next.background === "transparent") {
        next.background = "opaque";
      }
      return next;
    });
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
      const result = await api<{ ok: true; jobId: string; status: "queued" }>("/api/generations", {
        method: "POST",
        body: JSON.stringify({ ...form, turnstileToken }),
      });
      const firstPoll = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${result.jobId}`);
      setJob(firstPoll.job);
      setImages(firstPoll.images);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建任务失败。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-[calc(100vh-104px)] gap-4 xl:grid-cols-[424px_minmax(0,1fr)]">
      <form className="rounded-lg border bg-card shadow-panel" onSubmit={submit}>
        <div className="border-b p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">Text to Image</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-normal">图片生成</h2>
            </div>
            <Badge variant="secondary" className="gap-1">
              <SlidersHorizontal className="size-3" />
              {form.width}x{form.height}
            </Badge>
          </div>
        </div>

        <div className="grid gap-5 p-4">
          <Field label="提示词">
            <Textarea
              value={form.prompt}
              onChange={(event) => update("prompt", event.target.value)}
              placeholder="描述画面、主体、材质、镜头、光线和风格"
              rows={8}
              required
              className="min-h-40 resize-none"
            />
          </Field>

          <InspirationPromptStrip onSelect={(item) => update("prompt", item.prompt)} onOpenInspirations={onOpenInspirations} />

          <Field label="比例">
            <div className="grid grid-cols-3 gap-2">
              {config?.ratios.map((ratio) => (
                <Button
                  key={ratio}
                  type="button"
                  variant={form.aspectRatio === ratio ? "default" : "outline"}
                  className="h-12"
                  onClick={() => update("aspectRatio", ratio)}
                >
                  {ratio}
                </Button>
              ))}
            </div>
          </Field>

          {form.aspectRatio === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="宽">
                <Input type="number" step={16} value={form.width} onChange={(event) => update("width", Number(event.target.value))} />
              </Field>
              <Field label="高">
                <Input type="number" step={16} value={form.height} onChange={(event) => update("height", Number(event.target.value))} />
              </Field>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <SelectField label="质量" value={form.quality} values={config?.qualities ?? []} onChange={(value) => update("quality", value)} />
            <Field label="数量">
              <Input
                type="number"
                min={1}
                max={config?.maxImagesPerRequest ?? 4}
                value={form.quantity}
                onChange={(event) => update("quantity", Number(event.target.value))}
              />
            </Field>
            <SelectField label="格式" value={form.outputFormat} values={config?.formats ?? []} onChange={(value) => update("outputFormat", value)} />
            <SelectField
              label="背景"
              value={form.background}
              values={["auto", "opaque", "transparent"]}
              onChange={(value) => update("background", value)}
            />
          </div>

          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <Label>压缩率</Label>
              <span className="text-sm font-medium text-muted-foreground">{form.outputFormat === "png" ? "PNG 不压缩" : `${form.compression}%`}</span>
            </div>
            <Slider
              value={[form.compression]}
              min={0}
              max={100}
              step={5}
              disabled={form.outputFormat === "png"}
              onValueChange={([value]) => update("compression", value)}
            />
          </div>

          {error && <Notice tone="error" text={error} />}
          {!providerConfigured && <Notice tone="warn" text="请先在设置页保存 baseURL 和 API Key。" />}
          {config?.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />}

          <Button className="h-12 text-base" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
            {providerConfigured ? "开始生成" : "去配置 Provider"}
          </Button>
        </div>
      </form>

      <section className="relative overflow-hidden rounded-lg border bg-[linear-gradient(135deg,hsl(216_32%_98%),hsl(190_28%_96%))] shadow-canvas">
        <div className="flex flex-col gap-3 border-b bg-background/82 p-4 backdrop-blur md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Canvas</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-normal">{job ? statusText(job.status) : "等待生成"}</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={cn("capitalize", statusBadgeClass(job?.status))} variant="outline">
              {job?.status ?? "idle"}
            </Badge>
            <Badge variant="secondary">{form.quantity} 张</Badge>
          </div>
        </div>

        <div className="min-h-[560px] p-4 md:p-6">
          {job?.status === "failed" && <Notice tone="error" text={job.error_message ?? "生成失败。"} />}
          {!job && (
            <EmptyState
              icon={<Images className="size-7" />}
              title="结果会在这里铺开"
              text="左侧输入提示词并选择比例、质量、数量。完成后图片会自动进入当前空间图库。"
            />
          )}
          {(job?.status === "queued" || job?.status === "running") && (
            <div className="grid min-h-[420px] place-items-center text-center">
              <div className="grid gap-4">
                <div className="mx-auto grid size-16 place-items-center rounded-lg bg-background shadow-panel">
                  <Loader2 className="size-7 animate-spin text-primary" />
                </div>
                <div>
                  <p className="font-semibold">模型正在处理</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    已等待 {formatElapsed(elapsedSeconds)}，最长可能接近 {formatElapsed(config?.generationTimeoutSeconds ?? 600)}。
                  </p>
                </div>
              </div>
            </div>
          )}
          {images.length > 0 && <ImageGrid images={images} />}
        </div>
      </section>
    </div>
  );
}

function InspirationPromptStrip({
  onSelect,
  onOpenInspirations,
}: {
  onSelect: (item: InspirationItem) => void;
  onOpenInspirations: () => void;
}) {
  const [items, setItems] = useState<InspirationItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      try {
        const favorites = await api<{ ok: true; inspirations: InspirationItem[] }>("/api/inspirations?favorites=1");
        const result = favorites.inspirations.length
          ? favorites
          : await api<{ ok: true; inspirations: InspirationItem[] }>("/api/inspirations");
        if (mounted) setItems(result.inspirations.filter((item) => item.prompt.trim()).slice(0, 4));
      } catch {
        if (mounted) setItems([]);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <Label>灵感片段</Label>
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onOpenInspirations}>
          <LibraryBig className="size-3.5" />
          灵感库
        </Button>
      </div>
      {loading && <div className="h-10 rounded-lg border bg-muted/50" />}
      {!loading && items.length === 0 && (
        <button
          type="button"
          className="rounded-lg border border-dashed bg-background px-3 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
          onClick={onOpenInspirations}
        >
          导入或采集灵感后，可在这里快速套用提示词。
        </button>
      )}
      {items.length > 0 && (
        <div className="grid gap-2">
          {items.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto justify-start py-2 text-left"
              onClick={() => {
                void api(`/api/inspirations/${item.id}/use`, { method: "POST" });
                onSelect(item);
              }}
            >
              <span className="line-clamp-2">{item.prompt}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function InspirationView({ onUse }: { onUse: (item: InspirationItem) => void }) {
  const [items, setItems] = useState<InspirationItem[]>([]);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [tag, setTag] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importPrompt, setImportPrompt] = useState("");
  const [importTags, setImportTags] = useState("");
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (source !== "all") params.set("source", source);
    if (tag.trim()) params.set("tag", tag.trim());
    if (favoritesOnly) params.set("favorites", "1");
    try {
      const result = await api<{ ok: true; inspirations: InspirationItem[] }>(`/api/inspirations?${params.toString()}`);
      setItems(result.inspirations);
    } catch (err) {
      setError(err instanceof Error ? err.message : "灵感库加载失败。");
    } finally {
      setLoading(false);
    }
  }, [favoritesOnly, query, source, tag]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitImport(event: FormEvent) {
    event.preventDefault();
    setImporting(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ ok: true; inspiration: InspirationItem }>("/api/inspirations/import-url", {
        method: "POST",
        body: JSON.stringify({
          url: importUrl,
          prompt: importPrompt,
          tags: splitTags(importTags),
        }),
      });
      setItems((current) => [result.inspiration, ...current.filter((item) => item.id !== result.inspiration.id)]);
      setImportUrl("");
      setImportPrompt("");
      setImportTags("");
      setMessage("灵感已导入。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败。");
    } finally {
      setImporting(false);
    }
  }

  async function toggleFavorite(item: InspirationItem) {
    const next = !item.favorite;
    setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, favorite: next } : entry)));
    try {
      const result = await api<{ ok: true; favorite: boolean }>(`/api/inspirations/${item.id}/favorite`, {
        method: "POST",
        body: JSON.stringify({ favorite: next }),
      });
      setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, favorite: result.favorite } : entry)));
    } catch (err) {
      setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, favorite: item.favorite } : entry)));
      setError(err instanceof Error ? err.message : "收藏失败。");
    }
  }

  async function useItem(item: InspirationItem) {
    await api(`/api/inspirations/${item.id}/use`, { method: "POST" }).catch(() => null);
    onUse(item);
  }

  return (
    <section className="grid gap-5">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Inspiration</p>
          <h2 className="mt-1 text-3xl font-semibold tracking-normal">灵感库</h2>
        </div>
        <form className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_140px_150px_auto_auto]" onSubmit={(event) => { event.preventDefault(); void load(); }}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提示词、作者、标签" className="pl-9" />
          </div>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部来源</SelectItem>
              <SelectItem value="civitai">Civitai</SelectItem>
              <SelectItem value="x">X</SelectItem>
              <SelectItem value="jimeng">即梦</SelectItem>
              <SelectItem value="generic">网页</SelectItem>
            </SelectContent>
          </Select>
          <Input value={tag} onChange={(event) => setTag(event.target.value)} placeholder="标签" />
          <Button type="button" variant={favoritesOnly ? "default" : "outline"} onClick={() => setFavoritesOnly((current) => !current)}>
            <Heart className={cn("size-4", favoritesOnly && "fill-current")} />
            收藏
          </Button>
          <Button type="submit" variant="outline">
            <RefreshCcw className="size-4" />
            刷新
          </Button>
        </form>
      </div>

      <form className="grid gap-3 rounded-lg border bg-card p-4 shadow-panel lg:grid-cols-[minmax(260px,1fr)_minmax(280px,1.2fr)_180px_auto]" onSubmit={submitImport}>
        <Field label="来源链接">
          <Input value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="https://..." required />
        </Field>
        <Field label="提示词">
          <Input value={importPrompt} onChange={(event) => setImportPrompt(event.target.value)} placeholder="X 手动导入时必填；网页可自动读取描述" />
        </Field>
        <Field label="标签">
          <Input value={importTags} onChange={(event) => setImportTags(event.target.value)} placeholder="产品, 海报" />
        </Field>
        <div className="flex items-end">
          <Button className="w-full" disabled={importing}>
            {importing ? <Loader2 className="animate-spin" /> : <LinkIcon />}
            导入
          </Button>
        </div>
      </form>

      {message && <Notice tone="success" text={message} />}
      {error && <Notice tone="error" text={error} />}

      {loading && (
        <div className="grid min-h-80 place-items-center rounded-lg border bg-card text-muted-foreground">
          <div className="flex items-center gap-3">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-sm font-medium">加载灵感</span>
          </div>
        </div>
      )}
      {!loading && items.length === 0 && (
        <EmptyState icon={<LibraryBig className="size-7" />} title="还没有可用灵感" text="定时采集会写入公开素材，也可以先粘贴来源链接手动导入。" />
      )}
      {!loading && items.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {items.map((item) => (
            <InspirationCard key={item.id} item={item} onFavorite={() => void toggleFavorite(item)} onUse={() => void useItem(item)} />
          ))}
        </div>
      )}
    </section>
  );
}

function InspirationCard({
  item,
  onFavorite,
  onUse,
}: {
  item: InspirationItem;
  onFavorite: () => void;
  onUse: () => void;
}) {
  const hasPrompt = item.prompt.trim().length > 0;
  return (
    <article className="group overflow-hidden rounded-lg border bg-card shadow-panel">
      <InspirationThumb item={item} />
      <div className="grid gap-3 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{item.sourceName || item.sourceKey || "来源"}</Badge>
              {item.aspectRatio && <span className="text-xs text-muted-foreground">{item.aspectRatio}</span>}
            </div>
            <strong className="mt-2 line-clamp-2 block text-sm font-semibold">{item.title || item.author || "未命名灵感"}</strong>
          </div>
          <Button variant="ghost" size="icon" className="shrink-0 rounded-lg" onClick={onFavorite} aria-label={item.favorite ? "取消收藏" : "收藏"}>
            <Heart className={cn("size-4", item.favorite && "fill-current text-rose-600")} />
          </Button>
        </div>
        <p className={cn("min-h-16 text-sm leading-6", hasPrompt ? "line-clamp-3 text-foreground" : "text-muted-foreground")}>
          {hasPrompt ? item.prompt : "这个素材没有可读取的提示词，可打开来源查看详情。"}
        </p>
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.tags.slice(0, 4).map((tagName) => (
              <Badge key={tagName} variant="outline" className="text-[11px]">
                {tagName}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <Button variant="outline" size="sm" asChild>
            <a href={item.originalUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              来源
            </a>
          </Button>
          <Button size="sm" onClick={onUse} disabled={!hasPrompt}>
            <Wand2 className="size-4" />
            套用
          </Button>
        </div>
      </div>
    </article>
  );
}

function InspirationThumb({ item }: { item: InspirationItem }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : item.thumbnailUrl;
  return (
    <div className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-muted">
      {src ? (
        <img
          src={src}
          alt={item.title || item.prompt || "灵感图片"}
          loading="lazy"
          className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="grid justify-items-center gap-2 text-muted-foreground">
          <Images className="size-7" />
          <span className="text-xs">无缩略图</span>
        </div>
      )}
      <div className="absolute left-3 top-3 flex gap-2">
        {item.model && <Badge className="bg-background/85 text-foreground backdrop-blur">{item.model}</Badge>}
      </div>
    </div>
  );
}

function GalleryView() {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<{ ok: true; images: ImageItem[] }>("/api/images");
      setImages(result.images);
    } catch (err) {
      setError(err instanceof Error ? err.message : "图库加载失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="grid gap-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Gallery</p>
          <h2 className="mt-1 text-3xl font-semibold tracking-normal">空间图库</h2>
        </div>
        <Button variant="outline" onClick={load}>
          <RefreshCcw className="size-4" />
          刷新
        </Button>
      </div>
      {error && <Notice tone="error" text={error} />}
      {loading && (
        <div className="grid min-h-80 place-items-center rounded-lg border bg-card text-muted-foreground">
          <div className="flex items-center gap-3">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-sm font-medium">加载图库</span>
          </div>
        </div>
      )}
      {!loading && images.length === 0 && (
        <EmptyState icon={<GalleryHorizontalEnd className="size-7" />} title="图库为空" text="生成成功后的图片会自动出现在这里。" />
      )}
      <ImageGrid images={images} showMeta />
    </section>
  );
}

function SettingsView({ defaultModel, onSaved }: { defaultModel: string; onSaved: () => Promise<void> }) {
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [baseURL, setBaseURL] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(defaultModel);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ ok: true; provider: ProviderSettings | null }>("/api/settings/provider").then((result) => {
      setProvider(result.provider);
      if (result.provider) {
        setBaseURL(result.provider.baseURL);
        setModel(result.provider.model);
      }
    });
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ ok: true; provider: ProviderSettings }>("/api/settings/provider", {
        method: "POST",
        body: JSON.stringify({ baseURL, apiKey, model }),
      });
      setProvider(result.provider);
      setApiKey("");
      setMessage("Provider 已保存，API Key 不会回显。");
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
      const result = await api<{ ok: true; result: { ok: boolean; message: string; status: number } }>("/api/provider/test", {
        method: "POST",
        body: JSON.stringify(apiKey ? { baseURL, apiKey, model } : {}),
      });
      setMessage(result.result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "测试失败。");
    }
  }

  return (
    <section className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Provider</p>
          <CardTitle className="text-3xl">模型服务配置</CardTitle>
          <CardDescription>保存用户自己的 baseURL、API Key 和模型名。API Key 加密存储，不会完整回显。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-5" onSubmit={save}>
            <Field label="baseURL">
              <Input value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="https://api.openai.com/v1" />
            </Field>
            <Field label="API Key">
              <Input
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                type="password"
                placeholder={provider ? provider.apiKeyHint : "sk-..."}
              />
            </Field>
            <Field label="模型">
              <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder={defaultModel} />
            </Field>

            {provider && (
              <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <CheckCircle2 className="size-4" />
                <span>
                  已保存 {provider.model}，Key：{provider.apiKeyHint}
                </span>
              </div>
            )}
            {message && <Notice tone="success" text={message} />}
            {error && <Notice tone="error" text={error} />}

            <div className="flex flex-wrap gap-3">
              <Button disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                保存
              </Button>
              <Button type="button" variant="outline" onClick={test}>
                测试连接
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="size-5 text-emerald-700" />
              安全边界
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm text-muted-foreground">
            <p>API Key 使用 Worker Secret 派生密钥加密后写入 D1。</p>
            <Separator />
            <p>baseURL 只允许 HTTPS，并拦截 localhost、内网地址和重定向。</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">默认配额</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">每日任务</span>
              <strong>50</strong>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">单次图片</span>
              <strong>4</strong>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">并发任务</span>
              <strong>2</strong>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function ImageGrid({ images, showMeta = false }: { images: ImageItem[]; showMeta?: boolean }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
      {images.map((image) => (
        <article key={image.id} className="group overflow-hidden rounded-lg border bg-card shadow-panel">
          <div className="relative bg-muted">
            <img src={image.url} alt={image.prompt ?? "生成图片"} loading="lazy" className="aspect-square w-full object-cover" />
            <Button asChild size="icon" variant="secondary" className="absolute right-3 top-3 opacity-0 shadow-panel transition-opacity group-hover:opacity-100">
              <a href={image.url} download aria-label="下载图片">
                <Download className="size-4" />
              </a>
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
            <span>
              {image.width}x{image.height} · {image.format}
            </span>
            <a className="font-medium text-foreground hover:underline" href={image.url} download>
              下载
            </a>
          </div>
          {showMeta && (
            <div className="grid gap-1 border-t px-3 py-3">
              <strong className="truncate text-sm font-medium">{image.prompt || "未记录提示词"}</strong>
              <span className="text-xs text-muted-foreground">
                {image.quality ?? "auto"} · {image.aspectRatio ?? "custom"} · {formatBytes(image.byteSize)}
              </span>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function MainTabTrigger({ value, label, icon: Icon }: { value: View; label: string; icon: typeof Wand2 }) {
  return (
    <TabsTrigger value={value} className="gap-2">
      <Icon className="size-4" />
      {label}
    </TabsTrigger>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SelectField({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="grid min-h-96 place-items-center rounded-lg border border-dashed bg-background/70 p-6 text-center">
      <div className="grid max-w-sm gap-3 justify-items-center">
        <div className="grid size-14 place-items-center rounded-lg bg-muted text-muted-foreground">{icon}</div>
        <strong className="text-lg font-semibold">{title}</strong>
        <span className="text-sm leading-6 text-muted-foreground">{text}</span>
      </div>
    </div>
  );
}

function Notice({ tone, text }: { tone: "error" | "success" | "warn"; text: string }) {
  const variant = tone === "error" ? "destructive" : tone === "success" ? "success" : "warning";
  const Icon = tone === "error" ? AlertCircle : CheckCircle2;
  return (
    <Alert variant={variant} className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0" />
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

function statusText(status: GenerationJob["status"]): string {
  return {
    queued: "任务排队中",
    running: "正在生成",
    succeeded: "生成完成",
    failed: "生成失败",
    cancelled: "已取消",
  }[status];
}

function statusBadgeClass(status?: GenerationJob["status"]): string {
  return {
    queued: "border-cyan-300 bg-cyan-50 text-cyan-800",
    running: "border-blue-300 bg-blue-50 text-blue-800",
    succeeded: "border-emerald-300 bg-emerald-50 text-emerald-800",
    failed: "border-red-300 bg-red-50 text-red-800",
    cancelled: "border-muted bg-muted text-muted-foreground",
    idle: "border-border bg-background text-muted-foreground",
  }[status ?? "idle"];
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
}

function splitTags(value: string): string[] {
  return value
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
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
          theme: "light";
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
        theme: "light",
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
