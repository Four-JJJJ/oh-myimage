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
