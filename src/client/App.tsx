import {
  AlertCircle,
  CheckCircle2,
  Download,
  GalleryHorizontalEnd,
  ImagePlus,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCcw,
  Settings,
  Sparkles,
  Wand2,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, AppConfig, formatBytes, GenerationJob, ImageItem, ProviderSettings } from "./api";

type View = "generate" | "gallery" | "settings";

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

const ratioSizes: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "16:9": [1536, 864],
  "9:16": [864, 1536],
};

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

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [me, setMe] = useState<MeState | null>(null);
  const [view, setView] = useState<View>("generate");
  const [booting, setBooting] = useState(true);

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
      <main className="boot">
        <Loader2 className="spin" size={28} />
        <span>正在进入工作台</span>
      </main>
    );
  }

  if (!me) {
    return <LoginScreen config={config} onLogin={refreshMe} />;
  }

  return (
    <main className="shell">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={20} />
          </div>
          <div>
            <strong>Image-2 Studio</strong>
            <span>{me.space.name}</span>
          </div>
        </div>

        <nav className="nav">
          <button className={view === "generate" ? "active" : ""} onClick={() => setView("generate")}>
            <Wand2 size={18} />
            生成
          </button>
          <button className={view === "gallery" ? "active" : ""} onClick={() => setView("gallery")}>
            <GalleryHorizontalEnd size={18} />
            图库
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            <Settings size={18} />
            设置
          </button>
        </nav>

        <button
          className="logout"
          onClick={async () => {
            await api("/api/auth/logout", { method: "POST" });
            setMe(null);
          }}
        >
          <LogOut size={17} />
          离开空间
        </button>
      </aside>

      <section className="workspace">
        {view === "generate" && (
          <GenerateView config={config} providerConfigured={me.providerConfigured} onProviderNeeded={() => setView("settings")} />
        )}
        {view === "gallery" && <GalleryView />}
        {view === "settings" && <SettingsView defaultModel={config?.model ?? "gpt-image-2"} onSaved={refreshMe} />}
      </section>
    </main>
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
    <main className="login">
      <section className="login-copy">
        <span className="eyebrow">Cloudflare low-cost studio</span>
        <h1>用自己的 Key，建立一个轻量生图空间。</h1>
        <p>空间名和密码决定你的工作区。相同组合进入同一空间，新空间名会创建新空间。</p>
      </section>
      <form className="login-panel" onSubmit={submit}>
        <KeyRound size={24} />
        <label>
          空间名
          <input value={spaceName} onChange={(event) => setSpaceName(event.target.value)} minLength={2} required />
        </label>
        <label>
          密码
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            minLength={8}
            required
          />
        </label>
        {config?.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />}
        {config?.turnstileRequired && !config.turnstileSiteKey && <p className="hint">Turnstile 已启用，请配置站点 Key。</p>}
        {error && <Notice tone="error" text={error} />}
        <button className="primary" disabled={loading}>
          {loading ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
          进入空间
        </button>
      </form>
    </main>
  );
}

