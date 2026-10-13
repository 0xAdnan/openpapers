import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from 'd3-force';
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import type { GraphCanvasProps } from '../../shared/types.ts';
import './graph.css';

interface LayoutNode extends SimulationNodeDatum {
  id: string;
  radius: number;
  label: string;
  x: number;
  y: number;
}

interface LayoutEdge extends SimulationLinkDatum<LayoutNode> {
  source: LayoutNode;
  target: LayoutNode;
  weight: number;
  key: number;
}

interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  node?: LayoutNode;
  offsetX: number;
  offsetY: number;
}

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 5;
const numberFormat = new Intl.NumberFormat();

function fitCamera(layout: Layout, size: { width: number; height: number }): Camera {
  if (!layout.nodes.length) return { x: size.width / 2, y: size.height / 2, scale: 1 };
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const node of layout.nodes) {
    const halfWidth = Math.max(node.radius + 7, node.label.length * 3.2);
    left = Math.min(left, node.x - halfWidth);
    right = Math.max(right, node.x + halfWidth);
    top = Math.min(top, node.y - node.radius - 22);
    bottom = Math.max(bottom, node.y + node.radius + 7);
  }
  // Reserve real space for the selection strip, controls, and year legend.
  const scale = Math.max(MIN_ZOOM, Math.min(1.4,
    Math.max(1, size.width - 48) / Math.max(1, right - left),
    Math.max(1, size.height - 152) / Math.max(1, bottom - top),
  ));
  return {
    x: size.width / 2 - (left + right) / 2 * scale,
    y: 76 + (size.height - 152) / 2 - (top + bottom) / 2 * scale,
    scale,
  };
}

