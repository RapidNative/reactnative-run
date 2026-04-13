import { Suspense, lazy } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

const ItemDetails = lazy(() => import('@/components/item-details'));

export default function ItemRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ThemedView style={{ flex: 1, padding: 24, gap: 12 }}>
      <ThemedText type="title">Item {id}</ThemedText>
      <Suspense
        fallback={
          <View style={{ paddingVertical: 24 }}>
            <ActivityIndicator />
          </View>
        }
      >
        <ItemDetails id={id} />
      </Suspense>
    </ThemedView>
  );
}
