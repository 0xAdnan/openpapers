import { yearColor } from './graphLayout';

// A prebuilt layout of a real graph (scripts/build-featured.ts), drawn as a static thumbnail.
export interface FeaturedPreview {
  id: string;
  title: string;
  author: string;
  year: number | null;
  nodes: { x: number; y: number; r: number; year: number | null; label: string; origin: boolean }[];
  // [source index, target index, weight relative to the strongest edge]; 0 marks a direct-citation link.
  edges: [number, number, number][];
}

export default function GraphPreview({ preview }: { preview: FeaturedPreview }) {
  return (
    <svg className="graph-preview" viewBox="0 0 320 220" aria-hidden="true" focusable="false">
      <g className="graph-preview-edges">
        {preview.edges.map(([a, b, weight], i) => {
          const source = preview.nodes[a], target = preview.nodes[b];
          return <line key={i} x1={source.x} y1={source.y} x2={target.x} y2={target.y}
            strokeWidth={0.3 + 0.9 * weight} strokeDasharray={weight === 0 ? '2 1.5' : undefined} />;
        })}
      </g>
      {preview.nodes.map((node, i) => (
        <circle key={i} className={node.origin ? 'graph-preview-origin' : undefined} cx={node.x} cy={node.y} r={node.r} fill={yearColor(node.year)} />
      ))}
      <g className="graph-preview-labels">
        {preview.nodes.map((node, i) => <text key={i} x={node.x} y={node.y - node.r - 1.2}>{node.label}</text>)}
      </g>
    </svg>
  );
}
