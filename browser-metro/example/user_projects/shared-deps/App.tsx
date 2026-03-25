import React from "react";
import { Counter } from "./Counter";
import { Display } from "./Display";

export function App() {
  return (
    <div style={{ fontFamily: "sans-serif", padding: 20 }}>
      <h1>Shared Deps Demo</h1>
      <p>
        react, react-dom, and zustand all share a single React instance
        via peer dependency externalization.
      </p>
      <Counter />
      <Display />
    </div>
  );
}
