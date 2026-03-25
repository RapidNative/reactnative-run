import type { MDXComponents } from "mdx/types";
import type { ComponentPropsWithoutRef } from "react";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: (props: ComponentPropsWithoutRef<"h1">) => (
      <h1
        className="text-3xl font-bold tracking-tight text-white mt-0 mb-6"
        {...props}
      />
    ),
    h2: (props: ComponentPropsWithoutRef<"h2">) => (
      <h2
        className="text-2xl font-semibold tracking-tight text-white mt-10 mb-4 pb-2 border-b border-zinc-800/50"
        {...props}
      />
    ),
    h3: (props: ComponentPropsWithoutRef<"h3">) => (
      <h3
        className="text-xl font-semibold text-white mt-8 mb-3"
        {...props}
      />
    ),
    h4: (props: ComponentPropsWithoutRef<"h4">) => (
      <h4
        className="text-base font-semibold text-white mt-6 mb-2"
        {...props}
      />
    ),
    p: (props: ComponentPropsWithoutRef<"p">) => (
      <p className="text-zinc-300 leading-7 mb-4" {...props} />
    ),
    a: (props: ComponentPropsWithoutRef<"a">) => (
      <a className="text-cyan-400 hover:underline" {...props} />
    ),
    ul: (props: ComponentPropsWithoutRef<"ul">) => (
      <ul
        className="list-disc pl-6 mb-4 space-y-1.5 text-zinc-300"
        {...props}
      />
    ),
    ol: (props: ComponentPropsWithoutRef<"ol">) => (
      <ol
        className="list-decimal pl-6 mb-4 space-y-1.5 text-zinc-300"
        {...props}
      />
    ),
    li: (props: ComponentPropsWithoutRef<"li">) => (
      <li className="leading-7" {...props} />
    ),
    strong: (props: ComponentPropsWithoutRef<"strong">) => (
      <strong className="font-semibold text-white" {...props} />
    ),
    // Inline code only - rehype-pretty-code handles code blocks
    code: (props: ComponentPropsWithoutRef<"code">) => {
      // rehype-pretty-code adds data attributes to code blocks
      const isHighlighted =
        props.hasOwnProperty("data-language") ||
        props.hasOwnProperty("data-theme");
      if (isHighlighted) {
        return <code {...props} />;
      }
      return (
        <code
          className="text-cyan-300 bg-zinc-800 px-1.5 py-0.5 rounded text-sm font-mono"
          {...props}
        />
      );
    },
    // rehype-pretty-code wraps in <figure>, style the pre inside
    figure: (props: ComponentPropsWithoutRef<"figure">) => {
      const isCodeBlock = (props as any)["data-rehype-pretty-code-figure"] !== undefined;
      if (isCodeBlock) {
        return (
          <figure className="mb-4 rounded-lg border border-zinc-800/50 overflow-hidden" {...props} />
        );
      }
      return <figure {...props} />;
    },
    pre: (props: ComponentPropsWithoutRef<"pre">) => (
      <pre
        className="p-4 overflow-x-auto text-sm leading-relaxed"
        {...props}
      />
    ),
    blockquote: (props: ComponentPropsWithoutRef<"blockquote">) => (
      <blockquote
        className="border-l-2 border-zinc-700 pl-4 italic text-zinc-400 mb-4"
        {...props}
      />
    ),
    hr: () => <hr className="border-zinc-800 my-8" />,
    table: (props: ComponentPropsWithoutRef<"table">) => (
      <div className="overflow-x-auto mb-4">
        <table className="w-full text-sm text-left border-collapse" {...props} />
      </div>
    ),
    thead: (props: ComponentPropsWithoutRef<"thead">) => (
      <thead className="border-b border-zinc-700" {...props} />
    ),
    th: (props: ComponentPropsWithoutRef<"th">) => (
      <th
        className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400"
        {...props}
      />
    ),
    td: (props: ComponentPropsWithoutRef<"td">) => (
      <td
        className="px-3 py-2 text-zinc-300 border-b border-zinc-800/50"
        {...props}
      />
    ),
    ...components,
  };
}
