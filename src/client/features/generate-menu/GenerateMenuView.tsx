import { ClipboardEvent, ChangeEvent, Dispatch, FormEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BorderBeam } from "border-beam";
import {
  ChevronDown,
  CircleEllipsis,
  Sparkle,
  WandSparkles,
  X,
  Redo2,
  Undo2,
} from "lucide-react";
import { api, AppConfig, GenerationJob, GenerationRecord, ImageItem } from "../../api";
import generationContinueIcon from "../../assets/figma/generation-continue.svg";
import generationCopyIcon from "../../assets/figma/generation-copy.svg";
import generationDeleteIcon from "../../assets/figma/generation-delete.svg";
import generationDownloadIcon from "../../assets/figma/generation-download.svg";
import generationLocalEditIcon from "../../assets/figma/generation-local-edit.svg";
import generationReferenceSourceIcon from "../../assets/figma/generation-reference-source.svg";
import generationRegenerateIcon from "../../assets/figma/generation-regenerate.svg";
import referenceDeleteIcon from "../../assets/figma/reference-delete.svg";
import sidebarAdd from "../../assets/figma/sidebar-add.svg";
import { claimGenerationSubmitLock, isTerminalGenerationJobStatus, mergePolledJobState, releaseGenerationSubmitLock } from "../../generation-state";
import { generationProgressSummary } from "../../generation-progress";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, dialogBackdropSurfaceClassName } from "../../components/ui/dialog";
import { cn } from "../../lib/utils";
import { Group } from "../../components/ui/group";
import { Input } from "../../components/ui/input";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip";
import { AppShell } from "../generate-shell/AppShell";
import { CossButton, CossTextarea } from "../shared/coss";
import { LoadersWtfStatusIcon, LoadingStatusText as SharedLoadingStatusText } from "../shared/generation-loading";
import {
  collapsedPromptMaxHeightPx,
  conversationCanvasBottomPadding,
  conversationFlowGapPx,
  conversationHorizontalPaddingPx,
  conversationMessageWidthClassName,
  conversationPanelMaxWidthPx,
  conversationPanelWidthClassName,
  conversationTopPaddingPx,
  emptyStateCopyToComposerGapPx,
  emptyFirstComposerTopPercent,
  generationModuleGapPx,
  isScrollNearBottom,
  resolveComposerLayoutMode,
  type ComposerLayoutMode,
} from "./layout";
import {
  buildConversationRecords,
  buildGenerationFlowItem,
  buildSidebarConversations,
  composerDraftFromRecord,
  conversationIdForRecord,
  createDraftConversation,
  mergeJobReferenceImages,
  resolveDefaultActiveConversationId,
  resolveGenerationFlowRecord,
  resolveLatestVisibleConversationId,
  submittedReferenceImages,
  updateDraftConversationTitle,
  type ConversationListItem,
} from "./mappers";
import { formatGenerationSettingsSummary, formatLabels, formatOptions, generationSettingsSummaryParts, qualityLabels, qualityOptions, ratioLabels, ratioOptions, resolutionOptions } from "./options";

const generationStageMaxWidthPx = conversationPanelMaxWidthPx;
const generationStageMaxHeightPx = 360;

interface GenerateMenuViewProps {
  config: AppConfig;
  providerConfigured: boolean;
  records: GenerationRecord[];
  setRecords: Dispatch<SetStateAction<GenerationRecord[]>>;
  recordsError: string;
  nextCursor: string | null;
  loadRecords: (cursor?: string, options?: { background?: boolean }) => Promise<void>;
  onProviderNeeded: () => void;
  onNavigate: (view: "generate" | "gallery" | "settings" | "inspiration") => void;
  pendingJumpTarget?: { conversationId: string; jobId: string } | null;
  onJumpHandled?: () => void;
  onLogout: () => void;
  onUsageChanged: () => Promise<void>;
}

interface GenerateForm {
  prompt: string;
  model: string;
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

interface SourceImagePreview {
  id: string;
  url: string;
  name: string;
}

interface ImageSelectionMask {
  file: File;
  name: string;
  url: string;
  previewName: string;
}

interface ImageSelectionPoint {
  x: number;
  y: number;
}

interface ImageSelectionStroke {
  brushRatio: number;
  points: ImageSelectionPoint[];
}

export interface PreviewImage {
  url: string;
  thumbnailUrl?: string | null;
  prompt?: string;
  actions?: HoverImageAction[];
}

export interface HoverImageAction {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect?: () => void;
  href?: string;
  confirm?: {
    title: string;
    description: string;
    confirmLabel: string;
  };
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

const defaultForm: GenerateForm = {
  prompt: "",
  model: "gpt-image-2",
  aspectRatio: "16:9",
  resolution: "1K",
  width: 1536,
  height: 864,
  quality: "auto",
  quantity: 1,
  outputFormat: "png",
  compression: 100,
};

const ratioSizes: Record<string, [number, number]> = {
  "16:9": [1536, 864],
  "9:16": [864, 1536],
  "4:3": [1536, 1152],
  "3:4": [1152, 1536],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "1:1": [1024, 1024],
};

const resolutionLongEdge: Record<string, number> = {
  "1K": 1536,
  "2K": 2048,
  "4K": 3840,
};

function ComposerReferenceIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 2C8.27613 2 8.5 2.22386 8.5 2.5V7.5H13.5C13.7761 7.5 14 7.72387 14 8C14 8.27613 13.7761 8.5 13.5 8.5H8.5V13.5C8.5 13.7761 8.27613 14 8 14C7.72387 14 7.5 13.7761 7.5 13.5V8.5H2.5C2.22386 8.5 2 8.27613 2 8C2 7.72387 2.22386 7.5 2.5 7.5H7.5V2.5C7.5 2.22386 7.72387 2 8 2Z"
        fill="currentColor"
        fillOpacity="0.9"
      />
    </svg>
  );
}

function SentReferenceIcon({ className }: { className?: string }) {
  return <img aria-hidden="true" src={generationReferenceSourceIcon} alt="" className={className} draggable={false} />;
}

function ToolbarActionIcon({ src, className }: { src: string; className?: string }) {
  return <img aria-hidden="true" src={src} alt="" className={cn("size-4 shrink-0", className)} draggable={false} />;
}

function ComposerOptimizeIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none">
      <path
        d="M3.14227 4.75207L2.97788 5.12919C2.85758 5.40528 2.47571 5.40528 2.35541 5.12919L2.19104 4.75207C1.89804 4.07965 1.3703 3.54427 0.71178 3.25139L0.205365 3.02615C-0.0684548 2.90435 -0.0684548 2.50587 0.205365 2.38408L0.683467 2.17143C1.35892 1.87101 1.89611 1.31582 2.18408 0.620552L2.35288 0.213023C2.47052 -0.0710075 2.86278 -0.0710075 2.98042 0.213023L3.14921 0.620552C3.43718 1.31582 3.97439 1.87101 4.64987 2.17143L5.12792 2.38408C5.40181 2.50587 5.40181 2.90435 5.12792 3.02615L4.62152 3.25139C3.96301 3.54427 3.43525 4.07965 3.14227 4.75207ZM2.04241 14.4088C2.72569 10.2813 4.20737 1.33105 14 1.33105C13.0028 3.33105 12.3333 4.33105 11.6667 4.99772L11 5.66439L12 6.33105C11.3333 8.33107 9.33333 10.6644 6.66667 10.9977C4.88764 11.2201 3.77614 12.4423 3.33216 14.6644H2C2.01383 14.5815 2.02793 14.4962 2.04241 14.4088Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ComposerModelIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none">
      <path
        d="M7.50633 1.45345C7.22727 1.37517 6.93313 1.33333 6.62963 1.33333C5.23029 1.33333 4.03907 2.21984 3.58513 3.46133C2.29548 3.75523 1.33333 4.90849 1.33333 6.28704C1.33333 6.92773 1.54163 7.52027 1.89357 8C1.54163 8.47973 1.33333 9.07227 1.33333 9.71293C1.33333 10.8398 1.97629 11.8154 2.91382 12.2948C3.41047 13.6773 4.73263 14.6667 6.28704 14.6667C6.71933 14.6667 7.13427 14.5899 7.51847 14.4493C7.50647 14.4063 7.5 14.3609 7.5 14.3141V11.335V11.3333C7.5 10.4129 6.7538 9.66667 5.83333 9.66667C5.55719 9.66667 5.33333 9.4428 5.33333 9.16667C5.33333 8.89053 5.55719 8.66667 5.83333 8.66667C6.46397 8.66667 7.04347 8.8856 7.5 9.25153V4.66666V4.66533V1.53333C7.5 1.50614 7.5022 1.47946 7.50633 1.45345Z"
        fill="currentColor"
        fillOpacity="0.9"
      />
      <path
        d="M8.48161 14.4493C8.86581 14.5899 9.28074 14.6667 9.71301 14.6667C11.2675 14.6667 12.5896 13.6773 13.0863 12.2948C14.0238 11.8154 14.6667 10.8398 14.6667 9.71293C14.6667 9.07227 14.4585 8.47973 14.1065 8C14.4585 7.52027 14.6667 6.92773 14.6667 6.28704C14.6667 4.90849 13.7046 3.75523 12.4149 3.46133C11.961 2.21984 10.7698 1.33333 9.37048 1.33333C9.06694 1.33333 8.77281 1.37517 8.49374 1.45345C8.49788 1.47946 8.50008 1.50614 8.50008 1.53333V4.66909C8.50141 5.58845 9.24708 6.33333 10.1667 6.33333C10.4429 6.33333 10.6667 6.55719 10.6667 6.83333C10.6667 7.10947 10.4429 7.33333 10.1667 7.33333C9.53614 7.33333 8.95661 7.1144 8.50008 6.74847V14.3141C8.50008 14.3609 8.49361 14.4063 8.48161 14.4493Z"
        fill="currentColor"
        fillOpacity="0.9"
      />
    </svg>
  );
}

function ComposerQualityIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none">
      <path
        d="M6 8.5C7.30227 8.5 8.3852 9.43267 8.61913 10.6667H13.5C13.7761 10.6667 14 10.8905 14 11.1667C14 11.4428 13.7761 11.6667 13.5 11.6667H8.61913C8.3852 12.9007 7.30227 13.8333 6 13.8333C4.69773 13.8333 3.61482 12.9007 3.38086 11.6667H2.5C2.22386 11.6667 2 11.4428 2 11.1667C2 10.8905 2.22386 10.6667 2.5 10.6667H3.38086C3.61482 9.43267 4.69773 8.5 6 8.5Z"
        fill="currentColor"
        fillOpacity="0.9"
      />
      <path
        d="M10 2.16667C11.3023 2.16667 12.3852 3.09934 12.6191 4.33333H13.5C13.7761 4.33333 14 4.55719 14 4.83333C14 5.10947 13.7761 5.33333 13.5 5.33333H12.6191C12.3852 6.56733 11.3023 7.5 10 7.5C8.69773 7.5 7.6148 6.56733 7.38087 5.33333H2.5C2.22386 5.33333 2 5.10947 2 4.83333C2 4.55719 2.22386 4.33333 2.5 4.33333H7.38087C7.6148 3.09934 8.69773 2.16667 10 2.16667Z"
        fill="currentColor"
        fillOpacity="0.9"
      />
    </svg>
  );
}

const fastPollIntervalMs = 2000;
const standardPollIntervalMs = 5000;
const slowPollIntervalMs = 5000;
const standardPollAfterMs = 30_000;
const slowPollAfterMs = 120_000;
const activeGenerationRecordsRefreshIntervalMs = 12_000;
const initialGenerationStatusTimeoutMs = 8_000;
const maxReferenceImages = 8;
const referenceImageMaxBytes = 10 * 1024 * 1024;
const referenceImageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const fastReferenceImageEdge = 2048;
const composerTextareaLineHeight = 21;
const composerTextareaMinRows = 2;
const composerTextareaMaxRows = 12;
const imageModelOptions = ["gpt-image-2"] as const;
const imagePreviewActionOrder = ["continue", "local-edit", "regenerate", "copy", "download", "delete"] as const;
const imageSelectionBrushRatio = 0.085;
export const loadingStatusAnimationDurationMs = 24_480;
export const composerPromptPlaceholderText = "可以直接描述想生成的图片内容，例如：主体 / 材质 / 构图 / 风格 / 镜头 / 光线等";
export const composerPromptTextMetricsClassName = "text-[15px] leading-[21px]";
export const imagePreviewToolbarPositionClassName = "absolute bottom-4 right-4 z-10";
export const imagePreviewToolbarGroupClassName = "rounded-[16px] border border-white/[0.08] bg-[#121212] p-0.5";
export const loadingStatusLines = [
  "正在生成图片",
  "正在排队处理",
  "正在渲染细节",
  "正在铺陈光影",
  "正在调整构图",
  "正在推敲层次",
  "正在润色质感",
  "正在平衡色彩",
] as const;
export const loadingStatusLoopLines = [...loadingStatusLines, loadingStatusLines[0]] as const;
export const composerPromptTextareaClassName =
  `ohm-composer-prompt-textarea ohm-textarea-scrollbar relative z-[1] min-h-[42px] max-h-[252px] resize-none overflow-x-hidden overflow-y-auto border-0 p-0 ${composerPromptTextMetricsClassName} text-white/90 placeholder:text-[15px] placeholder:leading-[21px] placeholder:text-white/30 focus-visible:ring-0`;
