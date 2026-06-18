import type { ReactNode } from "react";
import navGallery from "../../assets/figma/nav-gallery.svg";
import navGalleryActive from "../../assets/figma/nav-gallery-active.svg";
import navGenerate from "../../assets/figma/nav-generate.svg";
import navGenerateActive from "../../assets/figma/nav-generate-active.svg";
import navLogout from "../../assets/figma/nav-logout.svg";
import navMagic from "../../assets/figma/nav-magic.svg";
import navMagicActive from "../../assets/figma/nav-magic-active.svg";
import navSettings from "../../assets/figma/nav-settings-figma.svg";
import navSettingsActive from "../../assets/figma/nav-settings-active.svg";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip";
import ohmioWordmark from "../../assets/figma/ohmio-wordmark.svg";
import { cn } from "../../lib/utils";
import { CossButton } from "../shared/coss";

interface AppShellProps {
  sidebar?: ReactNode;
  children: ReactNode;
  activeView: "generate" | "gallery" | "settings" | "inspiration";
  onNavigate: (view: "generate" | "gallery" | "settings" | "inspiration") => void;
  onLogout: () => void;
}

const navItems: Array<{
  value: string;
  view?: "generate" | "gallery" | "settings" | "inspiration";
  label: string;
  icon: string;
  activeIcon: string;
}> = [
  { value: "generate", view: "generate", label: "生成", icon: navGenerate, activeIcon: navGenerateActive },
  { value: "gallery", view: "gallery", label: "作品", icon: navGallery, activeIcon: navGalleryActive },
  { value: "magic", view: "inspiration", label: "灵感", icon: navMagic, activeIcon: navMagicActive },
  { value: "settings", view: "settings", label: "设置", icon: navSettings, activeIcon: navSettingsActive },
];

export const navGroupAnchorTop = "37.56%";

function SidebarIcon({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return <img src={src} alt={alt} className={cn("size-5 shrink-0 select-none", className)} draggable={false} />;
}

export function AppShell({ sidebar, children, activeView, onNavigate, onLogout }: AppShellProps) {
  return (
    <main className="ohm-app-shell h-dvh overflow-hidden bg-[#161616] text-white">
      <div className="flex h-full overflow-hidden">
        <aside className="relative flex h-full w-[72px] shrink-0 flex-col items-center border-r border-white/10 bg-[#121212]">
          <div className="flex h-[60px] w-[50px] flex-col items-center pt-4">
            <img src={ohmioWordmark} alt="Ohmio" className="h-4 w-[50px] shrink-0 select-none" draggable={false} />
            <span className="ohm-smooth-chip mt-2 inline-flex h-5 items-center border border-white/20 bg-transparent px-3 text-[10px] leading-none text-white/60">
              Beta
            </span>
          </div>

          <TooltipProvider delay={120}>
            <nav className="flex-1 self-stretch">
              <div className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-3" style={{ top: navGroupAnchorTop }}>
                {navItems.map((item) => {
                  const selected = item.view === activeView;
                  const navigable = Boolean(item.view);

                  return (
                    <Tooltip key={item.value}>
                      <TooltipTrigger
                        render={
                          <CossButton
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
                            <SidebarIcon src={selected ? item.activeIcon : item.icon} alt="" />
                          </CossButton>
                        }
                      />
                      <TooltipContent side="right">{item.label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </nav>
          </TooltipProvider>

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

        {sidebar ? <aside className="h-full w-[224px] shrink-0 bg-[#121212]">{sidebar}</aside> : null}
        <section className="relative h-full min-w-0 flex-1 overflow-hidden bg-[#181818]">{children}</section>
      </div>
    </main>
  );
}
