import React from "react";
import { useCounter } from "./store";

export function Counter() {
  const { count, inc, dec } = useCounter();

  return (
    <div style={{ marginTop: 16 }}>
      <p>Count: {count}</p>
      <button onClick={inc} style={{ marginRight: 8 }}>
        +
      </button>
      <button onClick={dec}>-</button>
    </div>
  );
}
