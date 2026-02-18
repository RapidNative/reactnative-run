import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_PROJECTS_DIR = path.resolve(__dirname, "../user_projects");
const OUTPUT_FILE = path.resolve(__dirname, "../public/projects.json");

interface ProjectFiles {
  [filePath: string]: string;
}

interface Projects {
  [projectName: string]: ProjectFiles;
}

const IGNORED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico",
  ".mp4", ".mov", ".avi", ".webm", ".mkv",
  ".mp3", ".wav", ".ogg", ".aac",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".exe", ".bin", ".dll", ".so", ".dylib",
  ".pdf", ".doc", ".docx",
]);

function readFilesRecursively(dir: string, base: string = ""): ProjectFiles {
  const result: ProjectFiles = {};
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = base + "/" + entry.name;
    const full = path.join(dir, entry.name);

    if (entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      Object.assign(result, readFilesRecursively(full, rel));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (IGNORED_EXTENSIONS.has(ext)) continue;
      result[rel] = fs.readFileSync(full, "utf-8");
    }
  }

  return result;
}

// Ensure output directory exists
fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

const projects: Projects = {};
const projectDirs = fs.readdirSync(USER_PROJECTS_DIR, { withFileTypes: true });

for (const entry of projectDirs) {
  if (entry.isDirectory()) {
    const projectPath = path.join(USER_PROJECTS_DIR, entry.name);
    projects[entry.name] = readFilesRecursively(projectPath);
  }
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(projects, null, 2));
console.log(
  `Generated projects.json with ${Object.keys(projects).length} project(s)`
);
