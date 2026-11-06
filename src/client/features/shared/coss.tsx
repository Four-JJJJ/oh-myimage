import { Loader2 } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Separator } from "../../components/ui/separator";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../components/ui/select";

export { Button as CossButton, Input as CossInput, Textarea as CossTextarea, Badge as CossBadge, Separator as CossSeparator };

export function CossSelect({
  value,
  items,
  onValueChange,
  disabled,
  label,
}: {
  value: string;
  items: { value: string; label: string }[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Select items={items} value={value} disabled={disabled} onValueChange={(next) => { if (next !== null) onValueChange(next); }}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
      </SelectPopup>
    </Select>
  );
}

export function CossSpinner({ className }: { className?: string }) {
  return <Loader2 role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} />;
}
