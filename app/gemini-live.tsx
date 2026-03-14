import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  Vibration,
  View,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  BRAILLE_MAP,
  READ_CHARACTER_GAP,
  READ_FIELD_DURATION,
  READ_ROW_GAP,
  ROW_DOTS,
  VIBRATION_PULSE,
} from '@/constants/braille';
import { Colors } from '@/constants/colors';
import { GeminiLiveService } from '@/services/gemini-live';
import type { GeminiLiveResponse } from '@/services/gemini-live';
import {
  GEMINI_AUDIO_MODE,
  NativeAudioPlayer,
  restoreRecordingMode,
} from '@/utils/gemini-audio-native';
import {
  GEMINI_RECORDING_OPTIONS,
  NativeAudioStreamer,
} from '@/utils/gemini-media-native';
import { WebAudioPlayer, WebAudioStreamer } from '@/utils/gemini-media-web';

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || '';
const IS_WEB = Platform.OS === 'web';

type Dots = [boolean, boolean, boolean, boolean, boolean, boolean];

function BrailleMatrix({
  dots,
  activeRow,
  activeField,
}: {
  dots: Dots | null;
  activeRow: number | null;
  activeField: 'left' | 'right' | null;
}) {
  const DOT_SIZE = 24;
  const COL_GAP = 12;
  const R_GAP = 12;

  return (
    <View style={{ gap: R_GAP }}>
      {ROW_DOTS.map(([leftIdx, rightIdx], ri) => {
        const rowFiring = activeRow === ri;
        const leftActive = dots ? dots[leftIdx] : false;
        const rightActive = dots ? dots[rightIdx] : false;
        const firingLeft = rowFiring && activeField === 'left';
        const firingRight = rowFiring && activeField === 'right';

        const getDotStyle = (active: boolean, firing: boolean) => ({
          width: DOT_SIZE,
          height: DOT_SIZE,
          borderRadius: DOT_SIZE / 2,
          backgroundColor: firing && active ? Colors.primary : active ? 'rgba(255,255,0,0.35)' : '#1c1c1e',
          borderWidth: active ? 0 : 1,
          borderColor: Colors.zinc800,
        });

        return (
          <View
            key={ri}
            style={{ flexDirection: 'row', alignItems: 'center', gap: COL_GAP }}
          >
            <Text
              style={{
                fontSize: 8,
                width: 10,
                textAlign: 'right',
                color: rowFiring ? Colors.primary : Colors.zinc700,
              }}
            >
              {ri + 1}
            </Text>
            <View style={getDotStyle(leftActive, firingLeft)} />
            <View style={getDotStyle(rightActive, firingRight)} />
          </View>
        );
      })}
    </View>
  );
}

function ListenWave({ small }: { small?: boolean }) {
  const bars = small ? 10 : 18;
  const maxH = small ? 20 : 44;
  const [heights, setHeights] = useState<number[]>(Array(bars).fill(4));
  useEffect(() => {
    const id = setInterval(() => {
      setHeights((prev) => prev.map(() => 4 + Math.random() * maxH));
    }, 90);
    return () => clearInterval(id);
  }, []);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        height: small ? 24 : 56,
      }}
    >
      {heights.map((h, i) => (
        <View
          key={i}
          style={{
            width: small ? 2 : 3,
            height: h,
            borderRadius: 1,
            backgroundColor: Colors.primary,
            opacity: 0.5 + (h / (maxH + 4)) * 0.5,
          }}
        />
      ))}
    </View>
  );
}

