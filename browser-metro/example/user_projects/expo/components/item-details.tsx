import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function ItemDetails({ id }: { id: string }) {
  return (
    <ThemedView style={{ gap: 8 }}>
      <ThemedText type="subtitle">Lazy-loaded details</ThemedText>
      <ThemedText>
        This component was loaded via {`React.lazy(() => import(...))`} for item {id}.
      </ThemedText>
      <ThemedText>If you can read this, the dynamic-import lowering works.</ThemedText>
    </ThemedView>
  );
}
