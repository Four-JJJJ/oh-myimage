import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { DayPicker } from "react-day-picker";
import type { DayPickerProps } from "react-day-picker";
import { cn } from "../../lib/utils";

function Calendar({ className, classNames, showOutsideDays = true, ...props }: DayPickerProps): React.ReactElement {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("ohm-calendar text-white", className)}
      classNames={{
        root: "w-fit",
        months: "flex max-w-fit flex-col gap-4",
        month: "space-y-3",
        month_caption: "relative flex h-9 items-center justify-center px-9 text-sm font-semibold text-white/88",
        caption_label: "truncate",
        nav: "absolute inset-x-0 top-0 flex h-9 items-center justify-between",
        button_previous:
          "ohm-smooth-control inline-flex size-8 items-center justify-center rounded-[12px] border border-white/10 bg-white/[0.04] text-white/58 hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-35",
        button_next:
          "ohm-smooth-control inline-flex size-8 items-center justify-center rounded-[12px] border border-white/10 bg-white/[0.04] text-white/58 hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-35",
        chevron: "size-4",
        month_grid: "w-full border-collapse",
        weekdays: "grid grid-cols-7",
        weekday: "grid h-8 place-items-center text-[11px] font-medium text-white/35",
        week: "grid grid-cols-7",
        day: "relative grid size-9 place-items-center text-center text-sm text-white/72",
        day_button:
          "ohm-smooth-control relative z-[1] inline-flex size-8 items-center justify-center rounded-[12px] border border-transparent text-sm font-medium text-inherit hover:border-white/10 hover:bg-white/[0.08] hover:text-white focus-visible:ring-2 focus-visible:ring-white/20",
        today: "text-white",
        selected: "text-black",
        range_start:
          "rounded-l-[12px] bg-[linear-gradient(90deg,transparent_50%,rgba(255,255,255,0.14)_50%)] text-black [&>button]:border-white/80 [&>button]:bg-white/90 [&>button]:text-black",
        range_middle: "bg-white/[0.14] text-white [&>button]:hover:bg-white/[0.12]",
        range_end:
          "rounded-r-[12px] bg-[linear-gradient(90deg,rgba(255,255,255,0.14)_50%,transparent_50%)] text-black [&>button]:border-white/80 [&>button]:bg-white/90 [&>button]:text-black",
        outside: "text-white/20",
        disabled: "pointer-events-none text-white/18",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: iconClassName }) =>
          orientation === "left" ? <ChevronLeft className={iconClassName} /> : <ChevronRight className={iconClassName} />,
      }}
      {...props}
    />
  );
}

export { Calendar };