export default function GraphCanvas({ nodes, edges, selectedId, onSelect, onOpen, onHover }: GraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<Simulation<LayoutNode, LayoutEdge> | null>(null);
  const layoutRef = useRef<Layout>({ nodes: [], edges: [] });
  const sizeRef = useRef({ width: 720, height: 600 });
  const cameraRef = useRef<Camera>({ x: 360, y: 300, scale: 1 });
  const autoFitRef = useRef(true);
  const gestureRef = useRef<Gesture | null>(null);
  const suppressClickRef = useRef(false);
  const [layout, setLayout] = useState<Layout>(layoutRef.current);
  const [size, setSize] = useState(sizeRef.current);
  const [camera, setCamera] = useState(cameraRef.current);
  const [helpOpen, setHelpOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const helpId = useId();
  const yearGradientId = useId();

  const papers = new Map(nodes.map((node) => [node.id, node]));
  const selected = papers.get(selectedId);
  // The origin is selected by default; only fade the rest once the reader picks another paper.
  const focusing = !!selected && !selected.isOrigin;
  const years = nodes.flatMap((node) => node.year === null ? [] : [node.year]);
  const firstYear = years.length ? Math.min(...years) : null;
  const lastYear = years.length ? Math.max(...years) : null;

  // Canonical layout inputs avoid re-simulation on selection or new array identities.
  const layoutKey = JSON.stringify({
    nodes: nodes.map((node) => ({
      id: node.id,
      citations: Number.isFinite(node.citations) ? Math.max(0, node.citations) : 0,
      label: `${node.authors[0]?.trim().split(/\s+/).at(-1) || 'Unknown'}, ${node.year ?? 'n.d.'}`,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.map((edge) => ({
      source: edge.source < edge.target ? edge.source : edge.target,
      target: edge.source < edge.target ? edge.target : edge.source,
      weight: Number.isFinite(edge.weight) ? Math.max(0, edge.weight) : 0,
    })).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.weight - b.weight),
  });

  useEffect(() => {
    const input = JSON.parse(layoutKey) as {
      nodes: { id: string; citations: number; label: string }[];
      edges: { source: string; target: string; weight: number }[];
    };
    const maxCitations = Math.max(1, ...input.nodes.map((node) => node.citations));
    const nextNodes: LayoutNode[] = input.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      radius: 7 + 23 * Math.log1p(node.citations) / Math.log1p(maxCitations),
      // d3 replaces NaN with deterministic phyllotaxis positions.
      x: NaN,
      y: NaN,
    }));
    const byId = new Map(nextNodes.map((node) => [node.id, node]));
    const nextEdges: LayoutEdge[] = [];
    for (const edge of input.edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (source && target && source !== target) {
        nextEdges.push({ source, target, weight: edge.weight, key: nextEdges.length });
      }
    }
    const maxWeight = Math.max(0.001, ...nextEdges.map((edge) => edge.weight));
    // d3-force's default random source is seeded. Sorted inputs make reloads reproducible.
    // Strong links pull hard and short; weak links are long and slack, so similar papers
    // cluster and weakly related ones drift outward. Collision only prevents disc overlap:
    // reserving label width spreads nodes evenly and hides the similarity structure.
    const simulation = forceSimulation<LayoutNode>(nextNodes)
      .force('link', forceLink<LayoutNode, LayoutEdge>(nextEdges)
        .id((node) => node.id)
        .distance((edge) => edge.source.radius + edge.target.radius + 15 + 60 * (1 - edge.weight / maxWeight))
        .strength((edge) => (edge.weight / maxWeight) ** 2))
      .force('charge', forceManyBody<LayoutNode>().strength(-120))
      .force('center', forceCenter(0, 0))
      .force('collision', forceCollide<LayoutNode>()
        .radius((node) => node.radius + 3)
        .iterations(4))
      .stop();
    simulation.tick(280);
    const nextLayout = { nodes: nextNodes, edges: nextEdges };
    layoutRef.current = nextLayout;
    simulationRef.current = simulation;
    gestureRef.current = null;
    setDragging(false);
    setLayout(nextLayout);
    autoFitRef.current = true;
    const fitted = fitCamera(nextLayout, sizeRef.current);
    cameraRef.current = fitted;
    setCamera(fitted);
    simulation.on('tick', () => setLayout({ ...layoutRef.current }));
    return () => {
      simulation.stop();
      simulation.on('tick', null);
      simulationRef.current = null;
    };
  }, [layoutKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
      const nextSize = { width: entry.contentRect.width, height: entry.contentRect.height };
      const previousSize = sizeRef.current;
      sizeRef.current = nextSize;
      setSize(nextSize);
      const nextCamera = autoFitRef.current ? fitCamera(layoutRef.current, nextSize) : {
        ...cameraRef.current,
        x: cameraRef.current.x + (nextSize.width - previousSize.width) / 2,
        y: cameraRef.current.y + (nextSize.height - previousSize.height) / 2,
      };
      cameraRef.current = nextCamera;
      setCamera(nextCamera);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // React's wheel listener is passive; a native listener is needed to prevent page scroll.
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = svg.getBoundingClientRect();
      const x = (event.clientX - bounds.left) * sizeRef.current.width / bounds.width;
      const y = (event.clientY - bounds.top) * sizeRef.current.height / bounds.height;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? sizeRef.current.height : 1);
      const current = cameraRef.current;
      const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002)));
      const ratio = scale / current.scale;
      const nextCamera = { x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio, scale };
      autoFitRef.current = false;
      cameraRef.current = nextCamera;
      setCamera(nextCamera);
    };
    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    if (!helpOpen) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !helpRef.current?.contains(event.target) && !helpButtonRef.current?.contains(event.target)) {
        setHelpOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHelpOpen(false);
        helpButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [helpOpen]);

  const adjacency = new Map(layout.nodes.map((node) => [node.id, [] as { id: string; edge: LayoutEdge }[]]));
  for (const edge of layout.edges) {
    adjacency.get(edge.source.id)?.push({ id: edge.target.id, edge });
    adjacency.get(edge.target.id)?.push({ id: edge.source.id, edge });
  }
  const neighbors = new Set(adjacency.get(selectedId)?.map((neighbor) => neighbor.id));
  const pathNodes = new Set<string>();
  const pathEdges = new Set<number>();
  let nearestOrigin: string | undefined;
  if (selected && adjacency.has(selectedId)) {
    // Undirected Dijkstra: cost = inverse normalized similarity (floor 0.001).
    // This prefers strong similarity routes, not necessarily the fewest hops.
    const maxWeight = Math.max(0.001, ...layout.edges.map((edge) => edge.weight));
    const distances = new Map([[selectedId, 0]]);
    const previous = new Map<string, { id: string; edge: number }>();
    const remaining = new Set(adjacency.keys());
    while (remaining.size) {
      let current: string | undefined;
      let best = Infinity;
      for (const id of remaining) {
        const distance = distances.get(id) ?? Infinity;
        if (distance < best) { current = id; best = distance; }
      }
      if (current === undefined) break;
      remaining.delete(current);
      if (papers.get(current)?.isOrigin) { nearestOrigin = current; break; }
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!remaining.has(neighbor.id)) continue;
        const distance = best + 1 / Math.max(0.001, neighbor.edge.weight / maxWeight);
        if (distance < (distances.get(neighbor.id) ?? Infinity)) {
          distances.set(neighbor.id, distance);
          previous.set(neighbor.id, { id: current, edge: neighbor.edge.key });
        }
      }
    }
    let current = nearestOrigin;
    while (current !== undefined) {
      pathNodes.add(current);
      const step = previous.get(current);
      if (!step) break;
      pathEdges.add(step.edge);
      current = step.id;
    }
  }

  function zoom(factor: number) {
    const current = cameraRef.current;
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.scale * factor));
    const ratio = scale / current.scale;
    const nextCamera = {
      x: size.width / 2 - (size.width / 2 - current.x) * ratio,
      y: size.height / 2 - (size.height / 2 - current.y) * ratio,
      scale,
    };
    autoFitRef.current = false;
    cameraRef.current = nextCamera;
    setCamera(nextCamera);
  }

  function pointerPoint(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * sizeRef.current.width / bounds.width,
      y: (event.clientY - bounds.top) * sizeRef.current.height / bounds.height,
    };
  }

  function startGesture(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || gestureRef.current) return;
    const target = event.target instanceof Element ? event.target.closest('[data-paper-id]') : null;
    const node = layoutRef.current.nodes.find((item) => item.id === target?.getAttribute('data-paper-id'));
    const point = pointerPoint(event);
    const current = cameraRef.current;
    suppressClickRef.current = false;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: point.x,
      lastY: point.y,
      moved: false,
      node,
      offsetX: node ? (point.x - current.x) / current.scale - node.x : 0,
      offsetY: node ? (point.y - current.y) / current.scale - node.y : 0,
    };
    // Capture on the node itself so clicks/double-clicks still target its button group.
    (target ?? event.currentTarget).setPointerCapture(event.pointerId);
  }

  function moveGesture(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = pointerPoint(event);
    if (!gesture.moved && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 4) return;
    if (!gesture.moved) {
      gesture.moved = true;
      suppressClickRef.current = true;
      autoFitRef.current = false;
      setDragging(true);
      if (gesture.node) simulationRef.current?.alphaTarget(0.15).restart();
    }
    const current = cameraRef.current;
    if (gesture.node) {
      const node = gesture.node;
      node.fx = node.x = (point.x - current.x) / current.scale - gesture.offsetX;
      node.fy = node.y = (point.y - current.y) / current.scale - gesture.offsetY;
      setLayout({ ...layoutRef.current });
    } else {
      const nextCamera = { ...current, x: current.x + point.x - gesture.lastX, y: current.y + point.y - gesture.lastY };
      cameraRef.current = nextCamera;
      setCamera(nextCamera);
    }
    gesture.lastX = point.x;
    gesture.lastY = point.y;
  }

  function endGesture(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.node && gesture.moved) {
      gesture.node.fx = null;
      gesture.node.fy = null;
      simulationRef.current?.alphaTarget(0);
    }
    gestureRef.current = null;
    setDragging(false);
    if (event.target instanceof Element && event.target.hasPointerCapture(event.pointerId)) {
      event.target.releasePointerCapture(event.pointerId);
    }
  }

  const maxWeight = Math.max(0.001, ...layout.edges.map((edge) => edge.weight));
  const pathDescription = !selected ? 'Select a paper to explore its connections.'
    : selected.isOrigin ? 'Origin paper selected.'
    : nearestOrigin ? `${pathEdges.size} similarity ${pathEdges.size === 1 ? 'step' : 'steps'} to the nearest origin.`
    : 'No similarity path to an origin in this graph.';

  return (
    <div className="graph-canvas" ref={hostRef} role="region" aria-label="Paper similarity graph" aria-describedby={descriptionId}>
      <p className="graph-sr-only" id={descriptionId}>
        Interactive similarity map, not a citation tree. Each node is a paper; size shows citations,
        teal shade shows publication year, and magenta rings mark origins. Use the papers list for a
        text alternative. Tab to a node and press Enter or Space to select; Shift+Enter opens a graph
        with that paper as origin. Drag a node to move it, drag empty space to pan, and use the zoom controls.
      </p>
      <svg
        ref={svgRef}
        className={`graph-svg${dragging ? ' graph-svg--dragging' : ''}${camera.scale < 0.65 ? ' graph-svg--overview' : ''}`}
        viewBox={`0 0 ${size.width} ${size.height}`}
        role="group"
        aria-label={`${nodes.length} papers and ${layout.edges.length} similarity connections`}
        onPointerDown={startGesture}
        onPointerMove={moveGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onLostPointerCapture={endGesture}
      >
        <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
          <g className="graph-edges" aria-hidden="true">
            {layout.edges.map((edge) => {
              const isPath = pathEdges.has(edge.key);
              const isNeighbor = edge.source.id === selectedId || edge.target.id === selectedId;
              return (
                <line
                  key={edge.key}
                  className={`graph-edge${isPath ? ' graph-edge--path' : isNeighbor ? ' graph-edge--neighbor' : focusing ? ' graph-edge--faded' : ''}`}
                  x1={edge.source.x} y1={edge.source.y} x2={edge.target.x} y2={edge.target.y}
                  strokeWidth={isPath ? 2.5 : 0.5 + 1.5 * edge.weight / maxWeight}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </g>
          {layout.nodes.map((node) => {
            const paper = papers.get(node.id);
            if (!paper) return null;
            const isSelected = node.id === selectedId;
            const isPath = pathNodes.has(node.id);
            const isNeighbor = neighbors.has(node.id);
            const yearRatio = paper.year === null || firstYear === null || lastYear === null ? null
              : (paper.year - firstYear) / Math.max(1, lastYear - firstYear);
            const yearColor = yearRatio === null ? '#b4c9ca'
              : `rgb(${Math.round(178 - 162 * yearRatio)}, ${Math.round(204 - 126 * yearRatio)}, ${Math.round(204 - 122 * yearRatio)})`;
            return (
              <g
                key={node.id}
                data-paper-id={node.id}
                className={`graph-node${paper.isOrigin ? ' graph-node--origin' : ''}${isSelected ? ' graph-node--selected' : ''}${isPath ? ' graph-node--path' : ''}${focusing && !isSelected && !isPath && !isNeighbor ? ' graph-node--faded' : ''}`}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`${paper.title}. ${paper.authors.join(', ') || 'Unknown author'}. ${paper.year ?? 'Year unknown'}. ${numberFormat.format(paper.citations)} citations.${paper.isOrigin ? ' Origin paper.' : ''} Select paper; Shift+Enter opens its graph.`}
                onPointerEnter={() => onHover?.(node.id)}
                onPointerLeave={() => onHover?.(null)}
                onClick={(event) => { if (event.detail === 0 || !suppressClickRef.current) onSelect(node.id); }}
                onDoubleClick={() => { if (!suppressClickRef.current) onOpen(node.id); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (event.key === 'Enter' && event.shiftKey) onOpen(node.id);
                    else onSelect(node.id);
                  }
                }}
              >
                <title>{`${paper.title}\n${node.label}\n${numberFormat.format(paper.citations)} citations`}</title>
                <circle className="graph-node-hit" r={Math.max(22, node.radius + 6)} />
                <circle className="graph-node-disc" r={node.radius} fill={yearColor} />
                {paper.isOrigin && <circle className="graph-origin-ring" r={node.radius + 2} vectorEffect="non-scaling-stroke" />}
                <circle className="graph-selection-ring" r={node.radius + 6} vectorEffect="non-scaling-stroke" />
                <text className="graph-node-label" textAnchor="middle" y={-node.radius - 8 / Math.min(1, camera.scale)} fontSize={11 / Math.min(1, camera.scale)} aria-hidden="true">{node.label}</text>
              </g>
            );
          })}
        </g>
      </svg>

      {selected && (
        <div className="graph-selection">
          <div className="graph-selection-copy">
            <span className="graph-selection-title" title={selected.title}>{selected.title}</span>
            <span className="graph-selection-detail">{pathDescription}</span>
          </div>
          <button className="graph-open-button" type="button" onClick={() => onOpen(selected.id)} aria-label={`Open graph with ${selected.title} as origin`}>Open graph</button>
        </div>
      )}
      <p className="graph-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {selected ? `${selected.title}. ${pathDescription} ${neighbors.size} neighboring papers.` : pathDescription}
      </p>
      {!nodes.length && <div className="graph-empty">No papers to display. Choose a paper to build a similarity graph.</div>}

      <button
        ref={helpButtonRef}
        className="graph-control graph-help-button"
        type="button"
        aria-label="How to read and navigate the graph"
        aria-expanded={helpOpen}
        aria-controls={helpId}
        onClick={() => setHelpOpen(!helpOpen)}
      >?</button>
      {helpOpen && (
        <div className="graph-help" ref={helpRef} id={helpId} role="region" aria-label="How to read the graph">
          <strong className="graph-help-title">A map of similar papers</strong>
          <p>This is <strong>not a citation tree</strong>. Connections represent similarity through shared references and co-citations, not who cites whom.</p>
          <ul>
            <li>Larger circles mean more citations. Sizes are logarithmic and capped to keep the map readable.</li>
            <li>Darker teal means a newer publication; pale gray-teal means the year is unknown.</li>
            <li>Magenta rings mark origin papers. Thicker gray lines mean stronger similarity.</li>
            <li>Only each paper's strongest connections are drawn, so a missing line does not mean two papers are unrelated.</li>
            <li>Selection highlights neighbors and the blue path to the nearest origin, minimizing the sum of inverse similarity weights (normalized, with a 0.001 floor). When a paper other than the origin is selected, other papers fade.</li>
          </ul>
          <p>Drag a paper to move it. Drag empty space to pan, including on touch screens. Scroll or use + / - to zoom; Fit restores the whole map. In a zoomed-out overview, only origin, path, selected, hovered, and focused labels are shown. Zoom in to see all labels.</p>
          <p>Tab to a paper; Enter or Space selects it. Double-click, Shift+Enter, or Open graph uses the selected paper as a new origin. The papers list is the text alternative.</p>
          <button className="graph-help-close" type="button" onClick={() => { setHelpOpen(false); helpButtonRef.current?.focus(); }}>Close help</button>
        </div>
      )}

      <div className="graph-controls" role="group" aria-label="Graph zoom controls">
        <button className="graph-control" type="button" aria-label="Zoom out" title="Zoom out" disabled={!nodes.length || camera.scale <= MIN_ZOOM} onClick={() => zoom(1 / 1.25)}>-</button>
        <button className="graph-control" type="button" aria-label="Zoom in" title="Zoom in" disabled={!nodes.length || camera.scale >= MAX_ZOOM} onClick={() => zoom(1.25)}>+</button>
        <button className="graph-control" type="button" aria-label="Fit all papers in view" title="Fit all papers in view" disabled={!nodes.length} onClick={() => {
          autoFitRef.current = true;
          const fitted = fitCamera(layoutRef.current, sizeRef.current);
          cameraRef.current = fitted;
          setCamera(fitted);
        }}>
          <svg className="graph-control-icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />
            <circle cx="10" cy="10" r="3" />
          </svg>
        </button>
      </div>
      {nodes.length > 0 && (
        <div className="graph-legend" role="img" aria-label={firstYear === null ? 'Publication years unknown' : `Publication year: pale teal ${firstYear}, dark teal ${lastYear}. Circle size shows citations.`}>
          <span className="graph-legend-title">Publication year</span>
          <svg className="graph-year-scale" width="180" height="8" viewBox="0 0 180 8" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id={yearGradientId}><stop offset="0" stopColor="#b2cccc" /><stop offset="1" stopColor="#104e52" /></linearGradient></defs>
            <rect width="180" height="8" fill={`url(#${yearGradientId})`} />
          </svg>
          <div className="graph-legend-years"><span>{firstYear ?? 'Unknown'}</span><span>{lastYear ?? ''}</span></div>
        </div>
      )}
    </div>
  );
}
