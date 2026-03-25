import { useState, useMemo } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  FileCode,
  FileJson,
  FileType,
  FolderOpen,
  Folder,
} from "lucide-react";

interface FileTreeNode {
  name: string;
  path: string;
  children?: FileTreeNode[];
}

function buildTree(files: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const filePath of files) {
    const parts = filePath.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const path = "/" + parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;

      let existing = current.find((n) => n.name === name);
      if (!existing) {
        existing = { name, path, children: isFile ? undefined : [] };
        current.push(existing);
      }
      if (!isFile && existing.children) {
        current = existing.children;
      }
    }
  }

  function sort(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.sort((a, b) => {
      if (a.children && !b.children) return -1;
      if (!a.children && b.children) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  function sortRecursive(nodes: FileTreeNode[]): FileTreeNode[] {
    for (const node of nodes) {
      if (node.children) {
        node.children = sortRecursive(node.children);
      }
    }
    return sort(nodes);
  }

  return sortRecursive(root);
}

function getFileIcon(name: string) {
  if (name.endsWith(".json")) return <FileJson size={16} className="shrink-0 text-yellow-400" />;
  if (name.endsWith(".tsx") || name.endsWith(".jsx"))
    return <FileCode size={16} className="shrink-0 text-blue-400" />;
  if (name.endsWith(".ts") || name.endsWith(".js"))
    return <FileCode size={16} className="shrink-0 text-emerald-400" />;
  if (name.endsWith(".css")) return <FileType size={16} className="shrink-0 text-purple-400" />;
  return <File size={16} className="shrink-0 text-zinc-400" />;
}

function TreeNode({
  node,
  depth,
  activeFile,
  onSelect,
  theme,
}: {
  node: FileTreeNode;
  depth: number;
  activeFile: string;
  onSelect: (path: string) => void;
  theme: "dark" | "light";
}) {
  const [expanded, setExpanded] = useState(true);
  const isFolder = !!node.children;
  const isActive = node.path === activeFile;

  if (isFolder) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className={`flex items-center gap-1.5 w-full px-2 py-1.5 text-[13px] rounded-sm ${theme === "dark" ? "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50" : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/50"}`}
          style={{ paddingLeft: depth * 14 + 8 }}
        >
          {expanded ? (
            <ChevronDown size={14} className="shrink-0" />
          ) : (
            <ChevronRight size={14} className="shrink-0" />
          )}
          {expanded ? (
            <FolderOpen size={16} className="shrink-0 text-zinc-500" />
          ) : (
            <Folder size={16} className="shrink-0 text-zinc-500" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {expanded &&
          node.children!.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFile={activeFile}
              onSelect={onSelect}
              theme={theme}
            />
          ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`flex items-center gap-1.5 w-full px-2 py-1.5 text-[13px] rounded-sm truncate ${
        isActive
          ? theme === "dark" ? "bg-blue-500/20 text-blue-300" : "bg-blue-500/15 text-blue-600"
          : theme === "dark" ? "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50" : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/50"
      }`}
      style={{ paddingLeft: depth * 14 + 8 }}
    >
      {getFileIcon(node.name)}
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function FileExplorer({
  files,
  activeFile,
  onSelect,
  theme = "dark",
}: {
  files: string[];
  activeFile: string;
  onSelect: (path: string) => void;
  theme?: "dark" | "light";
}) {
  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <div className="py-1">
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          activeFile={activeFile}
          onSelect={onSelect}
          theme={theme}
        />
      ))}
    </div>
  );
}
