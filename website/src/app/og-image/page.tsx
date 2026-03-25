import Image from "next/image";

export default function OGImagePage() {
  return (
    <div
      className="w-[1200px] h-[630px] bg-zinc-950 flex flex-col items-center justify-center relative overflow-hidden"
      style={{ fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}
    >
      {/* Subtle radial glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-cyan-500/5 via-transparent to-transparent" />

      {/* Logo + brand */}
      <div className="relative z-10 flex flex-col items-center">
        <div className="flex items-center gap-4 mb-12">
          <Image src="/logo.svg" alt="logo" width={48} height={48} />
          <span className="text-3xl font-semibold text-white tracking-tight">
            reactnative.run
          </span>
          <span className="text-lg text-zinc-600 ml-2">by RapidNative</span>
        </div>

        <h1 className="text-7xl font-bold tracking-tighter text-center leading-[1.1] mb-6">
          <span className="text-white">Run React Native</span>
          <br />
          <span className="bg-gradient-to-r from-cyan-400 to-cyan-300 bg-clip-text text-transparent">
            in your browser
          </span>
        </h1>

        <p className="text-xl text-zinc-400 text-center max-w-2xl mb-10">
          Write, bundle, and preview React Native apps instantly.
          Full HMR, Expo Router, and npm support.
        </p>

        {/* Tags */}
        <div className="flex gap-3">
          {["HMR", "Expo Router", "TypeScript", "npm packages", "Source Maps"].map(
            (tag) => (
              <span
                key={tag}
                className="px-4 py-1.5 rounded-full border border-zinc-800 text-sm text-cyan-400 bg-zinc-900/50"
              >
                {tag}
              </span>
            )
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="absolute bottom-0 left-0 right-0 h-12 bg-zinc-900/50 border-t border-zinc-800/50 flex items-center justify-between px-10 text-sm text-zinc-500">
        <span>Open Source (MIT)</span>
        <span>reactnative.run</span>
      </div>
    </div>
  );
}
