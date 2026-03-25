import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function ErrorScreen() {
  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Error Testing</ThemedText>
      <ThemedText>
        Tap the button below to throw a runtime error. Check the console panel to see the source-mapped error with original file and line number.
      </ThemedText>

      <Pressable
        style={styles.button}
        onPress={() => {
          throw new Error('This is a test error thrown from the Error tab!');
        }}
      >
        <Text style={styles.buttonText}>Throw Error</Text>
      </Pressable>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    paddingTop: 60,
    gap: 16,
  },
  button: {
    backgroundColor: '#ef4444',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
});
