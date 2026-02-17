import React, { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ marginTop: 16 }}>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)} style={{ marginRight: 8 }}>
        Increment
      </button>
      <button onClick={() => setCount(count - 1)}>Decrement</button>
    </div>
  );
}
