import type { GenerationJob, GenerationRecord } from "../../api";

export interface ConversationListItem {
  id: string;
  title: string;
  previewImage: string | null;
  createdAt: string;
  groupLabel: string;
  latestRecordId?: string;
  isDraft?: boolean;
}

export interface GenerationFlowItem {
  id: string;
  status: "pending" | "success" | "failed";
  job: GenerationJob;
  images: GenerationRecord["images"];
  elapsedSeconds: number | null;
}

export interface ComposerDraft {
  prompt: string;
  referenceImages: File[];
  selectedModel: string;
  selectedQuality: string;
  sourceImageId?: string;
  sourceRecordId?: string;
  mode: "create" | "remix";
}

interface SubmittedReferenceImagePreview {
  file: Pick<File, "type" | "size">;
  url: string;
  name?: string;
}

interface SubmittedSourceImagePreview {
  url: string;
  name: string;
}

interface SubmittedMaskImagePreview extends SubmittedReferenceImagePreview {}

const TITLE_MAX_LENGTH = 12;
const draftConversationPrefix = "draft-conversation-";

export function truncateConversationTitle(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) return "新的创作";
  if (normalized.length <= TITLE_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, TITLE_MAX_LENGTH)}...`;
}

export function buildConversationList(records: GenerationRecord[], now = new Date()): ConversationListItem[] {
  return records.map((record) => ({
    id: record.job.id,
    title: truncateConversationTitle(record.job.prompt),
    previewImage: record.images[0]?.url ?? null,
    createdAt: record.job.created_at,
    groupLabel: groupLabelForDate(record.job.created_at, now),
    latestRecordId: record.job.id,
  }));
}

export function createDraftConversation(now = new Date()): ConversationListItem {
  const createdAt = now.toISOString();
  return {
    id: `${draftConversationPrefix}${now.getTime()}`,
    title: truncateConversationTitle(""),
    previewImage: null,
    createdAt,
    groupLabel: groupLabelForDate(createdAt, now),
    isDraft: true,
  };
}

export function updateDraftConversationTitle(draft: ConversationListItem, prompt: string): ConversationListItem {
  if (!draft.isDraft) return draft;
  const nextTitle = truncateConversationTitle(prompt);
  if (draft.title === nextTitle) return draft;
  return { ...draft, title: nextTitle };
}

export function buildSidebarConversations(
  records: GenerationRecord[],
  draftConversation: ConversationListItem | null,
  conversationIdsByRecordId: Record<string, string> = {},
  now = new Date(),
): ConversationListItem[] {
  const items = buildConversationList(records, now);
  const grouped: ConversationListItem[] = [];
  const seenConversationIds = new Set<string>();

  for (const item of items) {
    const record = records.find((candidate) => candidate.job.id === item.id);
    const conversationId = recordConversationId(record, conversationIdsByRecordId);
    if (seenConversationIds.has(conversationId)) continue;
    seenConversationIds.add(conversationId);

    const anchorItem = items.find((candidate) => candidate.id === conversationId) ?? item;
    grouped.push({
      ...anchorItem,
      id: conversationId,
      previewImage: item.previewImage,
      latestRecordId: item.latestRecordId ?? item.id,
    });
  }

  grouped.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return draftConversation ? [draftConversation, ...grouped] : grouped;
}

export function resolveDefaultActiveConversationId(
  records: GenerationRecord[],
  conversationIdsByRecordId: Record<string, string> = {},
): string | null {
  const conversationId = conversationIdForRecord(records[0], conversationIdsByRecordId);
  return conversationId || null;
}

export function resolveLatestVisibleConversationId(conversations: ConversationListItem[]): string | null {
  return conversations.find((conversation) => !conversation.isDraft)?.id ?? null;
}

export function buildGenerationFlowItem(record: GenerationRecord): GenerationFlowItem {
  return {
    id: record.job.id,
    status: flowStatus(record.job.status),
    job: record.job,
    images: record.images,
    elapsedSeconds: record.elapsedSeconds,
  };
}

export function mergeJobReferenceImages(job: GenerationJob, fallbackJob?: GenerationJob | null): GenerationJob {
  if (!fallbackJob || fallbackJob.id !== job.id || (fallbackJob.referenceImages?.length ?? 0) === 0) return job;
  if ((job.referenceImages?.length ?? 0) === 0) return { ...job, referenceImages: fallbackJob.referenceImages };

  const mergedReferenceImages = fallbackJob.referenceImages!.map((fallbackImage, index) => {
    const serverImage = job.referenceImages?.[index];
    if (!serverImage) return fallbackImage;
    const fallbackName = fallbackImage.name?.trim();
    const shouldPreferFallbackPreview = Boolean(fallbackName?.startsWith("局部重绘"));
    if (!fallbackName && !shouldPreferFallbackPreview) return serverImage;
    return {
      ...serverImage,
      name: fallbackName || serverImage.name,
      url: shouldPreferFallbackPreview ? (fallbackImage.url || serverImage.url) : serverImage.url,
    };
  });

  return { ...job, referenceImages: mergedReferenceImages };
}

export function submittedReferenceImages(
  referenceImages: SubmittedReferenceImagePreview[],
  sourceImagePreview?: SubmittedSourceImagePreview | null,
): NonNullable<GenerationJob["referenceImages"]> {
  if (referenceImages.length > 0) {
    return referenceImages.map((image, index) => ({
      name: image.name || `参考图 ${index + 1}`,
      mimeType: image.file.type || "image/png",
      byteSize: image.file.size,
      url: image.url,
    }));
  }
  if (!sourceImagePreview) return [];
  return [
    {
      name: sourceImagePreview.name || "参考图 1",
      mimeType: "image/png",
      byteSize: 0,
      url: sourceImagePreview.url,
    },
  ];
}

export function buildConversationRecords(
  records: GenerationRecord[],
  conversationIdsByRecordId: Record<string, string>,
  conversationId: string,
): GenerationRecord[] {
  return records
    .filter((record) => recordConversationId(record, conversationIdsByRecordId) === conversationId)
    .sort((left, right) => Date.parse(left.job.created_at) - Date.parse(right.job.created_at));
}

function recordConversationId(record: GenerationRecord | undefined, conversationIdsByRecordId: Record<string, string>): string {
  if (!record) return "";
  const mappedConversationId = conversationIdsByRecordId[record.job.id];
  if (mappedConversationId) return mappedConversationId;
  const persistedConversationId = record.job.conversation_id?.trim();
  return persistedConversationId || record.job.id;
}

export function conversationIdForRecord(record: GenerationRecord | undefined, conversationIdsByRecordId: Record<string, string> = {}): string {
  return recordConversationId(record, conversationIdsByRecordId);
}

export function composerDraftFromRecord(record: GenerationRecord, sourceImageId?: string): ComposerDraft {
  return {
    prompt: record.job.prompt,
    referenceImages: [],
    selectedModel: "gpt-image-2",
    selectedQuality: record.job.quality,
    sourceImageId,
    sourceRecordId: record.job.id,
    mode: "remix",
  };
}

function flowStatus(status: GenerationJob["status"]): GenerationFlowItem["status"] {
  if (status === "queued" || status === "running") return "pending";
  if (status === "failed" || status === "cancelled" || status === "partial_succeeded") return "failed";
  return "success";
}

function groupLabelForDate(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "较早";
  if (isSameLocalDay(date, now)) return "今天";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}
