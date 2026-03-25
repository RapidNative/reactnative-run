import { create } from "zustand";

interface CounterState {
  count: number;
  inc: () => void;
  dec: () => void;
}

export const useCounter = create<CounterState>((set) => ({
  count: 0,
  inc: () => set((s) => ({ count: s.count + 1 })),
  dec: () => set((s) => ({ count: s.count - 1 })),
}));
