import type { CSSProperties } from "react";

export const generationDotMatrixColumns = 13;
export const generationDotMatrixRows = 9;

const generationDotMatrixDots = Array.from({ length: generationDotMatrixColumns * generationDotMatrixRows }, (_, index) => ({
  index,
  column: index % generationDotMatrixColumns,
  row: Math.floor(index / generationDotMatrixColumns),
}));

export function GenerationDotMatrixLoader({ delayIndex = 0 }: { delayIndex?: number }) {
  return (
    <div className="generation-dot-matrix-loader" aria-hidden="true">
      {generationDotMatrixDots.map((dot) => (
        <span
          key={dot.index}
          className="generation-dot-matrix-dot"
          style={
            {
              "--dot-delay": `${delayIndex * 120 + dot.column * 34 - dot.row * 16}ms`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

export function LoadersWtfStatusIcon({ className = "size-[14px]" }: { className?: string }) {
  const opacityFrames = [
    "1;0.7667;0.5333;0;0;0;0;0",
    "0;1;0.7667;0.5333;0;0;0;0",
    "0;0;1;0.7667;0.5333;0;0;0",
    "0.7667;0.5333;0;0;0;0;0;1",
    "0;0;0;0;0;0;0;0",
    "0;0;0;1;0.7667;0.5333;0;0",
    "0.5333;0;0;0;0;0;1;0.7667",
    "0;0;0;0;0;1;0.7667;0.5333",
    "0;0;0;0;1;0.7667;0.5333;0",
  ];
  const cells = Array.from({ length: 9 }, (_, index) => index);
  return (
    <svg aria-hidden="true" className={`ohm-loaders-wtf-status shrink-0 ${className}`} viewBox="0 0 91 91" fill="none">
      <g>
        {cells.map((index) => {
          const row = Math.floor(index / 3);
          const column = index % 3;
          return <circle key={`off-${index}`} cx={column * 32 + 13.5} cy={row * 32 + 13.5} r="13.5" fill="#383737" />;
        })}
      </g>
      <g>
        {cells.map((index) => {
          const row = Math.floor(index / 3);
          const column = index % 3;
          return (
            <circle key={`on-${index}`} cx={column * 32 + 13.5} cy={row * 32 + 13.5} r="13.5" fill="#FFFFFFE6">
              <animate attributeName="opacity" values={opacityFrames[index]} dur="1s" calcMode="discrete" repeatCount="indefinite" />
            </circle>
          );
        })}
      </g>
    </svg>
  );
}

export function LoadingStatusText({
  ariaLabel,
  lines,
  loopLines,
  animationDurationMs,
}: {
  ariaLabel: string;
  lines: readonly string[];
  loopLines: readonly string[];
  animationDurationMs: number;
}) {
  const resolvedAriaLabel = ariaLabel || lines[0] || "加载中";
  return (
    <span className="ohm-loading-status" aria-label={resolvedAriaLabel}>
      <span className="sr-only">{resolvedAriaLabel}</span>
      <span className="ohm-loading-status-track" aria-hidden="true" style={{ animationDuration: `${animationDurationMs}ms` }}>
        {loopLines.map((line, index) => (
          <span key={`${line}-${index}`} className="ohm-loading-status-line">
            {line}
          </span>
        ))}
      </span>
    </span>
  );
}
