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
  metadataBase: new URL(process.env.NEXT_PUBLIC_URL || "https://reactnative.run"),
  icons: { icon: "/logo.svg" },
  title: {
    default: "reactnative.run - Run React Native in your browser",
    template: "%s | reactnative.run",
  },
  description:
    "Write and run React Native apps instantly in your browser. No setup, no installs. Powered by browser-metro, an open-source browser-based JavaScript bundler with HMR, Expo Router, and npm support.",
  keywords: [
    "React Native",
    "browser",
    "playground",
    "online IDE",
    "HMR",
    "Expo Router",
    "TypeScript",
    "bundler",
    "browser-metro",
    "react-native-web",
  ],
  authors: [{ name: "Sanket Sahu", url: "https://github.com/sanketsahu" }],
  creator: "RapidNative",
  openGraph: {
    title: "reactnative.run - Run React Native in your browser",
    description:
      "Write, bundle, and preview React Native apps instantly in your browser. Full HMR, Expo Router, and npm support.",
    url: "https://reactnative.run",
    siteName: "reactnative.run",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "reactnative.run - Run React Native in your browser",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "reactnative.run - Run React Native in your browser",
    description:
      "Write, bundle, and preview React Native apps instantly in your browser. Full HMR, Expo Router, and npm support.",
    creator: "@sanketsahu",
    images: ["/og.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
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