export default function GeminiLiveScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const router = useRouter();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const screenReady = IS_WEB || (cameraPermission?.granted ?? false);

  const [connected, setConnected] = useState(false);
  const [currentReply, setCurrentReply] = useState('');
  const [currentUserSpeech, setCurrentUserSpeech] = useState('');
  const [inputText, setInputText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isWebAudio] = useState(IS_WEB);
  const [micPermission, setMicPermission] = useState<'checking' | 'granted' | 'denied' | null>(null);
  const [cameraFacing, setCameraFacing] = useState<'front' | 'back'>('back');
  const [heartPulse, setHeartPulse] = useState(false);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [activeField, setActiveField] = useState<'left' | 'right' | null>(null);
  const [wordIdx, setWordIdx] = useState(0);
  const [letterIdx, setLetterIdx] = useState(0);
  const [readingDone, setReadingDone] = useState(false);

  const letterTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const serviceRef = useRef<GeminiLiveService | null>(null);
  const audioStreamerRef = useRef<WebAudioStreamer | null>(null);
  const nativeStreamerRef = useRef<NativeAudioStreamer | null>(null);
  const audioPlayerRef = useRef<WebAudioPlayer | null>(null);
  const nativeAudioPlayerRef = useRef<NativeAudioPlayer | null>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cameraRef = useRef<CameraView | null>(null);
  const expectNewTurnRef = useRef(false);

  const nativeRecorder = useAudioRecorder(GEMINI_RECORDING_OPTIONS);

  const words = currentReply.trim().split(/\s+/).filter(Boolean);
  const currentWord = words[wordIdx] ?? '';
  const wordChars = currentWord
    .split('')
    .map((c) => c.toUpperCase())
    .filter((c) => c in BRAILLE_MAP);
  const currentChar = wordChars[letterIdx] ?? null;
  const readingDots: Dots | null =
    currentChar && currentChar in BRAILLE_MAP ? BRAILLE_MAP[currentChar] : null;
  const lastChar = currentReply.trim().slice(-1).toUpperCase() || null;
  const displayChar = currentChar ?? lastChar ?? null;
  const currentDots: Dots | null =
    readingDots ?? (lastChar && lastChar in BRAILLE_MAP ? BRAILLE_MAP[lastChar] : null);

  useEffect(() => {
    if (IS_WEB) return;
    setMicPermission('checking');
    getRecordingPermissionsAsync()
      .then(async (r) => {
        setMicPermission(r.granted ? 'granted' : 'denied');
        if (r.granted) {
          await setAudioModeAsync(GEMINI_AUDIO_MODE).catch(() => {});
        }
      })
      .catch(() => setMicPermission('denied'));
  }, []);

  useEffect(() => {
    if (!screenReady) return;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const id = setInterval(() => {
      setHeartPulse(true);
      if (Platform.OS !== 'web' && connected) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        timeouts.push(
          setTimeout(
            () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
            120
          )
        );
      }
      timeouts.push(setTimeout(() => setHeartPulse(false), 400));
    }, 4000);
    return () => {
      clearInterval(id);
      timeouts.forEach(clearTimeout);
    };
  }, [screenReady, connected]);

  const LETTER_MS =
    READ_FIELD_DURATION * 2 +
    READ_ROW_GAP +
    READ_FIELD_DURATION * 2 +
    READ_ROW_GAP +
    READ_FIELD_DURATION * 2 +
    READ_CHARACTER_GAP / 2; // ~300ms gap przed następnym znakiem

  useEffect(() => {
    if (!currentReply.trim()) {
      setWordIdx(0);
      setLetterIdx(0);
      setReadingDone(false);
    } else {
      const words = currentReply.trim().split(/\s+/).filter(Boolean);
      setReadingDone((done) => (done && words.length > wordIdx ? false : done));
    }
  }, [currentReply]);

  useEffect(() => {
    if (!screenReady || !connected || readingDone || !currentReply.trim()) return;
    const words = currentReply.split(/\s+/).filter(Boolean);
    if (words.length === 0) return;
    const wordChars = words[wordIdx]
      ?.split('')
      .map((c) => c.toUpperCase())
      .filter((c) => c in BRAILLE_MAP) ?? [];
    const advanceWord = () => {
      if (wordIdx >= words.length - 1) {
        setReadingDone(true);
      } else {
        setWordIdx((wi) => wi + 1);
        setLetterIdx(0);
      }
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (wordChars.length === 0) {
      timers.push(setTimeout(advanceWord, 50));
    } else {
      for (let i = 1; i < wordChars.length; i++) {
        timers.push(setTimeout(() => setLetterIdx(i), i * LETTER_MS));
      }
      const wordDuration = wordChars.length * LETTER_MS + READ_CHARACTER_GAP;
      timers.push(setTimeout(advanceWord, wordDuration));
    }
    return () => timers.forEach(clearTimeout);
  }, [wordIdx, currentReply, connected, screenReady, readingDone]);

  useEffect(() => {
    if (!screenReady || !connected || readingDone || !currentReply.trim()) return;
    letterTimersRef.current.forEach(clearTimeout);
    letterTimersRef.current = [];
    const words = currentReply.split(/\s+/).filter(Boolean);
    const wordChars = words[wordIdx]
      ?.split('')
      .map((c) => c.toUpperCase())
      .filter((c) => c in BRAILLE_MAP) ?? [];
    const ch = wordChars[letterIdx];
    const dots: Dots | null = ch && ch in BRAILLE_MAP ? BRAILLE_MAP[ch] : null;
    const rows = dots
      ? [
          [dots[0], dots[3]],
          [dots[1], dots[4]],
          [dots[2], dots[5]],
        ]
      : [];
    const fieldHaptic = async (filled: boolean) => {
      if (Platform.OS === 'web') return;
      if (filled) {
        if (Platform.OS === 'android') {
          Vibration.vibrate(VIBRATION_PULSE);
        }
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
      } else {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    };
    let cum = 0;
    const sched = [
      { delay: cum, fn: () => { setActiveRow(0); setActiveField('left'); if (rows[0]) fieldHaptic(rows[0][0]); } },
      { delay: (cum += READ_FIELD_DURATION), fn: () => { setActiveRow(0); setActiveField('right'); if (rows[0]) fieldHaptic(rows[0][1]); } },
      { delay: (cum += READ_FIELD_DURATION), fn: () => { setActiveRow(null); setActiveField(null); } },
      { delay: (cum += READ_ROW_GAP), fn: () => { setActiveRow(1); setActiveField('left'); if (rows[1]) fieldHaptic(rows[1][0]); } },
      { delay: (cum += READ_FIELD_DURATION), fn: () => { setActiveRow(1); setActiveField('right'); if (rows[1]) fieldHaptic(rows[1][1]); } },
      { delay: (cum += READ_FIELD_DURATION), fn: () => { setActiveRow(null); setActiveField(null); } },
      { delay: (cum += READ_ROW_GAP), fn: () => { setActiveRow(2); setActiveField('left'); if (rows[2]) fieldHaptic(rows[2][0]); } },
      { delay: (cum += READ_FIELD_DURATION), fn: () => { setActiveRow(2); setActiveField('right'); if (rows[2]) fieldHaptic(rows[2][1]); } },
      { delay: (cum += READ_FIELD_DURATION), fn: () => { setActiveRow(null); setActiveField(null); } },
    ];
    sched.forEach(({ delay, fn }) => letterTimersRef.current.push(setTimeout(fn, delay)));
    return () => letterTimersRef.current.forEach(clearTimeout);
  }, [letterIdx, wordIdx, currentReply, connected, screenReady, readingDone]);

  const connect = useCallback(async () => {
    if (!API_KEY) {
      setError('Ustaw EXPO_PUBLIC_GEMINI_API_KEY w .env');
      return;
    }
    if (!isWebAudio) {
      const { granted } = await requestRecordingPermissionsAsync();
      setMicPermission(granted ? 'granted' : 'denied');
      if (!granted) {
        setError('Potrzebny dostęp do mikrofonu – włącz w Ustawieniach');
        return;
      }
      await setAudioModeAsync(GEMINI_AUDIO_MODE).catch(() => {});
    }
    setError(null);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      const svc = new GeminiLiveService(API_KEY);
      serviceRef.current = svc;

      if (isWebAudio) {
        audioPlayerRef.current = new WebAudioPlayer();
      } else {
        nativeAudioPlayerRef.current = new NativeAudioPlayer({
          onPlayStart: () => nativeStreamerRef.current?.pause(),
          onPlayEnd: async () => {
            await restoreRecordingMode();
            await new Promise((r) => setTimeout(r, 350));
            nativeStreamerRef.current?.resume();
          },
        });
      }

      svc.setCallbacks({
        onOpen: () => setConnected(true),

        onSetupComplete: () => {
          if (isWebAudio) {
            const streamer = new WebAudioStreamer((base64) => svc.sendAudio(base64));
            audioStreamerRef.current = streamer;
            streamer.start().catch((e) => setError('Mikrofon: ' + (e as Error).message));
          } else {
            const streamer = new NativeAudioStreamer(
              nativeRecorder,
              (base64) => svc.sendAudio(base64)
            );
            nativeStreamerRef.current = streamer;
            streamer.start();
          }
        },

        onClose: (reason) => {
          setConnected(false);
          if (reason) setError(`Połączenie zamknięte${reason}`);
        },
        onError: (msg) => setError(msg),
        onReceiveResponse: (msg: GeminiLiveResponse) => {
          if (msg.type === 'SETUP_COMPLETE') return;

          if (msg.type === 'OUTPUT_TRANSCRIPTION' && typeof msg.data === 'object' && 'text' in msg.data) {
            const d = msg.data as { text: string; finished?: boolean };
            if (expectNewTurnRef.current) {
              expectNewTurnRef.current = false;
              setCurrentReply(d.text);
            } else {
              setCurrentReply((prev) => prev + d.text);
            }
            if (d.finished && !isWebAudio) nativeAudioPlayerRef.current?.finishTurn();
          }
          if (msg.type === 'INPUT_TRANSCRIPTION' && typeof msg.data === 'object' && 'text' in msg.data) {
            const d = msg.data as { text: string; finished?: boolean };
            setCurrentUserSpeech((prev) => (d.finished ? '' : prev + d.text));
          }
          if (msg.type === 'TURN_COMPLETE') {
            nativeAudioPlayerRef.current?.finishTurn();
            audioStreamerRef.current?.resume();
            // Nie czyścimy currentReply – haptyki kończą Braille. expectNewTurn = next OUTPUT replaces
            expectNewTurnRef.current = true;
            return;
          }
          if (msg.type === 'INTERRUPTED') {
            nativeAudioPlayerRef.current?.interrupt();
            audioStreamerRef.current?.resume();
            // Native: interrupt() wywołuje onPlayEnd → restoreRecordingMode + resume
            setCurrentReply('');
            setCurrentUserSpeech('');
            return;
          }
          if (msg.type === 'AUDIO' && typeof msg.data === 'string') {
            setCurrentUserSpeech('');
            if (isWebAudio) {
              audioStreamerRef.current?.pause();
              audioPlayerRef.current?.play(msg.data);
            } else {
              nativeAudioPlayerRef.current?.addChunk(msg.data);
            }
          }
        },
      });

      await svc.connect();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [isWebAudio, nativeRecorder]);

  const disconnect = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    letterTimersRef.current.forEach(clearTimeout);
    letterTimersRef.current = [];
    audioStreamerRef.current?.stop();
    audioStreamerRef.current = null;
    nativeStreamerRef.current?.stop();
    nativeStreamerRef.current = null;
    audioPlayerRef.current?.interrupt?.();
    nativeAudioPlayerRef.current?.interrupt();
    nativeAudioPlayerRef.current = null;
    captureIntervalRef.current && clearInterval(captureIntervalRef.current);
    serviceRef.current?.disconnect();
    serviceRef.current = null;
    setConnected(false);
    setCurrentReply('');
    setCurrentUserSpeech('');
    setWordIdx(0);
    setLetterIdx(0);
    setReadingDone(false);
    setActiveRow(null);
    setActiveField(null);
  }, []);

  const sendText = useCallback(() => {
    setInputText((t) => {
      const trimmed = t.trim();
      if (!trimmed || !serviceRef.current?.isConnected()) return t;
      Haptics.selectionAsync();
      serviceRef.current?.sendText(trimmed);
      return '';
    });
  }, []);

  useEffect(() => {
    if (!connected || !cameraPermission?.granted || Platform.OS === 'web') return;
    const interval = setInterval(async () => {
      if (!cameraRef.current || !serviceRef.current?.isConnected()) return;
      try {
        const photo = await cameraRef.current.takePictureAsync({
          quality: 0.7,
          base64: true,
          skipProcessing: true,
        });
        if (photo?.base64) serviceRef.current.sendVideoFrame(photo.base64);
      } catch {
        // Ignore
      }
    }, 1500);
    captureIntervalRef.current = interval;
    return () => {
      if (captureIntervalRef.current) clearInterval(captureIntervalRef.current);
    };
  }, [connected, cameraPermission?.granted, cameraFacing]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', () => {
      disconnect();
    });
    return unsubscribe;
  }, [navigation, disconnect]);

  if (Platform.OS !== 'web' && (!cameraPermission || !cameraPermission.granted)) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionGate}>
          <View style={styles.permissionIcon}>
            <Feather name="camera" size={48} color={Colors.primary} />
          </View>
          <Text style={styles.permissionTitle}>WORLD LENS</Text>
          <Text style={styles.permissionDesc}>
            HapticMind uses the camera to see your surroundings and describe them through haptic Braille patterns.
          </Text>
          {!cameraPermission ? (
            <View style={styles.permissionLoading}>
              <Text style={styles.permissionLoadingText}>Loading...</Text>
            </View>
          ) : cameraPermission.canAskAgain ? (
            <Pressable style={styles.permissionButton} onPress={requestCameraPermission}>
              <Text style={styles.permissionButtonText}>ENABLE CAMERA</Text>
            </Pressable>
          ) : (
            <Pressable
              style={styles.permissionButton}
              onPress={() => Linking.openSettings()}
            >
              <Text style={styles.permissionButtonText}>OPEN SETTINGS</Text>
            </Pressable>
          )}
          <Text style={styles.permissionHint}>
            {cameraPermission?.canAskAgain === false
              ? 'Camera was denied. Open settings to enable it.'
              : 'Camera access is required to continue.'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.statusBar, { marginTop: insets.top }]}>
          <Text style={styles.worldLensTitle}>WORLD LENS</Text>
          <View style={styles.statusRight}>
            <View style={styles.aiStatus}>
              <View
                style={[
                  styles.aiDot,
                  {
                    backgroundColor: heartPulse ? Colors.primary : 'rgba(255,255,0,0.25)',
                  },
                ]}
              />
              <Text style={styles.aiLabel}>AI</Text>
            </View>
            <View style={styles.liveStatus}>
              <Feather name="eye" size={12} color={Colors.zinc500} />
              <Text style={styles.liveLabel}>LIVE</Text>
            </View>
          </View>
        </View>

        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.push('/tutorial');
          }}
          style={[styles.practiceButton, { top: insets.top + 28 }]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Practice"
          accessibilityHint="Open letter training tutorial"
        >
          <Text style={styles.practiceText}>PRACTICE</Text>
        </Pressable>

        <View style={styles.cameraZone}>
          {Platform.OS !== 'web' && cameraPermission?.granted ? (
            <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={cameraFacing} />
          ) : null}

          <View style={styles.gridOverlay}>
            {Array(10)
              .fill(0)
              .map((_, i) => (
                <View
                  key={`h${i}`}
                  style={{
                    position: 'absolute',
                    top: `${(i + 1) * 10}%`,
                    left: 0,
                    right: 0,
                    height: 1,
                    backgroundColor: 'rgba(255,255,255,0.02)',
                  }}
                />
              ))}
            {Array(10)
              .fill(0)
              .map((_, i) => (
                <View
                  key={`v${i}`}
                  style={{
                    position: 'absolute',
                    left: `${(i + 1) * 10}%`,
                    top: 0,
                    bottom: 0,
                    width: 1,
                    backgroundColor: 'rgba(255,255,255,0.02)',
                  }}
                />
              ))}
          </View>

          {!connected ? (
            <View style={styles.holdContainer}>
              <Pressable
                style={styles.holdRingOuter}
                onPress={connect}
                accessibilityRole="button"
                accessibilityLabel="Connect to AI"
              >
                <Svg
                  width={76}
                  height={76}
                  viewBox="0 0 76 76"
                  style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}
                >
                  <Circle
                    cx="38"
                    cy="38"
                    r="34"
                    fill="none"
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth="3"
                  />
                </Svg>
                <View style={styles.holdInner}>
                  <Feather name="mic" size={20} color="rgba(255,255,255,0.25)" />
                </View>
              </Pressable>
              <Text style={styles.holdLabel}>PRESS TO CONNECT</Text>
            </View>
          ) : (
            <View style={styles.listenOverlay}>
              <View style={styles.listenBorder} />
              <View style={styles.readyView}>
                <View style={styles.voicePill}>
                  <Feather name="mic" size={16} color="rgba(255,255,0,0.6)" />
                  <ListenWave small />
                  <Text style={styles.voiceLabel}>Voice</Text>
                </View>
                {(currentUserSpeech || currentReply) && (
                  <View style={styles.transcriptOverlay}>
                    {currentUserSpeech ? (
                      <Text style={styles.overlayUser}>{currentUserSpeech}</Text>
                    ) : null}
                    {currentReply ? (
                      <Text style={styles.overlayAI} numberOfLines={4}>
                        {currentReply}
                      </Text>
                    ) : null}
                  </View>
                )}
              </View>
              <Pressable
                style={styles.cameraSwitch}
                onPress={() => {
                  Haptics.selectionAsync();
                  setCameraFacing((f) => (f === 'front' ? 'back' : 'front'));
                }}
              >
                <Text style={styles.cameraSwitchText}>
                  {cameraFacing === 'front' ? 'Tył' : 'Przód'}
                </Text>
              </Pressable>
            </View>
          )}
        </View>

        {error && (
          <View style={styles.errorBlock}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View
          style={[
            styles.bottomPanel,
            { paddingBottom: Math.max(insets.bottom, 8) },
          ]}
        >
          <View style={styles.bottomContent}>
            <View style={styles.leftCol}>
              <Text style={styles.leftLabel}>{connected ? 'AI' : 'NOW'}</Text>
              <View style={styles.leftCharBox}>
                <Text style={styles.leftChar}>{displayChar ?? '·'}</Text>
              </View>
              <BrailleMatrix dots={currentDots} activeRow={activeRow} activeField={activeField} />
              <View style={styles.leftStatusBadge}>
                <Text style={styles.leftStatusText}>
                  {connected ? 'listening' : 'ready'}
                </Text>
              </View>
            </View>

            <View style={styles.divider} />

            <View style={styles.rightCol}>
              <Text style={styles.rightLabel}>AI RESPONSE</Text>
              <View style={{ flex: 1, justifyContent: 'center' }}>
                <Text style={styles.aiResponseText}>
                  {currentReply || (
                    <Text style={{ color: Colors.zinc600 }}>
                      Połącz się i mów – AI opisze otoczenie.
                    </Text>
                  )}
                </Text>
              </View>

              {connected && (
                <View style={styles.inputRow}>
                  <TextInput
                    style={styles.textInput}
                    placeholder="Napisz wiadomość..."
                    placeholderTextColor={Colors.zinc600}
                    value={inputText}
                    onChangeText={setInputText}
                    onSubmitEditing={sendText}
                    returnKeyType="send"
                    blurOnSubmit={false}
                    editable={connected}
                  />
                  <Pressable style={styles.sendBtn} onPress={sendText} hitSlop={12}>
                    <Text style={styles.sendBtnText}>Wyślij</Text>
                  </Pressable>
                </View>
              )}

              {connected && (
                <Pressable style={styles.stopBtn} onPress={disconnect}>
                  <Text style={styles.stopBtnText}>STOP</Text>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#000000',
  },
  statusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingBottom: 4,
  },
  worldLensTitle: {
    color: Colors.primary,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 2.5,
  },
  statusRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  aiStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  aiDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  aiLabel: {
    color: Colors.zinc600,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1,
  },
  liveStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  liveLabel: {
    color: Colors.zinc500,
    fontSize: 10,
    fontWeight: '500',
  },
  practiceButton: {
    position: 'absolute',
    right: 20,
    zIndex: 30,
    height: 44,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  practiceText: {
    color: '#000000',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },
  cameraZone: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  permissionGate: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 20,
  },
  permissionIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(255,255,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  permissionTitle: {
    color: Colors.primary,
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 4,
  },
  permissionDesc: {
    color: Colors.zinc400,
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 22,
  },
  permissionButton: {
    height: 52,
    paddingHorizontal: 32,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  permissionButtonText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2,
  },
  permissionHint: {
    color: 'rgba(255,255,255,0.25)',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
  permissionLoading: {
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionLoadingText: {
    color: Colors.zinc400,
    fontSize: 14,
    fontWeight: '500',
  },
  gridOverlay: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.5,
  },
  holdContainer: {
    position: 'absolute',
    bottom: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 8,
  },
  holdRingOuter: {
    width: 76,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
  },
  holdInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  holdLabel: {
    fontSize: 8,
    fontWeight: '600',
    letterSpacing: 2,
    color: 'rgba(255,255,255,0.15)',
  },
  listenOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listenBorder: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    bottom: 12,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: 'rgba(255,255,0,0.2)',
  },
  readyView: {
    alignItems: 'center',
    gap: 16,
    flex: 1,
    justifyContent: 'center',
  },
  voicePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1,
    borderColor: Colors.zinc800,
  },
  voiceLabel: {
    color: Colors.zinc500,
    fontSize: 9,
    fontWeight: '500',
    letterSpacing: 1,
  },
  transcriptOverlay: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    maxWidth: '90%',
    gap: 6,
  },
  overlayUser: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    fontStyle: 'italic',
    lineHeight: 20,
  },
  overlayAI: {
    color: Colors.primary,
    fontSize: 16,
    lineHeight: 23,
    fontWeight: '500',
  },
  cameraSwitch: {
    position: 'absolute',
    top: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  cameraSwitchText: {
    color: Colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  errorBlock: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  errorText: {
    color: Colors.red,
    fontSize: 14,
  },
  bottomPanel: {
    backgroundColor: 'rgba(0,0,0,0.95)',
    borderTopWidth: 1,
    borderTopColor: Colors.zinc900,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  bottomContent: {
    flexDirection: 'row',
    gap: 16,
  },
  leftCol: {
    width: 100,
    alignItems: 'center',
    gap: 8,
  },
  leftLabel: {
    color: Colors.zinc600,
    fontSize: 8,
    fontWeight: '600',
    letterSpacing: 2,
  },
  leftCharBox: {
    width: 52,
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,0,0.4)',
    backgroundColor: 'rgba(255,255,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  leftChar: {
    color: Colors.primary,
    fontSize: 28,
    fontWeight: '700',
  },
  leftStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Colors.zinc800,
    backgroundColor: Colors.zinc950,
    width: '100%',
    alignItems: 'center',
    marginTop: 4,
  },
  leftStatusText: {
    color: Colors.zinc500,
    fontSize: 8,
    fontWeight: '400',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  divider: {
    width: 1,
    backgroundColor: Colors.zinc900,
  },
  rightCol: {
    flex: 1,
    gap: 8,
  },
  rightLabel: {
    color: Colors.zinc600,
    fontSize: 8,
    fontWeight: '600',
    letterSpacing: 2,
  },
  aiResponseText: {
    fontSize: 20,
    lineHeight: 28,
    color: Colors.primary,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  textInput: {
    flex: 1,
    minWidth: 0,
    backgroundColor: Colors.zinc900,
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: Colors.zinc800,
  },
  sendBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 48,
  },
  sendBtnText: {
    color: '#000000',
    fontWeight: '600',
  },
  stopBtn: {
    backgroundColor: Colors.red,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  stopBtnText: {
    color: '#fff',
    fontWeight: '700',
    letterSpacing: 2,
  },
});
