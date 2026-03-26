"use client";

import Link from "next/link";
import Image from "next/image";
import { BookOpen, ExternalLink, Play } from "lucide-react";
import { useEffect, useState } from "react";

export function Nav() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      setHidden((e as CustomEvent).detail === true);
    };
    window.addEventListener("playground-visible", handler);
    return () => window.removeEventListener("playground-visible", handler);
  }, []);

  return (
    <nav
      className={`flex items-center justify-between px-4 md:px-6 py-3 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-50 transition-all duration-300 ${hidden ? "-translate-y-full opacity-0 pointer-events-none" : "translate-y-0 opacity-100"}`}
    >
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-2 text-base font-semibold tracking-tight text-white"
        >
          <Image src="/logo.svg" alt="logo" width={24} height={24} />
          reactnative.run
        </Link>
        <a
          href="https://rapidnative.com?utm_source=reactnative.run&utm_medium=header&utm_campaign=website"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors hidden md:inline"
        >
          by RapidNative
        </a>
      </div>
      <div className="flex items-center gap-1">
        <Link
          href="/docs"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-400 hover:text-white rounded-md hover:bg-zinc-800/50 transition-colors"
        >
          <BookOpen size={14} />
          <span className="hidden sm:inline">Docs</span>
        </Link>
        <Link
          href="/playground"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-400 hover:text-white rounded-md hover:bg-zinc-800/50 transition-colors"
        >
          <Play size={14} />
          <span className="hidden sm:inline">Playground</span>
        </Link>
        <a
          href="https://github.com/RapidNative/reactnative-run"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-400 hover:text-white rounded-md hover:bg-zinc-800/50 transition-colors"
        >
          <ExternalLink size={14} />
          <span className="hidden sm:inline">GitHub</span>
        </a>
      </div>
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-zinc-800/50 px-6 py-10">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-start justify-between gap-6 text-sm text-zinc-500">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Image src="/logo.svg" alt="logo" width={20} height={20} />
            <span>reactnative.run</span>
            <span className="text-zinc-700">|</span>
            <a
              href="https://rapidnative.com?utm_source=reactnative.run&utm_medium=footer&utm_campaign=website"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-300 transition-colors"
            >
              by RapidNative
            </a>
          </div>
          <p className="text-xs text-zinc-600">
            Not affiliated with Meta, the React Native team, or React Foundation. React Native is a trademark of Meta Platforms, Inc.
          </p>
        </div>
        <div className="flex items-center gap-6">
          <Link
            href="/docs"
            className="hover:text-zinc-300 transition-colors"
          >
            Docs
          </Link>
          <Link
            href="/playground"
            className="hover:text-zinc-300 transition-colors"
          >
            Playground
          </Link>
          <a
            href="https://github.com/RapidNative/reactnative-run"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-300 transition-colors"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
