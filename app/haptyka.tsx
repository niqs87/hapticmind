import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const IMPACT_STYLES = [
  { key: 'light', label: 'Delikatna', style: Haptics.ImpactFeedbackStyle.Light },
  { key: 'medium', label: 'Średnia', style: Haptics.ImpactFeedbackStyle.Medium },
  { key: 'heavy', label: 'Mocna', style: Haptics.ImpactFeedbackStyle.Heavy },
  { key: 'soft', label: 'Miękka', style: Haptics.ImpactFeedbackStyle.Soft },
  { key: 'rigid', label: 'Sztywna', style: Haptics.ImpactFeedbackStyle.Rigid },
];

const NOTIFICATION_TYPES = [
  { key: 'success', label: 'Sukces', type: Haptics.NotificationFeedbackType.Success },
  { key: 'warning', label: 'Ostrzeżenie', type: Haptics.NotificationFeedbackType.Warning },
  { key: 'error', label: 'Błąd', type: Haptics.NotificationFeedbackType.Error },
];

const ANDROID_TYPES = [
  { key: 'confirm', label: 'Potwierdź', type: Haptics.AndroidHaptics.Confirm },
  { key: 'reject', label: 'Odrzuć', type: Haptics.AndroidHaptics.Reject },
  { key: 'longpress', label: 'Długie', type: Haptics.AndroidHaptics.Long_Press },
  { key: 'keyboard', label: 'Klawiatura', type: Haptics.AndroidHaptics.Keyboard_Tap },
];

type ImpactKey = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid';

export default function HaptykaScreen() {
  const [selectedImpact, setSelectedImpact] = useState<ImpactKey>('medium');
  const [repeatInterval, setRepeatInterval] = useState(500);
  const [isRepeating, setIsRepeating] = useState(false);
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const triggerImpact = useCallback((style: Haptics.ImpactFeedbackStyle) => {
    Haptics.impactAsync(style).catch(() => {});
  }, []);

  const triggerNotification = useCallback((type: Haptics.NotificationFeedbackType) => {
    Haptics.notificationAsync(type).catch(() => {});
  }, []);

  const triggerSelection = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const triggerAndroid = useCallback((type: Haptics.AndroidHaptics) => {
    if (Platform.OS === 'android') {
      Haptics.performAndroidHapticsAsync(type).catch(() => {});
    }
  }, []);

  const startRepeat = useCallback(() => {
    if (repeatIntervalRef.current) return;
    const config = IMPACT_STYLES.find((c) => c.key === selectedImpact);
    const style = config?.style ?? Haptics.ImpactFeedbackStyle.Medium;
    const fn = () => {
      if (repeatIntervalRef.current) {
        Haptics.impactAsync(style).catch(() => {});
      }
    };
    fn();
    repeatIntervalRef.current = setInterval(fn, repeatInterval);
    setIsRepeating(true);
  }, [selectedImpact, repeatInterval]);

  const stopRepeat = useCallback(() => {
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
      setIsRepeating(false);
    }
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Konfiguracja – rodzaj i natężenie</Text>
      <View style={styles.configRow}>
        {IMPACT_STYLES.map(({ key, label, style }) => (
          <Pressable
            key={key}
            style={[styles.configBtn, selectedImpact === key && styles.configBtnActive]}
            onPress={() => {
              setSelectedImpact(key);
              triggerImpact(style);
            }}
          >
            <Text style={styles.configBtnText}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Pojedyncza wibracja (Impact)</Text>
      <Pressable
        style={styles.mainBtn}
        onPress={() => triggerImpact(IMPACT_STYLES.find((c) => c.key === selectedImpact)?.style ?? Haptics.ImpactFeedbackStyle.Medium)}
      >
        <Text style={styles.mainBtnText}>Wyzwól wibrację</Text>
      </Pressable>

      <Text style={styles.sectionTitle}>Powtarzanie</Text>
      <View style={styles.repeatRow}>
        <Pressable style={[styles.repeatBtn, styles.repeatStart]} onPress={startRepeat}>
          <Text style={styles.repeatBtnText}>Start</Text>
        </Pressable>
        <Pressable style={[styles.repeatBtn, styles.repeatStop]} onPress={stopRepeat}>
          <Text style={styles.repeatBtnText}>Zatrzymaj</Text>
        </Pressable>
      </View>
      <View style={styles.intervalRow}>
        <Text style={styles.intervalLabel}>Interwał (ms):</Text>
        <View style={styles.intervalBtns}>
          {[200, 300, 500, 700, 1000].map((ms) => (
            <Pressable
              key={ms}
              style={[styles.intervalBtn, repeatInterval === ms && styles.intervalBtnActive]}
              onPress={() => setRepeatInterval(ms)}
            >
              <Text style={styles.intervalBtnText}>{ms}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Text style={styles.sectionTitle}>Powiadomienia</Text>
      <View style={styles.btnRow}>
        {NOTIFICATION_TYPES.map(({ key, label, type }) => (
          <Pressable key={key} style={styles.smallBtn} onPress={() => triggerNotification(type)}>
            <Text style={styles.smallBtnText}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Wybór (Selection)</Text>
      <Pressable style={styles.mainBtn} onPress={triggerSelection}>
        <Text style={styles.mainBtnText}>Selection</Text>
      </Pressable>

      {Platform.OS === 'android' && (
        <>
          <Text style={styles.sectionTitle}>Android – typy</Text>
          <View style={styles.btnRow}>
            {ANDROID_TYPES.map(({ key, label, type }) => (
              <Pressable key={key} style={styles.smallBtn} onPress={() => triggerAndroid(type)}>
                <Text style={styles.smallBtnText}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  sectionTitle: {
    color: '#aaa',
    fontSize: 14,
    marginTop: 20,
    marginBottom: 10,
  },
  configRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  configBtn: {
    backgroundColor: '#333',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  configBtnActive: {
    backgroundColor: '#6a1b9a',
  },
  configBtnText: {
    color: '#fff',
    fontSize: 13,
  },
  mainBtn: {
    backgroundColor: '#6a1b9a',
    paddingVertical: 18,
    borderRadius: 12,
    alignItems: 'center',
  },
  mainBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  repeatRow: {
    flexDirection: 'row',
    gap: 12,
  },
  repeatBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  repeatStart: {
    backgroundColor: '#2e7d32',
  },
  repeatStop: {
    backgroundColor: '#c62828',
  },
  repeatBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  intervalRow: {
    marginTop: 12,
  },
  intervalLabel: {
    color: '#888',
    fontSize: 13,
    marginBottom: 6,
  },
  intervalBtns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  intervalBtn: {
    backgroundColor: '#333',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  intervalBtnActive: {
    backgroundColor: '#6a1b9a',
  },
  intervalBtnText: {
    color: '#fff',
    fontSize: 13,
  },
  btnRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  smallBtn: {
    backgroundColor: '#444',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  smallBtnText: {
    color: '#fff',
    fontSize: 14,
  },
});
