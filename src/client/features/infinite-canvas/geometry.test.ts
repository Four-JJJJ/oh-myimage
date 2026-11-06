import { describe, expect, it } from "vitest";
import { RATIO_OPTIONS } from "../../../image-models";
import {
  alignDraggedNodes,
  canvasRatioOptions,
  canConnect,
  connectNodes,
  cardSizeForImage,
  cardSizeForRatio,
  createCanvasNode,
  duplicateNodes,
  emptyCanvasDocument,
  fitViewport,
  nodesInsideRect,
  parseCanvasDocument,
  placeLinkedNode,
  promptForNode,
  referenceSourcesForNode,
  removeNodes,
  screenToCanvas,
  zoomViewportAt,
} from "./geometry";

describe("infinite canvas geometry", () => {
  it("keeps the point under the cursor fixed while zooming", () => {
    const viewport = zoomViewportAt({ x: 40, y: 20, zoom: 1 }, { x: 140, y: 120 }, 2);
    expect(screenToCanvas({ x: 140, y: 120 }, viewport)).toEqual({ x: 100, y: 100 });
    expect(viewport.zoom).toBe(2);
  });

  it("selects every node touched by a marquee, including a reverse drag", () => {
    const nodes = [
      createCanvasNode("text", { x: 0, y: 0 }, "a"),
      createCanvasNode("image", { x: 400, y: 40 }, "b"),
    ];
    expect(nodesInsideRect(nodes, { x: 500, y: 300, width: -180, height: -80 })).toEqual(["b"]);
  });

  it("rejects a connection that would cycle and accepts a usable upstream link", () => {
    const nodes = [
      createCanvasNode("text", { x: 0, y: 0 }, "prompt"),
      createCanvasNode("image", { x: 360, y: 0 }, "picture"),
    ];
    const edges = connectNodes(nodes, [], "prompt", "picture", "edge-1");
    expect(edges).toHaveLength(1);
    expect(canConnect(nodes, edges, "picture", "prompt")).toBe(false);
    expect(canConnect(nodes, edges, "prompt", "picture")).toBe(false);
  });

  it("builds a prompt from the node and its text upstreams", () => {
    const text = { ...createCanvasNode("text", { x: 0, y: 0 }, "text"), text: "雾气森林" };
    const image = { ...createCanvasNode("image", { x: 360, y: 0 }, "image"), text: "电影感" };
    const edges = connectNodes([text, image], [], "text", "image", "edge");
    expect(promptForNode([text, image], edges, "image")).toBe("电影感\n\n雾气森林");

    const source = { ...createCanvasNode("image", { x: 0, y: 240 }, "source"), text: "马尔代夫泻湖遇上了一群manta；浮潜视" };
    const next = createCanvasNode("image", { x: 360, y: 240 }, "next");
    const linked = connectNodes([source, next], [], "source", "next", "image-edge");
    expect(promptForNode([source, next], linked, "next")).toBe("");
  });

  it("shows guides and snaps to center, horizontal, top, and bottom alignment", () => {
    const target = { ...createCanvasNode("image", { x: 0, y: 0 }, "target"), width: 200, height: 100 };
    const moving = { ...createCanvasNode("image", { x: 46, y: 8 }, "moving"), width: 100, height: 80 };
    const center = alignDraggedNodes([target, moving], ["moving"], 8);
    expect(center.nodes.find((node) => node.id === "moving")).toMatchObject({ x: 50, y: 10 });
    expect(center.guides.map((guide) => guide.orientation).sort()).toEqual(["horizontal", "vertical"]);

    const top = alignDraggedNodes([target, { ...moving, x: 400, y: 4 }], ["moving"], 8);
    expect(top.nodes.find((node) => node.id === "moving")?.y).toBe(0);
    const bottom = alignDraggedNodes([target, { ...moving, x: 400, y: 24 }], ["moving"], 8);
    expect(bottom.nodes.find((node) => node.id === "moving")?.y).toBe(20);
  });

  it("places a linked card at a fixed gap on either side", () => {
    const source = { ...createCanvasNode("image", { x: 100, y: 80 }, "source"), width: 280, height: 180 };
    const next = { ...createCanvasNode("image", { x: 0, y: 0 }, "next"), width: 280, height: 120 };
    expect(placeLinkedNode(source, next, "right", 96)).toMatchObject({ x: 476, y: 110 });
    expect(placeLinkedNode(source, next, "left", 96)).toMatchObject({ x: -276, y: 110 });
  });

  it("keeps only upstream images that already have a picture", () => {
    const upload = { ...createCanvasNode("upload", { x: 0, y: 0 }, "upload"), imageUrl: "blob:ref" };
    const empty = createCanvasNode("image", { x: 0, y: 240 }, "empty");
    const target = createCanvasNode("image", { x: 360, y: 80 }, "target");
    const nodes = [upload, empty, target];
    const edges = [
      ...connectNodes(nodes, [], "upload", "target", "a"),
      ...connectNodes(nodes, [], "empty", "target", "b"),
    ];
    expect(referenceSourcesForNode(nodes, edges, "target").map((node) => node.id)).toEqual(["upload"]);
  });

  it("duplicates a connected selection without sharing ids or jobs", () => {
    const first = createCanvasNode("text", { x: 10, y: 10 }, "first");
    const second = { ...createCanvasNode("image", { x: 320, y: 10 }, "second"), jobId: "job_1", status: "succeeded" as const };
    const document = {
      ...emptyCanvasDocument(),
      nodes: [first, second],
      edges: connectNodes([first, second], [], "first", "second", "edge"),
    };
    const ids = ["copy-a", "copy-b", "copy-edge"];
    const duplicated = duplicateNodes(document, ["first", "second"], () => ids.shift() ?? "missing");
    expect(duplicated.nodes.map((node) => node.id)).toEqual(["first", "second", "copy-a", "copy-b"]);
    expect(duplicated.edges.at(-1)).toEqual({ id: "copy-edge", from: "copy-a", to: "copy-b" });
    expect(duplicated.nodes.at(-1)?.jobId).toBeUndefined();
    expect(removeNodes(duplicated, ["copy-a"]).edges.some((edge) => edge.id === "copy-edge")).toBe(false);
  });

  it("restores a saved document and drops dangling edges", () => {
    const raw = JSON.stringify({
      name: "分镜",
      nodes: [createCanvasNode("text", { x: 1, y: 2 }, "kept")],
      edges: [{ id: "gone", from: "kept", to: "missing" }],
      viewport: { x: 3, y: 4, zoom: 9 },
    });
    const parsed = parseCanvasDocument(raw);
    expect(parsed?.name).toBe("分镜");
    expect(parsed?.edges).toEqual([]);
    expect(parsed?.viewport.zoom).toBeLessThanOrEqual(2.4);
    expect(parseCanvasDocument("not-json")).toBeNull();
  });

  it("frames every node inside the visible canvas", () => {
    const nodes = [
      createCanvasNode("text", { x: 0, y: 0 }, "a"),
      createCanvasNode("image", { x: 600, y: 300 }, "b"),
    ];
    const viewport = fitViewport(nodes, { width: 1000, height: 700 });
    expect(viewport.zoom).toBeGreaterThan(0.2);
    expect(viewport.zoom).toBeLessThanOrEqual(1);
  });

  it("keeps a 16:9 image card wide instead of padding it into a square", () => {
    expect(cardSizeForRatio("16:9", "1K")).toEqual({ width: 420, height: 236 });
    expect(cardSizeForImage(1536, 864)).toEqual({ width: 420, height: 236 });
    expect(cardSizeForRatio("9:16", "1K").height).toBeGreaterThan(cardSizeForRatio("9:16", "1K").width);
    for (const ratio of ["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1", "21:9", "5:4"]) {
      const [width, height] = ratio.split(":").map(Number);
      const card = cardSizeForRatio(ratio);
      expect(card.width / card.height).toBeCloseTo(width / height, 2);
      expect(Math.max(card.width, card.height)).toBe(420);
    }
  });

  it("keeps the composer-only custom ratio out of canvas node options", () => {
    expect(canvasRatioOptions({ ratios: ["16:9", "9:16", "custom"] })).toEqual(["16:9", "9:16"]);
    expect(canvasRatioOptions({ ratios: ["custom"] })).toEqual([...RATIO_OPTIONS]);
    expect(canvasRatioOptions({ ratios: [] })).toEqual([...RATIO_OPTIONS]);
  });
});