function GenerateView({
  config,
  providerConfigured,
  onProviderNeeded,
}: {
  config: AppConfig | null;
  providerConfigured: boolean;
  onProviderNeeded: () => void;
}) {
  const [form, setForm] = useState<GenerateForm>(defaultForm);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!job || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") return;
    const timer = window.setInterval(async () => {
      const result = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${job.id}`);
      setJob(result.job);
      setImages(result.images);
      if (result.job.status === "succeeded" || result.job.status === "failed") window.clearInterval(timer);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [job]);

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
    <div className="generate-layout">
      <form className="control-panel" onSubmit={submit}>
        <div className="section-head">
          <span className="eyebrow">Generate</span>
          <h2>图片生成</h2>
        </div>

        <label>
          提示词
          <textarea
            value={form.prompt}
            onChange={(event) => update("prompt", event.target.value)}
            placeholder="描述画面、主体、材质、镜头和风格"
            rows={9}
            required
          />
        </label>

        <div className="field-grid">
          <label>
            比例
            <select value={form.aspectRatio} onChange={(event) => update("aspectRatio", event.target.value)}>
              {config?.ratios.map((ratio) => (
                <option key={ratio} value={ratio}>
                  {ratio}
                </option>
              ))}
            </select>
          </label>
          <label>
            质量
            <select value={form.quality} onChange={(event) => update("quality", event.target.value)}>
              {config?.qualities.map((quality) => (
                <option key={quality} value={quality}>
                  {quality}
                </option>
              ))}
            </select>
          </label>
          <label>
            数量
            <input
              type="number"
              min={1}
              max={config?.maxImagesPerRequest ?? 4}
              value={form.quantity}
              onChange={(event) => update("quantity", Number(event.target.value))}
            />
          </label>
          <label>
            格式
            <select value={form.outputFormat} onChange={(event) => update("outputFormat", event.target.value)}>
              {config?.formats.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
          </label>
        </div>

        {form.aspectRatio === "custom" && (
          <div className="field-grid">
            <label>
              宽
              <input type="number" step={16} value={form.width} onChange={(event) => update("width", Number(event.target.value))} />
            </label>
            <label>
              高
              <input type="number" step={16} value={form.height} onChange={(event) => update("height", Number(event.target.value))} />
            </label>
          </div>
        )}

        <div className="field-grid">
          <label>
            背景
            <select value={form.background} onChange={(event) => update("background", event.target.value)}>
              <option value="auto">auto</option>
              <option value="opaque">opaque</option>
              <option value="transparent">transparent</option>
            </select>
          </label>
          <label>
            压缩率
            <input
              type="number"
              min={0}
              max={100}
              value={form.compression}
              disabled={form.outputFormat === "png"}
              onChange={(event) => update("compression", Number(event.target.value))}
            />
          </label>
        </div>

        {error && <Notice tone="error" text={error} />}
        {!providerConfigured && <Notice tone="warn" text="请先在设置页保存 baseURL 和 API Key。" />}
        {config?.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />}

        <button className="primary" disabled={loading}>
          {loading ? <Loader2 className="spin" size={18} /> : <ImagePlus size={18} />}
          {providerConfigured ? "开始生成" : "去配置 Provider"}
        </button>
      </form>

      <section className="result-stage">
        <div className="stage-top">
          <div>
            <span className="eyebrow">Result</span>
            <h2>{job ? statusText(job.status) : "等待生成"}</h2>
          </div>
          {job && <span className={`status ${job.status}`}>{job.status}</span>}
        </div>

        {job?.status === "failed" && <Notice tone="error" text={job.error_message ?? "生成失败。"} />}
        {!job && <EmptyState title="还没有任务" text="配置 provider 后输入提示词，即可生成并保存到当前空间图库。" />}
        {(job?.status === "queued" || job?.status === "running") && (
          <div className="waiting">
            <Loader2 className="spin" size={28} />
            <span>模型正在处理，页面会自动刷新结果。</span>
          </div>
        )}
        {images.length > 0 && <ImageGrid images={images} />}
      </section>
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
    <section className="view-stack">
      <div className="view-title">
        <div>
          <span className="eyebrow">Gallery</span>
          <h2>空间图库</h2>
        </div>
        <button className="ghost" onClick={load}>
          <RefreshCcw size={17} />
          刷新
        </button>
      </div>
      {error && <Notice tone="error" text={error} />}
      {loading && <div className="waiting"><Loader2 className="spin" size={24} />加载图库</div>}
      {!loading && images.length === 0 && <EmptyState title="图库为空" text="生成成功后的图片会自动出现在这里。" />}
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
    <section className="settings-layout">
      <div className="view-title">
        <div>
          <span className="eyebrow">Provider</span>
          <h2>模型服务配置</h2>
        </div>
      </div>

      <form className="settings-form" onSubmit={save}>
        <label>
          baseURL
          <input value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="https://api.openai.com/v1" />
        </label>
        <label>
          API Key
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
            placeholder={provider ? provider.apiKeyHint : "sk-..."}
          />
        </label>
        <label>
          模型
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={defaultModel} />
        </label>

        {provider && (
          <div className="provider-state">
            <CheckCircle2 size={18} />
            <span>
              已保存 {provider.model}，Key：{provider.apiKeyHint}
            </span>
          </div>
        )}
        {message && <Notice tone="success" text={message} />}
        {error && <Notice tone="error" text={error} />}

        <div className="button-row">
          <button className="primary" disabled={saving}>
            {saving ? <Loader2 className="spin" size={18} /> : <CheckCircle2 size={18} />}
            保存
          </button>
          <button type="button" className="secondary" onClick={test}>
            测试连接
          </button>
        </div>
      </form>
    </section>
  );
}

function ImageGrid({ images, showMeta = false }: { images: ImageItem[]; showMeta?: boolean }) {
  return (
    <div className="image-grid">
      {images.map((image) => (
        <article className="image-tile" key={image.id}>
          <img src={image.url} alt={image.prompt ?? "生成图片"} loading="lazy" />
          <div className="image-actions">
            <span>
              {image.width}x{image.height} · {image.format}
            </span>
            <a href={image.url} download>
              <Download size={16} />
            </a>
          </div>
          {showMeta && (
            <div className="image-meta">
              <strong>{image.prompt || "未记录提示词"}</strong>
              <span>
                {image.quality ?? "auto"} · {image.aspectRatio ?? "custom"} · {formatBytes(image.byteSize)}
              </span>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <AlertCircle size={24} />
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function Notice({ tone, text }: { tone: "error" | "success" | "warn"; text: string }) {
  return <div className={`notice ${tone}`}>{text}</div>;
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

  return <div className="turnstile" ref={ref} />;
}
