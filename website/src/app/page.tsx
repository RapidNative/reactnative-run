import Link from "next/link";
import Image from "next/image";

function Nav() {
  return (
    <nav className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-white">
          <Image src="/logo.svg" alt="logo" width={28} height={28} />
          reactnative.run
        </Link>
        <a
          href="https://rapidnative.com?utm_source=reactnative.run&utm_medium=header&utm_campaign=landing"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
        >
          by RapidNative
        </a>
      </div>
      <div className="flex items-center gap-6">
        <Link
          href="/playground"
          className="text-sm text-zinc-400 hover:text-white transition-colors"
        >
          Playground
        </Link>
        <a
          href="https://github.com/RapidNative/almostmetro"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-zinc-400 hover:text-white transition-colors"
        >
          GitHub
        </a>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <section className="flex flex-col items-center justify-center text-center px-6 py-32 max-w-4xl mx-auto">
      <div className="inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-1.5 text-sm text-zinc-400 mb-8">
        <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
        Powered by browser-metro
      </div>
      <h1 className="text-5xl sm:text-6xl font-bold tracking-tight leading-tight">
        Run React Native
        <br />
        <span className="text-blue-400">in your browser</span>
      </h1>
      <p className="mt-6 text-lg text-zinc-400 max-w-2xl leading-relaxed">
        Write, bundle, and preview React Native apps instantly. No installs, no
        setup, no waiting. Everything runs in the browser with hot module
        replacement.
      </p>
      <div className="flex gap-4 mt-10">
        <Link
          href="/playground"
          className="rounded-full bg-blue-500 hover:bg-blue-400 px-8 py-3 text-sm font-semibold transition-colors"
        >
          Try the Playground
        </Link>
        <a
          href="https://github.com/RapidNative/almostmetro"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-full border border-zinc-700 hover:border-zinc-500 px-8 py-3 text-sm font-semibold transition-colors"
        >
          View on GitHub
        </a>
      </div>
    </section>
  );
}

function Features() {
  const features = [
    {
      title: "Zero Setup",
      description:
        "No CLI, no Xcode, no Android Studio. Open the browser and start coding React Native immediately.",
      icon: "~",
    },
    {
      title: "Hot Module Replacement",
      description:
        "Edit code and see changes instantly without losing component state. Full React Refresh support.",
      icon: "#",
    },
    {
      title: "Expo Router Support",
      description:
        "File-based routing with dynamic route addition via HMR. Add a new route file and see it appear instantly.",
      icon: "/",
    },
    {
      title: "API Routes",
      description:
        "Write +api.ts files that run in-browser via fetch interception. No server needed.",
      icon: ">",
    },
    {
      title: "Any npm Package",
      description:
        "Import any npm package. Packages are bundled on-demand and cached. No configuration required.",
      icon: "+",
    },
    {
      title: "Source Maps",
      description:
        "Full source map support. Errors show original file names and line numbers, not bundle positions.",
      icon: "*",
    },
  ];

  return (
    <section className="px-6 py-24 max-w-6xl mx-auto">
      <h2 className="text-3xl font-bold text-center mb-16">How it works</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6"
          >
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-zinc-800 text-blue-400 font-mono text-lg mb-4">
              {feature.icon}
            </div>
            <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              {feature.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Architecture() {
  return (
    <section className="px-6 py-24 max-w-4xl mx-auto">
      <h2 className="text-3xl font-bold text-center mb-12">Architecture</h2>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 font-mono text-sm text-zinc-300 leading-relaxed overflow-x-auto">
        <pre>{`Browser                          esm.reactnative.run
+----------------------------+   +---------------------+
| VirtualFS                  |   | GET /pkg/:specifier |
|   In-memory file system    |   |   npm install       |
|                            |   |   esbuild bundle    |
| browser-metro              |   |   cache to disk     |
|   1. Walk dependency graph |   +---------------------+
|   2. Transform (Sucrase)   |            ^
|   3. Rewrite requires      |            |
|   4. Fetch npm pkgs -------+---> fetch /pkg/lodash
|   5. Emit bundle + HMR     |
|                            |
| Execute in iframe          |
+----------------------------+`}</pre>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="px-6 py-24 text-center">
      <h2 className="text-3xl font-bold mb-4">Ready to try it?</h2>
      <p className="text-zinc-400 mb-8">
        Start writing React Native code in your browser right now.
      </p>
      <Link
        href="/playground"
        className="inline-block rounded-full bg-blue-500 hover:bg-blue-400 px-8 py-3 text-sm font-semibold transition-colors"
      >
        Open Playground
      </Link>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-zinc-800 px-6 py-8 text-center text-sm text-zinc-500">
      <p>
        Built with{" "}
        <a
          href="https://github.com/RapidNative/almostmetro"
          className="text-zinc-400 hover:text-white transition-colors"
        >
          browser-metro
        </a>
      </p>
    </footer>
  );
}

export default function Home() {
  return (
    <>
      <Nav />
      <main className="flex-1">
        <Hero />
        <Features />
        <Architecture />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
