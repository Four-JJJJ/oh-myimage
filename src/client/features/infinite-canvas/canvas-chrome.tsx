import { IconImages2 } from "./central-icons/IconImages2";
import type { CSSProperties, RefObject } from "react";
import { cn } from "../../lib/utils";
import type { CanvasEdge, CanvasNode, CanvasNodeKind, CanvasViewport } from "./geometry";
import { edgePath, inputPort, outputPort } from "./geometry";

export function AssetRail({
  open,
  nodes,
  selectedIds,
  onToggle,
  onFocus,
}: {
  open: boolean;
  nodes: CanvasNode[];
  selectedIds: string[];
  onToggle: () => void;
  onFocus: (id: string) => void;
}) {
  const assets = nodes.filter((node) => node.imageUrl || node.text.trim());
  return (
    <aside className={cn("z-20 flex h-full shrink-0 flex-col border-r border-white/10 bg-[#121212]", open ? "w-56" : "w-12")}>
      <button type="button" aria-label={open ? "收起素材" : "展开素材"} className="flex h-12 items-center gap-2 px-3 text-sm text-white/72" onClick={onToggle}>
        <IconImages2 className="size-4 shrink-0" />
        {open && <span>素材</span>}
      </button>
      {open && (
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {assets.length === 0 && <p className="px-2 py-3 text-xs leading-5 text-white/38">生成或上传后，图片会出现在这里。</p>}
          {assets.map((node) => (
            <button key={node.id} type="button" className={cn("flex w-full items-center gap-2 rounded-[12px] px-2 py-2 text-left hover:bg-white/8", selectedIds.includes(node.id) && "bg-white/10")} onClick={() => onFocus(node.id)}>
              {node.imageUrl ? <img src={node.imageUrl} alt="" className="size-10 rounded-[8px] object-cover" /> : <span className="grid size-10 place-items-center rounded-[8px] bg-white/8 text-xs text-white/55">文</span>}
              <span className="min-w-0">
                <span className="block truncate text-xs text-white/82">{node.text.trim() || nodeLabel(node.kind)}</span>
                <span className="block text-[11px] text-white/38">{nodeLabel(node.kind)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

export function AssistantRail({
  open,
  draft,
  onDraft,
  onPlace,
  onClose,
}: {
  open: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onPlace: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <aside className="z-20 flex h-full w-72 shrink-0 flex-col border-l border-white/10 bg-[#121212]">
      <div className="flex h-12 items-center justify-between px-4">
        <p className="text-sm text-white/84">对话</p>
        <button type="button" aria-label="关闭对话" className="text-xs text-white/48 hover:text-white" onClick={onClose}>关闭</button>
      </div>
      <div className="min-h-0 flex-1 px-4">
        <p className="text-sm leading-6 text-white/48">写一段想法，确认后会变成画布上的文字节点。</p>
      </div>
      <form className="border-t border-white/10 p-3" onSubmit={(event) => { event.preventDefault(); onPlace(); }}>
        <textarea aria-label="对话内容" value={draft} placeholder="描述想放上画布的内容" className="h-24 w-full resize-none rounded-[12px] border border-white/10 bg-white/[0.04] px-3 py-2 text-sm leading-6 text-white outline-none placeholder:text-white/28" onChange={(event) => onDraft(event.target.value)} />
        <button type="submit" className="mt-2 h-9 w-full rounded-[12px] bg-white text-sm font-medium text-black disabled:opacity-40" disabled={!draft.trim()}>添加文字节点</button>
      </form>
    </aside>
  );
}

export function MiniMap({ nodes, viewport, onFocus }: { nodes: CanvasNode[]; viewport: CanvasViewport; onFocus: () => void }) {
  if (nodes.length === 0) return null;
  const bounds = nodes.reduce((box, node) => ({
    left: Math.min(box.left, node.x),
    top: Math.min(box.top, node.y),
    right: Math.max(box.right, node.x + node.width),
    bottom: Math.max(box.bottom, node.y + node.height),
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const scale = Math.min(132 / Math.max(1, bounds.right - bounds.left), 78 / Math.max(1, bounds.bottom - bounds.top));
  return (
    <button type="button" aria-label="小地图" className="absolute bottom-5 right-4 z-20 h-24 w-40 overflow-hidden rounded-[16px] border border-white/10 bg-[#1b1b1b]/90" onClick={onFocus}>
      {nodes.map((node) => (
        <span key={node.id} className="absolute rounded-[6px] bg-white/60" style={{ left: 8 + (node.x - bounds.left) * scale, top: 8 + (node.y - bounds.top) * scale, width: Math.max(4, node.width * scale), height: Math.max(3, node.height * scale) }} />
      ))}
      <span className="sr-only">{Math.round(viewport.zoom * 100)}%</span>
    </button>
  );
}

export function worldStyle(viewport: CanvasViewport): CSSProperties {
  return { transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`, transformOrigin: "0 0" };
}

export function dotGridStyle(viewport: CanvasViewport): CSSProperties {
  return {
    backgroundImage: "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1px)",
    backgroundSize: `${22 * viewport.zoom}px ${22 * viewport.zoom}px`,
    backgroundPosition: `${viewport.x}px ${viewport.y}px`,
  };
}

export function paintWorld(world: HTMLDivElement | null, surface: HTMLDivElement | null, viewport: CanvasViewport) {
  if (world) {
    const style = worldStyle(viewport);
    world.style.transform = String(style.transform);
    world.style.transformOrigin = "0 0";
  }
  if (surface) {
    const style = dotGridStyle(viewport);
    surface.style.backgroundImage = String(style.backgroundImage);
    surface.style.backgroundSize = String(style.backgroundSize);
    surface.style.backgroundPosition = String(style.backgroundPosition);
  }
}

export function paintDraggedNodes(world: HTMLDivElement | null, nodes: CanvasNode[], edges: CanvasEdge[], ids: readonly string[]) {
  if (!world) return;
  const moved = new Set(ids);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (!moved.has(node.id)) continue;
    const element = world.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`);
    if (!element) continue;
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
  }
  for (const edge of edges) {
    if (!moved.has(edge.from) && !moved.has(edge.to)) continue;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const path = world.querySelector<SVGPathElement>(`[data-edge-id="${CSS.escape(edge.id)}"]`);
    if (!from || !to || !path) continue;
    path.setAttribute("d", edgePath(outputPort(from), inputPort(to)));
  }
}

function nodeLabel(kind: CanvasNodeKind) {
  if (kind === "text") return "文字";
  if (kind === "upload") return "上传";
  return "图片";
}

export type CanvasFrameRef = RefObject<HTMLDivElement | null>;
