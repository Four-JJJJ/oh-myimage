export const CANVAS_NODE_WIDTH = 280;
export const CANVAS_TEXT_MIN_HEIGHT = 220;
export const CANVAS_IMAGE_MIN_HEIGHT = 220;
export const CANVAS_PORT_OFFSET = 8;
export const CANVAS_NODE_GAP = 96;
export const CANVAS_ALIGNMENT_THRESHOLD = 6;
export const CANVAS_MIN_ZOOM = 0.2;
export const CANVAS_MAX_ZOOM = 2.4;
export const CANVAS_HISTORY_LIMIT = 50;

export type CanvasNodeKind = "text" | "image" | "upload";
export type CanvasNodeStatus = "idle" | "queued" | "running" | "succeeded" | "failed";

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  aspectRatio: string;
  resolution: string;
  quality: string;
  quantity: number;
  model?: string;
  imageUrl?: string;
  imageName?: string;
  sourceImageId?: string;
  jobId?: string;
  status: CanvasNodeStatus;
  progressLabel?: string;
  maskFile?: File;
  maskName?: string;
  error?: string;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasDocument {
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: CanvasViewport;
}

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function emptyCanvasDocument(name = "未命名项目"): CanvasDocument {
  return {
    name,
    nodes: [],
    edges: [],
    viewport: { x: 80, y: 72, zoom: 1 },
  };
}

export function createCanvasNode(
  kind: CanvasNodeKind,
  point: CanvasPoint,
  id: string,
  defaults?: Partial<Pick<CanvasNode, "aspectRatio" | "resolution" | "quality" | "quantity">>,
): CanvasNode {
  return {
    id,
    kind,
    x: point.x,
    y: point.y,
    width: CANVAS_NODE_WIDTH,
    height: kind === "text" ? CANVAS_TEXT_MIN_HEIGHT : CANVAS_IMAGE_MIN_HEIGHT,
    text: "",
    aspectRatio: defaults?.aspectRatio ?? "16:9",
    resolution: defaults?.resolution ?? "1K",
    quality: defaults?.quality ?? "auto",
    quantity: defaults?.quantity ?? 1,
    status: "idle",
  };
}

export function screenToCanvas(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

export function canvasToScreen(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  };
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom));
}

export function zoomViewportAt(viewport: CanvasViewport, screen: CanvasPoint, nextZoom: number): CanvasViewport {
  const zoom = clampZoom(nextZoom);
  const anchor = screenToCanvas(screen, viewport);
  return {
    zoom,
    x: screen.x - anchor.x * zoom,
    y: screen.y - anchor.y * zoom,
  };
}

export function panViewport(viewport: CanvasViewport, delta: CanvasPoint): CanvasViewport {
  return {
    ...viewport,
    x: viewport.x + delta.x,
    y: viewport.y + delta.y,
  };
}

