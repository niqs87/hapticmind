import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  Vibration,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DOT_ORDER, H_DOTS, M_DOTS, VIBRATION_PULSE } from '@/constants/braille';
import { Colors } from '@/constants/colors';

function BrailleCell({
  dots,
  visibleDots,
  pulse,
  dotSize,
}: {
  dots: boolean[];
  visibleDots: boolean[];
  pulse: boolean;
  dotSize: number;
}) {
  const gap = Math.round(dotSize * 0.65);
  const inactiveSize = Math.round(dotSize * 0.55);

  return (
    <View style={{ gap }}>
      {[0, 1, 2].map((row) => (
        <View key={row} style={{ flexDirection: 'row', gap }}>
          {[0, 1].map((col) => {
            const dotIdx = DOT_ORDER[row * 2 + col];
            const isActive = dots[dotIdx];
            const isVisible = visibleDots[dotIdx];
            const size = isActive ? dotSize : inactiveSize;

            return (
              <View
                key={col}
                style={{
                  width: dotSize,
                  height: dotSize,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <View
                  style={{
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    backgroundColor:
                      isActive && isVisible
                        ? Colors.primary
                        : isActive
                          ? 'transparent'
                          : Colors.zinc800,
                    opacity: isActive ? (isVisible ? 1 : 0) : 0.12,
                    borderWidth: isActive ? 0 : 1,
                    borderColor: Colors.zinc700,
                    transform: [{ scale: isActive && isVisible ? 1 : isActive ? 0.4 : 1 }],
                  }}
                />
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export function SplashView({ onContinue }: { onContinue?: () => void }) {
  const insets = useSafeAreaInsets();
  const [hVisible, setHVisible] = useState<boolean[]>(Array(6).fill(false));
  const [mVisible, setMVisible] = useState<boolean[]>(Array(6).fill(false));
  const [showCta, setShowCta] = useState(false);
  const titleOpacity = useRef(new Animated.Value(0)).current;
  const titleTranslate = useRef(new Animated.Value(12)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;
  const taglineTranslate = useRef(new Animated.Value(10)).current;
  const ctaOpacity = useRef(new Animated.Value(0)).current;
  const ctaTranslate = useRef(new Animated.Value(10)).current;
  const ctaPulse = useRef(new Animated.Value(1)).current;
  const ctaLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  const [pulse, setPulse] = useState(false);
  const pulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const pulseInterval = setInterval(() => {
      setPulse(true);
      pulseTimeoutRef.current = setTimeout(() => setPulse(false), 350);
    }, 2000);
    return () => {
      clearInterval(pulseInterval);
      if (pulseTimeoutRef.current) clearTimeout(pulseTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    const filledHaptic = async () => {
      if (Platform.OS === 'web') return;
      if (Platform.OS === 'android') Vibration.vibrate(VIBRATION_PULSE);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
    };
    const blankHaptic = () => {
      if (Platform.OS === 'web') return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    };

    const timeouts: ReturnType<typeof setTimeout>[] = [];
    let delay = 300;

    DOT_ORDER.forEach((dotIdx) => {
      timeouts.push(
        setTimeout(() => {
          if (H_DOTS[dotIdx]) {
            setHVisible((prev) => {
              const n = [...prev];
              n[dotIdx] = true;
              return n;
            });
            filledHaptic();
          } else {
            blankHaptic();
          }
        }, delay)
      );
      delay += 180;
    });
    delay += 120;
    DOT_ORDER.forEach((dotIdx) => {
      timeouts.push(
        setTimeout(() => {
          if (M_DOTS[dotIdx]) {
            setMVisible((prev) => {
              const n = [...prev];
              n[dotIdx] = true;
              return n;
            });
            filledHaptic();
          } else {
            blankHaptic();
          }
        }, delay)
      );
      delay += 180;
    });

    timeouts.push(
      setTimeout(() => {
        Animated.parallel([
          Animated.timing(titleOpacity, { toValue: 1, duration: 700, useNativeDriver: true }),
          Animated.timing(titleTranslate, { toValue: 0, duration: 700, useNativeDriver: true }),
        ]).start();
      }, delay + 100)
    );
    timeouts.push(
      setTimeout(() => {
        Animated.parallel([
          Animated.timing(taglineOpacity, { toValue: 1, duration: 700, useNativeDriver: true }),
          Animated.timing(taglineTranslate, { toValue: 0, duration: 700, useNativeDriver: true }),
        ]).start();
      }, delay + 400)
    );
    timeouts.push(
      setTimeout(() => {
        setShowCta(true);
        Animated.parallel([
          Animated.timing(ctaOpacity, { toValue: 1, duration: 700, useNativeDriver: true }),
          Animated.timing(ctaTranslate, { toValue: 0, duration: 700, useNativeDriver: true }),
        ]).start();
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(ctaPulse, { toValue: 1.25, duration: 1000, useNativeDriver: true }),
            Animated.timing(ctaPulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
          ])
        );
        ctaLoopRef.current = loop;
        loop.start();
      }, delay + 800)
    );

    return () => {
      timeouts.forEach(clearTimeout);
      ctaLoopRef.current?.stop();
    };
  }, []);

  const handlePress = useCallback(() => {
    if (showCta && onContinue) {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onContinue();
    }
  }, [showCta, onContinue]);

  return (
    <Pressable
      style={styles.container}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel="Tap anywhere to begin"
    >
      <View style={styles.content}>
        <View style={styles.cellsRow}>
          <BrailleCell dots={H_DOTS} visibleDots={hVisible} pulse={pulse} dotSize={34} />
          <View style={styles.divider} />
          <BrailleCell dots={M_DOTS} visibleDots={mVisible} pulse={pulse} dotSize={34} />
        </View>

        <Animated.View style={[styles.titleBlock, { opacity: titleOpacity, transform: [{ translateY: titleTranslate }] }]}>
          <Text style={styles.titleText}>
            <Text style={{ color: Colors.primary }}>Haptic</Text>
            <Text style={{ color: Colors.white }}>Mind</Text>
          </Text>
          <View style={styles.subtitleRow}>
            <View style={styles.subtitleLine} />
            <Text style={styles.subtitleText}>PULSE BRAILLE AI</Text>
            <View style={styles.subtitleLine} />
          </View>
        </Animated.View>

        <Animated.View style={[styles.taglineBlock, { opacity: taglineOpacity, transform: [{ translateY: taglineTranslate }] }]}>
          <Text style={styles.taglineText}>
            Feel language through vibration.{'\n'}A haptic interface for the deaf-blind.
          </Text>
        </Animated.View>

        <Animated.View style={[styles.ctaBlock, { opacity: ctaOpacity, transform: [{ translateY: ctaTranslate }] }]}>
          <View style={styles.ctaRing}>
            <Animated.View style={[styles.ctaDot, { transform: [{ scale: ctaPulse }] }]} />
          </View>
          <Text style={styles.ctaText}>TAP ANYWHERE TO BEGIN</Text>
        </Animated.View>
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 8) }]}>
        <Text style={styles.versionText}>v0.1.0 · PoC Build</Text>
        <View style={styles.homeBar} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 },
  cellsRow: { flexDirection: 'row', alignItems: 'center', gap: 24, marginBottom: 20 },
  divider: { width: 1, height: 80, backgroundColor: 'rgba(39,39,42,0.5)' },
  titleBlock: { alignItems: 'center', gap: 8, marginBottom: 12 },
  titleText: { fontSize: 42, fontWeight: '700', letterSpacing: -0.5 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subtitleLine: { height: 1, width: 32, backgroundColor: Colors.zinc800 },
  subtitleText: { color: Colors.zinc600, fontSize: 10, fontWeight: '600', letterSpacing: 3, textTransform: 'uppercase' },
  taglineBlock: { paddingHorizontal: 48, marginBottom: 32 },
  taglineText: { color: Colors.zinc400, fontSize: 16, textAlign: 'center', lineHeight: 24 },
  ctaBlock: { alignItems: 'center', gap: 12 },
  ctaRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,0,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.primary },
  ctaText: { color: Colors.zinc600, fontSize: 11, fontWeight: '600', letterSpacing: 3, textTransform: 'uppercase' },
  footer: { alignItems: 'center', gap: 12 },
  versionText: { color: Colors.zinc800, fontSize: 9, letterSpacing: 2 },
  homeBar: { width: 120, height: 4, backgroundColor: Colors.zinc800, borderRadius: 2 },
});
