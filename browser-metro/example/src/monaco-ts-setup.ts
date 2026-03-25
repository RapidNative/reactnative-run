import type { Monaco } from "@monaco-editor/react";
import type { FileMap } from "browser-metro";

let currentModels: Map<string, any> = new Map();

export function syncFilesToMonaco(monaco: Monaco, files: FileMap) {
  const uri = monaco.Uri;

  // Add or update models for each file
  const activePaths = new Set<string>();
  for (const [path, entry] of Object.entries(files)) {
    const content = typeof entry === "string" ? entry : entry.content;
    activePaths.add(path);
    const monacoUri = uri.parse("file://" + path);
    const existing = monaco.editor.getModel(monacoUri);
    if (existing) {
      if (existing.getValue() !== content) {
        existing.setValue(content);
      }
    } else {
      const lang = getLanguageFromPath(path);
      monaco.editor.createModel(content, lang, monacoUri);
    }
    currentModels.set(path, true);
  }

  // Remove models for deleted files
  for (const path of currentModels.keys()) {
    if (!activePaths.has(path)) {
      const monacoUri = uri.parse("file://" + path);
      const model = monaco.editor.getModel(monacoUri);
      if (model) model.dispose();
      currentModels.delete(path);
    }
  }
}

export function configureTypeScript(monaco: Monaco) {
  const tsDefaults = monaco.languages.typescript.typescriptDefaults;
  const jsDefaults = monaco.languages.typescript.javascriptDefaults;

  const compilerOptions: any = {
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    strict: false,
    skipLibCheck: true,
    baseUrl: ".",
    paths: {
      "@/*": ["./*"],
    },
  };

  tsDefaults.setCompilerOptions(compilerOptions);
  jsDefaults.setCompilerOptions(compilerOptions);

  // Enable JSX in .tsx files
  tsDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });

  // Add React types stub so JSX doesn't error
  const reactTypes = `
declare module 'react' {
  export function useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: any[]): void;
  export function useRef<T>(initial: T): { current: T };
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: any[]): T;
  export function useMemo<T>(factory: () => T, deps: any[]): T;
  export function useContext<T>(context: React.Context<T>): T;
  export function createContext<T>(defaultValue: T): React.Context<T>;
  export function forwardRef<T, P>(render: (props: P, ref: React.Ref<T>) => React.ReactElement | null): React.ForwardRefExoticComponent<P & React.RefAttributes<T>>;
  export function memo<T extends React.ComponentType<any>>(component: T): T;
  export function Fragment(props: { children?: any }): any;
  export function createElement(type: any, props?: any, ...children: any[]): any;
  export type FC<P = {}> = (props: P) => ReactElement | null;
  export type ReactNode = ReactElement | string | number | boolean | null | undefined;
  export type ReactElement = any;
  export type Ref<T> = { current: T | null } | ((instance: T | null) => void) | null;
  export type RefAttributes<T> = { ref?: Ref<T> };
  export type Context<T> = any;
  export type ForwardRefExoticComponent<P> = any;
  export type ComponentType<P = {}> = FC<P>;
  export default { createElement, Fragment };
}

declare module 'react-dom/client' {
  export function createRoot(container: Element): { render(element: any): void };
}

declare module 'react-native' {
  export const View: any;
  export const Text: any;
  export const StyleSheet: { create<T>(styles: T): T };
  export const TouchableOpacity: any;
  export const ScrollView: any;
  export const Image: any;
  export const TextInput: any;
  export const FlatList: any;
  export const Platform: { OS: string; select(specifics: any): any };
  export const Dimensions: { get(dim: string): { width: number; height: number } };
  export const Pressable: any;
  export const ActivityIndicator: any;
  export const SafeAreaView: any;
  export const StatusBar: any;
  export type ViewStyle = any;
  export type TextStyle = any;
  export type ImageStyle = any;
}

declare module 'expo-router' {
  export const Link: any;
  export const Stack: any;
  export const Tabs: any;
  export function useRouter(): any;
  export function useLocalSearchParams(): any;
  export function useSegments(): string[];
}

declare module '*.json' {
  const value: any;
  export default value;
}
`;

  tsDefaults.addExtraLib(reactTypes, "file:///node_modules/@types/react/index.d.ts");
  jsDefaults.addExtraLib(reactTypes, "file:///node_modules/@types/react/index.d.ts");
}

function getLanguageFromPath(path: string): string {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return "typescript";
  if (path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".js")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".html")) return "html";
  return "plaintext";
}