export function nodeRect(node: Pick<CanvasNode, "x" | "y" | "width" | "height">): CanvasRect {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

export function rectsIntersect(a: CanvasRect, b: CanvasRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function nodesInsideRect(nodes: CanvasNode[], rect: CanvasRect): string[] {
  const normalized = normalizeRect(rect);
  return nodes.filter((node) => rectsIntersect(nodeRect(node), normalized)).map((node) => node.id);
}

export function normalizeRect(rect: CanvasRect): CanvasRect {
  const width = Math.abs(rect.width);
  const height = Math.abs(rect.height);
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    width,
    height,
  };
}

export function moveNodes(nodes: CanvasNode[], ids: readonly string[], delta: CanvasPoint): CanvasNode[] {
  if (ids.length === 0 || (delta.x === 0 && delta.y === 0)) return nodes;
  const selected = new Set(ids);
  return nodes.map((node) => (selected.has(node.id) ? { ...node, x: node.x + delta.x, y: node.y + delta.y } : node));
}

export interface CanvasAlignmentGuide {
  orientation: "horizontal" | "vertical";
  position: number;
  start: number;
  end: number;
}

export function alignDraggedNodes(
  nodes: CanvasNode[],
  ids: readonly string[],
  threshold = CANVAS_ALIGNMENT_THRESHOLD,
): { nodes: CanvasNode[]; guides: CanvasAlignmentGuide[] } {
  const selected = new Set(ids);
  const moving = nodes.filter((node) => selected.has(node.id));
  const stationary = nodes.filter((node) => !selected.has(node.id));
  if (moving.length === 0 || stationary.length === 0) return { nodes, guides: [] };

  const movingBounds = boundsForNodes(moving);
  const verticalCandidates = [
    { source: movingBounds.centerX, apply: (delta: number) => ({ x: delta }) },
    { source: movingBounds.left, apply: (delta: number) => ({ x: delta }) },
    { source: movingBounds.right, apply: (delta: number) => ({ x: delta }) },
  ];
  const horizontalCandidates = [
    { source: movingBounds.centerY, apply: (delta: number) => ({ y: delta }) },
    { source: movingBounds.top, apply: (delta: number) => ({ y: delta }) },
    { source: movingBounds.bottom, apply: (delta: number) => ({ y: delta }) },
  ];
  let bestX: { delta: number; position: number; distance: number } | null = null;
  let bestY: { delta: number; position: number; distance: number } | null = null;

  for (const target of stationary) {
    const targetBounds = boundsForNode(target);
    for (const candidate of verticalCandidates) {
      for (const position of [targetBounds.centerX, targetBounds.left, targetBounds.right]) {
        const distance = Math.abs(candidate.source - position);
        if (distance > threshold || (bestX && distance >= bestX.distance)) continue;
        bestX = { delta: position - candidate.source, position, distance };
      }
    }
    for (const candidate of horizontalCandidates) {
      for (const position of [targetBounds.centerY, targetBounds.top, targetBounds.bottom]) {
        const distance = Math.abs(candidate.source - position);
        if (distance > threshold || (bestY && distance >= bestY.distance)) continue;
        bestY = { delta: position - candidate.source, position, distance };
      }
    }
  }

  const aligned = nodes.map((node) => selected.has(node.id)
    ? { ...node, x: node.x + (bestX?.delta ?? 0), y: node.y + (bestY?.delta ?? 0) }
    : node);
  const alignedMoving = aligned.filter((node) => selected.has(node.id));
  const alignedBounds = boundsForNodes(alignedMoving);
  const guides: CanvasAlignmentGuide[] = [];
  if (bestX) {
    const matched = [alignedBounds, ...stationary.map(boundsForNode)].filter((bounds) =>
      [bounds.left, bounds.centerX, bounds.right].some((value) => Math.abs(value - bestX.position) <= 0.5),
    );
    guides.push({
      orientation: "vertical",
      position: bestX.position,
      start: Math.min(...matched.map((bounds) => bounds.top)) - 24,
      end: Math.max(...matched.map((bounds) => bounds.bottom)) + 24,
    });
  }
  if (bestY) {
    const matched = [alignedBounds, ...stationary.map(boundsForNode)].filter((bounds) =>
      [bounds.top, bounds.centerY, bounds.bottom].some((value) => Math.abs(value - bestY.position) <= 0.5),
    );
    guides.push({
      orientation: "horizontal",
      position: bestY.position,
      start: Math.min(...matched.map((bounds) => bounds.left)) - 24,
      end: Math.max(...matched.map((bounds) => bounds.right)) + 24,
    });
  }
  return { nodes: aligned, guides };
}

export function placeLinkedNode(
  source: Pick<CanvasNode, "x" | "y" | "width" | "height">,
  node: CanvasNode,
  side: "left" | "right",
  gap = CANVAS_NODE_GAP,
): CanvasNode {
  return {
    ...node,
    x: side === "right" ? source.x + source.width + gap : source.x - gap - node.width,
    y: source.y + (source.height - node.height) / 2,
  };
}

function boundsForNode(node: Pick<CanvasNode, "x" | "y" | "width" | "height">) {
  return {
    left: node.x,
    right: node.x + node.width,
    top: node.y,
    bottom: node.y + node.height,
    centerX: node.x + node.width / 2,
    centerY: node.y + node.height / 2,
  };
}

function boundsForNodes(nodes: Array<Pick<CanvasNode, "x" | "y" | "width" | "height">>) {
  const bounds = nodes.map(boundsForNode);
  const left = Math.min(...bounds.map((item) => item.left));
  const right = Math.max(...bounds.map((item) => item.right));
  const top = Math.min(...bounds.map((item) => item.top));
  const bottom = Math.max(...bounds.map((item) => item.bottom));
  return { left, right, top, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}

export function outputPort(node: CanvasNode): CanvasPoint {
  return { x: node.x + node.width + CANVAS_PORT_OFFSET, y: node.y + node.height / 2 };
}

export function inputPort(node: CanvasNode): CanvasPoint {
  return { x: node.x - CANVAS_PORT_OFFSET, y: node.y + node.height / 2 };
}

export function edgePath(from: CanvasPoint, to: CanvasPoint): string {
  const distance = Math.max(48, Math.abs(to.x - from.x) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x + distance} ${from.y}, ${to.x - distance} ${to.y}, ${to.x} ${to.y}`;
}

export function canConnect(nodes: CanvasNode[], edges: CanvasEdge[], fromId: string, toId: string): boolean {
  if (!fromId || !toId || fromId === toId) return false;
  const from = nodes.find((node) => node.id === fromId);
  const to = nodes.find((node) => node.id === toId);
  if (!from || !to || to.kind === "upload") return false;
  if (edges.some((edge) => edge.from === fromId && edge.to === toId)) return false;
  return !createsCycle(edges, fromId, toId);
}

export function connectNodes(nodes: CanvasNode[], edges: CanvasEdge[], fromId: string, toId: string, edgeId: string): CanvasEdge[] {
  if (!canConnect(nodes, edges, fromId, toId)) return edges;
  return [...edges, { id: edgeId, from: fromId, to: toId }];
}

export function incomingNodes(nodes: CanvasNode[], edges: CanvasEdge[], nodeId: string): CanvasNode[] {
  const incoming = new Set(edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from));
  return nodes.filter((node) => incoming.has(node.id));
}

export function promptForNode(nodes: CanvasNode[], edges: CanvasEdge[], nodeId: string): string {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return "";
  const own = node.text.trim();
  const upstream = incomingNodes(nodes, edges, nodeId)
    .filter((item) => item.kind === "text")
    .map((item) => item.text.trim())
    .filter((text) => text && text !== own);
  return [own, ...upstream].filter(Boolean).join("\n\n");
}

import { RATIO_OPTIONS, sizeForRatioResolution } from "../../../image-models";

/** Canvas nodes only support fixed ratios; the composer's custom size needs width/height inputs. */
export function canvasRatioOptions(config: { ratios: readonly string[] }): string[] {
  const ratios = config.ratios.length > 0 ? config.ratios : [...RATIO_OPTIONS];
  const supported = ratios.filter((ratio) => ratio !== "custom");
  return supported.length > 0 ? supported : [...RATIO_OPTIONS];
}

export function referenceSourcesForNode(nodes: CanvasNode[], edges: CanvasEdge[], nodeId: string): CanvasNode[] {
  return incomingNodes(nodes, edges, nodeId).filter((node) => Boolean(node.imageUrl) && (node.kind === "image" || node.kind === "upload"));
}

export function cardSizeForRatio(ratio: string, resolution = "1K", longEdge = 420): { width: number; height: number } {
  const parsed = ratioSize(ratio);
  if (parsed) return cardSizeForImage(parsed[0], parsed[1], longEdge);
  const [width, height] = sizeForRatioResolution(ratio, resolution);
  return cardSizeForImage(width, height, longEdge);
}

function ratioSize(ratio: string): [number, number] | null {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(ratio.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return [width, height];
}

export function cardSizeForImage(width: number, height: number, longEdge = 420): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: longEdge, height: Math.round(longEdge * 9 / 16) };
  }
  const scale = longEdge / Math.max(width, height);
  return {
    width: Math.max(160, Math.round(width * scale)),
    height: Math.max(120, Math.round(height * scale)),
  };
}

export function removeNodes(document: CanvasDocument, ids: readonly string[]): CanvasDocument {
  const removed = new Set(ids);
  return {
    ...document,
    nodes: document.nodes.filter((node) => !removed.has(node.id)),
    edges: document.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)),
  };
}

export function duplicateNodes(document: CanvasDocument, ids: readonly string[], idFactory: () => string): CanvasDocument {
  const selected = document.nodes.filter((node) => ids.includes(node.id));
  if (selected.length === 0) return document;
  const idMap = new Map(selected.map((node) => [node.id, idFactory()]));
  const copies = selected.map((node) => ({
    ...node,
    id: idMap.get(node.id) ?? idFactory(),
    x: node.x + 36,
    y: node.y + 36,
    jobId: undefined,
    status: "idle" as const,
    progressLabel: undefined,
    maskFile: undefined,
    maskName: undefined,
    error: undefined,
  }));
  const selectedIds = new Set(selected.map((node) => node.id));
  const copiedEdges = document.edges
    .filter((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to))
    .map((edge) => ({
      id: idFactory(),
      from: idMap.get(edge.from) ?? edge.from,
      to: idMap.get(edge.to) ?? edge.to,
    }));
  return {
    ...document,
    nodes: [...document.nodes, ...copies],
    edges: [...document.edges, ...copiedEdges],
  };
}

export function fitViewport(nodes: CanvasNode[], frame: { width: number; height: number }, padding = 96): CanvasViewport {
  if (nodes.length === 0 || frame.width <= 0 || frame.height <= 0) {
    return { x: 80, y: 72, zoom: 1 };
  }
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  const contentWidth = Math.max(1, right - left);
  const contentHeight = Math.max(1, bottom - top);
  const zoom = clampZoom(Math.min((frame.width - padding * 2) / contentWidth, (frame.height - padding * 2) / contentHeight));
  return {
    zoom,
    x: (frame.width - contentWidth * zoom) / 2 - left * zoom,
    y: (frame.height - contentHeight * zoom) / 2 - top * zoom,
  };
}

export function pushHistory(history: CanvasDocument[], present: CanvasDocument): CanvasDocument[] {
  const next = [...history, cloneDocument(present)];
  return next.slice(-CANVAS_HISTORY_LIMIT);
}

export function cloneDocument(document: CanvasDocument): CanvasDocument {
  return {
    name: document.name,
    viewport: { ...document.viewport },
    nodes: document.nodes.map((node) => ({ ...node })),
    edges: document.edges.map((edge) => ({ ...edge })),
  };
}

export function parseCanvasDocument(value: string | null): CanvasDocument | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CanvasDocument>;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    const nodes = parsed.nodes.filter(isCanvasNode);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = parsed.edges.filter(
      (edge): edge is CanvasEdge =>
        Boolean(edge)
        && typeof edge.id === "string"
        && typeof edge.from === "string"
        && typeof edge.to === "string"
        && nodeIds.has(edge.from)
        && nodeIds.has(edge.to),
    );
    const viewport = parsed.viewport;
    return {
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : "未命名项目",
      nodes,
      edges,
      viewport: {
        x: finiteNumber(viewport?.x, 80),
        y: finiteNumber(viewport?.y, 72),
        zoom: clampZoom(finiteNumber(viewport?.zoom, 1)),
      },
    };
  } catch {
    return null;
  }
}

function isCanvasNode(value: unknown): value is CanvasNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<CanvasNode>;
  return typeof node.id === "string"
    && (node.kind === "text" || node.kind === "image" || node.kind === "upload")
    && Number.isFinite(node.x)
    && Number.isFinite(node.y)
    && Number.isFinite(node.width)
    && Number.isFinite(node.height);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function createsCycle(edges: CanvasEdge[], fromId: string, toId: string): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const next = adjacency.get(edge.from) ?? [];
    next.push(edge.to);
    adjacency.set(edge.from, next);
  }
  const pending = [toId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    if (current === fromId) return true;
    seen.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}
