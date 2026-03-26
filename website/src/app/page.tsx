import Link from "next/link";
import Image from "next/image";
import {
  Play,
  ArrowRight,
  ChevronDown,
} from "lucide-react";
import { Nav, Footer } from "@/components/nav";
import { PlaygroundEmbed } from "@/components/playground-embed";
import { HeroWithPaths } from "@/components/ui/background-paths";
import { FeaturesSection } from "@/components/features-section";

// Hero is now HeroWithPaths from background-paths.tsx

// Features section is now in @/components/features-section

function ArchitectureDiagram() {
  return (
    <section className="px-6 py-24 max-w-5xl mx-auto">
      <div className="text-center mb-12">
        <h2 className="text-3xl font-bold text-white">Architecture</h2>
        <p className="mt-3 text-zinc-400">
          Two services work together: the browser-based bundler and the ESM
          package server.
        </p>
      </div>
      <Image
        src="/architecture.svg"
        alt="Architecture diagram showing browser-metro client and reactnative-esm server"
        width={800}
        height={420}
        className="w-full rounded-xl border border-zinc-800/50"
      />
      <div className="text-center mt-6">
        <Link
          href="/docs/architecture"
          className="text-sm text-cyan-400 hover:underline"
        >
          Learn more about the architecture &rarr;
        </Link>
      </div>
    </section>
  );
}

function Comparison() {
  return (
    <section className="px-6 py-24 max-w-5xl mx-auto">
      <div className="text-center mb-16">
        <h2 className="text-3xl font-bold">How it compares</h2>
        <p className="mt-3 text-zinc-400 max-w-lg mx-auto">
          reactnative.run vs other online development environments.
        </p>
      </div>
      <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/20 overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="border-b border-zinc-800/50">
              <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-zinc-500" />
              <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-cyan-400">
                reactnative.run
              </th>
              <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Expo Snack
              </th>
              <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                CodeSandbox
              </th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            {[
              ["Bundling", "Client-side", "Partially client-side", "Server-side"],
              ["npm packages", "Any, on-demand", "Curated subset", "Any, via server"],
              ["HMR", "Full + React Refresh", "Live reload", "Full HMR"],
              ["Expo Router", "Full + HMR", "Limited", "Basic"],
              ["API Routes", "In-browser", "No", "Via server"],
              ["Native preview", "Web only", "iOS, Android, Web", "Web"],
              ["Open source", "Yes (MIT)", "Partially", "No"],
              ["Price", "Free", "Free", "Free tier + paid"],
            ].map(([feature, us, snack, cs]) => (
              <tr key={feature} className="border-b border-zinc-800/30 last:border-0">
                <td className="px-6 py-4 font-medium text-zinc-300">
                  {feature}
                </td>
                <td className="px-6 py-4 text-cyan-300">{us}</td>
                <td className="px-6 py-4">{snack}</td>
                <td className="px-6 py-4">{cs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-center mt-8">
        <Link
          href="/docs/comparison"
          className="text-sm text-cyan-400 hover:underline"
        >
          Read the full comparison &rarr;
        </Link>
      </div>
    </section>
  );
}

function FAQ() {
  const faqs = [
    {
      q: "Is this an official React Native project?",
      a: "No. reactnative.run is an independent open-source project built by RapidNative. It is not affiliated with, endorsed by, or associated with Meta, Facebook, the React Native team, or the React Foundation. The domain name is simply a descriptive name for this tool. React Native is a trademark of Meta Platforms, Inc.",
    },
    {
      q: "Can I preview on iOS or Android?",
      a: "Currently, reactnative.run only supports web preview. The bundler targets react-native-web, so your app renders as a web page. Native device preview is on the roadmap.",
    },
    {
      q: "Does it work offline?",
      a: "Partially. Once npm packages are cached by the ESM server, subsequent requests are instant. The bundler itself runs entirely in the browser. However, the first load of any npm package requires a network request.",
    },
    {
      q: "Can I use any npm package?",
      a: "Yes. Unlike some online editors that restrict which packages you can use, reactnative.run bundles any npm package on-demand via the ESM server. There's a cold-start delay on first use, but subsequent requests are cached.",
    },
    {
      q: "How is this different from Expo Snack?",
      a: "The key difference is where bundling happens. Expo Snack compiles on their servers. reactnative.run bundles everything client-side in a Web Worker, giving you faster iteration cycles. Expo Snack supports native preview via Expo Go, which we don't (yet).",
    },
    {
      q: "Is it open source?",
      a: "Yes. browser-metro (the bundler), reactnative-esm (the package server), and the playground are all open source under the MIT license.",
    },
    {
      q: "Can I self-host it?",
      a: "Yes. You can run both the playground and the ESM server on your own infrastructure. See the docs for setup instructions.",
    },
  ];

  return (
    <section className="px-6 py-24 max-w-3xl mx-auto">
      <div className="text-center mb-16">
        <h2 className="text-3xl font-bold">Frequently asked questions</h2>
      </div>
      <div className="divide-y divide-zinc-800/50">
        {faqs.map((faq) => (
          <details key={faq.q} className="group py-6 first:pt-0 last:pb-0">
            <summary className="flex items-center justify-between cursor-pointer list-none text-base font-medium text-white">
              {faq.q}
              <span className="shrink-0 ml-6 w-6 h-6 flex items-center justify-center rounded-full border border-zinc-700 text-zinc-400 text-sm group-open:border-cyan-500 group-open:text-cyan-400 transition-colors">
                <span className="group-open:hidden">+</span>
                <span className="hidden group-open:inline">&minus;</span>
              </span>
            </summary>
            <p className="mt-4 text-sm text-zinc-400 leading-relaxed pr-12">
              {faq.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="px-6 py-24">
      <div className="max-w-3xl mx-auto text-center rounded-2xl border border-zinc-800/50 bg-gradient-to-b from-zinc-900/50 to-zinc-950 p-12">
        <h2 className="text-3xl font-bold mb-3">Ready to try it?</h2>
        <p className="text-zinc-400 mb-8">
          Start writing React Native code in your browser right now.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/playground"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 px-6 py-3 text-sm font-semibold transition-colors"
          >
            <Play size={16} />
            Open Playground
          </Link>
          <Link
            href="/docs"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-700 hover:border-zinc-500 hover:bg-zinc-900 px-6 py-3 text-sm font-semibold transition-colors"
          >
            Read the Docs
          </Link>
        </div>
      </div>
    </section>
  );
}

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "reactnative.run",
  url: "https://reactnative.run",
  description:
    "Write, bundle, and preview React Native apps instantly in your browser. Full HMR, Expo Router, and npm support.",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web Browser",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  author: {
    "@type": "Person",
    name: "Sanket Sahu",
    url: "https://github.com/sanketsahu",
  },
  creator: {
    "@type": "Organization",
    name: "RapidNative",
    url: "https://rapidnative.com",
  },
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Nav />
      <main className="flex-1">
        <HeroWithPaths />
        <FeaturesSection />
        <ArchitectureDiagram />
        <Comparison />
        <FAQ />
        <CTA />
        <Footer />
      </main>
      <PlaygroundEmbed />
    </>
  );
}
