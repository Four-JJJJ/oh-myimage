import type { GenerationJob, GenerationRecord, ImageItem } from "./api";
import { resolveGenerationFlowRecord } from "./features/generate-menu/mappers";

export interface GalleryDateFilter {
  from: string;
  to: string;
}

interface GalleryGroupsOptions {
  dateFilter?: GalleryDateFilter;
  now?: Date;
  showOlderThanDefaultRange?: boolean;
}

interface NormalizedGalleryDateFilter {
  active: boolean;
  from: string;
  to: string;
}

const GALLERY_DEFAULT_RANGE_DAYS = 10;

export function buildGalleryGroups(
  records: GenerationRecord[],
  activeJob: GenerationJob | null,
  activeImages: ImageItem[],
  elapsedSeconds: number,
  options: GalleryGroupsOptions = {},
) {
  const normalizedRecords = normalizeGalleryRecords(records, activeJob, activeImages, elapsedSeconds);
  const normalizedFilter = normalizeGalleryDateFilter(options.dateFilter);
  const defaultStartKey = galleryDefaultStartDateKey(options.now);
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
      if (!isGalleryDateVisible(dateKey, normalizedFilter, Boolean(options.showOlderThanDefaultRange), defaultStartKey)) continue;
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

export function galleryHasHiddenDefaultRangeItems(
  records: GenerationRecord[],
  activeJob: GenerationJob | null,
  activeImages: ImageItem[],
  now = new Date(),
): boolean {
  const defaultStartKey = galleryDefaultStartDateKey(now);
  return normalizeGalleryRecords(records, activeJob, activeImages).some((record) =>
    record.images.some((image) => {
      const dateKey = galleryDayKey(image.createdAt || record.job.created_at);
      return !isValidGalleryDateKey(dateKey) || dateKey < defaultStartKey;
    }),
  );
}

export function normalizeGalleryDateFilter(filter?: GalleryDateFilter): NormalizedGalleryDateFilter {
  const from = isValidGalleryDateKey(filter?.from ?? "") ? filter?.from ?? "" : "";
  const to = isValidGalleryDateKey(filter?.to ?? "") ? filter?.to ?? "" : "";
  if (!from && !to) return { active: false, from: "", to: "" };
  const start = from || to;
  const end = to || from;
  return start <= end ? { active: true, from: start, to: end } : { active: true, from: end, to: start };
}

function normalizeGalleryRecords(records: GenerationRecord[], activeJob: GenerationJob | null, activeImages: ImageItem[], elapsedSeconds = 0) {
  return records.map((record) => {
    const nextRecord = resolveGenerationFlowRecord(record, activeJob, activeImages);
    if (nextRecord === record) return record;
    return { ...nextRecord, elapsedSeconds: elapsedSeconds || record.elapsedSeconds };
  });
}

function galleryDefaultStartDateKey(now = new Date()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (GALLERY_DEFAULT_RANGE_DAYS - 1));
  return galleryDayKey(start.toISOString());
}

function isGalleryDateVisible(
  dateKey: string,
  filter: NormalizedGalleryDateFilter,
  showOlderThanDefaultRange: boolean,
  defaultStartKey: string,
): boolean {
  if (!isValidGalleryDateKey(dateKey)) return !filter.active && showOlderThanDefaultRange;
  if (filter.active) return dateKey >= filter.from && dateKey <= filter.to;
  return showOlderThanDefaultRange || dateKey >= defaultStartKey;
}

function galleryDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "older";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidGalleryDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
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
