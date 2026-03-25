import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://reactnative.run";

  const staticPages = [
    "",
    "/playground",
    "/docs",
    "/docs/quick-start",
    "/docs/comparison",
    "/docs/about",
    "/docs/architecture",
    "/docs/virtual-fs",
    "/docs/resolution",
    "/docs/transformation",
    "/docs/assets",
    "/docs/hmr",
    "/docs/expo-router",
    "/docs/api-routes",
    "/docs/shims",
    "/docs/source-maps",
    "/docs/api/bundler",
    "/docs/api/incremental-bundler",
    "/docs/api/virtual-fs",
    "/docs/api/plugins",
    "/docs/api/types",
    "/docs/esm-server",
  ];

  return staticPages.map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "" ? "weekly" : "monthly",
    priority: path === "" ? 1 : path === "/playground" ? 0.9 : 0.7,
  }));
}
