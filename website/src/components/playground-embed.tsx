"use client";

import { useEffect, useRef } from "react";

export function PlaygroundEmbed() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isPlaygroundRoute = useRef(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const isFullyVisible = entry.intersectionRatio > 0.85;

        if (isFullyVisible && !isPlaygroundRoute.current) {
          isPlaygroundRoute.current = true;
          window.history.replaceState(null, "", "/playground");
          window.dispatchEvent(new CustomEvent("playground-visible", { detail: true }));
        } else if (!isFullyVisible && isPlaygroundRoute.current) {
          isPlaygroundRoute.current = false;
          window.history.replaceState(null, "", "/");
          window.dispatchEvent(new CustomEvent("playground-visible", { detail: false }));
        }
      },
      { threshold: [0, 0.85, 1] }
    );

    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} className="h-screen w-full relative">
      <iframe
        src="/playground/index.html"
        className="w-full h-full border-0"
        allow="cross-origin-isolated"
      />
    </section>
  );
}
