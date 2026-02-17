import React from "react";
import { useCounter } from "./store";

// A separate component reading the SAME zustand store.
// This proves the store singleton works: both Counter and Display
// share state because zustand uses the same React instance.
export function Display() {
  const count = useCounter((s) => s.count);

  return (
    <div style={{ marginTop: 16, padding: 12, background: "#f0f0f0", borderRadius: 8 }}>
      <p>Display reads the same store: <strong>{count}</strong></p>
    </div>
  );
}
