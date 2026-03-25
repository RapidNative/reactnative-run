import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/playground/assets/"],
    },
    sitemap: "https://reactnative.run/sitemap.xml",
  };
}
