import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '@/constants/colors';

export type InputMode = 'tapping' | 'mic' | 'keyboard';

const OPTIONS: { mode: InputMode; icon: string; title: string; subtitle: string }[] = [
  {
    mode: 'tapping',
    icon: 'grid',
    title: 'BRAILLE TAPPING',
    subtitle: 'Tap to enter 6-dot Braille cells',
  },
  {
    mode: 'mic',
    icon: 'mic',
    title: 'VOICE INPUT',
    subtitle: 'Hold to speak your message',
  },
  {
    mode: 'keyboard',
    icon: 'type',
    title: 'KEYBOARD',
    subtitle: 'Type your message with the keyboard',
  },
];

function OptionCard({
  opt,
  onPress,
}: {
  opt: (typeof OPTIONS)[number];
  onPress: () => void;
}) {
  const [pressed, setPressed] = useState(false);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.optionCard, pressed && styles.optionCardPressed]}
      accessibilityRole="button"
      accessibilityLabel={opt.title}
      accessibilityHint={opt.subtitle}
    >
      <View style={styles.optionIcon}>
        <Feather name={opt.icon as any} size={24} color="#000000" />
      </View>
      <View style={styles.optionContent}>
        <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '700', letterSpacing: 2 }}>
          {opt.title}
        </Text>
        <Text style={{ color: Colors.zinc500, fontSize: 12, fontWeight: '500' }}>
          {opt.subtitle}
        </Text>
      </View>
      <Feather name="chevron-right" size={20} color="rgba(255,255,0,0.4)" />
    </Pressable>
  );
}

export function InputChooserModal({
  visible,
  onChoose,
  onClose,
  dismissable = true,
}: {
  visible: boolean;
  onChoose: (mode: InputMode) => void;
  onClose: () => void;
  dismissable?: boolean;
}) {
  const insets = useSafeAreaInsets();

  const handlePress = (mode: InputMode) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    onChoose(mode);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={dismissable ? onClose : undefined}
    >
      <View style={styles.backdrop}>
        <View
          style={[
            styles.container,
            {
              paddingTop: insets.top + 40,
              paddingBottom: Math.max(insets.bottom, 24),
            },
          ]}
        >
          {dismissable && (
            <Pressable
              style={[styles.closeButton, { top: insets.top + 12 }]}
              onPress={onClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Feather name="x" size={24} color={Colors.zinc500} />
            </Pressable>
          )}

          <View style={styles.header}>
            <Text style={{ color: Colors.primary, fontSize: 18, fontWeight: '700', letterSpacing: 4 }}>
              CHOOSE INPUT
            </Text>
            <Text style={{ color: Colors.zinc500, fontSize: 14, fontWeight: '500' }}>
              Select how you want to communicate
            </Text>
          </View>

          <View style={styles.options}>
            {OPTIONS.map((opt) => (
              <OptionCard key={opt.mode} opt={opt} onPress={() => handlePress(opt.mode)} />
            ))}
          </View>

          <Text style={{ color: Colors.zinc600, fontSize: 12, fontWeight: '500', textAlign: 'center', marginTop: 32 }}>
            You can change this later
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#000000',
  },
  container: {
    flex: 1,
    backgroundColor: '#000000',
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  closeButton: {
    position: 'absolute',
    right: 20,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.zinc900,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 48,
    gap: 12,
  },
  options: {
    gap: 12,
  },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.zinc800,
    backgroundColor: 'rgba(255,255,0,0.03)',
  },
  optionCardPressed: {
    backgroundColor: 'rgba(255,255,0,0.08)',
    borderColor: 'rgba(255,255,0,0.3)',
  },
  optionIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionContent: {
    flex: 1,
    gap: 4,
  },
});
