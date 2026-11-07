import { IconArrowCornerDownRight } from "./central-icons/IconArrowCornerDownRight";
import { IconArrowCornerUpLeft } from "./central-icons/IconArrowCornerUpLeft";
import { IconBubble5 } from "./central-icons/IconBubble5";
import { IconChevronDownSmall } from "./central-icons/IconChevronDownSmall";
import { IconCloudUpload } from "./central-icons/IconCloudUpload";
import { IconCursor1 } from "./central-icons/IconCursor1";
import { IconFocusZoomIn } from "./central-icons/IconFocusZoomIn";
import { IconFocusZoomOut } from "./central-icons/IconFocusZoomOut";
import { IconHand5Finger } from "./central-icons/IconHand5Finger";
import { IconImages2 } from "./central-icons/IconImages2";
import { IconPan } from "./central-icons/IconPan";
import { IconPlusSmall } from "./central-icons/IconPlusSmall";
import { IconText2 } from "./central-icons/IconText2";
import { IconTrashCan } from "./central-icons/IconTrashCan";
import {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { DEFAULT_IMAGE_MODEL, RESOLUTION_OPTIONS, clampQualityForModel, imageModelLabel, qualityTiersForModel, sizeForRatioResolution } from "../../../image-models";
import { api, getGenerationStatus, type AppConfig, type GenerationJob, type ImageItem } from "../../api";
import { cn } from "../../lib/utils";
import { isTerminalGenerationJobStatus } from "../../generation-state";
import { AppShell } from "../generate-shell/AppShell";
import generationContinueIcon from "../../assets/figma/generation-continue.svg";
import generationCopyIcon from "../../assets/figma/generation-copy.svg";
import generationDeleteIcon from "../../assets/figma/generation-delete.svg";
import generationDownloadIcon from "../../assets/figma/generation-download.svg";
import generationLocalEditIcon from "../../assets/figma/generation-local-edit.svg";
import generationRegenerateIcon from "../../assets/figma/generation-regenerate.svg";
import { ComposerPanel, ImagePreview, LocalEditDialog, updateGenerateForm, type GenerateForm, type ImageSelectionStroke } from "../generate-menu/GenerateMenuView";
import { generationProgressSummary } from "../../generation-progress";
import { DotmSquare12 } from "@/components/ui/dotm-square-12";
import { AssistantRail, AssetRail, MiniMap, dotGridStyle, paintDraggedNodes, paintWorld, worldStyle } from "./canvas-chrome";
import type { WorkspaceView } from "../generate-shell/AppShell";
import {
  type CanvasAlignmentGuide,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeKind,
  type CanvasPoint,
  type CanvasRect,
  type CanvasViewport,
  CANVAS_NODE_WIDTH,
  canvasRatioOptions,
  cloneDocument,
  connectNodes,
  alignDraggedNodes,
  createCanvasNode,
  duplicateNodes,
  edgePath,
  emptyCanvasDocument,
  fitViewport,
  incomingNodes,
  inputPort,
  moveNodes,
  nodesInsideRect,
  outputPort,
  panViewport,
  parseCanvasDocument,
  placeLinkedNode,
  promptForNode,
  pushHistory,
  cardSizeForImage,
  cardSizeForRatio,
  referenceSourcesForNode,
  removeNodes,
  screenToCanvas,
  zoomViewportAt,
} from "./geometry";

interface InfiniteCanvasViewProps {
  config: AppConfig;
  providerConfigured: boolean;
  onNavigate: (view: WorkspaceView) => void;
  onProviderNeeded: () => void;
  onLogout: () => void;
}

type Tool = "select" | "pan";
type MenuState = { x: number; y: number; canvas: CanvasPoint; side?: "left" | "right" } | null;

const STORAGE_KEY = "ohm.infinite-canvas.v2";
const LEGACY_STORAGE_KEY = "ohm.infinite-canvas.v1";

interface CanvasLibrary {
  activeId: string;
  canvases: Array<{ id: string; document: CanvasDocument }>;
}
const QUALITY_LABELS: Record<string, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export function InfiniteCanvasView({
  config,
  providerConfigured,
  onNavigate,
  onProviderNeeded,
  onLogout,
}: InfiniteCanvasViewProps) {
  const [library, setLibrary] = useState<CanvasLibrary>(() => readCanvasLibrary());
  const activeCanvas = library.canvases.find((item) => item.id === library.activeId) ?? library.canvases[0];
  const documentState = activeCanvas.document;
  const [past, setPast] = useState<CanvasDocument[]>([]);
  const [future, setFuture] = useState<CanvasDocument[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuState>(null);
  const [marquee, setMarquee] = useState<CanvasRect | null>(null);
  const [draftEdge, setDraftEdge] = useState<{ from: string; to: CanvasPoint } | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<CanvasAlignmentGuide[]>([]);
  const pendingSourceRef = useRef<string | null>(null);
  const [notice, setNotice] = useState("");
  const [localEditNodeId, setLocalEditNodeId] = useState<string | null>(null);
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [assetsOpen, setAssetsOpen] = useState(true);
  const [promptDraft, setPromptDraft] = useState("");
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<CanvasPoint | null>(null);
  const documentRef = useRef(documentState);
  const spacePressed = useRef(false);
  const idRef = useRef(0);

  useEffect(() => {
    documentRef.current = documentState;
  }, [documentState]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [library]);

  const activeGenerationKey = documentState.nodes
    .filter((node) => node.jobId && !isTerminalGenerationJobStatus(node.status === "idle" ? "queued" : node.status))
    .map((node) => `${node.id}:${node.jobId}`)
    .join("|");

  useEffect(() => {
    if (!activeGenerationKey) return;
    const active = activeGenerationKey.split("|").map((item) => {
      const separator = item.indexOf(":");
      return { nodeId: item.slice(0, separator), jobId: item.slice(separator + 1) };
    });
    let cancelled = false;
    let inFlight = false;
    const abortController = new AbortController();
    const poll = () => {
      // Skip while hidden or while the previous round is still running, so slow
      // networks never stack overlapping status requests.
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void Promise.all(active.map(async (node) => {
        const result = await getGenerationStatus(node.jobId, undefined, { signal: abortController.signal });
        return { nodeId: node.nodeId, job: result.job, images: result.images };
      })).then((results) => {
        if (cancelled) return;
        setDocumentState((current) => applyGenerationResults(current, results));
      }).catch((error: unknown) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : "画布生成状态刷新失败。");
      }).finally(() => {
        inFlight = false;
      });
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      abortController.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [activeGenerationKey]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const meta = event.metaKey || event.ctrlKey;
      if (meta && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (meta && key === "a") {
        event.preventDefault();
        setSelectedIds(documentRef.current.nodes.map((node) => node.id));
      } else if (meta && key === "d") {
        event.preventDefault();
        duplicateSelection();
      } else if (key === "delete" || key === "backspace") {
        event.preventDefault();
        deleteSelection();
      } else if (key === "v") {
        setTool("select");
      } else if (key === "h") {
        setTool("pan");
      } else if (event.code === "Space") {
        spacePressed.current = true;
      } else if (key === "f") {
        fit();
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.code === "Space") spacePressed.current = false;
    }
    function onPaste(event: ClipboardEvent) {
      if (isTypingTarget(event.target)) return;
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (files.length === 0) return;
      event.preventDefault();
      const frame = surfaceRef.current?.getBoundingClientRect();
      const point = frame ? screenToCanvas({ x: frame.width / 2, y: frame.height / 2 }, documentRef.current.viewport) : { x: 160, y: 120 };
      void addUploadFiles(files, point);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
    };
  });

  const selected = useMemo(
    () => documentState.nodes.filter((node) => selectedIds.includes(node.id)),
    [documentState.nodes, selectedIds],
  );
  const primary = selected.length === 1 ? selected[0] : null;

  function setDocumentState(next: CanvasDocument | ((current: CanvasDocument) => CanvasDocument)) {
    setLibrary((current) => ({
      ...current,
      canvases: current.canvases.map((item) => item.id === current.activeId ? { ...item, document: typeof next === "function" ? next(item.document) : next } : item),
    }));
  }

  function createCanvas() {
    const id = nextId("canvas");
    const document = emptyCanvasDocument(`未命名项目 ${library.canvases.length + 1}`);
    setLibrary((current) => ({ activeId: id, canvases: [...current.canvases, { id, document }] }));
    setPast([]);
    setFuture([]);
    setSelectedIds([]);
  }

  function openCanvas(id: string) {
    setLibrary((current) => ({ ...current, activeId: id }));
    setPast([]);
    setFuture([]);
    setSelectedIds([]);
  }

  function nextId(prefix: string) {
    idRef.current += 1;
    return `${prefix}_${Date.now().toString(36)}_${idRef.current}`;
  }

  function commit(recipe: (current: CanvasDocument) => CanvasDocument, recordHistory = true) {
    setDocumentState((current) => {
      const next = recipe(current);
      if (next === current) return current;
      if (recordHistory) {
        setPast((items) => pushHistory(items, current));
        setFuture([]);
      }
      return next;
    });
  }

  function undo() {
    setPast((items) => {
      const previous = items.at(-1);
      if (!previous) return items;
      setFuture((forward) => [cloneDocument(documentRef.current), ...forward].slice(0, 50));
      setDocumentState(previous);
      return items.slice(0, -1);
    });
  }

  function redo() {
    setFuture((items) => {
      const [next, ...rest] = items;
      if (!next) return items;
      setPast((backward) => pushHistory(backward, documentRef.current));
      setDocumentState(next);
      return rest;
    });
  }

  function addNode(kind: CanvasNodeKind, point: CanvasPoint) {
    const node = createCanvasNode(kind, point, nextId(kind), {
      aspectRatio: canvasRatioOptions(config)[0] ?? "16:9",
      resolution: "1K",
      quality: config.qualities[0] ?? "auto",
    });
    commit((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedIds([node.id]);
    setMenu(null);
    if (kind === "upload") {
      uploadTargetRef.current = point;
      fileInputRef.current?.click();
    }
  }

  function updateNode(id: string, patch: Partial<CanvasNode>, recordHistory = false) {
    commit((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
    }), recordHistory);
  }

  function deleteSelection() {
    if (selectedIds.length === 0) return;
    const ids = selectedIds;
    commit((current) => removeNodes(current, ids));
    setSelectedIds([]);
  }

  function duplicateSelection() {
    if (selectedIds.length === 0) return;
    const ids = selectedIds;
    let created: string[] = [];
    commit((current) => {
      const before = new Set(current.nodes.map((node) => node.id));
      const next = duplicateNodes(current, ids, () => nextId("node"));
      created = next.nodes.filter((node) => !before.has(node.id)).map((node) => node.id);
      return next;
    });
    setSelectedIds(created);
  }

  function fit() {
    const frame = surfaceRef.current?.getBoundingClientRect();
    if (!frame) return;
    commit((current) => ({ ...current, viewport: fitViewport(current.nodes, frame) }), false);
  }

  function zoomBy(factor: number) {
    const frame = surfaceRef.current?.getBoundingClientRect();
    const origin = frame ? { x: frame.width / 2, y: frame.height / 2 } : { x: 0, y: 0 };
    commit((current) => ({ ...current, viewport: zoomViewportAt(current.viewport, origin, current.viewport.zoom * factor) }), false);
  }

  function continueFromImage(node: CanvasNode) {
    if (!node.imageUrl) return;
    const point = { x: node.x + node.width + 96, y: node.y };
    const next = createCanvasNode("image", point, nextId("image"), {
      aspectRatio: node.aspectRatio,
      resolution: node.resolution,
      quality: node.quality,
      quantity: node.quantity,
    });
    const linked = {
      ...next,
      model: node.model,
      width: node.width,
      height: node.height,
      text: "",
    };
    commit((current) => ({
      ...current,
      nodes: [...current.nodes, linked],
      edges: connectNodes(current.nodes.concat(linked), current.edges, node.id, linked.id, nextId("edge")),
    }));
    setSelectedIds([linked.id]);
  }

  async function applyCanvasLocalEdit(nodeId: string, image: ImageItem, strokes: ImageSelectionStroke[]) {
    const mask = await createCanvasSelectionMask(image, strokes);
    const point = documentRef.current.nodes.find((node) => node.id === nodeId);
    if (!point?.imageUrl) return;
    const next = createCanvasNode("image", { x: point.x + point.width + 96, y: point.y }, nextId("image"), {
      aspectRatio: point.aspectRatio,
      resolution: point.resolution,
      quality: point.quality,
      quantity: point.quantity,
    });
    const linked = {
      ...next,
      model: point.model,
      width: point.width,
      height: point.height,
      text: "",
      sourceImageId: image.id,
      maskFile: mask.file,
      maskName: mask.name,
    };
    commit((current) => ({
      ...current,
      nodes: [...current.nodes, linked],
      edges: connectNodes(current.nodes.concat(linked), current.edges, nodeId, linked.id, nextId("edge")),
    }));
    setSelectedIds([linked.id]);
    setLocalEditNodeId(null);
  }

  async function generateNode(nodeId: string) {
    const current = documentRef.current;
    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node || node.kind === "upload") return;
    if (!providerConfigured) {
      onProviderNeeded();
      return;
    }
    const prompt = promptForNode(current.nodes, current.edges, nodeId);
    if (!prompt) {
      setNotice("先写提示词，或把文字节点连到这张图上。");
      return;
    }
    if (!node.text.trim()) {
      updateNode(nodeId, { text: prompt });
    }
    const references = referenceSourcesForNode(current.nodes, current.edges, nodeId);
    const requestedSize = cardSizeForRatio(node.aspectRatio, node.resolution);
    const [width, height] = sizeForRatioResolution(node.aspectRatio, node.resolution);
    const model = node.model || config.model || DEFAULT_IMAGE_MODEL;
    setNotice("");
    updateNode(nodeId, {
      status: "queued",
      progressLabel: "排队",
      error: undefined,
      text: node.text,
      width: requestedSize.width,
      height: requestedSize.height,
    });
    try {
      const body = await canvasGenerationBody({
        prompt,
        model,
        aspectRatio: node.aspectRatio,
        resolution: node.resolution,
        width,
        height,
        quality: clampQualityForModel(model, node.quality),
        quantity: Math.min(4, Math.max(1, node.quantity)),
        outputFormat: "png",
        compression: 100,
        ...(node.sourceImageId ? { sourceImageId: node.sourceImageId } : {}),
      }, references, node.maskFile && node.maskName ? { file: node.maskFile, name: node.maskName } : null);
      const created = await api<{ ok: true; jobId: string; status: "queued" }>("/api/generations", { method: "POST", body });
      updateNode(nodeId, { jobId: created.jobId, status: "queued", progressLabel: "排队", error: undefined });
    } catch (error) {
      updateNode(nodeId, { status: "failed", progressLabel: undefined, error: error instanceof Error ? error.message : "创建生成任务失败。" });
    }
  }

  async function addUploadFiles(files: File[], point: CanvasPoint) {
    const images = files.filter((file) => ["image/png", "image/jpeg", "image/webp", "image/jpg"].includes(file.type));
    if (images.length === 0) {
      setNotice("只支持 PNG、JPEG 或 WebP。");
      return;
    }
    const nodes = await Promise.all(images.map(async (file, index) => {
      const url = URL.createObjectURL(file);
      const node = createCanvasNode("upload", { x: point.x + index * 32, y: point.y + index * 24 }, nextId("upload"));
      return { ...node, imageUrl: url, imageName: file.name || "参考图", text: file.name || "上传图片", status: "succeeded" as const };
    }));
    commit((current) => ({ ...current, nodes: [...current.nodes, ...nodes] }));
    setSelectedIds(nodes.map((node) => node.id));
    setMenu(null);
  }

  function onSurfacePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    const onNode = Boolean(target?.closest("[data-node-id]"));
    const onControl = Boolean(target?.closest("button, input, textarea, select, a"));
    if (!onNode && !onControl && (event.button === 1 || (event.button === 0 && !event.shiftKey))) {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.drag = "pan";
      event.currentTarget.dataset.x = String(event.clientX);
      event.currentTarget.dataset.y = String(event.clientY);
      setMenu(null);
      return;
    }
    if (event.button !== 0 || onControl || !event.shiftKey) return;
    const local = localPoint(event, surfaceRef.current);
    const origin = screenToCanvas(local, documentRef.current.viewport);
    setMenu(null);
    if (!event.shiftKey) setSelectedIds([]);
    setMarquee({ ...origin, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.drag = "marquee";
    event.currentTarget.dataset.x = String(origin.x);
    event.currentTarget.dataset.y = String(origin.y);
  }

  function onSurfacePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const mode = event.currentTarget.dataset.drag;
    if (!mode) return;
    if (mode === "pan") {
      const previousX = Number(event.currentTarget.dataset.x);
      const previousY = Number(event.currentTarget.dataset.y);
      const delta = { x: event.clientX - previousX, y: event.clientY - previousY };
      event.currentTarget.dataset.x = String(event.clientX);
      event.currentTarget.dataset.y = String(event.clientY);
      const viewport = panViewport(documentRef.current.viewport, delta);
      documentRef.current = { ...documentRef.current, viewport };
      paintWorld(worldRef.current, surfaceRef.current, viewport);
      return;
    }
    if (mode === "marquee") {
      const origin = { x: Number(event.currentTarget.dataset.x), y: Number(event.currentTarget.dataset.y) };
      const point = screenToCanvas(localPoint(event, surfaceRef.current), documentRef.current.viewport);
      setMarquee({ x: origin.x, y: origin.y, width: point.x - origin.x, height: point.y - origin.y });
    }
  }

  function onSurfacePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const mode = event.currentTarget.dataset.drag;
    delete event.currentTarget.dataset.drag;
    if (mode === "pan") {
      setDocumentState((current) => ({ ...current, viewport: documentRef.current.viewport }));
    }
    if (mode === "marquee" && marquee) {
      const ids = nodesInsideRect(documentRef.current.nodes, marquee);
      setSelectedIds((current) => (event.shiftKey ? Array.from(new Set([...current, ...ids])) : ids));
    }
    setMarquee(null);
  }

  function onWheel(event: React.WheelEvent<HTMLDivElement>) {
    const current = documentRef.current.viewport;
    const viewport = event.ctrlKey || event.metaKey
      ? zoomViewportAt(current, localPoint(event, surfaceRef.current), current.zoom * Math.exp(-event.deltaY * 0.0015))
      : panViewport(current, { x: -event.deltaX, y: -event.deltaY });
    documentRef.current = { ...documentRef.current, viewport };
    paintWorld(worldRef.current, surfaceRef.current, viewport);
    scheduleViewportCommit();
  }

  function scheduleViewportCommit() {
    const surface = surfaceRef.current;
    if (!surface) return;
    const existing = Number(surface.dataset.commitTimer);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      if (surfaceRef.current) delete surfaceRef.current.dataset.commitTimer;
      setDocumentState((current) => current.viewport === documentRef.current.viewport ? current : { ...current, viewport: documentRef.current.viewport });
    }, 120);
    surface.dataset.commitTimer = String(timer);
  }

  function startNodeDrag(event: ReactPointerEvent<HTMLElement>, nodeId: string) {
    const target = event.target instanceof Element ? event.target : null;
    if (tool === "pan" || event.button !== 0 || target?.closest("button, textarea, input, select")) return;
    event.stopPropagation();
    const ids = selectedIds.includes(nodeId) ? selectedIds : [nodeId];
    if (!selectedIds.includes(nodeId)) setSelectedIds(event.shiftKey ? [...selectedIds, nodeId] : [nodeId]);
    const start = screenToCanvas(localPoint(event, surfaceRef.current), documentRef.current.viewport);
    const snapshot = documentRef.current;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const point = screenToCanvas(clientToLocal(next, surfaceRef.current), snapshot.viewport);
      const delta = { x: point.x - start.x, y: point.y - start.y };
      const moved = moveNodes(snapshot.nodes, ids, delta);
      const aligned = alignDraggedNodes(moved, ids);
      documentRef.current = { ...snapshot, nodes: aligned.nodes };
      paintDraggedNodes(worldRef.current, aligned.nodes, snapshot.edges, ids);
      setAlignmentGuides(aligned.guides);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setAlignmentGuides([]);
      const moved = documentRef.current;
      setDocumentState((current) => ({
        ...current,
        nodes: current.nodes.map((node) => {
          const next = moved.nodes.find((item) => item.id === node.id);
          return next ? { ...node, x: next.x, y: next.y } : node;
        }),
      }));
      setPast((items) => pushHistory(items, snapshot));
      setFuture([]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startConnect(event: ReactPointerEvent<HTMLButtonElement>, nodeId: string, side: "left" | "right") {
    event.stopPropagation();
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const move = (next: PointerEvent) => {
      if (Math.hypot(next.clientX - start.x, next.clientY - start.y) <= 4) return;
      moved = true;
      setDraftEdge({ from: nodeId, to: screenToCanvas(clientToLocal(next, surfaceRef.current), documentRef.current.viewport) });
    };
    const up = (next: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const point = screenToCanvas(clientToLocal(next, surfaceRef.current), documentRef.current.viewport);
      const target = moved
        ? documentRef.current.nodes.find((node) => node.id !== nodeId && pointInsideNode(point, node))
        : undefined;
      if (target) {
        commit((current) => ({ ...current, edges: connectNodes(current.nodes, current.edges, nodeId, target.id, nextId("edge")) }));
        pendingSourceRef.current = null;
      } else {
        pendingSourceRef.current = nodeId;
        setMenu({ x: next.clientX, y: next.clientY, canvas: point, side });
      }
      setDraftEdge(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function connectFromMenu(kind: CanvasNodeKind) {
    if (!menu || !pendingSourceRef.current) return;
    const source = documentRef.current.nodes.find((node) => node.id === pendingSourceRef.current);
    if (!source) return;
    const side = menu.side === "left" ? "left" : "right";
    const node = placeLinkedNode(source, createCanvasNode(kind, menu.canvas, nextId(kind), {
      aspectRatio: source.aspectRatio,
      resolution: source.resolution,
      quality: source.quality,
      quantity: source.quantity,
    }), side);
    const sourceId = source.id;
    pendingSourceRef.current = null;
    commit((current) => {
      const nodes = [...current.nodes, node];
      const edges = side === "left"
        ? connectNodes(nodes, current.edges, node.id, sourceId, nextId("edge"))
        : connectNodes(nodes, current.edges, sourceId, node.id, nextId("edge"));
      return { ...current, nodes, edges };
    });
    setSelectedIds([node.id]);
    setMenu(null);
  }

  function onDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    const point = screenToCanvas(localPoint(event, surfaceRef.current), documentRef.current.viewport);
    void addUploadFiles(files, point);
  }

  const viewport = documentState.viewport;
  const marqueeStyle = marquee ? rectStyle(normalizeDisplayedRect(marquee)) : null;

  return (
    <AppShell activeView="canvas" onNavigate={onNavigate} onLogout={onLogout}>
      <div className="relative flex h-full min-w-0 overflow-hidden bg-[#161616] text-white">
        <AssetRail
          open={assetsOpen}
          nodes={documentState.nodes}
          selectedIds={selectedIds}
          onToggle={() => setAssetsOpen((current) => !current)}
          onFocus={(id) => setSelectedIds([id])}
        />
        <div className="relative min-w-0 flex-1">
        <CanvasTopBar
          name={documentState.name}
          canvases={library.canvases.map((item) => ({ id: item.id, name: item.document.name }))}
          activeId={library.activeId}
          onOpen={openCanvas}
          onCreate={createCanvas}
          onName={(name) => commit((current) => ({ ...current, name }), false)}
          zoom={viewport.zoom}
          assistantOpen={assistantOpen}
          onAssistant={() => setAssistantOpen((current) => !current)}
        />
        <div
          ref={surfaceRef}
          className={cn("absolute inset-0 overflow-hidden", tool === "pan" || spacePressed.current ? "cursor-grab active:cursor-grabbing" : "cursor-grab active:cursor-grabbing")}
          style={dotGridStyle(viewport)}
          onPointerDown={onSurfacePointerDown}
          onPointerMove={onSurfacePointerMove}
          onPointerUp={onSurfacePointerUp}
          onPointerCancel={onSurfacePointerUp}
          onWheel={onWheel}
          onDoubleClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const canvas = screenToCanvas(localPoint(event, surfaceRef.current), viewport);
            setMenu({ x: event.clientX, y: event.clientY, canvas });
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            const canvas = screenToCanvas(localPoint(event, surfaceRef.current), viewport);
            setMenu({ x: event.clientX, y: event.clientY, canvas });
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <div ref={worldRef} className="canvas-world absolute left-0 top-0" style={worldStyle(viewport)}>
            <svg className="pointer-events-none absolute overflow-visible" width="1" height="1">
              {documentState.edges.map((edge) => {
                const from = documentState.nodes.find((node) => node.id === edge.from);
                const to = documentState.nodes.find((node) => node.id === edge.to);
                if (!from || !to) return null;
                return <path key={edge.id} data-edge-id={edge.id} d={edgePath(outputPort(from), inputPort(to))} fill="none" stroke="rgba(255,255,255,0.72)" strokeWidth="1.6" />;
              })}
              {draftEdge && (() => {
                const from = documentState.nodes.find((node) => node.id === draftEdge.from);
                return from ? <path d={edgePath(outputPort(from), draftEdge.to)} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="1.6" strokeDasharray="5 4" /> : null;
              })()}
              {alignmentGuides.map((guide) => guide.orientation === "vertical" ? (
                <line key={`v-${guide.position}`} x1={guide.position} y1={guide.start} x2={guide.position} y2={guide.end} stroke="#7cc4ff" strokeWidth="1" />
              ) : (
                <line key={`h-${guide.position}`} x1={guide.start} y1={guide.position} x2={guide.end} y2={guide.position} stroke="#7cc4ff" strokeWidth="1" />
              ))}
            </svg>
            {documentState.nodes.map((node) => (
              <CanvasCard
                key={node.id}
                node={node}
                selected={selectedIds.includes(node.id)}
                incoming={incomingNodes(documentState.nodes, documentState.edges, node.id).length}
                composerOpen={selectedIds.length === 1 && selectedIds[0] === node.id && node.kind !== "upload"}
                config={config}
                onPointerDown={(event) => startNodeDrag(event, node.id)}
                onSelect={() => setSelectedIds([node.id])}
                onConnect={(event, side) => startConnect(event, node.id, side)}
                editing={editingTextId === node.id}
                onEdit={() => setEditingTextId((current) => current === node.id ? null : node.id)}
                onText={(text) => updateNode(node.id, { text })}
                onPatch={(patch) => updateNode(node.id, patch)}
                onGenerate={() => {
                  setSelectedIds([node.id]);
                  if (!node.text.trim() && promptForNode(documentRef.current.nodes, documentRef.current.edges, node.id)) {
                    void generateNode(node.id);
                    return;
                  }
                  void generateNode(node.id);
                }}
                onUpload={() => {
                  uploadTargetRef.current = { x: node.x, y: node.y };
                  fileInputRef.current?.click();
                }}
              />
            ))}
            {marqueeStyle && <div className="pointer-events-none absolute border border-white/80 bg-white/10" style={marqueeStyle} />}
          </div>
        </div>

        {documentState.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="max-w-sm text-center">
              <p className="text-lg text-white/88">从一张画布开始</p>
              <p className="mt-2 text-sm leading-6 text-white/48">双击空白处添加文字或图片。把节点连起来，上游文字和图片会成为下一次生成的上下文。</p>
            </div>
          </div>
        )}

        <CanvasToolbar
          tool={tool}
          canUndo={past.length > 0}
          canRedo={future.length > 0}
          onTool={setTool}
          onAdd={(kind) => {
            const frame = surfaceRef.current?.getBoundingClientRect();
            const center = frame
              ? screenToCanvas({ x: frame.width / 2, y: frame.height / 2 }, documentRef.current.viewport)
              : { x: 240, y: 180 };
            const offset = documentRef.current.nodes.length * 36;
            addNode(kind, { x: center.x - CANVAS_NODE_WIDTH / 2 + offset, y: center.y - 90 + offset });
          }}
          onUpload={() => {
            const frame = surfaceRef.current?.getBoundingClientRect();
            uploadTargetRef.current = frame ? screenToCanvas({ x: frame.width / 2 - 140, y: frame.height / 2 - 80 }, viewport) : { x: 120, y: 120 };
            fileInputRef.current?.click();
          }}
          onUndo={undo}
          onRedo={redo}
        />
        <ZoomControl zoom={viewport.zoom} onZoomOut={() => zoomBy(0.9)} onZoomIn={() => zoomBy(1.1)} onFit={fit} />
        {primary && (
          <Inspector
            node={primary}
            config={config}
            onChange={(patch) => updateNode(primary.id, patch)}
            onDelete={deleteSelection}
            onDuplicate={duplicateSelection}
          />
        )}
        {menu && (
          <CanvasMenu
            menu={menu}
            canChain={Boolean(pendingSourceRef.current)}
            onAdd={pendingSourceRef.current ? connectFromMenu : addNode}
            onUpload={() => {
              uploadTargetRef.current = menu.canvas;
              fileInputRef.current?.click();
              setMenu(null);
            }}
            onClose={() => {
              pendingSourceRef.current = null;
              setMenu(null);
              setDraftEdge(null);
            }}
          />
        )}
        {primary && primary.kind === "image" && primary.status !== "queued" && primary.status !== "running" && (
          <div
            className="absolute z-30 w-[min(840px,calc(100vw-32px))] -translate-x-1/2"
            style={{ left: viewport.x + (primary.x + primary.width / 2) * viewport.zoom, top: viewport.y + (primary.y + primary.height) * viewport.zoom + 16 }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <CanvasComposer node={primary} nodes={documentState.nodes} edges={documentState.edges} config={config} onPatch={(patch) => updateNode(primary.id, patch)} onGenerate={() => void generateNode(primary.id)} onRemoveReference={(sourceId) => commit((current) => ({ ...current, edges: current.edges.filter((edge) => !(edge.to === primary.id && edge.from === sourceId)) }))} />
          </div>
        )}
        {primary?.kind === "image" && primary.imageUrl && primary.status !== "queued" && primary.status !== "running" && (
          <CanvasImageToolbar
            node={primary}
            viewport={viewport}
            onContinue={() => continueFromImage(primary)}
            onLocalEdit={() => setLocalEditNodeId(primary.id)}
            onRegenerate={() => void generateNode(primary.id)}
            onCopy={() => void copyCanvasPrompt(promptForNode(documentState.nodes, documentState.edges, primary.id), setNotice)}
            onPreview={() => setPreviewNodeId(primary.id)}
            onDelete={() => {
              commit((current) => removeNodes(current, [primary.id]));
              setSelectedIds([]);
            }}
          />
        )}
        {(() => {
          const previewImage = canvasImageItem(documentState.nodes.find((node) => node.id === previewNodeId));
          return previewImage ? <ImagePreview image={previewImage} onClose={() => setPreviewNodeId(null)} /> : null;
        })()}
        <LocalEditDialog
          image={canvasImageItem(documentState.nodes.find((node) => node.id === localEditNodeId))}
          open={Boolean(localEditNodeId)}
          onOpenChange={(open) => {
            if (!open) setLocalEditNodeId(null);
          }}
          onConfirm={(image, strokes) => {
            if (!localEditNodeId) return Promise.resolve();
            return applyCanvasLocalEdit(localEditNodeId, image, strokes);
          }}
        />
        {notice && <div className="absolute bottom-24 left-1/2 max-w-md -translate-x-1/2 rounded-[12px] bg-black/80 px-4 py-2 text-sm text-white shadow-lg">{notice}</div>}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            const point = uploadTargetRef.current ?? { x: 120, y: 120 };
            event.target.value = "";
            void addUploadFiles(files, point);
          }}
        />
        </div>
        <AssistantRail
          open={assistantOpen}
          draft={promptDraft}
          onDraft={setPromptDraft}
          onClose={() => setAssistantOpen(false)}
          onPlace={() => {
            const text = promptDraft.trim();
            if (!text) return;
            const frame = surfaceRef.current?.getBoundingClientRect();
            const center = frame ? screenToCanvas({ x: frame.width * 0.62, y: frame.height / 2 }, documentRef.current.viewport) : { x: 280, y: 180 };
            const node = createCanvasNode("text", { x: center.x, y: center.y }, nextId("text"), { aspectRatio: canvasRatioOptions(config)[0] ?? "16:9" });
            commit((current) => ({ ...current, nodes: [...current.nodes, { ...node, text }] }));
            setSelectedIds([node.id]);
            setPromptDraft("");
          }}
        />
        <MiniMap nodes={documentState.nodes} viewport={viewport} onFocus={fit} />
      </div>
    </AppShell>
  );
}

const CanvasCard = memo(function CanvasCard({
  node,
  selected,
  incoming,
  composerOpen,
  config,
  onPointerDown,
  onSelect,
  onConnect,
  editing,
  onEdit,
  onText,
  onPatch,
  onGenerate,
  onUpload,
}: {
  node: CanvasNode;
  selected: boolean;
  incoming: number;
  composerOpen: boolean;
  config: AppConfig;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onSelect: () => void;
  onConnect: (event: ReactPointerEvent<HTMLButtonElement>, side: "left" | "right") => void;
  editing: boolean;
  onEdit: () => void;
  onText: (text: string) => void;
  onPatch: (patch: Partial<CanvasNode>) => void;
  onGenerate: () => void;
  onUpload: () => void;
}) {
  const busy = node.status === "queued" || node.status === "running";
  return (
    <article
      data-node-id={node.id}
      data-drag-handle="true"
      className={cn("canvas-node absolute cursor-grab overflow-visible border bg-[#171717] active:cursor-grabbing", busy ? "canvas-node-generating" : selected ? "border-white/55" : "border-white/16")}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
      onPointerDown={(event) => {
        if (node.kind === "image" && event.button === 0) onSelect();
        onPointerDown(event);
      }}
      onDoubleClick={(event) => {
        if (node.kind !== "text") return;
        event.stopPropagation();
        onEdit();
      }}
    >
      <div className="pointer-events-none absolute -top-7 left-0 flex h-6 items-center gap-1.5 text-xs text-white/58">
        {node.kind === "text" ? <IconText2 className="size-3.5" /> : <IconImages2 className="size-3.5" />}
        <span>{node.kind === "text" ? "文本" : node.kind === "upload" ? "上传" : "图片"}{incoming > 0 ? ` ${incoming}` : ""}</span>
      </div>
      <div className="h-full overflow-hidden rounded-[inherit]">
        {node.kind === "text" ? (
          editing ? (
            <textarea
              autoFocus
              value={node.text}
              placeholder="双击编辑文本"
              className="h-full w-full resize-none bg-transparent px-4 py-4 text-sm leading-6 text-white outline-none placeholder:text-white/32"
              onChange={(event) => onText(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onBlur={() => onEdit()}
            />
          ) : (
            <div className="flex h-full items-start whitespace-pre-wrap px-4 py-4 text-sm leading-6 text-white/82">
              {node.text.trim() || <span className="text-white/32">双击编辑文本</span>}
            </div>
          )
        ) : busy ? (
          <CanvasGenerationProgress label={node.progressLabel || "生成中"} />
        ) : node.imageUrl ? (
          <img src={node.imageUrl} alt="" className="pointer-events-none h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="grid h-full place-items-center text-white/28">
            <IconImages2 className="size-6" />
          </div>
        )}
        {node.error && !busy && <p className="absolute inset-x-3 bottom-3 text-xs leading-5 text-[#ffb4b4]">{node.error}</p>}
      </div>
      {node.kind !== "upload" && <Port side="input" onPointerDown={(event) => onConnect(event, "left")} />}
      <Port side="output" onPointerDown={(event) => onConnect(event, "right")} />
    </article>
  );
});

function CanvasComposer({
  node,
  nodes,
  edges,
  config,
  onPatch,
  onGenerate,
  onRemoveReference,
}: {
  node: CanvasNode;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  config: AppConfig;
  onPatch: (patch: Partial<CanvasNode>) => void;
  onGenerate: () => void;
  onRemoveReference: (sourceId: string) => void;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const references = referenceSourcesForNode(nodes, edges, node.id);
  const [width, height] = sizeForRatioResolution(node.aspectRatio, node.resolution);
  const form: GenerateForm = {
    prompt: node.text,
    model: node.model || config.model || DEFAULT_IMAGE_MODEL,
    aspectRatio: node.aspectRatio,
    resolution: node.resolution,
    width,
    height,
    quality: node.quality,
    quantity: node.quantity,
    outputFormat: "png",
    compression: 100,
  };
  return (
    <ComposerPanel
        formRef={formRef}
        panelRef={panelRef}
        layoutMode="canvas-card"
        form={form}
        config={config}
        loading={node.status === "queued" || node.status === "running"}
        referencePreparing={false}
        optimizing={false}
        providerConfigured
        modelProviders={[]}
        selectedModelProviderId={null}
        onModelProviderChange={() => undefined}
        showReferenceCarryoverHint={false}
        referenceImages={references.map((item, index) => ({ file: new File([], item.imageName || `参考图 ${index + 1}`), url: item.imageUrl || "", name: `参考图 ${index + 1}` }))}
        sourceImagePreview={null}
        referenceMask={null}
        localEditPreviewUrl={null}
        textareaRef={textareaRef}
        referenceInputRef={fileRef}
        onSubmit={(event) => {
          event.preventDefault();
          onGenerate();
        }}
        onPromptPaste={() => undefined}
        onReferenceInput={() => undefined}
        onPickReference={() => undefined}
        onRemoveSourceReference={() => undefined}
        onRemoveReference={(index) => {
          const source = references[index];
          if (!source) return;
          onRemoveReference(source.id);
        }}
        onOptimize={() => undefined}
        onUpdate={(key, value) => {
          const next = updateGenerateForm(form, key, value);
          onPatch({
            text: next.prompt,
            model: next.model,
            aspectRatio: next.aspectRatio,
            resolution: next.resolution,
            ...cardSizeForRatio(next.aspectRatio, next.resolution),
            quality: next.quality,
            quantity: next.quantity,
          });
        }}
        onConfigureProvider={() => undefined}
        turnstileToken=""
        onTurnstileToken={() => undefined}
      />
  );
}

function CanvasGenerationProgress({ label }: { label: string }) {
  return (
    <div className="generation-loading-thumbnail grid h-full place-items-center" role="status" aria-label={label}>
      <DotmSquare12
        size={24}
        dotSize={3}
        dotShape="circle"
        color="rgb(255 255 255 / 0.82)"
        ariaLabel={label}
      />
      <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-1 text-xs leading-none text-white/82">{label}</span>
    </div>
  );
}

function CanvasImageToolbar({
  node,
  viewport,
  onContinue,
  onLocalEdit,
  onRegenerate,
  onCopy,
  onPreview,
  onDelete,
}: {
  node: CanvasNode;
  viewport: CanvasViewport;
  onContinue: () => void;
  onLocalEdit: () => void;
  onRegenerate: () => void;
  onCopy: () => void;
  onPreview: () => void;
  onDelete: () => void;
}) {
  const actions = [
    { key: "continue", label: "继续创作", icon: generationContinueIcon, onClick: onContinue },
    { key: "local-edit", label: "局部编辑", icon: generationLocalEditIcon, onClick: onLocalEdit },
    { key: "regenerate", label: "重新生成", icon: generationRegenerateIcon, onClick: onRegenerate },
    { key: "copy", label: "复制提示词", icon: generationCopyIcon, onClick: onCopy },
    { key: "preview", label: "查看大图", icon: "image", onClick: onPreview },
    { key: "download", label: "下载", icon: generationDownloadIcon, href: node.sourceImageId ? `/api/images/${node.sourceImageId}/download?raw=1&download=1` : node.imageUrl },
    { key: "delete", label: "删除", icon: generationDeleteIcon, onClick: onDelete },
  ];
  return (
    <div
      className="absolute z-30 flex w-max -translate-x-1/2 items-center gap-0.5 whitespace-nowrap rounded-full border border-white/10 bg-[#121212]/94 p-1 shadow-2xl backdrop-blur"
      style={{ left: viewport.x + (node.x + node.width / 2) * viewport.zoom, top: Math.max(12, viewport.y + node.y * viewport.zoom - 52) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {actions.map((action) => {
        const content = (
          <>
            {action.icon === "image" ? <IconImages2 className="size-4 shrink-0" /> : <img src={action.icon} alt="" className="size-4 shrink-0" draggable={false} />}
            <span className="whitespace-nowrap">{action.label}</span>
          </>
        );
        const className = "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs text-white/86 hover:bg-white/10";
        return action.href ? (
          <a key={action.key} className={className} href={action.href} download>{content}</a>
        ) : (
          <button key={action.key} type="button" className={className} onClick={action.onClick}>{content}</button>
        );
      })}
    </div>
  );
}

function canvasImageItem(node: CanvasNode | undefined): ImageItem | null {
  if (!node?.imageUrl) return null;
  return {
    id: node.sourceImageId || node.id,
    jobId: node.jobId || node.id,
    url: node.imageUrl,
    width: node.width,
    height: node.height,
    format: "png",
    createdAt: new Date(0).toISOString(),
    prompt: node.text,
  };
}

async function copyCanvasPrompt(prompt: string, notify: (message: string) => void) {
  if (!prompt.trim()) {
    notify("这张卡片还没有提示词。");
    return;
  }
  if (!navigator.clipboard) {
    notify("当前浏览器不能复制提示词。");
    return;
  }
  await navigator.clipboard.writeText(prompt);
  notify("提示词已复制。");
}

async function createCanvasSelectionMask(image: Pick<ImageItem, "id" | "width" | "height">, strokes: ImageSelectionStroke[]) {
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
    if (stroke.points.length === 0) continue;
    const lineWidth = Math.max(8, stroke.brushRatio * Math.min(canvas.width, canvas.height));
    context.lineWidth = lineWidth;
    const first = stroke.points[0];
    if (stroke.points.length === 1) {
      context.beginPath();
      context.arc(first.x * canvas.width, first.y * canvas.height, lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    context.moveTo(first.x * canvas.width, first.y * canvas.height);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x * canvas.width, point.y * canvas.height);
    context.stroke();
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("局部重绘遮罩生成失败。")), "image/png");
  });
  const name = `${image.id}-mask.png`;
  return { file: new File([blob], name, { type: "image/png" }), name };
}

function Port({ side, onPointerDown }: { side: "input" | "output"; onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      type="button"
      aria-label={side === "input" ? "输入" : "输出"}
      className={cn("absolute top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full border border-white/18 bg-[#141414] text-white/72 hover:border-white/50 hover:text-white", side === "input" ? "left-[-42px]" : "right-[-42px]")}
      onPointerDown={onPointerDown}
    >
      <IconPlusSmall className="size-3.5" />
    </button>
  );
}

function CanvasTopBar({ name, canvases, activeId, onOpen, onCreate, zoom, assistantOpen, onAssistant, onName }: { name: string; canvases: Array<{ id: string; name: string }>; activeId: string; onOpen: (id: string) => void; onCreate: () => void; zoom: number; assistantOpen: boolean; onAssistant: () => void; onName: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute left-4 top-4 z-20 flex h-11 items-center gap-1 rounded-[16px] border border-white/10 bg-[#1b1b1b]/92 px-1.5 shadow-lg backdrop-blur">
      <button type="button" aria-label="画布列表" aria-expanded={open} className="flex h-8 max-w-52 items-center gap-1.5 rounded-[8px] px-2 text-sm text-white hover:bg-white/8" onClick={() => setOpen((current) => !current)}>
        <span className="truncate">{name || "未命名项目"}</span>
        <IconChevronDownSmall className="size-4 shrink-0 text-white/70" />
      </button>
      <button type="button" aria-label="新建画布" className="flex h-8 items-center gap-1 rounded-[8px] border border-white/10 bg-white/[0.06] px-2.5 text-sm text-white hover:bg-white/12" onClick={onCreate}>
        <IconPlusSmall className="size-4" />
        新建
      </button>
      {open && (
        <div className="absolute left-0 top-12 w-64 rounded-[12px] border border-white/10 bg-[#202020] p-2 shadow-2xl">
          <label className="mb-2 block px-1 text-xs text-white/45">
            重命名
            <input aria-label="项目名称" value={name} className="mt-1 h-8 w-full rounded-[8px] border border-white/10 bg-white/[0.04] px-2 text-sm text-white outline-none" onChange={(event) => onName(event.target.value)} />
          </label>
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {canvases.map((item) => (
              <button key={item.id} type="button" className={cn("block w-full truncate rounded-[8px] px-3 py-2 text-left text-sm", item.id === activeId ? "bg-white/10 text-white" : "text-white/72 hover:bg-white/8")} onClick={() => { onOpen(item.id); setOpen(false); }}>{item.name || "未命名项目"}</button>
            ))}
          </div>
          <button type="button" className="mt-1 flex w-full items-center gap-2 rounded-[8px] px-3 py-2 text-left text-sm text-white hover:bg-white/10" onClick={() => { onCreate(); setOpen(false); }}>
            <IconPlusSmall className="size-4" />
            新建画布
          </button>
        </div>
      )}
      <span className="px-1.5 text-xs tabular-nums text-white/45">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="对话" aria-pressed={assistantOpen} className={cn("grid size-8 place-items-center rounded-[8px] text-white/62 hover:bg-white/10", assistantOpen && "bg-white/10 text-white")} onClick={onAssistant}>
        <IconBubble5 className="size-4" />
      </button>
    </div>
  );
}

function CanvasToolbar({
  tool,
  canUndo,
  canRedo,
  onTool,
  onAdd,
  onUpload,
  onUndo,
  onRedo,
}: {
  tool: Tool;
  canUndo: boolean;
  canRedo: boolean;
  onTool: (tool: Tool) => void;
  onAdd: (kind: CanvasNodeKind) => void;
  onUpload: () => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-[16px] border border-white/10 bg-[#1b1b1b]/94 p-1.5 shadow-2xl backdrop-blur">
      <ToolButton label="选择" active={tool === "select"} onClick={() => onTool("select")}><IconCursor1 className="size-4" /></ToolButton>
      <ToolButton label="抓手" active={tool === "pan"} onClick={() => onTool("pan")}><IconPan className="size-4" /></ToolButton>
      <span className="mx-1 h-5 w-px bg-white/10" />
      <ToolButton label="文字" onClick={() => onAdd("text")}><IconText2 className="size-4" /></ToolButton>
      <ToolButton label="图片" onClick={() => onAdd("image")}><IconImages2 className="size-4" /></ToolButton>
      <ToolButton label="上传" onClick={onUpload}><IconCloudUpload className="size-4" /></ToolButton>
      <span className="mx-1 h-5 w-px bg-white/10" />
      <ToolButton label="撤销" disabled={!canUndo} onClick={onUndo}><IconArrowCornerUpLeft className="size-4" /></ToolButton>
      <ToolButton label="重做" disabled={!canRedo} onClick={onRedo}><IconArrowCornerDownRight className="size-4" /></ToolButton>
    </div>
  );
}

function ToolButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} className={cn("flex h-9 items-center gap-1.5 rounded-[12px] px-2.5 text-xs text-white/72 hover:bg-white/10 disabled:opacity-35", active && "bg-white/12 text-white")} onClick={onClick}>
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function ZoomControl({ zoom, onZoomOut, onZoomIn, onFit }: { zoom: number; onZoomOut: () => void; onZoomIn: () => void; onFit: () => void }) {
  return (
    <div className="absolute bottom-5 left-4 z-20 flex items-center gap-1 rounded-[16px] border border-white/10 bg-[#1b1b1b]/94 p-1 shadow-lg">
      <ToolButton label="缩小" onClick={onZoomOut}><IconFocusZoomOut className="size-4" /></ToolButton>
      <span className="w-12 text-center text-xs text-white/70">{Math.round(zoom * 100)}%</span>
      <ToolButton label="放大" onClick={onZoomIn}><IconFocusZoomIn className="size-4" /></ToolButton>
      <ToolButton label="适应" onClick={onFit}><IconHand5Finger className="size-4" /></ToolButton>
    </div>
  );
}

function Inspector({
  node,
  config,
  onChange,
  onDelete,
  onDuplicate,
}: {
  node: CanvasNode;
  config: AppConfig;
  onChange: (patch: Partial<CanvasNode>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const ratios = canvasRatioOptions(config);
  const qualities = qualityTiersForModel(config.model || DEFAULT_IMAGE_MODEL);
  return (
    <aside className="absolute right-4 top-4 z-20 w-64 rounded-[16px] border border-white/10 bg-[#1b1b1b]/94 p-3 shadow-2xl backdrop-blur">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-white/88">节点</p>
        <div className="flex gap-1">
          <button type="button" aria-label="复制节点" className="rounded-[8px] px-2 py-1 text-xs text-white/60 hover:bg-white/10" onClick={onDuplicate}>复制</button>
          <button type="button" aria-label="删除节点" className="rounded-[8px] p-1 text-white/60 hover:bg-white/10" onClick={onDelete}><IconTrashCan className="size-3.5" /></button>
        </div>
      </div>
      {node.kind !== "upload" && (
        <div className="space-y-2">
          <Field label="比例">
            <select aria-label="比例" className="canvas-select" value={node.aspectRatio} onChange={(event) => onChange({ aspectRatio: event.target.value })}>
              {ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
            </select>
          </Field>
          <Field label="清晰度">
            <select aria-label="清晰度" className="canvas-select" value={node.resolution} onChange={(event) => onChange({ resolution: event.target.value })}>
              {RESOLUTION_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </Field>
          <Field label="质量">
            <select aria-label="质量" className="canvas-select" value={node.quality} onChange={(event) => onChange({ quality: event.target.value })}>
              {qualities.map((item) => <option key={item} value={item}>{QUALITY_LABELS[item] ?? item}</option>)}
            </select>
          </Field>
          <Field label="数量">
            <input aria-label="数量" className="canvas-select" type="number" min={1} max={4} value={node.quantity} onChange={(event) => onChange({ quantity: clampQuantity(event.target.value) })} />
          </Field>
          <p className="pt-1 text-xs text-white/38">{imageModelLabel(config.model || DEFAULT_IMAGE_MODEL)}</p>
        </div>
      )}
      {node.kind === "upload" && <p className="text-xs leading-5 text-white/48">上传节点作为参考图。把它的输出连到图片节点后，生成时会带上这张图。</p>}
    </aside>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-white/55">
      <span>{label}</span>
      {children}
    </label>
  );
}

function CanvasMenu({
  menu,
  canChain,
  onAdd,
  onUpload,
  onClose,
}: {
  menu: NonNullable<MenuState>;
  canChain: boolean;
  onAdd: (kind: CanvasNodeKind, point: CanvasPoint) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed z-30 min-w-40 rounded-[12px] border border-white/10 bg-[#202020] p-1 shadow-2xl" style={{ left: menu.x, top: menu.y }}>
      <MenuItem label={canChain ? "连接到文字" : "文字节点"} onClick={() => onAdd("text", menu.canvas)} />
      <MenuItem label={canChain ? "连接到图片" : "图片节点"} onClick={() => onAdd("image", menu.canvas)} />
      {!canChain && <MenuItem label="上传图片" onClick={onUpload} />}
      <MenuItem label="关闭" onClick={onClose} />
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="block w-full rounded-[8px] px-3 py-2 text-left text-sm text-white/82 hover:bg-white/10" onClick={onClick}>{label}</button>;
}

function readCanvasLibrary(): CanvasLibrary {
  if (typeof window === "undefined") {
    const document = emptyCanvasDocument();
    return { activeId: "canvas_1", canvases: [{ id: "canvas_1", document }] };
  }
  const stored = parseCanvasLibrary(window.localStorage.getItem(STORAGE_KEY));
  if (stored) return stored;
  const legacy = parseCanvasDocument(window.localStorage.getItem(LEGACY_STORAGE_KEY)) ?? emptyCanvasDocument();
  return { activeId: "canvas_1", canvases: [{ id: "canvas_1", document: legacy }] };
}

function parseCanvasLibrary(value: string | null): CanvasLibrary | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CanvasLibrary>;
    const canvases = (parsed.canvases ?? []).flatMap((item) => {
      const document = parseCanvasDocument(JSON.stringify(item.document));
      return document && item.id ? [{ id: item.id, document }] : [];
    });
    if (canvases.length === 0) return null;
    return { activeId: canvases.some((item) => item.id === parsed.activeId) ? parsed.activeId! : canvases[0].id, canvases };
  } catch {
    return null;
  }
}

function readStoredCanvas(): CanvasDocument {
  if (typeof window === "undefined") return emptyCanvasDocument();
  return parseCanvasDocument(window.localStorage.getItem(STORAGE_KEY)) ?? emptyCanvasDocument();
}

function localPoint(event: { clientX: number; clientY: number }, surface: HTMLElement | null): CanvasPoint {
  return clientToLocal(event, surface);
}

function clientToLocal(event: { clientX: number; clientY: number }, surface: HTMLElement | null): CanvasPoint {
  const bounds = surface?.getBoundingClientRect();
  return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) };
}

function pointInsideNode(point: CanvasPoint, node: CanvasNode): boolean {
  return point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height;
}

function rectStyle(rect: CanvasRect): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

function normalizeDisplayedRect(rect: CanvasRect): CanvasRect {
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

function statusLabel(status: CanvasNode["status"]): string {
  if (status === "queued" || status === "running") return "生成中";
  if (status === "succeeded") return "完成";
  if (status === "failed") return "失败";
  return "";
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

function clampQuantity(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(4, Math.max(1, Math.round(parsed)));
}

async function canvasGenerationBody(
  form: Record<string, string | number>,
  references: CanvasNode[],
  mask: { file: File; name: string } | null,
): Promise<BodyInit> {
  const files = (await Promise.all(references.map(nodeToReferenceFile))).filter((file): file is File => Boolean(file)).slice(0, 6);
  if (files.length === 0 && !mask) return JSON.stringify(form);
  const body = new FormData();
  Object.entries(form).forEach(([key, value]) => body.set(key, String(value)));
  files.forEach((file) => body.append("referenceImage", file, file.name));
  if (mask) body.set("maskImage", mask.file, mask.name);
  return body;
}

async function nodeToReferenceFile(node: CanvasNode): Promise<File | null> {
  if (!node.imageUrl) return null;
  if (node.imageUrl.startsWith("blob:")) {
    const response = await fetch(node.imageUrl);
    const blob = await response.blob();
    return new File([blob], node.imageName || "reference.png", { type: blob.type || "image/png" });
  }
  const response = await fetch(node.imageUrl);
  const blob = await response.blob();
  return new File([blob], node.imageName || "reference.png", { type: blob.type || "image/png" });
}

function applyGenerationResults(
  document: CanvasDocument,
  results: Array<{ nodeId: string; job: GenerationJob; images: ImageItem[] }>,
): CanvasDocument {
  if (results.length === 0) return document;
  let changed = false;
  const nodes = document.nodes.map((node) => {
    const result = results.find((item) => item.nodeId === node.id);
    if (!result) return node;
    const image = result.images[0];
    const status = generationStatus(result.job.status);
    const imageSize = image && image.width > 0 && image.height > 0
      ? cardSizeForImage(image.width, image.height)
      : null;
    const jobSize = result.job.width > 0 && result.job.height > 0
      ? cardSizeForImage(result.job.width, result.job.height)
      : null;
    const selectedSize = cardSizeForRatio(node.aspectRatio, node.resolution);
    const resolvedSize = imageSize && matchesCardRatio(imageSize, selectedSize)
      ? imageSize
      : jobSize && matchesCardRatio(jobSize, selectedSize)
        ? jobSize
        : selectedSize;
    const next = {
      ...node,
      status,
      progressLabel: status === "queued" || status === "running" ? canvasProgressLabel(result.job) : undefined,
      imageUrl: image?.url ?? node.imageUrl,
      sourceImageId: image?.id ?? node.sourceImageId,
      aspectRatio: node.aspectRatio,
      error: result.job.error_message ?? undefined,
      width: resolvedSize.width,
      height: resolvedSize.height,
    };
    if (JSON.stringify(next) !== JSON.stringify(node)) changed = true;
    return next;
  });
  return changed ? { ...document, nodes } : document;
}

function matchesCardRatio(actual: { width: number; height: number }, expected: { width: number; height: number }): boolean {
  if (actual.width <= 0 || actual.height <= 0 || expected.width <= 0 || expected.height <= 0) return false;
  const actualRatio = actual.width / actual.height;
  const expectedRatio = expected.width / expected.height;
  return Math.abs(actualRatio - expectedRatio) / expectedRatio < 0.04;
}

function canvasProgressLabel(job: GenerationJob): string {
  if (job.error_message) {
    const message = /^fetch failed$/i.test(job.error_message.trim()) ? "网络连接中断" : job.error_message;
    return `上游暂时失败，正在重试：${message}`;
  }
  const stage = job.stage ?? (job.status === "queued" ? "queued" : "waiting_provider");
  const stageText = {
    queued: "排队",
    submitting: "提交中",
    waiting_provider: "生成中",
    saving: "保存中",
    completed: "完成",
    failed: "失败",
    cancelled: "已取消",
  }[stage];
  return `${stageText} · ${generationProgressSummary(job)}`;
}

function generationStatus(status: GenerationJob["status"]): CanvasNode["status"] {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "succeeded" || status === "partial_succeeded") return "succeeded";
  if (status === "failed" || status === "cancelled") return "failed";
  return "idle";
}

export function canvasStorageKey() {
  return STORAGE_KEY;
}
