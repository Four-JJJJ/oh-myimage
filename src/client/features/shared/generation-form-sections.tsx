import { Loader2 } from "lucide-react";
import type { ClipboardEventHandler, ReactNode, RefObject } from "react";
import addIcon from "../../assets/figma/add.svg";
import optimizeIcon from "../../assets/figma/optimize.svg";
import { Label } from "../../components/ui/label";
import { CossButton, CossTextarea } from "./coss";
import { cn } from "../../lib/utils";

export function PromptSection({
  textareaRef,
  value,
  onChange,
  onPaste,
  placeholder,
  required = false,
  optimizing,
  disabled,
  onOptimize,
  trailingContent,
}: {
  textareaRef: RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (value: string) => void;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  placeholder: string;
  required?: boolean;
  optimizing: boolean;
  disabled: boolean;
  onOptimize: () => void;
  trailingContent?: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex h-[18px] items-center justify-between">
        <Label className="text-xs font-semibold leading-[18px] text-white">提示词</Label>
        <CossButton
          type="button"
          variant="ghost"
          className="h-[18px] gap-1.5 rounded-none px-0 py-0 text-xs leading-[18px] text-white/82 disabled:cursor-not-allowed disabled:opacity-55"
          disabled={optimizing || disabled}
          onClick={onOptimize}
        >
          {optimizing ? <Loader2 className="size-3 animate-spin" /> : <img src={optimizeIcon} alt="" className="size-3" />}
          {optimizing ? "优化中" : "提示词优化"}
        </CossButton>
      </div>
      <div className="figma-prompt-box flex min-h-[200px] flex-col gap-3 overflow-hidden rounded-[10px] border border-white/15 p-3">
        <CossTextarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPaste={onPaste}
          placeholder={placeholder}
          required={required}
          className="figma-prompt-textarea block min-h-[100px] max-h-[400px] w-full resize-none overflow-hidden rounded-none border-0 bg-transparent p-0 text-[15px] leading-[21px] text-white/80 outline-none placeholder:text-[15px] placeholder:leading-[21px] placeholder:text-white/40"
        />
        {trailingContent}
      </div>
    </section>
  );
}

export function PromptPlaceholderThumbnail() {
  return (
    <div className="grid h-16 w-12 place-items-center overflow-hidden rounded-[6px] bg-white/10">
      <img src={addIcon} alt="" className="size-4" />
    </div>
  );
}

export function ParameterSection({
  aspectRatios,
  selectedAspectRatio,
  onAspectRatioChange,
  qualityOptions,
  selectedQuality,
  qualityLabels,
  onQualityChange,
  resolutions,
  selectedResolution,
  onResolutionChange,
  quantities,
  selectedQuantity,
  onQuantityChange,
  formatOptions,
  selectedFormat,
  formatLabels,
  onFormatChange,
}: {
  aspectRatios: readonly string[];
  selectedAspectRatio: string;
  onAspectRatioChange: (value: string) => void;
  qualityOptions: readonly string[];
  selectedQuality: string;
  qualityLabels: Record<string, string>;
  onQualityChange: (value: string) => void;
  resolutions: readonly string[];
  selectedResolution: string;
  onResolutionChange: (value: string) => void;
  quantities: readonly string[];
  selectedQuantity: number;
  onQuantityChange: (value: number) => void;
  formatOptions: readonly string[];
  selectedFormat: string;
  formatLabels: Record<string, string>;
  onFormatChange: (value: string) => void;
}) {
  return (
    <section className="mt-4 pb-4">
      <Label className="mb-2 block text-xs font-semibold leading-[18px] text-white">参数</Label>
      <div className="figma-param-panel flex flex-col gap-4 rounded-[10px] border border-white/15 p-3">
        <OptionGroup label="比例">
          {aspectRatios.map((ratio) => (
            <SegmentButton key={ratio} active={selectedAspectRatio === ratio} onClick={() => onAspectRatioChange(ratio)}>
              {ratio}
            </SegmentButton>
          ))}
        </OptionGroup>

        <OptionGroup label="质量">
          {qualityOptions.map((quality) => (
            <SegmentButton key={quality} active={selectedQuality === quality} grow onClick={() => onQualityChange(quality)}>
              {qualityLabels[quality] ?? quality}
            </SegmentButton>
          ))}
        </OptionGroup>

        <OptionGroup label="分辨率">
          {resolutions.map((resolution) => (
            <SegmentButton key={resolution} active={selectedResolution === resolution} grow onClick={() => onResolutionChange(resolution)}>
              {resolution}
            </SegmentButton>
          ))}
        </OptionGroup>

        <OptionGroup label="数量">
          {quantities.map((quantity) => (
            <SegmentButton key={quantity} active={selectedQuantity === Number(quantity)} grow onClick={() => onQuantityChange(Number(quantity))}>
              {quantity}
            </SegmentButton>
          ))}
        </OptionGroup>

        <OptionGroup label="格式">
          {formatOptions.map((format) => (
            <SegmentButton key={format} active={selectedFormat === format} grow onClick={() => onFormatChange(format)}>
              {formatLabels[format] ?? format.toUpperCase()}
            </SegmentButton>
          ))}
        </OptionGroup>
      </div>
    </section>
  );
}

export function GenerationFormFooter({
  loading,
  idleLabel,
}: {
  loading: boolean;
  idleLabel: string;
}) {
  return (
    <div className="shrink-0 px-4 pb-4 pt-3">
      <div className="flex items-center justify-between gap-4">
        <p className="truncate text-xs leading-[18px] text-white/40">禁止利用功能从事违法活动</p>
        <CossButton
          type="submit"
          variant="outline"
          className="figma-generate-button flex h-[34px] w-[120px] shrink-0 items-center justify-center rounded-[10px] border border-white/28 bg-transparent px-0 text-xs font-semibold leading-none text-white/90 hover:bg-transparent hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
          loading={loading}
        >
          {loading ? "生成中" : idleLabel}
        </CossButton>
      </div>
    </div>
  );
}

function OptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-[18px] text-white/60">{label}</p>
      <div className="flex w-full items-center gap-1">{children}</div>
    </div>
  );
}

function SegmentButton({
  active,
  grow = false,
  children,
  onClick,
}: {
  active: boolean;
  grow?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <CossButton
      type="button"
      variant="outline"
      className={cn(
        "figma-segment h-[28px] rounded-md px-2 text-center text-xs font-semibold leading-[18px] text-white/90",
        grow ? "min-w-0 flex-1" : "w-[44px] shrink-0",
        active ? "border-white/90 bg-white/10 hover:bg-white/10" : "border-white/10 bg-transparent hover:bg-transparent",
      )}
      onClick={onClick}
    >
      {children}
    </CossButton>
  );
}
