import type { ReactNode } from "react";
import ohmioWordmark from "../../assets/figma/ohmio-wordmark.svg";
import { cn } from "../../lib/utils";

export const entrySurfaceContract = {
  background: "#181818",
  brand: "Ohmio",
  betaBadge: true,
  brandIcon: false,
  showHeader: false,
  showFeaturePanel: false,
  showDescription: false,
  cardMaxWidth: "560px",
  cardShadow: "none",
  controlRadius: "10px",
  inputBackground: "#1c1c1c",
  primaryButtonBackground: "rgba(255,255,255,0.9)",
} as const;

export const entryStatusLoadingLines = [
  "正在加载会话消息",
  "正在读取会话记录",
  "正在恢复生成状态",
  "正在准备 coss 工作区",
  "正在同步空间信息",
] as const;
export const entryStatusLoadingLoopLines = [...entryStatusLoadingLines, entryStatusLoadingLines[0]] as const;
export const entryStatusLoadingAnimationDurationMs = 15_300;

export function EntryStatusScreen({ label, detail }: { label: string; detail?: string }) {
  return (
    <main className="app-shell relative grid min-h-screen place-items-center overflow-hidden px-6">
      <EntryBackdrop />
      <div className="entry-fade relative z-10 flex w-full max-w-[420px] items-center gap-4 rounded-[22px] border border-white/12 bg-[#171717]/92 px-7 py-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <EntryStatusDotLoader />
        <div className="min-w-0 text-[22px] font-semibold leading-7 tracking-[0.01em] text-white">
          <span className="sr-only">{label}</span>
          {detail ? <span className="sr-only">{detail}</span> : null}
          <EntryStatusLoadingText />
        </div>
      </div>
    </main>
  );
}

function EntryStatusDotLoader() {
  const opacityFrames = [
    "1;0.7667;0.5333;0;0;0;0;0",
    "0;1;0.7667;0.5333;0;0;0;0",
    "0;0;1;0.7667;0.5333;0;0;0",
    "0.7667;0.5333;0;0;0;0;0;1",
    "0;0;0;0;0;0;0;0",
    "0;0;0;1;0.7667;0.5333;0;0",
    "0.5333;0;0;0;0;0;1;0.7667",
    "0;0;0;0;0;1;0.7667;0.5333",
    "0;0;0;0;1;0.7667;0.5333;0",
  ];
  const cells = Array.from({ length: 9 }, (_, index) => index);
  return (
    <svg aria-hidden="true" className="ohm-loaders-wtf-status size-[30px] shrink-0" viewBox="0 0 91 91" fill="none">
      <g>
        {cells.map((index) => {
          const row = Math.floor(index / 3);
          const column = index % 3;
          return <circle key={`off-${index}`} cx={column * 32 + 13.5} cy={row * 32 + 13.5} r="13.5" fill="#383737" />;
        })}
      </g>
      <g>
        {cells.map((index) => {
          const row = Math.floor(index / 3);
          const column = index % 3;
          return (
            <circle key={`on-${index}`} cx={column * 32 + 13.5} cy={row * 32 + 13.5} r="13.5" fill="#FFFFFFE6">
              <animate attributeName="opacity" values={opacityFrames[index]} dur="1s" calcMode="discrete" repeatCount="indefinite" />
            </circle>
          );
        })}
      </g>
    </svg>
  );
}

function EntryStatusLoadingText() {
  return (
    <span className="entry-status-loading-copy" aria-label={entryStatusLoadingLines[0]}>
      <span
        className="entry-status-loading-track"
        aria-hidden="true"
        style={{ animationDuration: `${entryStatusLoadingAnimationDurationMs}ms` }}
      >
        {entryStatusLoadingLoopLines.map((line, index) => (
          <span key={`${line}-${index}`} className="entry-status-loading-line">
            {line}
          </span>
        ))}
      </span>
    </span>
  );
}

export function EntryShell({
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="app-shell relative min-h-dvh overflow-hidden text-white">
      <EntryBackdrop />
      <div className="relative z-10 grid min-h-dvh px-6 py-10">
        <section className="entry-fade m-auto w-full max-w-[560px] rounded-[30px] border border-white/10 bg-[#1c1c1c] p-6 shadow-none md:p-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <img src={ohmioWordmark} alt="Ohmio" className="h-4 w-[50px] shrink-0 select-none" draggable={false} />
              <span className="rounded-[10px] border border-white/12 px-2 py-0.5 text-[11px] font-medium uppercase leading-4 text-white/52">
                beta
              </span>
            </div>
          </div>
          {children}
        </section>
      </div>
    </main>
  );
}

export function EntryFormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-6">
      <div>
        <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-white">{title}</h2>
        {description ? <p className="mt-2 text-sm leading-6 text-white/48">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function EntryField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2.5">
      <label htmlFor={htmlFor} className="text-xs font-medium uppercase tracking-[0.14em] text-white/58">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs leading-5 text-white/38">{hint}</p> : null}
    </div>
  );
}

export function EntryNoticeStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid gap-3", className)}>{children}</div>;
}

function EntryBackdrop() {
  return (
    <>
      <div className="pointer-events-none absolute inset-0 bg-[#181818]" />
    </>
  );
}
