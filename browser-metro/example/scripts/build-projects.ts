import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_PROJECTS_DIR = path.resolve(__dirname, "../user_projects");
const OUTPUT_FILE = path.resolve(__dirname, "../public/projects.json");
const PUBLIC_DIR = path.resolve(__dirname, "../public");

interface FileEntry {
  content: string;
  isExternal?: boolean;
}

interface ProjectFiles {
  [filePath: string]: FileEntry;
}

interface Projects {
  [projectName: string]: ProjectFiles;
}

const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico",
  ".mp4", ".mov", ".avi", ".webm", ".mkv",
  ".mp3", ".wav", ".ogg", ".aac",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
]);

const IGNORED_EXTENSIONS = new Set([
  ...ASSET_EXTENSIONS,
  ".zip", ".tar", ".gz", ".exe", ".bin", ".dll", ".so", ".dylib",
  ".pdf", ".doc", ".docx",
]);

function readFilesRecursively(
  dir: string,
  base: string,
  projectName: string,
): { files: ProjectFiles; assetCount: number } {
  const result: ProjectFiles = {};
  let assetCount = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = base + "/" + entry.name;
    const full = path.join(dir, entry.name);

    if (entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      const sub = readFilesRecursively(full, rel, projectName);
      Object.assign(result, sub.files);
      assetCount += sub.assetCount;
    } else {
      const ext = path.extname(entry.name).toLowerCase();

      if (ASSET_EXTENSIONS.has(ext)) {
        // Copy asset to public/projects/<projectName>/<rel>
        const destPath = path.join(PUBLIC_DIR, "projects", projectName, rel);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(full, destPath);
        assetCount++;
        result[rel] = { content: "", isExternal: true };
        continue;
      }

      if (IGNORED_EXTENSIONS.has(ext)) continue;
      result[rel] = { content: fs.readFileSync(full, "utf-8"), isExternal: false };
    }
  }

  return { files: result, assetCount };
}

// Ensure output directory exists
fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

const projects: Projects = {};
let totalAssets = 0;
const projectDirs = fs.readdirSync(USER_PROJECTS_DIR, { withFileTypes: true });

for (const entry of projectDirs) {
  if (entry.isDirectory()) {
    const projectPath = path.join(USER_PROJECTS_DIR, entry.name);
    const { files, assetCount } = readFilesRecursively(projectPath, "", entry.name);
    projects[entry.name] = files;
    totalAssets += assetCount;
  }
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(projects, null, 2));
console.log(
  `Generated projects.json with ${Object.keys(projects).length} project(s), ${totalAssets} asset(s) copied to public/`
);
