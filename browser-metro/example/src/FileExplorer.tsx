import { useState, useMemo, useRef, useEffect } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  FileCode,
  FileJson,
  FileType,
  FolderOpen,
  Folder,
  FilePlus,
  FolderPlus,
  Trash2,
} from "lucide-react";

interface FileTreeNode {
  name: string;
  path: string;
  children?: FileTreeNode[];
}

interface CreatingState {
  parentPath: string;
  type: "file" | "folder";
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
  if (name.endsWith(".json"))
    return <FileJson size={16} className="shrink-0 text-yellow-400" />;
  if (name.endsWith(".tsx") || name.endsWith(".jsx"))
    return <FileCode size={16} className="shrink-0 text-blue-400" />;
  if (name.endsWith(".ts") || name.endsWith(".js"))
    return <FileCode size={16} className="shrink-0 text-emerald-400" />;
  if (name.endsWith(".css"))
    return <FileType size={16} className="shrink-0 text-purple-400" />;
  return <File size={16} className="shrink-0 text-zinc-400" />;
}

function InlineInput({
  depth,
  isFolder,
  theme,
  onConfirm,
  onCancel,
}: {
  depth: number;
  isFolder: boolean;
  theme: "dark" | "light";
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && value.trim()) {
      onConfirm(value.trim());
    } else if (e.key === "Escape") {
      onCancel();
    }
  }

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5"
      style={{ paddingLeft: depth * 14 + 8 }}
    >
      {isFolder ? (
        <Folder size={16} className="shrink-0 text-zinc-500" />
      ) : (
        <File size={16} className="shrink-0 text-zinc-400" />
      )}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        placeholder={isFolder ? "folder name" : "filename.tsx"}
        className={`flex-1 text-[13px] bg-transparent border-b outline-none py-0.5 min-w-0 ${
          theme === "dark"
            ? "border-zinc-600 text-zinc-200 placeholder:text-zinc-600"
            : "border-zinc-300 text-zinc-800 placeholder:text-zinc-400"
        }`}
      />
    </div>
  );
}

function TreeNode({
  node,
  depth,
  activeFile,
  onSelect,
  onCreateFile,
  onCreateFolder,
  onDelete,
  creating,
  onConfirmCreate,
  onCancelCreate,
  theme,
}: {
  node: FileTreeNode;
  depth: number;
  activeFile: string;
  onSelect: (path: string) => void;
  onCreateFile: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onDelete: (path: string) => void;
  creating: CreatingState | null;
  onConfirmCreate: (name: string) => void;
  onCancelCreate: () => void;
  theme: "dark" | "light";
}) {
  const [expanded, setExpanded] = useState(true);
  const [hovered, setHovered] = useState(false);
  const isFolder = !!node.children;
  const isActive = node.path === activeFile;
  const isCreatingHere = creating?.parentPath === node.path;

  if (isFolder) {
    return (
      <div>
        <div
          className="relative group"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <button
            onClick={() => setExpanded(!expanded)}
            className={`flex items-center gap-1.5 w-full px-2 py-1.5 text-[13px] rounded-sm ${
              theme === "dark"
                ? "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/50"
            }`}
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
          {hovered && (
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(true);
                  onCreateFile(node.path);
                }}
                className={`p-0.5 rounded ${
                  theme === "dark"
                    ? "hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300"
                    : "hover:bg-zinc-300 text-zinc-400 hover:text-zinc-600"
                }`}
                title="New file"
              >
                <FilePlus size={13} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(true);
                  onCreateFolder(node.path);
                }}
                className={`p-0.5 rounded ${
                  theme === "dark"
                    ? "hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300"
                    : "hover:bg-zinc-300 text-zinc-400 hover:text-zinc-600"
                }`}
                title="New folder"
              >
                <FolderPlus size={13} />
              </button>
            </div>
          )}
        </div>
        {expanded && (
          <>
            {node.children!.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activeFile={activeFile}
                onSelect={onSelect}
                onCreateFile={onCreateFile}
                onCreateFolder={onCreateFolder}
                onDelete={onDelete}
                creating={creating}
                onConfirmCreate={onConfirmCreate}
                onCancelCreate={onCancelCreate}
                theme={theme}
              />
            ))}
            {isCreatingHere && (
              <InlineInput
                depth={depth + 1}
                isFolder={creating!.type === "folder"}
                theme={theme}
                onConfirm={onConfirmCreate}
                onCancel={onCancelCreate}
              />
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className="relative group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={() => onSelect(node.path)}
        className={`flex items-center gap-1.5 w-full px-2 py-1.5 text-[13px] rounded-sm truncate ${
          isActive
            ? theme === "dark"
              ? "bg-blue-500/20 text-blue-300"
              : "bg-blue-500/15 text-blue-600"
            : theme === "dark"
              ? "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/50"
        }`}
        style={{ paddingLeft: depth * 14 + 8 }}
      >
        {getFileIcon(node.name)}
        <span className="truncate">{node.name}</span>
      </button>
      {hovered && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.path);
            }}
            className={`p-0.5 rounded ${
              theme === "dark"
                ? "hover:bg-zinc-700 text-zinc-500 hover:text-red-400"
                : "hover:bg-zinc-300 text-zinc-400 hover:text-red-500"
            }`}
            title="Delete file"
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

export function FileExplorer({
  files,
  activeFile,
  onSelect,
  onCreateFile,
  onDeleteFile,
  theme = "dark",
}: {
  files: string[];
  activeFile: string;
  onSelect: (path: string) => void;
  onCreateFile: (path: string, content: string) => void;
  onDeleteFile: (path: string) => void;
  theme?: "dark" | "light";
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [creating, setCreating] = useState<CreatingState | null>(null);

  function handleConfirmCreate(name: string) {
    if (!creating) return;
    const fullPath = creating.parentPath + "/" + name;
    if (creating.type === "file") {
      onCreateFile(fullPath, "");
      onSelect(fullPath);
    } else {
      onCreateFile(fullPath + "/.gitkeep", "");
    }
    setCreating(null);
  }

  // Root-level creating (parentPath === "")
  const isCreatingAtRoot = creating?.parentPath === "";

  return (
    <div className="py-1">
      <div className="flex items-center gap-1 px-2 mb-1">
        <button
          onClick={() => setCreating({ parentPath: "", type: "file" })}
          className={`p-1 rounded ${
            theme === "dark"
              ? "hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300"
              : "hover:bg-zinc-300 text-zinc-400 hover:text-zinc-600"
          }`}
          title="New file"
        >
          <FilePlus size={14} />
        </button>
        <button
          onClick={() => setCreating({ parentPath: "", type: "folder" })}
          className={`p-1 rounded ${
            theme === "dark"
              ? "hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300"
              : "hover:bg-zinc-300 text-zinc-400 hover:text-zinc-600"
          }`}
          title="New folder"
        >
          <FolderPlus size={14} />
        </button>
      </div>
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          activeFile={activeFile}
          onSelect={onSelect}
          onCreateFile={(parentPath) => setCreating({ parentPath, type: "file" })}
          onCreateFolder={(parentPath) => setCreating({ parentPath, type: "folder" })}
          onDelete={onDeleteFile}
          creating={creating}
          onConfirmCreate={handleConfirmCreate}
          onCancelCreate={() => setCreating(null)}
          theme={theme}
        />
      ))}
      {isCreatingAtRoot && (
        <InlineInput
          depth={0}
          isFolder={creating!.type === "folder"}
          theme={theme}
          onConfirm={handleConfirmCreate}
          onCancel={() => setCreating(null)}
        />
      )}
    </div>
  );
}
