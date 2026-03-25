import type { Metadata } from "next";
import { Nav, Footer } from "@/components/nav";
import { DocsSidebar } from "@/components/docs-sidebar";

export const metadata: Metadata = {
  title: "Docs - reactnative.run",
  description: "Documentation for browser-metro and reactnative.run",
};

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-screen">
      <Nav />
      <div className="flex flex-1 min-h-0">
        <DocsSidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
