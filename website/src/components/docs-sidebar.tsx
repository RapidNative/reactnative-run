"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

interface DocSection {
  title: string;
  items: { title: string; href: string }[];
}

const sections: DocSection[] = [
  {
    title: "Getting Started",
    items: [
      { title: "Introduction", href: "/docs" },
      { title: "Quick Start", href: "/docs/quick-start" },
      { title: "Comparison", href: "/docs/comparison" },
      { title: "About", href: "/docs/about" },
    ],
  },
  {
    title: "Core Concepts",
    items: [
      { title: "Architecture", href: "/docs/architecture" },
      { title: "Virtual Filesystem", href: "/docs/virtual-fs" },
      { title: "Module Resolution", href: "/docs/resolution" },
      { title: "Transformation", href: "/docs/transformation" },
      { title: "Asset Handling", href: "/docs/assets" },
    ],
  },
  {
    title: "Features",
    items: [
      { title: "HMR & React Refresh", href: "/docs/hmr" },
      { title: "Expo Router", href: "/docs/expo-router" },
      { title: "API Routes", href: "/docs/api-routes" },
      { title: "Shims & Polyfills", href: "/docs/shims" },
      { title: "Source Maps", href: "/docs/source-maps" },
    ],
  },
  {
    title: "API Reference",
    items: [
      { title: "Bundler", href: "/docs/api/bundler" },
      { title: "IncrementalBundler", href: "/docs/api/incremental-bundler" },
      { title: "VirtualFS", href: "/docs/api/virtual-fs" },
      { title: "Plugins", href: "/docs/api/plugins" },
      { title: "Types", href: "/docs/api/types" },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      { title: "ESM Package Server", href: "/docs/esm-server" },
      { title: "Batch Fetching", href: "/docs/batch-fetching" },
    ],
  },
];

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 shrink-0 border-r border-zinc-800/50 overflow-y-auto py-6 px-4 hidden md:block">
      <nav className="space-y-6">
        {sections.map((section) => (
          <div key={section.title}>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 px-2">
              {section.title}
            </h3>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-md transition-colors ${
                        isActive
                          ? "bg-cyan-500/10 text-cyan-400 font-medium"
                          : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                      }`}
                    >
                      {isActive && <ChevronRight size={12} className="shrink-0" />}
                      {item.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

export function MobileDocsNav() {
  const pathname = usePathname();

  const allItems = sections.flatMap((s) => s.items);
  const currentIndex = allItems.findIndex((i) => i.href === pathname);
  const prev = currentIndex > 0 ? allItems[currentIndex - 1] : null;
  const next = currentIndex < allItems.length - 1 ? allItems[currentIndex + 1] : null;

  return (
    <div className="flex justify-between items-center border-t border-zinc-800/50 mt-12 pt-6">
      {prev ? (
        <Link href={prev.href} className="text-sm text-zinc-400 hover:text-white transition-colors">
          &larr; {prev.title}
        </Link>
      ) : (
        <div />
      )}
      {next ? (
        <Link href={next.href} className="text-sm text-zinc-400 hover:text-white transition-colors">
          {next.title} &rarr;
        </Link>
      ) : (
        <div />
      )}
    </div>
  );
}
