import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Playground - reactnative.run",
  description:
    "Write and run React Native code in your browser with live preview and hot module replacement.",
};

export default function PlaygroundPage() {
  return (
    <iframe
      src="/playground/index.html"
      className="w-full h-screen border-0"
      allow="cross-origin-isolated"
    />
  );
}
