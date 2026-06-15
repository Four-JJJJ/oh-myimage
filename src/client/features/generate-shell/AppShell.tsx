import type { ReactNode } from "react";
import navGallery from "../../assets/figma/nav-gallery.svg";
import navGenerate from "../../assets/figma/nav-generate.svg";
import navLogout from "../../assets/figma/nav-logout.svg";
import navMagic from "../../assets/figma/nav-magic.svg";
import navSettings from "../../assets/figma/nav-settings-figma.svg";
import ohmioWordmark from "../../assets/figma/ohmio-wordmark.svg";
import { cn } from "../../lib/utils";
import { CossButton } from "../shared/coss";

interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
  activeView: "generate" | "gallery" | "settings";
  onNavigate: (view: "generate" | "gallery" | "settings") => void;
  onLogout: () => void;
}

const navItems: Array<{
  value: string;
  view?: "generate" | "gallery" | "settings";
  label: string;
  icon: string;
}> = [
  { value: "generate", view: "generate", label: "生成", icon: navGenerate },
  { value: "gallery", view: "gallery", label: "作品", icon: navGallery },
  { value: "magic", label: "灵感", icon: navMagic },
  { value: "settings", view: "settings", label: "设置", icon: navSettings },
];

function SidebarIcon({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return <img src={src} alt={alt} className={cn("size-5 shrink-0 select-none", className)} draggable={false} />;
}

export function AppShell({ sidebar, children, activeView, onNavigate, onLogout }: AppShellProps) {
  return (
    <main className="ohm-app-shell h-dvh overflow-hidden bg-[#161616] text-white">
      <div className="flex h-full overflow-hidden">
        <aside className="flex h-full w-[72px] shrink-0 flex-col items-center border-r border-white/10 bg-[#121212]">
          <div className="flex h-[60px] w-[50px] flex-col items-center pt-4">
            <img src={ohmioWordmark} alt="Ohmio" className="h-4 w-[50px] shrink-0 select-none" draggable={false} />
            <span className="ohm-smooth-chip mt-2 inline-flex h-5 items-center border border-white/20 bg-transparent px-3 text-[10px] leading-none text-white/60">
              Beta
            </span>
          </div>

          <nav className="mt-[180px] flex flex-1 flex-col items-center gap-3">
            {navItems.map((item) => {
              const selected = item.view === activeView;
              const navigable = Boolean(item.view);

              return (
                <CossButton
                  key={item.value}
                  aria-label={item.label}
                  aria-disabled={!navigable}
                  size="icon"
                  variant="ghost"
                  className={cn(
                    "ohm-smooth-nav size-10 border border-transparent bg-transparent p-0 text-white/60 hover:bg-white/10 hover:text-white",
                    selected && "border-transparent bg-white/10 text-white",
                    !navigable && "cursor-default hover:bg-transparent hover:text-white/60",
                  )}
                  onClick={() => {
                    if (item.view) onNavigate(item.view);
                  }}
                >
                  <SidebarIcon src={item.icon} alt="" className={selected ? "opacity-90" : "opacity-60"} />
                </CossButton>
              );
            })}
          </nav>

          <CossButton
            aria-label="退出空间"
            size="icon"
            variant="ghost"
            className="ohm-smooth-nav mb-4 size-10 border border-transparent bg-transparent p-0 text-white/60 hover:bg-white/10 hover:text-white"
            onClick={onLogout}
          >
            <SidebarIcon src={navLogout} alt="" className="-scale-x-100 opacity-60" />
          </CossButton>
        </aside>

        <aside className="h-full w-[224px] shrink-0 bg-[#121212]">{sidebar}</aside>
        <section className="relative h-full min-w-0 flex-1 overflow-hidden bg-[#1B1B1B]">{children}</section>
      </div>
    </main>
  );
}