const composerActionButtonClassName =
  "h-8 w-auto gap-1 border-transparent bg-white/10 px-3 py-1 text-sm font-normal leading-[22px] text-white hover:bg-white/12";
export const composerOptimizeBeamClassName = "inline-flex shrink-0 rounded-[12px]";
export const composerOptimizeBeamProps = {
  size: "pulse-inner",
  colorVariant: "colorful",
  strength: 0.7,
} as const;
const imagePreviewVisibleImageClassName = "relative col-start-1 row-start-1 max-h-[calc(100dvh-64px)] max-w-[calc(100vw-64px)] object-contain";
const imagePreviewPreloadClassName = "pointer-events-none absolute size-px opacity-0";
const IMAGE_PREVIEW_STALL_TIMEOUT_MS = 30_000;

export function imagePreviewActionKeys() {
  return [...imagePreviewActionOrder];
}

export function resolveImagePreviewChromeState({
  hasImageUrl,
  imageLoaded,
}: {
  hasImageUrl: boolean;
  imageLoaded: boolean;
}) {
  return {
    showActions: hasImageUrl && imageLoaded,
  };
}

export function resolveImagePreviewProgressPercent(loaded: number, total: number): number | null {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
}

export function createQueuedGenerationJob(
  id: string,
  form: GenerateForm,
  referenceImages: NonNullable<GenerationJob["referenceImages"]>,
): GenerationJob {
  return {
    id,
    status: "queued",
    stage: "queued",
    prompt: form.prompt,
    aspect_ratio: form.aspectRatio,
    width: form.width,
    height: form.height,
    quality: form.quality,
    quantity: form.quantity,
    output_format: form.outputFormat,
    background: "auto",
    compression: form.compression,
    error_code: null,
    error_message: null,
    referenceImages,
    created_at: new Date().toISOString(),
  };
}

export function resolveInitialGenerationStatusTimeoutMs(): number {
  return initialGenerationStatusTimeoutMs;
}

export function remainingReferenceSlots(referenceImageCount: number, hasSourceImage: boolean): number {
  return Math.max(0, maxReferenceImages - referenceImageCount - (hasSourceImage ? 1 : 0));
}

export function shouldShowReferenceCarryoverHint({
  hasConversationImage,
  hasCurrentReference,
  prompt,
}: {
  hasConversationImage: boolean;
  hasCurrentReference: boolean;
  prompt: string;
}): boolean {
  return hasConversationImage && !hasCurrentReference && prompt.trim().length > 0;
}

export function shouldDismissImagePreviewAfterAction(action: Pick<HoverImageAction, "key">): boolean {
  return action.key === "continue" || action.key === "local-edit" || action.key === "regenerate" || action.key === "delete";
}

export function imagePreviewActionsWithDismiss(
  actions: HoverImageAction[] | undefined,
  onClose: () => void,
): HoverImageAction[] {
  return (actions ?? []).map((action) => {
    if (!action.onSelect || !shouldDismissImagePreviewAfterAction(action)) return action;
    return {
      ...action,
      onSelect: () => {
        onClose();
        action.onSelect?.();
      },
    };
  });
}

export function shouldShowComposerOptimizeBeam(optimizing: boolean): boolean {
  return optimizing;
}

export function resolveConversationAutoScrollBehavior({
  previousConversationId,
  nextConversationId,
  previousFlowCount,
  nextFlowCount,
}: {
  previousConversationId: string | null;
  nextConversationId: string | null;
  previousFlowCount: number;
  nextFlowCount: number;
}): ScrollBehavior {
  if (!nextConversationId) return "auto";
  if (previousConversationId !== nextConversationId) return "auto";
  if (nextFlowCount > previousFlowCount) return "smooth";
  return "auto";
}

export function resolveComposerPanelMode(flowCount: number): ComposerLayoutMode {
  return resolveComposerLayoutMode(flowCount);
}

export function resolveGenerationPollIntervalMs(createdAt: string, now = Date.now()): number {
  const createdAtMs = parseUtcTimestamp(createdAt);
  const elapsedMs = Number.isFinite(createdAtMs) ? Math.max(0, now - createdAtMs) : 0;
  if (elapsedMs >= slowPollAfterMs) return slowPollIntervalMs;
  if (elapsedMs >= standardPollAfterMs) return standardPollIntervalMs;
  return fastPollIntervalMs;
}

export function shouldPollGeneration(visibilityState: Document["visibilityState"] | undefined): boolean {
  return visibilityState !== "hidden";
}

export function shouldRefreshGenerationOnLifecycleEvent(
  _eventType: "visibilitychange" | "focus" | "online",
  visibilityState: Document["visibilityState"] | undefined,
): boolean {
  return shouldPollGeneration(visibilityState);
}

export function resolveGenerationPollRequestInit(): RequestInit {
  return { cache: "no-store" };
}

export function resolveActiveGenerationRecordsRefreshIntervalMs(): number {
  return activeGenerationRecordsRefreshIntervalMs;
}

export function shouldRefreshActiveGenerationRecords({
  records,
  activeJob,
}: {
  records: Pick<GenerationRecord, "job">[];
  activeJob: Pick<GenerationJob, "status"> | null | undefined;
}): boolean {
  if (activeJob && !isTerminalJobStatus(activeJob.status)) return true;
  return records.some((record) => !isTerminalJobStatus(record.job.status));
}

export function shouldRefreshActiveGenerationRecordsOnTimer({
  visibilityState,
  hasActiveRecords,
}: {
  visibilityState: Document["visibilityState"] | undefined;
  hasActiveRecords: boolean;
}): boolean {
  return hasActiveRecords && shouldPollGeneration(visibilityState);
}

export function shouldRefreshActiveGenerationRecordsOnLifecycleEvent({
  eventType,
  visibilityState,
  hasActiveRecords,
}: {
  eventType: "visibilitychange" | "focus" | "online";
  visibilityState: Document["visibilityState"] | undefined;
  hasActiveRecords: boolean;
}): boolean {
  return hasActiveRecords && shouldRefreshGenerationOnLifecycleEvent(eventType, visibilityState);
}

