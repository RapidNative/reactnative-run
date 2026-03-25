import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  icons: { icon: "/logo.svg" },
  title: "reactnative.run - Run React Native in your browser",
  description:
    "Write and run React Native apps instantly in your browser. No setup, no installs. Powered by browser-metro, a browser-based JavaScript bundler with HMR support.",
  openGraph: {
    title: "reactnative.run",
    description: "Write and run React Native apps instantly in your browser.",
    url: "https://reactnative.run",
    siteName: "reactnative.run",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "reactnative.run",
    description: "Write and run React Native apps instantly in your browser.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-white">
        {children}
      </body>
    </html>
  );
}
