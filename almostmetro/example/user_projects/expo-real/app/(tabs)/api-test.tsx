import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function ApiTestScreen() {
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function callGet() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/hello');
      const data = await res.json();
      setResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setResult('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function callPost() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/hello', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'World', count: 42 }),
      });
      const data = await res.json();
      setResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setResult('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">API Routes</ThemedText>
      <ThemedText>Test the in-browser API route at /api/hello</ThemedText>

      <ThemedView style={styles.buttons}>
        <Pressable style={styles.button} onPress={callGet} disabled={loading}>
          <Text style={styles.buttonText}>GET /api/hello</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.postButton]} onPress={callPost} disabled={loading}>
          <Text style={styles.buttonText}>POST /api/hello</Text>
        </Pressable>
      </ThemedView>

      {loading && <ThemedText>Loading...</ThemedText>}

      {result && (
        <ScrollView style={styles.resultBox}>
          <Text style={styles.resultText}>{result}</Text>
        </ScrollView>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    paddingTop: 60,
    gap: 12,
  },
  buttons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  button: {
    backgroundColor: '#2196f3',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  postButton: {
    backgroundColor: '#4caf50',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  resultBox: {
    backgroundColor: '#1e1e1e',
    borderRadius: 8,
    padding: 12,
    maxHeight: 300,
    marginTop: 8,
  },
  resultText: {
    color: '#e0e0e0',
    fontFamily: 'monospace',
    fontSize: 13,
  },
});