export function GenerateMenuView({
  config,
  providerConfigured,
  records,
  setRecords,
  recordsError,
  nextCursor,
  loadRecords,
  onProviderNeeded,
  onNavigate,
  pendingJumpTarget,
  onJumpHandled,
  onLogout,
  onUsageChanged,
}: GenerateMenuViewProps) {
  const [form, setForm] = useState<GenerateForm>(defaultForm);
  const [referenceImages, setReferenceImages] = useState<ReferenceImagePreview[]>([]);
  const [sourceImagePreview, setSourceImagePreview] = useState<SourceImagePreview | null>(null);
  const [referenceMask, setReferenceMask] = useState<ImageSelectionMask | null>(null);
  const [localEditPreviewUrl, setLocalEditPreviewUrl] = useState<string | null>(null);
  const [localEditImage, setLocalEditImage] = useState<ImageItem | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => resolveDefaultActiveConversationId(records));
  const [draftConversation, setDraftConversation] = useState<ReturnType<typeof createDraftConversation> | null>(null);
  const [activeJob, setActiveJob] = useState<GenerationJob | null>(null);
  const [activeImages, setActiveImages] = useState<ImageItem[]>([]);
  const [conversationIdsByRecordId, setConversationIdsByRecordId] = useState<Record<string, string>>({});
  const [submittedReferenceImagesByJobId, setSubmittedReferenceImagesByJobId] = useState<Record<string, NonNullable<GenerationJob["referenceImages"]>>>({});
  const [sourceImageId, setSourceImageId] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [preparingReferences, setPreparingReferences] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const submitLockRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const recordsRefreshInFlightRef = useRef(false);
  const activeJobRef = useRef<GenerationJob | null>(null);
  const hasActiveGenerationRecordsRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const lastAutoScrolledConversationIdRef = useRef<string | null>(null);
  const lastAutoScrolledFlowCountRef = useRef(0);
  const [composerHeight, setComposerHeight] = useState(170);

  const conversations = useMemo(
    () => buildSidebarConversations(records, draftConversation, conversationIdsByRecordId),
    [conversationIdsByRecordId, draftConversation, records],
  );
  const activeConversation = useMemo(() => {
    const fallbackConversationId = draftConversation ? null : resolveLatestVisibleConversationId(conversations);
    const resolvedActiveConversationId = activeConversationId ?? fallbackConversationId;
    if (!resolvedActiveConversationId) return null;
    return conversations.find((conversation) => conversation.id === resolvedActiveConversationId) ?? null;
  }, [activeConversationId, conversations, draftConversation]);
  const activeConversationRecords = useMemo(() => {
    if (draftConversation || !activeConversation?.id) return [];
    return buildConversationRecords(records, conversationIdsByRecordId, activeConversation.id).map((record) => ({
      ...record,
      job: mergeJobReferenceImages(record.job, submittedReferenceImagesByJobId[record.job.id] ? { ...record.job, referenceImages: submittedReferenceImagesByJobId[record.job.id] } : null),
    }));
  }, [activeConversation?.id, conversationIdsByRecordId, draftConversation, records, submittedReferenceImagesByJobId]);
  const activeFlows = useMemo(
    () =>
      activeConversationRecords.map((record) =>
        buildGenerationFlowItem(resolveGenerationFlowRecord(record, activeJob, activeImages)),
      ),
    [activeConversationRecords, activeImages, activeJob],
  );
  const composerLayoutMode = useMemo(() => resolveComposerPanelMode(activeFlows.length), [activeFlows.length]);

  useEffect(() => {
    activeJobRef.current = activeJob;
  }, [activeJob]);

  useEffect(() => {
    hasActiveGenerationRecordsRef.current = shouldRefreshActiveGenerationRecords({ records, activeJob });
  }, [activeJob, records]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const clearRefreshTimer = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };

    const refreshActiveRecords = async () => {
      if (cancelled || recordsRefreshInFlightRef.current) return;
      recordsRefreshInFlightRef.current = true;
      try {
        await loadRecords(undefined, { background: true });
      } finally {
        recordsRefreshInFlightRef.current = false;
      }
    };

    const scheduleRefresh = () => {
      if (cancelled) return;
      clearRefreshTimer();
      timer = window.setTimeout(() => {
        if (shouldRefreshActiveGenerationRecordsOnTimer({
          visibilityState: document.visibilityState,
          hasActiveRecords: hasActiveGenerationRecordsRef.current,
        })) {
          void refreshActiveRecords();
        }
        scheduleRefresh();
      }, resolveActiveGenerationRecordsRefreshIntervalMs());
    };

    const refreshNow = (eventType: "visibilitychange" | "focus" | "online") => {
      if (!shouldRefreshActiveGenerationRecordsOnLifecycleEvent({
        eventType,
        visibilityState: document.visibilityState,
        hasActiveRecords: hasActiveGenerationRecordsRef.current,
      })) {
        return;
      }
      void refreshActiveRecords();
    };

    const handleVisibilityChange = () => refreshNow("visibilitychange");
    const handleFocus = () => refreshNow("focus");
    const handleOnline = () => refreshNow("online");

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    scheduleRefresh();

    return () => {
      cancelled = true;
      recordsRefreshInFlightRef.current = false;
      clearRefreshTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [loadRecords]);

  useEffect(() => {
    setConversationIdsByRecordId((current) => {
      let changed = false;
      const next = { ...current };
      for (const record of records) {
        if (next[record.job.id]) continue;
        next[record.job.id] = conversationIdForRecord(record);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [records]);

  useEffect(() => {
    if (draftConversation) return;
    const latestConversationId = resolveLatestVisibleConversationId(conversations);
    if (!latestConversationId) {
      if (activeConversationId !== null) setActiveConversationId(null);
      return;
    }
    const hasActiveConversation = activeConversationId ? conversations.some((conversation) => conversation.id === activeConversationId) : false;
    if (hasActiveConversation) return;
    if (activeConversationId !== latestConversationId) setActiveConversationId(latestConversationId);
  }, [activeConversationId, conversations, draftConversation]);

  useEffect(() => {
    if (!pendingJumpTarget) return;
    shouldStickToBottomRef.current = false;
    setDraftConversation(null);
    setActiveConversationId(pendingJumpTarget.conversationId);
  }, [pendingJumpTarget]);

  useEffect(() => {
    if (!pendingJumpTarget) return;
    if ((activeConversation?.id ?? null) !== pendingJumpTarget.conversationId) return;
    if (!activeConversationRecords.some((record) => record.job.id === pendingJumpTarget.jobId)) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-generation-job-id="${pendingJumpTarget.jobId}"]`);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      onJumpHandled?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversation?.id, activeConversationRecords, onJumpHandled, pendingJumpTarget]);

  useEffect(() => {
    if (!draftConversation) return;
    setDraftConversation((current) => (current ? updateDraftConversationTitle(current, form.prompt) : current));
  }, [draftConversation?.id, form.prompt]);

  useEffect(() => {
    if (!activeJob || isTerminalJobStatus(activeJob.status)) return;
    let cancelled = false;
    let timer: number | undefined;

    const clearPollTimer = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };

    const schedulePoll = () => {
      if (cancelled) return;
      const currentJob = activeJobRef.current;
      if (!currentJob || isTerminalJobStatus(currentJob.status)) return;
      clearPollTimer();
      timer = window.setTimeout(pollJob, resolveGenerationPollIntervalMs(currentJob.created_at));
    };

    const pollJob = async () => {
      if (cancelled) return;
      clearPollTimer();
      const currentJob = activeJobRef.current;
      if (!currentJob || isTerminalJobStatus(currentJob.status)) return;
      if (!shouldPollGeneration(document.visibilityState)) {
        schedulePoll();
        return;
      }
      if (pollInFlightRef.current) {
        schedulePoll();
        return;
      }
      pollInFlightRef.current = true;
      try {
        const result = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${currentJob.id}`, resolveGenerationPollRequestInit());
        const fallbackReferenceImages = submittedReferenceImagesByJobId[currentJob.id] ?? currentJob.referenceImages;
        const mergedReferenceJob = mergeJobReferenceImages(result.job, fallbackReferenceImages ? { ...result.job, referenceImages: fallbackReferenceImages } : currentJob);
        const nextJob = mergePolledJobState(activeJobRef.current, mergedReferenceJob);
        activeJobRef.current = nextJob;
        setActiveJob(nextJob);
        setActiveImages(result.images);
        upsertRecord(setRecords, nextJob, result.images);
        if (isTerminalJobStatus(nextJob.status)) {
          clearPollTimer();
          void onUsageChanged();
          void loadRecords(undefined, { background: true });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "刷新任务状态失败。");
      } finally {
        pollInFlightRef.current = false;
        schedulePoll();
      }
    };

    const refreshNow = (eventType: "visibilitychange" | "focus" | "online") => {
      if (!shouldRefreshGenerationOnLifecycleEvent(eventType, document.visibilityState)) return;
      void pollJob();
    };

    const handleVisibilityChange = () => refreshNow("visibilitychange");
    const handleFocus = () => refreshNow("focus");
    const handleOnline = () => refreshNow("online");

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    schedulePoll();
    return () => {
      cancelled = true;
      pollInFlightRef.current = false;
      clearPollTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [activeJob?.id, activeJob?.status, activeJob?.referenceImages, loadRecords, onUsageChanged, setRecords, submittedReferenceImagesByJobId]);

  useEffect(() => {
    if (!textareaRef.current) return;
    const textarea = textareaRef.current;
    const minHeight = composerTextareaLineHeight * composerTextareaMinRows;
    const maxHeight = composerTextareaLineHeight * composerTextareaMaxRows;
    textarea.style.height = `${minHeight}px`;
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [form.prompt]);

  useEffect(() => () => revokeObjectUrls(objectUrlsRef.current), []);

  useEffect(() => {
    if (!composerRef.current) return;
    const composer = composerRef.current;
    const syncComposerHeight = () => setComposerHeight(composer.getBoundingClientRect().height);
    syncComposerHeight();
    const observer = new ResizeObserver(syncComposerHeight);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!sourceImagePreview || !referenceMask) {
      setLocalEditPreviewUrl(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    void buildLocalEditPreviewUrl(sourceImagePreview.url, referenceMask.url)
      .then((url) => {
        if (cancelled) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url.startsWith("blob:") ? url : null;
        setLocalEditPreviewUrl(url);
      })
      .catch(() => {
        if (!cancelled) setLocalEditPreviewUrl(sourceImagePreview.url);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [referenceMask, sourceImagePreview]);

  useEffect(() => {
    const canvas = canvasScrollRef.current;
    const nextConversationId = activeConversation?.id ?? null;
    const nextFlowCount = activeFlows.length;
    if (!canvas || !shouldStickToBottomRef.current) {
      lastAutoScrolledConversationIdRef.current = nextConversationId;
      lastAutoScrolledFlowCountRef.current = nextFlowCount;
      return;
    }
    const behavior = resolveConversationAutoScrollBehavior({
      previousConversationId: lastAutoScrolledConversationIdRef.current,
      nextConversationId,
      previousFlowCount: lastAutoScrolledFlowCountRef.current,
      nextFlowCount,
    });
    const frame = window.requestAnimationFrame(() => {
      canvas.scrollTo({ top: canvas.scrollHeight, behavior });
    });
    lastAutoScrolledConversationIdRef.current = nextConversationId;
    lastAutoScrolledFlowCountRef.current = nextFlowCount;
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversation?.id, activeFlows.length, error]);

  const updateForm = useCallback(<K extends keyof GenerateForm>(key: K, value: GenerateForm[K]) => {
    setForm((current) => updateGenerateForm(current, key, value));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!claimGenerationSubmitLock(submitLockRef)) return;
    if (!providerConfigured) {
      releaseGenerationSubmitLock(submitLockRef);
      onProviderNeeded();
      return;
    }
    if (!form.prompt.trim()) {
      releaseGenerationSubmitLock(submitLockRef);
      textareaRef.current?.focus();
      return;
    }
    if (config.turnstileRequired && config.turnstileSiteKey && !turnstileToken) {
      releaseGenerationSubmitLock(submitLockRef);
      setError("请先完成人机验证。");
      return;
    }

    setLoading(true);
    setError("");
    const submittedReferences = submittedReferenceImages(
      referenceImages,
      sourceImagePreview
        ? { ...sourceImagePreview, url: localEditPreviewUrl ?? sourceImagePreview.url }
        : null,
    );
    try {
      const result = await api<{ ok: true; jobId: string; status: "queued" }>("/api/generations", {
        method: "POST",
        body: generationRequestBody(
          form,
          referenceImages,
          sourceImageId,
          turnstileToken,
          referenceMask,
          draftConversation ? undefined : activeConversationId ?? undefined,
        ),
      });
      void onUsageChanged();
      let firstPollJob = createQueuedGenerationJob(result.jobId, form, submittedReferences);
      let firstPollImages: ImageItem[] = [];
      try {
        const firstPoll = await loadInitialGenerationStatus(result.jobId);
        firstPollJob = mergeJobReferenceImages(firstPoll.job, submittedReferences.length > 0 ? { ...firstPoll.job, referenceImages: submittedReferences } : null);
        firstPollImages = firstPoll.images;
      } catch {
        // The generation was accepted. The normal polling loop will pick up its status shortly.
      }
      if (submittedReferences.length > 0) {
        setSubmittedReferenceImagesByJobId((current) => ({ ...current, [firstPollJob.id]: submittedReferences }));
      }
      const conversationId =
        conversationIdForRecord({ job: firstPollJob, images: firstPollImages, elapsedSeconds: null }) || activeConversationId || result.jobId;
      shouldStickToBottomRef.current = true;
      setActiveJob(firstPollJob);
      setActiveImages(firstPollImages);
      setConversationIdsByRecordId((current) => ({ ...current, [firstPollJob.id]: conversationId }));
      setActiveConversationId(conversationId);
      setDraftConversation(null);
      upsertRecord(setRecords, firstPollJob, firstPollImages);
      setForm((current) => ({ ...current, prompt: "" }));
      setReferenceImages([]);
      setSourceImageId(undefined);
      setSourceImagePreview(null);
      setReferenceMask(null);
      void loadRecords(undefined, { background: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建任务失败。");
    } finally {
      releaseGenerationSubmitLock(submitLockRef);
      setLoading(false);
    }
  }

  async function optimizePrompt() {
    if (!providerConfigured) {
      onProviderNeeded();
      return;
    }
    if (!form.prompt.trim()) {
      textareaRef.current?.focus();
      return;
    }
    setOptimizing(true);
    setError("");
    try {
      const result = await api<{ ok: true; optimizedPrompt: string }>("/api/prompts/optimize", {
        method: "POST",
        body: JSON.stringify({
          prompt: form.prompt,
          aspectRatio: form.aspectRatio,
          width: form.width,
          height: form.height,
          quality: form.quality,
          outputFormat: form.outputFormat,
          referenceImageCount: referenceImages.length + (sourceImageId ? 1 : 0),
          hasSourceImage: Boolean(sourceImageId),
          hasMaskImage: Boolean(referenceMask),
        }),
      });
      updateForm("prompt", result.optimizedPrompt.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "提示词优化失败。");
    } finally {
      setOptimizing(false);
    }
  }

  function addReferenceFiles(event: ChangeEvent<HTMLInputElement>) {
    void addReferenceFilesFromList(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((item) => item.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void addReferenceFilesFromList(files);
  }

  async function addReferenceFilesFromList(files: File[]) {
    if (files.length === 0) return;
    const remaining = remainingReferenceSlots(referenceImages.length, Boolean(sourceImagePreview));
    if (remaining <= 0) {
      setError(`参考图最多 ${maxReferenceImages} 张。`);
      return;
    }

    setPreparingReferences(true);
    try {
      const accepted: ReferenceImagePreview[] = [];
      for (const file of files.slice(0, remaining)) {
        const mimeType = normalizeImageMime(file.type);
        if (!referenceImageMimeTypes.has(mimeType)) {
          setError("参考图仅支持 PNG、JPEG 或 WebP 格式。");
          return;
        }
        let preparedFile: File;
        try {
          preparedFile = await prepareReferenceImage(file);
        } catch (err) {
          setError(err instanceof Error ? err.message : "参考图读取失败。");
          return;
        }
        if (preparedFile.size > referenceImageMaxBytes) {
          setError("参考图不能超过 10MB。");
          return;
        }
        const url = URL.createObjectURL(preparedFile);
        objectUrlsRef.current.push(url);
        accepted.push({ file: preparedFile, name: preparedFile.name || file.name || "参考图", url });
      }

      if (files.length > remaining) setError(`参考图最多 ${maxReferenceImages} 张。`);
      else setError("");
      // Adding a regular reference changes a local edit into a regular multi-reference request,
      // but the continued-creation source image remains part of that request.
      setReferenceMask(null);
      setReferenceImages((current) => [...current, ...accepted]);
    } finally {
      setPreparingReferences(false);
    }
  }

  function clearAllReferences() {
    revokeObjectUrls(objectUrlsRef.current);
    objectUrlsRef.current = [];
    setReferenceImages([]);
    setSourceImageId(undefined);
    setSourceImagePreview(null);
    setReferenceMask(null);
    if (referenceInputRef.current) referenceInputRef.current.value = "";
  }

  function continueFromRecord(record: GenerationRecord, image?: ImageItem) {
    const draft = composerDraftFromRecord(record, image?.id);
    shouldStickToBottomRef.current = true;
    setForm((current) => ({ ...current, prompt: draft.prompt, quality: draft.selectedQuality }));
    setSourceImageId(draft.sourceImageId);
    setSourceImagePreview(image ? { id: image.id, url: image.url, name: "参考图 1" } : null);
    setReferenceMask(null);
    revokeObjectUrls(objectUrlsRef.current);
    objectUrlsRef.current = [];
    setReferenceImages([]);
    setDraftConversation(null);
    setActiveConversationId(conversationIdForRecord(record, conversationIdsByRecordId));
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function regenerate(record: GenerationRecord) {
    if (!claimGenerationSubmitLock(submitLockRef)) return;
    if (!providerConfigured) {
      releaseGenerationSubmitLock(submitLockRef);
      onProviderNeeded();
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await api<{ ok: true; jobId: string; status: "queued" }>(`/api/generations/${record.job.id}/regenerate`, { method: "POST" });
      const firstPoll = await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(`/api/generations/${result.jobId}`);
      const conversationId =
        conversationIdForRecord({ job: firstPoll.job, images: firstPoll.images, elapsedSeconds: null }, conversationIdsByRecordId)
        || conversationIdForRecord(record, conversationIdsByRecordId);
      shouldStickToBottomRef.current = true;
      setActiveJob(firstPoll.job);
      setActiveImages(firstPoll.images);
      setConversationIdsByRecordId((current) => ({ ...current, [firstPoll.job.id]: conversationId }));
      setActiveConversationId(conversationId);
      setDraftConversation(null);
      upsertRecord(setRecords, firstPoll.job, firstPoll.images);
      void onUsageChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新生成失败。");
    } finally {
      releaseGenerationSubmitLock(submitLockRef);
      setLoading(false);
    }
  }

  async function deleteRecord(record: GenerationRecord) {
    setError("");
    try {
      await api<{ ok: true }>(`/api/generations/${record.job.id}`, { method: "DELETE" });
      setRecords((current) => current.filter((item) => item.job.id !== record.job.id));
      setSubmittedReferenceImagesByJobId((current) => {
        const { [record.job.id]: _removed, ...rest } = current;
        return rest;
      });
      setConversationIdsByRecordId((current) => {
        const { [record.job.id]: _removed, ...rest } = current;
        return rest;
      });
      if (activeJob?.id === record.job.id) {
        setActiveJob(null);
        setActiveImages([]);
      }
      setPreviewImage(null);
      void loadRecords(undefined, { background: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除记录失败。");
    }
  }

  async function applyLocalEdit(image: ImageItem, strokes: ImageSelectionStroke[]) {
    const localEditMask = await createSelectionMask(image, strokes);
    shouldStickToBottomRef.current = true;
    revokeObjectUrls(objectUrlsRef.current);
    objectUrlsRef.current = [];
    const maskUrl = URL.createObjectURL(localEditMask.file);
    objectUrlsRef.current.push(maskUrl);
    setReferenceImages([]);
    setReferenceMask({ ...localEditMask, url: maskUrl, previewName: "局部重绘遮罩" });
    setSourceImageId(image.id);
    setSourceImagePreview({ id: image.id, url: image.url, name: "局部重绘" });
    setLocalEditImage(null);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  const sidebar = (
    <ConversationSidebar
      conversations={conversations}
      activeId={draftConversation?.id ?? activeConversation?.id ?? activeConversationId}
      error={recordsError}
      nextCursor={nextCursor}
      onNew={() => {
        shouldStickToBottomRef.current = true;
        const draft = createDraftConversation();
        setDraftConversation(draft);
        setActiveConversationId(draft.id);
        setActiveJob(null);
        setActiveImages([]);
        setSourceImageId(undefined);
        setForm(defaultForm);
        clearAllReferences();
        window.requestAnimationFrame(() => textareaRef.current?.focus());
      }}
      onSelect={(id) => {
        shouldStickToBottomRef.current = true;
        setDraftConversation(null);
        setActiveConversationId(id);
      }}
      onLoadMore={() => void loadRecords(nextCursor ?? undefined)}
    />
  );

  return (
    <AppShell activeView="generate" sidebar={sidebar} onNavigate={onNavigate} onLogout={onLogout}>
      <GenerationCanvas
        scrollRef={canvasScrollRef}
        composerHeight={composerHeight}
        composerLayoutMode={composerLayoutMode}
        flows={activeFlows}
        error={error}
        onPreview={setPreviewImage}
        onContinue={continueFromRecord}
        onLocalEdit={(image) => setLocalEditImage(image)}
        onRegenerate={regenerate}
        onDelete={(record) => void deleteRecord(record)}
        onCopyPrompt={(prompt) => void navigator.clipboard?.writeText(prompt)}
        onScrollStickyChange={(isSticky) => {
          shouldStickToBottomRef.current = isSticky;
        }}
      />
      <ComposerPanel
        formRef={composerRef}
        layoutMode={composerLayoutMode}
        form={form}
        config={config}
        loading={loading || preparingReferences}
        referencePreparing={preparingReferences}
        optimizing={optimizing}
        providerConfigured={providerConfigured}
        showReferenceCarryoverHint={shouldShowReferenceCarryoverHint({
          hasConversationImage: activeFlows.some((flow) => flow.images.length > 0),
          hasCurrentReference: Boolean(sourceImagePreview || referenceMask || referenceImages.length > 0),
          prompt: form.prompt,
        })}
        referenceImages={referenceImages}
        sourceImagePreview={sourceImagePreview}
        referenceMask={referenceMask}
        localEditPreviewUrl={localEditPreviewUrl}
        textareaRef={textareaRef}
        referenceInputRef={referenceInputRef}
        onSubmit={submit}
        onPromptPaste={handlePaste}
        onReferenceInput={addReferenceFiles}
        onPickReference={() => referenceInputRef.current?.click()}
        onRemoveSourceReference={() => {
          setSourceImageId(undefined);
          setSourceImagePreview(null);
          setReferenceMask(null);
        }}
        onRemoveReference={(index) =>
          setReferenceImages((current) => {
            const removed = current[index];
            if (removed) {
              URL.revokeObjectURL(removed.url);
              objectUrlsRef.current = objectUrlsRef.current.filter((url) => url !== removed.url);
            }
            return current.filter((_, itemIndex) => itemIndex !== index);
          })
        }
        onOptimize={() => void optimizePrompt()}
        onUpdate={updateForm}
        turnstileToken={turnstileToken}
        onTurnstileToken={setTurnstileToken}
      />
      {previewImage && <ImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />}
      <LocalEditDialog
        image={localEditImage}
        open={Boolean(localEditImage)}
        onOpenChange={(open) => {
          if (!open) setLocalEditImage(null);
        }}
        onConfirm={applyLocalEdit}
      />
    </AppShell>
  );
}

function ConversationSidebar({
  conversations,
  activeId,
  error,
  nextCursor,
  onNew,
  onSelect,
  onLoadMore,
}: {
  conversations: ConversationListItem[];
  activeId: string | null;
  error: string;
  nextCursor: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
}) {
  let lastGroup = "";
  let groupIndex = 0;
  return (
    <div className="flex h-full flex-col px-4 pt-[13px]">
      <div className="flex h-[22px] items-center">
        <span className="text-sm font-semibold leading-[22px] text-white/90">开启创作</span>
      </div>
      <CossButton variant="secondary" className="mt-4 h-8 justify-start gap-4 rounded-[8px] border-transparent bg-white/20 pl-2 pr-3 text-sm font-normal leading-[22px] text-white/90 hover:bg-white/20" onClick={onNew}>
        <img src={sidebarAdd} alt="" className="size-4 shrink-0" draggable={false} />
        新对话
      </CossButton>
      <div className="thin-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto pb-4">
        {error && <p className="mb-3 rounded-[8px] border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        {conversations.map((conversation) => {
          const showGroup = conversation.groupLabel !== lastGroup;
          const groupClassName = groupIndex === 0 ? "mt-0" : "mt-6";
          if (showGroup) groupIndex += 1;
          lastGroup = conversation.groupLabel;
          return (
            <div key={conversation.id} className="ohm-conversation-list-item">
              {showGroup && <p className={cn("mb-2 text-xs font-semibold leading-5 text-white/30", groupClassName)}>{conversation.groupLabel}</p>}
              <CossButton
                type="button"
                variant="ghost"
                className={cn(
                  "mb-2 flex h-8 w-full items-center gap-2 overflow-hidden rounded-[8px] border-0 bg-transparent px-0 text-left text-sm font-normal leading-[22px] text-white/90 transition-colors hover:bg-white/10",
                  activeId === conversation.id && "bg-white/10",
                )}
                onClick={() => onSelect(conversation.id)}
              >
                <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-[8px] bg-white/10">
                  {conversation.previewImage ? <img src={conversation.previewImage} alt="" loading="lazy" decoding="async" className="size-full object-cover" /> : <Sparkle aria-hidden size={16} className="text-white/45" />}
                </span>
                <span className="block min-w-0 flex-1 truncate pr-3">{conversation.title}</span>
              </CossButton>
            </div>
          );
        })}
        {nextCursor && (
          <CossButton variant="ghost" size="sm" className="mt-2 w-full" onClick={onLoadMore}>
            加载更多
          </CossButton>
        )}
      </div>
    </div>
  );
}

function GenerationCanvas({
  scrollRef,
  composerHeight,
  composerLayoutMode,
  flows,
  error,
  onPreview,
  onContinue,
  onLocalEdit,
  onRegenerate,
  onDelete,
  onCopyPrompt,
  onScrollStickyChange,
}: {
  scrollRef: RefObject<HTMLDivElement>;
  composerHeight: number;
  composerLayoutMode: ComposerLayoutMode;
  flows: Array<ReturnType<typeof buildGenerationFlowItem>>;
  error: string;
  onPreview: (image: PreviewImage) => void;
  onContinue: (record: GenerationRecord, image?: ImageItem) => void;
  onLocalEdit: (image: ImageItem) => void;
  onRegenerate: (record: GenerationRecord) => void;
  onDelete: (record: GenerationRecord) => void;
  onCopyPrompt: (prompt: string) => void;
  onScrollStickyChange: (isSticky: boolean) => void;
}) {
  return (
    <div
      ref={scrollRef}
      className="thin-scrollbar absolute inset-0 overflow-y-auto"
      style={{
        paddingTop: conversationTopPaddingPx,
        paddingRight: conversationHorizontalPaddingPx,
        paddingBottom: conversationCanvasBottomPadding(composerHeight, composerLayoutMode),
        paddingLeft: conversationHorizontalPaddingPx,
      }}
      onScroll={(event) => {
        const target = event.currentTarget;
        onScrollStickyChange(isScrollNearBottom(target.scrollTop, target.clientHeight, target.scrollHeight));
      }}
    >
      <div className={cn("relative left-1/2 flex -translate-x-1/2 flex-col", conversationPanelWidthClassName)} style={{ gap: conversationFlowGapPx }}>
        {error && <div className="ohm-smooth-card border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
        {flows.map((flow) => (
          <GenerationCard
            key={flow.id}
            flow={flow}
            onPreview={onPreview}
            onContinue={onContinue}
            onLocalEdit={onLocalEdit}
            onRegenerate={onRegenerate}
            onDelete={onDelete}
            onCopyPrompt={onCopyPrompt}
          />
        ))}
        {flows.length === 0 && composerLayoutMode === "conversation" && <EmptyConversationState />}
      </div>
    </div>
  );
}

function EmptyConversationState() {
  return (
    <div className="grid min-h-[538px] place-items-center px-10 text-center">
      <p className="text-[28px] font-medium leading-none tracking-[-0.04em] text-white/26">让我们一起创造点什么······</p>
    </div>
  );
}

function GenerationCard({
  flow,
  onPreview,
  onContinue,
  onLocalEdit,
  onRegenerate,
  onDelete,
  onCopyPrompt,
}: {
  flow: ReturnType<typeof buildGenerationFlowItem>;
  onPreview: (image: PreviewImage) => void;
  onContinue: (record: GenerationRecord, image?: ImageItem) => void;
  onLocalEdit: (image: ImageItem) => void;
  onRegenerate: (record: GenerationRecord) => void;
  onDelete: (record: GenerationRecord) => void;
  onCopyPrompt: (prompt: string) => void;
}) {
  const record: GenerationRecord = { job: flow.job, images: flow.images, elapsedSeconds: flow.elapsedSeconds };
  const [expandedPrompt, setExpandedPrompt] = useState(false);
  const [promptOverflowing, setPromptOverflowing] = useState(false);
  const promptRef = useRef<HTMLParagraphElement | null>(null);
  const referenceImages = flow.job.referenceImages ?? [];
  const chips = buildFlowChips(flow);
  const showStatusRow = flow.status === "pending";
  const stageImages = flow.images.slice(0, Math.max(1, flow.job.quantity));
  const stageLayout = generationStageLayout(flow.job, stageImages);

  useEffect(() => {
    if (!promptRef.current) return;
    const promptElement = promptRef.current;
    const measure = () => setPromptOverflowing(promptElement.scrollHeight > collapsedPromptMaxHeightPx() + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(promptElement);
    return () => observer.disconnect();
  }, [flow.job.prompt]);

  return (
    <article className="relative text-white/90" data-generation-job-id={flow.job.id}>
      {referenceImages.length > 0 && (
        <div className={cn("mb-2 flex min-h-8 items-start gap-2", conversationMessageWidthClassName)}>
          <span className="mt-2 grid size-4 shrink-0 place-items-center text-white/90">
            <SentReferenceIcon className="size-4 text-white/90" />
          </span>
          <div className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-2">
            {referenceImages.map((image, index) => (
              <CossButton
                key={`${image.url}-${index}`}
                type="button"
                variant="secondary"
                className="inline-flex h-8 shrink-0 items-center gap-1 overflow-hidden rounded-[8px] border border-transparent bg-white/10 px-1.5 py-1 text-sm font-normal leading-[22px] text-white transition hover:bg-white/12"
                onClick={() =>
                  onPreview({
                    url: image.url,
                    prompt: image.name || `参考图 ${index + 1}`,
                    actions: [
                      {
                        key: "download",
                        label: "下载这张图片",
                        icon: <ToolbarActionIcon src={generationDownloadIcon} />,
                        href: image.url,
                      },
                    ],
                  })}
              >
                <span className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-[6px] border border-transparent bg-white/10">
                  <img src={image.url} alt={image.name || `参考图 ${index + 1}`} loading="lazy" decoding="async" className="size-full object-cover" />
                </span>
                <span className="whitespace-nowrap">{image.name || `参考图 ${index + 1}`}</span>
              </CossButton>
            ))}
          </div>
        </div>
      )}
      <div className={conversationMessageWidthClassName}>
        <p
          ref={promptRef}
          className={cn(
            "whitespace-pre-wrap text-sm leading-[21px] text-white/90",
          )}
          style={!expandedPrompt && promptOverflowing ? { maxHeight: collapsedPromptMaxHeightPx(), overflow: "hidden" } : undefined}
        >
          {flow.job.prompt}
        </p>
      </div>

      <div className={cn("mt-2 flex items-center gap-2", conversationMessageWidthClassName)}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <span key={chip} className="rounded-[6px] bg-white/10 px-2 py-1 text-xs leading-none text-white/60">
              {chip}
            </span>
          ))}
        </div>
        {promptOverflowing && (
          <button
            type="button"
            className="shrink-0 rounded-[6px] bg-[#494949] px-3 py-1 text-xs leading-none text-white/90 transition hover:bg-[#5a5a5a]"
            onClick={() => setExpandedPrompt((current) => !current)}
          >
            {expandedPrompt ? "收起" : "展示全部"}
          </button>
        )}
      </div>

      {showStatusRow && (
        <div className={cn("flex items-center gap-2 text-sm leading-[22px] text-white", conversationMessageWidthClassName)} style={{ marginTop: generationModuleGapPx }}>
          <span className="inline-flex size-[14px] items-center justify-center">
            <LoadersWtfStatusIcon />
          </span>
          <LoadingStatusText />
        </div>
      )}

      {flow.status === "pending" ? (
        <BorderBeam
          className={cn("generation-preview-beam", showStatusRow ? "mt-2" : "mt-6")}
          size="pulse-inner"
          colorVariant="colorful"
          style={{ width: stageLayout.width, height: stageLayout.height }}
        >
          <div className="relative h-full w-full overflow-hidden rounded-[24px] border-[1.2px] border-transparent bg-white/[0.06]">
            <PendingStage />
          </div>
        </BorderBeam>
      ) : (
        <div
          className={cn("relative overflow-hidden rounded-[24px] border-[1.2px] border-white/20 bg-white/[0.06]", showStatusRow ? "mt-2" : "mt-6")}
          style={{ width: stageLayout.width, height: stageLayout.height }}
        >
          {stageImages.length > 0 && (
            <div className="flex h-full w-full">
              {stageImages.map((image, index) => (
                <GenerationStageImageCell
                  key={image.id}
                  image={image}
                  prompt={flow.job.prompt}
                  record={record}
                  showDivider={index > 0}
                  onPreview={onPreview}
                  onContinue={onContinue}
                  onLocalEdit={onLocalEdit}
                  onRegenerate={onRegenerate}
                  onDelete={onDelete}
                  onCopyPrompt={onCopyPrompt}
                />
              ))}
            </div>
          )}
          {flow.status === "failed" && (
            <div className="flex h-full items-center justify-center px-8 text-center text-sm leading-6 text-white/40">
              {flow.job.error_message ?? "生成失败"}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function GenerationStageImageCell({
  image,
  prompt,
  record,
  showDivider,
  onPreview,
  onContinue,
  onLocalEdit,
  onRegenerate,
  onDelete,
  onCopyPrompt,
}: {
  image: ImageItem;
  prompt: string;
  record: GenerationRecord;
  showDivider: boolean;
  onPreview: (image: PreviewImage) => void;
  onContinue: (record: GenerationRecord, image?: ImageItem) => void;
  onLocalEdit: (image: ImageItem) => void;
  onRegenerate: (record: GenerationRecord) => void;
  onDelete: (record: GenerationRecord) => void;
  onCopyPrompt: (prompt: string) => void;
}) {
  const [isPinnedOpen, setIsPinnedOpen] = useState(false);
  const [displayImageUrl, setDisplayImageUrl] = useState(image.thumbnailUrl ?? image.url);
  const actions = buildGeneratedImageActions(image, prompt, record, onContinue, onLocalEdit, onRegenerate, onDelete, onCopyPrompt);

  useEffect(() => {
    setDisplayImageUrl(image.thumbnailUrl ?? image.url);
  }, [image.thumbnailUrl, image.url]);

  return (
    <div data-image-action-host className={cn("group/image relative h-full min-w-0 flex-1 overflow-hidden bg-[#222]", showDivider && "border-l border-white/20")}>
      <CossButton
        type="button"
        variant="ghost"
        className="block h-full w-full rounded-none border-0 bg-transparent p-0 hover:bg-transparent"
        onClick={() => onPreview({ url: image.url, thumbnailUrl: image.thumbnailUrl, prompt: image.prompt ?? prompt, actions })}
      >
        <img
          src={displayImageUrl}
          alt={image.prompt ?? "生成图片"}
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => {
            if (displayImageUrl !== image.url) setDisplayImageUrl(image.url);
          }}
        />
      </CossButton>
      <div
        className={cn(
          "pointer-events-none absolute bottom-3 right-3 opacity-0 transition-opacity group-hover/image:pointer-events-auto group-hover/image:opacity-100",
          isPinnedOpen && "pointer-events-auto opacity-100",
        )}
      >
        <HoverImageActionBar actions={actions} onMoreOpenChange={setIsPinnedOpen} />
      </div>
    </div>
  );
}

function buildGeneratedImageActions(
  image: ImageItem,
  prompt: string,
  record: GenerationRecord,
  onContinue: (record: GenerationRecord, image?: ImageItem) => void,
  onLocalEdit: (image: ImageItem) => void,
  onRegenerate: (record: GenerationRecord) => void,
  onDelete: (record: GenerationRecord) => void,
  onCopyPrompt: (prompt: string) => void,
): HoverImageAction[] {
  return [
    { key: "continue", label: "基于这张图片继续创作", icon: <ToolbarActionIcon src={generationContinueIcon} />, onSelect: () => onContinue(record, image) },
    { key: "local-edit", label: "局部编辑", icon: <ToolbarActionIcon src={generationLocalEditIcon} />, onSelect: () => onLocalEdit(image) },
    { key: "regenerate", label: "重新生成", icon: <ToolbarActionIcon src={generationRegenerateIcon} />, onSelect: () => void onRegenerate(record) },
    { key: "copy", label: "复制提示词", icon: <ToolbarActionIcon src={generationCopyIcon} />, onSelect: () => onCopyPrompt(prompt) },
    { key: "download", label: "下载这张图片", icon: <ToolbarActionIcon src={generationDownloadIcon} />, href: `/api/images/${image.id}/download?raw=1&download=1` },
    {
      key: "delete",
      label: "删除这次生成",
      icon: <ToolbarActionIcon src={generationDeleteIcon} />,
      onSelect: () => onDelete(record),
      confirm: {
        title: "删除这次生成？",
        description: "会删除这次生成的图片、参考图、遮罩和生成使用的提示词记录。此操作不能撤销。",
        confirmLabel: "删除",
      },
    },
  ];
}

export function HoverImageActionBar({
  actions,
  maxInlineActions,
  onMoreOpenChange,
}: {
  actions: HoverImageAction[];
  maxInlineActions?: number;
  onMoreOpenChange?: (open: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [inlineActionCount, setInlineActionCount] = useState(() => Math.min(actions.length, maxInlineActions ?? actions.length));
  const [confirmAction, setConfirmAction] = useState<HoverImageAction | null>(null);
  const inlineActions = actions.slice(0, inlineActionCount);
  const overflowActions = actions.slice(inlineActionCount);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const host = root?.closest("[data-image-action-host]") ?? root?.parentElement?.parentElement ?? root?.parentElement ?? root;
    if (!host) {
      setInlineActionCount(Math.min(actions.length, maxInlineActions ?? actions.length));
      return;
    }

    const updateInlineActionCount = () => {
      const width = host.getBoundingClientRect().width - hoverImageActionBarHorizontalInsetPx;
      setInlineActionCount(
        resolveHoverImageInlineActionCount({
          actionCount: actions.length,
          availableWidth: width,
          maxInlineActions,
        }),
      );
    };

    updateInlineActionCount();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateInlineActionCount);
    observer.observe(host);
    return () => observer.disconnect();
  }, [actions.length, maxInlineActions]);

  function handleMoreOpenChange(open: boolean) {
    onMoreOpenChange?.(open);
    if (!open && moreTriggerRef.current && document.activeElement === moreTriggerRef.current) {
      moreTriggerRef.current.blur();
    }
  }

  return (
    <TooltipProvider delay={120}>
      <div ref={rootRef} className="pointer-events-auto inline-flex">
        <Group className={imagePreviewToolbarGroupClassName}>
          {inlineActions.map((action) => (
            <ActionGroupEntry key={action.key} action={action} onConfirmAction={setConfirmAction} />
          ))}
          {overflowActions.length > 0 && (
            <Tooltip>
              <Menu onOpenChange={handleMoreOpenChange}>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      ref={moreTriggerRef}
                      aria-label="更多操作"
                      className="ohm-smooth-control inline-flex size-8 shrink-0 items-center justify-center rounded-[12px] border border-transparent bg-transparent text-white/72 outline-none transition hover:bg-white/[0.08] hover:text-white data-[popup-open]:bg-white/[0.08] data-[popup-open]:text-white"
                    >
                      <CircleEllipsis aria-hidden size={16} />
                    </MenuTrigger>
                  }
                />
                <MenuPopup className="border-white/[0.08] bg-[#121212] shadow-[0_18px_44px_rgb(0_0_0/0.46)]">
                  <MenuGroup>
                    {overflowActions.map((action) => (
                      <OverflowMenuItem key={action.key} action={action} onConfirmAction={setConfirmAction} />
                    ))}
                  </MenuGroup>
                </MenuPopup>
              </Menu>
              <TooltipContent side="top">更多操作</TooltipContent>
            </Tooltip>
          )}
        </Group>
      </div>
      {confirmAction?.confirm && (
        <ConfirmImageActionDialog
          action={confirmAction}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setConfirmAction(null);
          }}
        />
      )}
    </TooltipProvider>
  );
}

export function resolveHoverImageInlineActionCount({
  actionCount,
  availableWidth,
  maxInlineActions = actionCount,
}: {
  actionCount: number;
  availableWidth: number;
  maxInlineActions?: number;
}) {
  const cappedActionCount = Math.max(0, Math.min(actionCount, maxInlineActions));
  if (cappedActionCount === 0) return 0;
  if (availableWidth <= 0) return cappedActionCount;

  const groupHorizontalPaddingPx = 4;
  const actionButtonWidthPx = 32;
  const moreButtonWidthPx = 32;
  const allActionsWidth = groupHorizontalPaddingPx + actionCount * actionButtonWidthPx;
  if (cappedActionCount >= actionCount && allActionsWidth <= availableWidth) return actionCount;

  const inlineWithMore = Math.floor((availableWidth - groupHorizontalPaddingPx - moreButtonWidthPx) / actionButtonWidthPx);
  return Math.max(0, Math.min(cappedActionCount, actionCount - 1, inlineWithMore));
}

const hoverImageActionBarHorizontalInsetPx = 24;

export function shouldCloseHoverImageOverflowOnSelect(action: Pick<HoverImageAction, "confirm">): boolean {
  return true;
}

function ActionGroupEntry({
  action,
  onConfirmAction,
}: {
  action: HoverImageAction;
  onConfirmAction: (action: HoverImageAction) => void;
}) {
  return (
    <HoverActionButton action={action} onConfirmAction={onConfirmAction} />
  );
}

function HoverActionButton({
  action,
  onConfirmAction,
}: {
  action: HoverImageAction;
  onConfirmAction: (action: HoverImageAction) => void;
}) {
  const commonClassName =
    "ohm-smooth-control inline-flex size-8 shrink-0 items-center justify-center rounded-[12px] border border-transparent bg-transparent text-white/72 transition hover:bg-white/[0.08] hover:text-white focus-visible:ring-2 focus-visible:ring-white/20";

  if (action.href) {
    return (
      <Tooltip>
        <TooltipTrigger render={<a aria-label={action.label} className={commonClassName} href={action.href}>{action.icon}</a>} />
        <TooltipContent side="top">{action.label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <CossButton
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={action.label}
              className={commonClassName}
              onClick={action.confirm ? () => onConfirmAction(action) : action.onSelect}
            >
              {action.icon}
            </CossButton>
          }
        />
        <TooltipContent side="top">{action.label}</TooltipContent>
      </Tooltip>
    </>
  );
}

function OverflowMenuItem({
  action,
  onConfirmAction,
}: {
  action: HoverImageAction;
  onConfirmAction: (action: HoverImageAction) => void;
}) {
  if (action.href) {
    return (
      <MenuItem
        className="text-white/90 data-[highlighted]:bg-white/[0.08]"
        render={
          <a href={action.href} />
        }
      >
        <span className="grid size-4 shrink-0 place-items-center text-white/80">{action.icon}</span>
        <span>{action.label}</span>
      </MenuItem>
    );
  }

  return (
    <>
      <MenuItem
        closeOnClick={shouldCloseHoverImageOverflowOnSelect(action)}
        onClick={action.confirm ? () => onConfirmAction(action) : action.onSelect}
        variant={action.confirm ? "destructive" : "default"}
        className={!action.confirm ? "text-white/90 data-[highlighted]:bg-white/[0.08]" : undefined}
      >
        <span className="grid size-4 shrink-0 place-items-center text-white/80">{action.icon}</span>
        <span>{action.label}</span>
      </MenuItem>
    </>
  );
}

function ConfirmImageActionDialog({
  action,
  open,
  onOpenChange,
}: {
  action: HoverImageAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!action.confirm) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[20px] font-semibold leading-6 text-white">{action.confirm.title}</AlertDialogTitle>
          <AlertDialogDescription className="text-[16px] leading-7 text-white/55">{action.confirm.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" className="h-8 border-transparent text-white shadow-none hover:bg-white/[0.08] focus-visible:ring-0" />}>
            取消
          </AlertDialogClose>
          <AlertDialogClose
            render={
              <Button
                variant="destructive"
                className="h-8 min-w-[88px]"
                onClick={() => action.onSelect?.()}
              />
            }
          >
            {action.confirm.confirmLabel}
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function LoadingStatusText() {
  return (
    <SharedLoadingStatusText
      ariaLabel="正在生成图片"
      lines={loadingStatusLines}
      loopLines={loadingStatusLoopLines}
      animationDurationMs={loadingStatusAnimationDurationMs}
    />
  );
}

export function generationStageLayout(job: Pick<GenerationJob, "width" | "height" | "quantity">, images: ImageItem[]): { width: number; height: number; columns: number } {
  const count = Math.max(1, job.quantity || images.length || 1);
  const firstImage = images[0];
  const aspect = safeAspectRatio(firstImage?.width ?? job.width, firstImage?.height ?? job.height);

  if (count === 1) {
    const height = Math.min(generationStageMaxHeightPx, generationStageMaxWidthPx / aspect);
    return { width: Math.round(height * aspect), height: Math.round(height), columns: 1 };
  }

  const totalAspect = aspect * count;
  const height = Math.min(generationStageMaxHeightPx, generationStageMaxWidthPx / totalAspect);
  return { width: Math.round(height * totalAspect), height: Math.round(height), columns: count };
}

function safeAspectRatio(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 4 / 3;
  return width / height;
}

function PendingStage() {
  return (
    <div className="h-full w-full bg-white/[0.06]" />
  );
}

function useDismissiblePopup(rootRef: RefObject<HTMLElement>, open: boolean, onDismiss: () => void) {
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        onDismiss();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onDismiss();
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onDismiss, rootRef]);
}

function ComposerChoiceMenu({
  label,
  icon,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useDismissiblePopup(rootRef, open, () => setOpen(false));

  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div ref={rootRef} className="relative shrink-0">
          <CossButton
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={label}
            disabled={disabled}
            className={cn(
              "ohm-smooth-control inline-flex h-8 max-w-full items-center gap-1 border border-transparent bg-white/10 pl-3 pr-2 text-sm leading-[22px] text-white shadow-none",
              disabled ? "cursor-default opacity-100" : "hover:bg-white/12",
            )}
            onClick={() => {
              if (!disabled) setOpen((current) => !current);
            }}
          >
            {icon && <span className="grid size-4 shrink-0 place-items-center text-white/90">{icon}</span>}
            <span className="whitespace-nowrap">{selected.label}</span>
            <ChevronDown aria-hidden size={20} className={cn("shrink-0 text-white/60 transition-transform", open && "rotate-180")} />
          </CossButton>
      {open && (
        <div className="absolute left-0 top-[calc(100%+8px)] z-30 w-max min-w-full overflow-hidden rounded-[8px] border border-white/15 bg-[#121212] p-1 shadow-[0_12px_32px_rgb(0_0_0/0.32)]">
          <div role="listbox" aria-label={label} className="flex w-max min-w-full flex-col gap-1">
            {options.map((option) => (
              <CossButton
                key={option.value}
                type="button"
                variant="ghost"
                role="option"
                aria-selected={option.value === selected.value}
                className={cn(
                  "h-auto rounded-[8px] border-0 px-3 py-1.5 text-left text-sm leading-[22px] text-white/78 transition hover:bg-white/10 hover:text-white",
                  option.value === selected.value && "bg-white/10 text-white",
                )}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </CossButton>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ComposerGenerationSettingsMenu({
  form,
  maxImagesPerRequest,
  onUpdate,
}: {
  form: GenerateForm;
  maxImagesPerRequest: number;
  onUpdate: <K extends keyof GenerateForm>(key: K, value: GenerateForm[K]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const quantities = Array.from({ length: Math.min(maxImagesPerRequest, 4) }, (_, index) => index + 1);
  const summary = formatGenerationSettingsSummary(form);
  const summaryParts = generationSettingsSummaryParts(form);
  useDismissiblePopup(rootRef, open, () => setOpen(false));

  return (
    <div ref={rootRef} className="relative min-w-0 shrink">
      <CossButton
        type="button"
        variant="secondary"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`生成参数：${summary}`}
        className="ohm-smooth-control inline-flex h-8 max-w-[360px] items-center gap-1 border border-transparent bg-white/10 pl-3 pr-2 text-sm font-normal leading-[22px] text-white shadow-none hover:bg-white/12"
        onClick={() => setOpen((current) => !current)}
      >
        <ComposerQualityIcon className="size-4 shrink-0 text-white/90" />
        <span className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap" aria-hidden="true">
          {summaryParts.map((part, index) => (
            <span key={`${part}-${index}`} className="inline-flex min-w-0 items-center gap-2">
              {index > 0 && <span className="shrink-0 text-white/30">｜</span>}
              <span className="min-w-0 truncate">{part}</span>
            </span>
          ))}
        </span>
        <ChevronDown aria-hidden size={20} className={cn("shrink-0 text-white/60 transition-transform", open && "rotate-180")} />
      </CossButton>
      {open && (
        <div className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-[480px] rounded-[16px] border border-white/15 bg-[#121212] p-4 shadow-[0_18px_48px_rgb(0_0_0/0.38)]">
          <div className="flex flex-col gap-6">
            <div>
              <SettingsOptionTabs
                label="生成比例"
                value={form.aspectRatio}
                options={ratioOptions.map((ratio) => ({ value: ratio, label: ratioLabels[ratio] ?? ratio }))}
                onValueChange={(value) => onUpdate("aspectRatio", value)}
              />
              {form.aspectRatio === "custom" && (
                <div className="mt-2">
                  <CustomSizeInputs
                    width={form.width}
                    height={form.height}
                    onWidthChange={(width) => onUpdate("width", width)}
                    onHeightChange={(height) => onUpdate("height", height)}
                  />
                </div>
              )}
            </div>
            <SettingsOptionTabs
              label="生成张数"
              value={String(form.quantity)}
              options={quantities.map((quantity) => ({ value: String(quantity), label: `${quantity}张` }))}
              onValueChange={(value) => onUpdate("quantity", Number(value))}
            />
            <SettingsOptionTabs
              label="生成质量"
              value={form.quality}
              options={qualityOptions.map((quality) => ({ value: quality, label: qualityLabels[quality] ?? quality }))}
              onValueChange={(value) => onUpdate("quality", value)}
            />
            <SettingsOptionTabs
              label="分辨率"
              value={form.resolution}
              options={resolutionOptions.map((resolution) => ({ value: resolution, label: resolution }))}
              onValueChange={(value) => onUpdate("resolution", value)}
            />
            <SettingsOptionTabs
              label="文件格式"
              value={form.outputFormat}
              options={formatOptions.map((format) => ({ value: format, label: formatLabels[format] ?? format.toUpperCase() }))}
              onValueChange={(value) => onUpdate("outputFormat", value)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsOptionTabs({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-normal leading-5 text-white/42">{label}</div>
      <Tabs value={value} onValueChange={onValueChange} className="w-full">
        <TabsList className="[--radius:8px] [--tabs-indicator-bg:rgb(255_255_255/0.16)] [--tabs-indicator-border:0] [--tabs-indicator-radius:6px] [--tabs-indicator-shadow:0_1px_8px_rgb(255_255_255/0.08),0_6px_16px_rgb(0_0_0/0.18)] flex h-8 w-full rounded-[8px] !bg-white/[0.06] p-1 !text-white/52">
          {options.map((option) => (
            <TabsTrigger
              key={option.value}
              value={option.value}
              className="!h-6 !min-w-0 !flex-1 !basis-0 !shrink !grow px-2 text-sm font-normal !text-white/52 hover:!text-white/80 data-active:!text-white"
            >
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}

function CustomSizeInputs({
  width,
  height,
  onWidthChange,
  onHeightChange,
}: {
  width: number;
  height: number;
  onWidthChange: (value: number) => void;
  onHeightChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <SizeInput ariaLabel="自定义长度" value={width} onChange={onWidthChange} />
      <X aria-hidden size={12} className="shrink-0 text-white/30" />
      <SizeInput ariaLabel="自定义宽度" value={height} onChange={onHeightChange} />
    </div>
  );
}

function SizeInput({ ariaLabel, value, onChange }: { ariaLabel: string; value: number; onChange: (value: number) => void }) {
  return (
    <Input
      aria-label={ariaLabel}
      type="number"
      min={16}
      step={16}
      value={value}
      className="h-8 min-w-0 flex-1 rounded-[8px] border-transparent bg-white/[0.06] px-3 py-0 text-sm leading-[22px] text-white outline-none transition placeholder:text-white/28 focus:border-transparent focus:bg-white/[0.08] focus-visible:ring-0"
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
    />
  );
}

function ComposerPanel({
  formRef,
  layoutMode,
  form,
  config,
  loading,
  referencePreparing,
  optimizing,
  providerConfigured,
  showReferenceCarryoverHint,
  referenceImages,
  sourceImagePreview,
  referenceMask,
  localEditPreviewUrl,
  textareaRef,
  referenceInputRef,
  onSubmit,
  onPromptPaste,
  onReferenceInput,
  onPickReference,
  onRemoveSourceReference,
  onRemoveReference,
  onOptimize,
  onUpdate,
  turnstileToken,
  onTurnstileToken,
}: {
  formRef: RefObject<HTMLFormElement>;
  layoutMode: ComposerLayoutMode;
  form: GenerateForm;
  config: AppConfig;
  loading: boolean;
  referencePreparing: boolean;
  optimizing: boolean;
  providerConfigured: boolean;
  showReferenceCarryoverHint: boolean;
  referenceImages: ReferenceImagePreview[];
  sourceImagePreview: SourceImagePreview | null;
  referenceMask: ImageSelectionMask | null;
  localEditPreviewUrl: string | null;
  textareaRef: RefObject<HTMLTextAreaElement>;
  referenceInputRef: RefObject<HTMLInputElement>;
  onSubmit: (event: FormEvent) => void;
  onPromptPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onReferenceInput: (event: ChangeEvent<HTMLInputElement>) => void;
  onPickReference: () => void;
  onRemoveSourceReference: () => void;
  onRemoveReference: (index: number) => void;
  onOptimize: () => void;
  onUpdate: <K extends keyof GenerateForm>(key: K, value: GenerateForm[K]) => void;
  turnstileToken: string;
  onTurnstileToken: (token: string) => void;
}) {
  const modelOptions = uniqueModelOptions(config.modelOptions ?? config.models, config.model);
  const modelName = modelOptions.includes(form.model) ? form.model : modelOptions[0];
  const submitDisabled = !providerConfigured || !form.prompt.trim() || (config.turnstileRequired && config.turnstileSiteKey ? !turnstileToken : false);
  const referenceCount = referenceImages.length + (sourceImagePreview ? 1 : 0);
  const optimizeButton = (
    <CossButton type="button" variant="outline" size="sm" loading={optimizing} className={composerActionButtonClassName} onClick={onOptimize}>
      <ComposerOptimizeIcon className="size-4 shrink-0 text-white" />
      {optimizing ? "优化中" : "优化提示词"}
    </CossButton>
  );

  return (
    <form
      ref={formRef}
      data-composer-layout-mode={layoutMode}
      className={cn(
        "ohm-smooth-panel ohm-composer-panel absolute left-1/2 flex min-h-[170px] -translate-x-1/2 flex-col items-start gap-4 overflow-visible border p-4",
        conversationPanelWidthClassName,
        layoutMode === "conversation" ? "bottom-6" : "",
      )}
      style={layoutMode === "empty-first-message" ? { top: `${emptyFirstComposerTopPercent}%` } : undefined}
      onSubmit={onSubmit}
    >
      {layoutMode === "empty-first-message" && (
        <p
          className="pointer-events-none absolute left-1/2 whitespace-nowrap text-center text-[28px] font-medium leading-none tracking-[-0.04em] text-white/90 -translate-x-1/2"
          style={{ bottom: `calc(100% + ${emptyStateCopyToComposerGapPx}px)` }}
        >
          让我们一起创造点什么······
        </p>
      )}
      <input ref={referenceInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={onReferenceInput} />
      <div className="flex min-h-8 w-full flex-wrap items-center gap-x-2 gap-y-2">
        {sourceImagePreview && (
          <span className="ohm-smooth-control inline-flex h-8 min-w-0 max-w-full shrink items-center gap-2 overflow-hidden border border-transparent bg-white/10 px-1.5 py-1 text-sm font-normal leading-[22px] text-white">
            <span className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-[6px] border border-transparent bg-white/10">
              <img src={localEditPreviewUrl ?? sourceImagePreview.url} alt={sourceImagePreview.name} loading="lazy" decoding="async" className="size-full object-cover" />
            </span>
            <span className="min-w-0 truncate whitespace-nowrap">{sourceImagePreview.name}</span>
            <CossButton type="button" variant="ghost" size="icon-xs" aria-label={`移除${sourceImagePreview.name}`} className="grid size-4 shrink-0 place-items-center border-0 p-0 text-white/72 hover:bg-transparent hover:text-white" onClick={onRemoveSourceReference}>
              <img aria-hidden="true" src={referenceDeleteIcon} alt="" className="size-4" draggable={false} />
            </CossButton>
          </span>
        )}
        {referenceImages.map((image, index) => (
          <span key={image.url} className="ohm-smooth-control inline-flex h-8 min-w-0 max-w-full shrink items-center gap-2 overflow-hidden border border-transparent bg-white/10 px-1.5 py-1 text-sm font-normal leading-[22px] text-white">
            <span className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-[6px] border border-transparent bg-white/10">
              <img src={image.url} alt={image.name} loading="lazy" decoding="async" className="size-full object-cover" />
            </span>
            <span className="min-w-0 truncate whitespace-nowrap">参考图 {index + 1}</span>
            <CossButton type="button" variant="ghost" size="icon-xs" aria-label={`移除参考图 ${index + 1}`} className="grid size-4 shrink-0 place-items-center border-0 p-0 text-white/72 hover:bg-transparent hover:text-white" onClick={() => onRemoveReference(index)}>
              <img aria-hidden="true" src={referenceDeleteIcon} alt="" className="size-4" draggable={false} />
            </CossButton>
          </span>
        ))}
        {referenceCount < maxReferenceImages && (
          <CossButton
            type="button"
            variant="outline"
            size="sm"
            className={composerActionButtonClassName}
            disabled={referencePreparing}
            onClick={onPickReference}
          >
            <ComposerReferenceIcon className="size-4 shrink-0 text-white/90" />
            参考图
          </CossButton>
        )}
        {referenceCount >= maxReferenceImages && (
          <span className="text-xs leading-5 text-white/30">最多 {maxReferenceImages} 张</span>
        )}
      </div>
      <div className="relative w-full">
        <CossTextarea
          ref={textareaRef}
          aria-label="提示词"
          value={form.prompt}
          required
          rows={composerTextareaMinRows}
          placeholder={composerPromptPlaceholderText}
          className={composerPromptTextareaClassName}
          onChange={(event) => onUpdate("prompt", event.target.value)}
          onPaste={onPromptPaste}
        />
      </div>
      {showReferenceCarryoverHint && (
        <p role="note" className="-mt-2 w-full text-xs leading-5 text-amber-100/72">
          当前不会自动参考上一张图；如需继续修改，请先在图片菜单选择“基于这张图片继续创作”。
        </p>
      )}
      <div className="flex w-full items-center justify-between gap-20">
        <div className="flex min-w-0 items-center gap-2">
          {shouldShowComposerOptimizeBeam(optimizing) ? (
            <BorderBeam {...composerOptimizeBeamProps} className={composerOptimizeBeamClassName}>
              {optimizeButton}
            </BorderBeam>
          ) : (
            optimizeButton
          )}
          <ComposerChoiceMenu
            label="模型"
            value={modelName}
            disabled={modelOptions.length <= 1}
            icon={<ComposerModelIcon className="size-4 text-white/90" />}
            options={modelOptions.map((model) => ({ value: model, label: model.replace(/^gpt-/, "") }))}
            onChange={(next) => onUpdate("model", next)}
          />
          <ComposerGenerationSettingsMenu form={form} maxImagesPerRequest={config.maxImagesPerRequest} onUpdate={onUpdate} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {config.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={onTurnstileToken} />}
          {config.turnstileRequired && !config.turnstileSiteKey && (
            <span className="text-xs text-red-200/80">缺少验证配置</span>
          )}
          <CossButton
            type="submit"
            loading={loading}
            disabled={submitDisabled}
            className="h-8 min-w-16 rounded-[12px] border-transparent bg-white/90 text-black shadow-none hover:bg-white disabled:opacity-100 disabled:bg-white/20 disabled:text-white/40 disabled:hover:bg-white/20 disabled:shadow-none"
          >
            生图
          </CossButton>
        </div>
      </div>
    </form>
  );
}

function uniqueModelOptions(options: string[] | undefined, configuredModel: string) {
  const candidates = [...(options ?? []), configuredModel, ...imageModelOptions].map((model) => model.trim()).filter(Boolean);
  return Array.from(new Set(candidates));
}

export function ImagePreview({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  const hasImageUrl = image.url.trim().length > 0;
  const placeholderUrl = image.thumbnailUrl ?? "";
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">(hasImageUrl ? "loading" : "error");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadProgressPercent, setLoadProgressPercent] = useState<number | null>(hasImageUrl ? 0 : null);
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const imageLoaded = loadState === "loaded";
  const loadingProgressLabel = `${imageLoaded ? 100 : loadProgressPercent ?? 0}%`;
  const chromeState = resolveImagePreviewChromeState({ hasImageUrl, imageLoaded });
  const actions = useMemo(() => imagePreviewActionsWithDismiss(image.actions, onClose), [image.actions, onClose]);

  useEffect(() => {
    setLoadState(hasImageUrl ? "loading" : "error");
    setLoadProgressPercent(hasImageUrl ? 0 : null);
    setLoadedImageUrl(null);
    if (!hasImageUrl) return;

    const abortController = new AbortController();
    let objectUrl: string | null = null;
    let stalledSince = Date.now();

    const stallTimer = window.setInterval(() => {
      if (Date.now() - stalledSince > IMAGE_PREVIEW_STALL_TIMEOUT_MS) {
        abortController.abort();
        setLoadState("error");
      }
    }, 1000);

    async function loadFullSizeImage() {
      try {
        // 使用原始 image.url（不带额外参数），让浏览器 HTTP 强缓存和 SW 缓存
        // 都能命中：画廊已加载过的图片，预览直接秒开；否则才走网络下载。
        const response = await fetch(image.url, { signal: abortController.signal });
        if (!response.ok) throw new Error(`Image preview request failed with ${response.status}`);
        stalledSince = Date.now();
        const contentLength = Number(response.headers.get("Content-Length") ?? "");
        const reader = response.body?.getReader();
        if (!reader) {
          const blob = await response.blob();
          objectUrl = URL.createObjectURL(blob);
          setLoadedImageUrl(objectUrl);
          setLoadProgressPercent(100);
          setLoadState("loaded");
          return;
        }

        const chunks: ArrayBuffer[] = [];
        let loaded = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stalledSince = Date.now();
          // Copy into an ArrayBuffer so Blob accepts chunks from every supported stream implementation.
          chunks.push(new Uint8Array(value).buffer);
          loaded += value.byteLength;
          setLoadProgressPercent(resolveImagePreviewProgressPercent(loaded, contentLength));
        }

        const blob = new Blob(chunks, {
          type: response.headers.get("Content-Type") ?? "image/png",
        });
        objectUrl = URL.createObjectURL(blob);
        setLoadedImageUrl(objectUrl);
        setLoadProgressPercent(100);
        setLoadState("loaded");
      } catch (error) {
        if (!abortController.signal.aborted || Date.now() - stalledSince > IMAGE_PREVIEW_STALL_TIMEOUT_MS) {
          console.error("image preview load failed", error);
          setLoadState("error");
        }
      }
    }

    void loadFullSizeImage();

    return () => {
      window.clearInterval(stallTimer);
      abortController.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasImageUrl, image.url, loadAttempt]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className={cn("fixed inset-0 z-[100] grid place-items-center p-8", dialogBackdropSurfaceClassName)}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onClose}
    >
      <CossButton
        type="button"
        variant="ghost"
        size="icon"
        aria-label="关闭预览"
        className="absolute right-8 top-8 z-10 grid size-9 place-items-center rounded-full border-0 bg-white/10 text-white/80 transition hover:bg-white/16 hover:text-white"
        onClick={onClose}
      >
        <X aria-hidden size={20} />
      </CossButton>
      <div className="relative isolate grid min-h-24 min-w-24 max-h-[calc(100dvh-64px)] max-w-[calc(100vw-64px)] place-items-center" onClick={(event) => event.stopPropagation()}>
        {chromeState.showActions && actions.length > 0 && (
          <div className={imagePreviewToolbarPositionClassName}>
            <HoverImageActionBar actions={actions} />
          </div>
        )}
        {placeholderUrl && !imageLoaded && (
          <img
            src={placeholderUrl}
            alt={image.prompt ?? "生成图片"}
            className={cn(imagePreviewVisibleImageClassName, "blur-sm")}
          />
        )}
        {loadedImageUrl && (
          <img
            src={loadedImageUrl}
            alt={image.prompt ?? "生成图片"}
            className={cn(imagePreviewVisibleImageClassName, !imageLoaded && "opacity-0")}
            onLoad={() => setLoadState("loaded")}
            onError={() => setLoadState("error")}
          />
        )}
        {loadState === "loading" && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="grid size-16 place-items-center rounded-full bg-black/70 text-sm font-medium text-white" aria-label="大图加载中">
              <span className="grid size-12 place-items-center rounded-full bg-[#121212]">
                {loadingProgressLabel}
              </span>
            </div>
          </div>
        )}
        {loadState === "error" && (
          <div className="absolute inset-0 grid place-items-center bg-black/45 px-6 text-center">
            <div className="flex max-w-xs flex-col items-center gap-3 rounded-[16px] bg-[#121212]/94 px-5 py-4 text-sm text-white/72">
              <span>大图加载失败，可重试或先关闭预览。</span>
              {hasImageUrl && (
                <CossButton
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                >
                  重新加载
                </CossButton>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function LocalEditDialog({
  image,
  open,
  onOpenChange,
  onConfirm,
}: {
  image: ImageItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (image: ImageItem, strokes: ImageSelectionStroke[]) => Promise<void>;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const selectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeSelectionStrokeRef = useRef<ImageSelectionStroke | null>(null);
  const [selectionStrokes, setSelectionStrokes] = useState<ImageSelectionStroke[]>([]);
  const [redoSelectionStrokes, setRedoSelectionStrokes] = useState<ImageSelectionStroke[]>([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectionStrokes([]);
    setRedoSelectionStrokes([]);
    activeSelectionStrokeRef.current = null;
    setError("");
    setSubmitting(false);
  }, [image?.id, open]);

  useEffect(() => {
    if (!open || !image || !stageRef.current) return;
    const redraw = () => drawImageSelectionCanvas(selectionCanvasRef.current, stageRef.current, image, selectionStrokes);
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [image, open, selectionStrokes]);

  function startSelectionStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!image) return;
    const point = imageSelectionPointFromEvent(event, stageRef.current, image);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: ImageSelectionStroke = {
      brushRatio: imageSelectionBrushRatio,
      points: [point],
    };
    activeSelectionStrokeRef.current = stroke;
    setRedoSelectionStrokes([]);
    setSelectionStrokes((current) => [...current, stroke]);
    setError("");
  }

  function moveSelectionStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    const activeStroke = activeSelectionStrokeRef.current;
    if (!image || !activeStroke) return;
    const point = imageSelectionPointFromEvent(event, stageRef.current, image);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    const previous = activeStroke.points[activeStroke.points.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.003) return;
    const nextStroke = { ...activeStroke, points: [...activeStroke.points, point] };
    activeSelectionStrokeRef.current = nextStroke;
    setSelectionStrokes((current) => [...current.slice(0, -1), nextStroke]);
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

  function undoSelectionStroke() {
    setSelectionStrokes((current) => {
      const removed = current[current.length - 1];
      if (removed) setRedoSelectionStrokes((redoCurrent) => [removed, ...redoCurrent]);
      return current.slice(0, -1);
    });
  }

  function redoSelectionStroke() {
    setRedoSelectionStrokes((current) => {
      const [restored, ...nextRedo] = current;
      if (restored) setSelectionStrokes((strokes) => [...strokes, restored]);
      return nextRedo;
    });
  }

  async function confirmSelection() {
    if (!image) return;
    if (selectionStrokes.length === 0) {
      setError("先在图片上涂抹需要局部重绘的区域。");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(image, selectionStrokes);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "局部重绘参考图生成失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup showCloseButton className="h-[80dvh] min-h-[70dvh] w-[80vw] !max-w-[80vw] max-h-[80dvh] bg-[#121212]">
        <DialogHeader className="px-5 py-3">
          <div className="min-w-0">
            <DialogTitle className="text-lg font-semibold leading-6 text-white">局部编辑</DialogTitle>
            <DialogDescription className="mt-0.5 text-sm leading-5 text-white/56">
              在图片上直接涂抹需要重绘的区域，确认后会以“局部重绘”带回输入框。
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogPanel className="grid min-h-0 gap-3 overflow-hidden px-4 py-4 lg:grid-cols-[minmax(0,1fr)_228px]">
          <div className="min-h-0 min-w-0">
            <div
              ref={stageRef}
              className="relative flex h-full min-h-0 items-center justify-center overflow-hidden rounded-[16px] border border-white/[0.08] bg-[#171717]"
            >
              {image && (
                <>
                  <img src={image.url} alt={image.prompt ?? "局部编辑图片"} decoding="async" className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain" draggable={false} />
                  <canvas
                    ref={selectionCanvasRef}
                    className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                    onPointerDown={startSelectionStroke}
                    onPointerMove={moveSelectionStroke}
                    onPointerUp={endSelectionStroke}
                    onPointerCancel={endSelectionStroke}
                    onPointerLeave={endSelectionStroke}
                  />
                </>
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-3">
            <div className="rounded-[16px] border border-white/[0.08] bg-white/[0.03] p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium leading-6 text-white">当前状态</span>
                <span className="rounded-[999px] bg-white/[0.08] px-2 py-1 text-xs leading-none text-white/60">
                  {selectionStrokes.length} 个选区笔画
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <CossButton variant="outline" size="sm" disabled={selectionStrokes.length === 0} className="h-8 border-white/[0.08] bg-white/[0.06] text-white/88 hover:bg-white/[0.1]" onClick={undoSelectionStroke}>
                  <Undo2 className="size-4" />
                  上一步
                </CossButton>
                <CossButton variant="outline" size="sm" disabled={redoSelectionStrokes.length === 0} className="h-8 border-white/[0.08] bg-white/[0.06] text-white/88 hover:bg-white/[0.1]" onClick={redoSelectionStroke}>
                  <Redo2 className="size-4" />
                  下一步
                </CossButton>
                <CossButton
                  variant="ghost"
                  size="sm"
                  disabled={selectionStrokes.length === 0}
                  className="h-8 bg-transparent text-white/64 hover:bg-white/[0.08] hover:text-white"
                  onClick={() => {
                    activeSelectionStrokeRef.current = null;
                    setSelectionStrokes([]);
                    setRedoSelectionStrokes([]);
                    setError("");
                  }}
                >
                  清空
                </CossButton>
              </div>
              {error && <p className="mt-3 text-sm leading-6 text-[#ffb4b4]">{error}</p>}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter className="px-5 py-3">
          <CossButton variant="ghost" className="h-9 px-4 text-white/72 hover:bg-white/[0.08] hover:text-white" onClick={() => onOpenChange(false)}>
            取消
          </CossButton>
          <CossButton variant="default" loading={submitting} className="h-9 px-4 shadow-none disabled:shadow-none" onClick={() => void confirmSelection()}>
            带入输入框
          </CossButton>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function updateGenerateForm<K extends keyof GenerateForm>(current: GenerateForm, key: K, value: GenerateForm[K]): GenerateForm {
  const next = { ...current, [key]: value };
  if (key === "width" || key === "height") {
    next[key] = normalizeCustomSize(value as number) as GenerateForm[K];
  }
  if (key === "aspectRatio" || key === "resolution") {
    if (next.aspectRatio === "custom") return next;
    const [width, height] = sizeForRatioResolution(next.aspectRatio, next.resolution);
    next.width = width;
    next.height = height;
  }
  return next;
}

function normalizeCustomSize(value: number): number {
  if (!Number.isFinite(value)) return 1024;
  return Math.max(16, Math.round(value / 16) * 16);
}

function sizeForRatioResolution(ratio: string, resolution: string): [number, number] {
  const [baseWidth, baseHeight] = ratioSizes[ratio] ?? ratioSizes["16:9"];
  const longEdge = resolutionLongEdge[resolution] ?? resolutionLongEdge["1K"];
  const scale = longEdge / Math.max(baseWidth, baseHeight);
  return [Math.round((baseWidth * scale) / 16) * 16, Math.round((baseHeight * scale) / 16) * 16];
}

export function generationRequestBody(
  form: GenerateForm,
  referenceImages: ReferenceImagePreview[],
  sourceImageId?: string,
  turnstileToken = "",
  maskImage?: ImageSelectionMask | null,
  conversationId?: string,
): BodyInit {
  if (referenceImages.length === 0 && !maskImage) {
    return JSON.stringify({
      ...form,
      turnstileToken,
      ...(sourceImageId ? { sourceImageId } : {}),
      ...(conversationId ? { conversationId } : {}),
    });
  }
  const body = new FormData();
  Object.entries(form).forEach(([key, value]) => body.set(key, String(value)));
  if (turnstileToken) body.set("turnstileToken", turnstileToken);
  if (sourceImageId) body.set("sourceImageId", sourceImageId);
  if (conversationId) body.set("conversationId", conversationId);
  referenceImages.slice(0, maxReferenceImages).forEach((image) => body.append("referenceImage", image.file, image.name));
  if (maskImage) body.set("maskImage", maskImage.file, maskImage.name);
  return body;
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
  if (stroke.points.length === 0) return;
  const lineWidth = Math.max(8, stroke.brushRatio * Math.min(imageRect.width, imageRect.height));
  context.lineWidth = lineWidth;
  const first = stroke.points[0];
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(imageRect.x + first.x * imageRect.width, imageRect.y + first.y * imageRect.height, lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(imageRect.x + first.x * imageRect.width, imageRect.y + first.y * imageRect.height);
  for (const point of stroke.points.slice(1)) {
    context.lineTo(imageRect.x + point.x * imageRect.width, imageRect.y + point.y * imageRect.height);
  }
  context.stroke();
}

async function createSelectionMask(
  image: Pick<ImageItem, "id" | "width" | "height">,
  strokes: ImageSelectionStroke[],
): Promise<Pick<ImageSelectionMask, "file" | "name">> {
  if (!image.width || !image.height) throw new Error("图片尺寸无效，无法生成局部重绘遮罩。");
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持局部重绘遮罩生成。");

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

async function buildLocalEditPreviewUrl(sourceUrl: string, maskUrl: string): Promise<string> {
  const [sourceImage, maskImage] = await Promise.all([loadPreviewImage(sourceUrl), loadPreviewImage(maskUrl)]);
  const canvas = document.createElement("canvas");
  canvas.width = sourceImage.naturalWidth || sourceImage.width;
  canvas.height = sourceImage.naturalHeight || sourceImage.height;
  const context = canvas.getContext("2d");
  if (!context || !canvas.width || !canvas.height) return sourceUrl;

  context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = canvas.width;
  overlayCanvas.height = canvas.height;
  const overlayContext = overlayCanvas.getContext("2d");
  if (!overlayContext) return sourceUrl;

  overlayContext.fillStyle = "rgba(110, 255, 48, 0.42)";
  overlayContext.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayContext.globalCompositeOperation = "destination-out";
  overlayContext.drawImage(maskImage, 0, 0, overlayCanvas.width, overlayCanvas.height);

  context.drawImage(overlayCanvas, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas, "image/png");
  return URL.createObjectURL(blob);
}

function loadPreviewImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`图片加载失败: ${url}`));
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("局部重绘遮罩生成失败。"));
    }, type, quality);
  });
}

async function prepareReferenceImage(file: File): Promise<File> {
  if (shouldPreserveReferenceImage(file)) return file;
  const image = await loadFileImage(file);

  const scale = Math.min(1, fastReferenceImageEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return file;
  context.drawImage(image, 0, 0, width, height);

  const compressed = await canvasToBlob(canvas, "image/webp", 0.86).catch(() => null)
    ?? await canvasToBlob(canvas, "image/jpeg", 0.88).catch(() => null);
  if (!compressed || compressed.size >= file.size) return file;

  const type = normalizeImageMime(compressed.type) || "image/jpeg";
  const extension = type === "image/webp" ? "webp" : "jpg";
  return new File([compressed], replaceFileExtension(file.name || "reference", extension), { type });
}

export function shouldPreserveReferenceImage(file: Pick<File, "size">): boolean {
  return file.size <= referenceImageMaxBytes;
}

function loadFileImage(file: File): Promise<HTMLImageElement> {
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildFlowChips(flow: ReturnType<typeof buildGenerationFlowItem>): string[] {
  const longEdge = Math.max(flow.job.width, flow.job.height);
  const resolution = longEdge >= 3840 ? "4K" : longEdge >= 2048 ? "2K" : "1K";
  const chips = [
    "image-2",
    flow.job.aspect_ratio,
    qualityLabels[flow.job.quality] ?? flow.job.quality,
    resolution,
    flow.job.output_format.toUpperCase(),
  ];
  if (flow.status !== "pending" && typeof flow.elapsedSeconds === "number") {
    chips.push(`耗时：${flow.elapsedSeconds.toFixed(1)}s`);
  }
  if (flow.status !== "pending") {
    chips.push(generationProgressSummary(flow.job, flow.images.length));
  }
  return chips;
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

  return <div className="min-h-[30px] min-w-[120px]" ref={ref} />;
}

function normalizeImageMime(value: string): string {
  const mime = value.toLowerCase().trim();
  if (mime === "image/jpg") return "image/jpeg";
  return mime;
}

function revokeObjectUrls(urls: string[]): void {
  for (const url of urls) URL.revokeObjectURL(url);
}

function isTerminalJobStatus(status: GenerationJob["status"]): boolean {
  return isTerminalGenerationJobStatus(status);
}

async function loadInitialGenerationStatus(jobId: string): Promise<{ ok: true; job: GenerationJob; images: ImageItem[] }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), resolveInitialGenerationStatusTimeoutMs());
  try {
    return await api<{ ok: true; job: GenerationJob; images: ImageItem[] }>(
      `/api/generations/${jobId}`,
      { ...resolveGenerationPollRequestInit(), signal: controller.signal },
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

function upsertRecord(
  setRecords: Dispatch<SetStateAction<GenerationRecord[]>>,
  job: GenerationJob,
  images: ImageItem[],
): void {
  setRecords((current) => {
    const next: GenerationRecord = { job, images, elapsedSeconds: estimateJobElapsed(job) };
    return [next, ...current.filter((record) => record.job.id !== job.id)];
  });
}

function estimateJobElapsed(job: GenerationJob): number | null {
  const start = Date.parse(job.started_at ?? job.created_at);
  const end = job.completed_at ? Date.parse(job.completed_at) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 100) / 10);
}

function parseUtcTimestamp(value: string): number {
  return /[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? Date.parse(value) : Date.parse(`${value.replace(" ", "T")}Z`);
}
