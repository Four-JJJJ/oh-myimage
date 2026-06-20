import type { ReactNode } from "react";
import ohmioWordmark from "../../assets/figma/ohmio-wordmark.svg";
import { LoadersWtfStatusIcon, LoadingStatusText } from "../shared/generation-loading";
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
  controlRadius: "12px",
  inputBackground: "#1c1c1c",
  primaryButtonBackground: "rgba(255,255,255,0.9)",
} as const;

export const entryStatusLoadingLines = [
  "正在读取会话",
  "正在同步记录",
  "正在恢复画布",
  "正在准备空间",
  "正在连接工作区",
  "正在整理生成状态",
  "正在载入历史图片",
  "正在校准页面",
] as const;
export const entryStatusLoadingLoopLines = [...entryStatusLoadingLines, entryStatusLoadingLines[0]] as const;
export const entryStatusLoadingAnimationDurationMs = 24_480;
export const entryStatusSurfaceContract = {
  card: false,
  iconSize: "14px",
  lineHeight: "22px",
  textSize: "14px",
  reusedGenerationStatus: true,
} as const;

export function EntryStatusScreen({ label, detail }: { label: string; detail?: string }) {
  return (
    <main className="app-shell relative grid min-h-screen place-items-center overflow-hidden px-6">
      <EntryBackdrop />
      <div className="entry-fade relative z-10 flex items-center gap-2 text-sm leading-[22px] text-white">
        <span className="inline-flex size-[14px] items-center justify-center">
          <LoadersWtfStatusIcon />
        </span>
        <span className="sr-only">{label}</span>
        {detail ? <span className="sr-only">{detail}</span> : null}
        <LoadingStatusText
          ariaLabel={entryStatusLoadingLines[0]}
          lines={entryStatusLoadingLines}
          loopLines={entryStatusLoadingLoopLines}
          animationDurationMs={entryStatusLoadingAnimationDurationMs}
        />
      </div>
    </main>
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
        <section className="entry-fade m-auto w-full max-w-[560px] rounded-[24px] border border-white/10 bg-[#1c1c1c] p-6 shadow-none md:p-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <img src={ohmioWordmark} alt="Ohmio" className="h-4 w-[50px] shrink-0 select-none" draggable={false} />
              <span className="rounded-full border border-white/12 px-2 py-0.5 text-[11px] font-medium uppercase leading-4 text-white/52">
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
