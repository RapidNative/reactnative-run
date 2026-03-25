import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 2,
  });

  const url = process.argv[2] || "http://localhost:3000/og-image";
  console.log(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  await page.screenshot({
    path: "public/og.png",
    type: "png",
  });

  console.log("OG image saved to public/og.png");
  await browser.close();
}

main().catch(console.error);
