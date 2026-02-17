import React, { useState } from "react";
import { Counter } from "./Counter";

export function App() {
  const [name, setName] = useState("World");

  return (
    <div style={{ fontFamily: "sans-serif", padding: 20 }}>
      <h1>Hello, {name}!</h1>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Enter your name"
        style={{ padding: 8, fontSize: 16, marginBottom: 16 }}
      />
      <Counter />
    </div>
  );
}
