import { CameraView, useCameraPermissions } from 'expo-camera';
import { useNavigation } from 'expo-router';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

import { GeminiLiveService } from '@/services/gemini-live';
import type { GeminiLiveResponse } from '@/services/gemini-live';
import { NativeAudioPlayer } from '@/utils/gemini-audio-native';
import { NativeAudioStreamer } from '@/utils/gemini-media-native';
import { WebAudioPlayer, WebAudioStreamer } from '@/utils/gemini-media-web';

// ── Waveform ──────────────────────────────────────────────────────────────────
const NUM_BARS = 16;
const BAR_MAX_H = 36;
const BAR_MIN_H = 2;
const SPEAKING_THRESHOLD = 0.12; // poniżej = cisza (szum tła iPhone)

function MicWaveform({ level }: { level: number }) {
  const anims = useRef(
    Array.from({ length: NUM_BARS }, () => new Animated.Value(BAR_MIN_H))
  ).current;

  useEffect(() => {
    const active = level > SPEAKING_THRESHOLD;
    Animated.parallel(
      anims.map((anim, i) => {
        // prosty sinusoidalny wzorzec amplitudy – różne wysokości słupków
        const mult = 0.4 + Math.abs(Math.sin(i * 1.9)) * 0.6;
        const target = active ? BAR_MIN_H + (BAR_MAX_H - BAR_MIN_H) * Math.min(1, level * mult) : BAR_MIN_H;
        return Animated.timing(anim, { toValue: target, duration: 100, useNativeDriver: false });
      })
    ).start();
  }, [level]);

  const active = level > SPEAKING_THRESHOLD;
  return (
    <View style={waveStyles.container}>
      {anims.map((anim, i) => (
        <Animated.View key={i} style={[waveStyles.bar, { height: anim, opacity: active ? 1 : 0.2 }]} />
      ))}
    </View>
  );
}

const waveStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', height: BAR_MAX_H + 8, gap: 3 },
  bar: { flex: 1, backgroundColor: '#0a7ea4', borderRadius: 3, minHeight: BAR_MIN_H },
});

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || '';
const IS_WEB = Platform.OS === 'web';

/** Mikrofon głosowy: tylko iOS (urządzenie fizyczne). Android i symulator – brak wsparcia (expo-av). */
const IS_IOS = Platform.OS === 'ios';
const IS_ANDROID = Platform.OS === 'android';

export default function GeminiLiveScreen() {
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [connected, setConnected] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [currentReply, setCurrentReply] = useState('');
  const [inputText, setInputText] = useState('');
  const [micLevel, setMicLevel] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [waitingForResponse, setWaitingForResponse] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isWebAudio] = useState(Platform.OS === 'web');
  const [micPermission, setMicPermission] = useState<'checking' | 'granted' | 'denied' | null>(null);
  const [micStatus, setMicStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const serviceRef = useRef<GeminiLiveService | null>(null);
  const audioStreamerRef = useRef<WebAudioStreamer | null>(null);
  const nativeStreamerRef = useRef<NativeAudioStreamer | null>(null);
  const isPlayingRef = useRef(false);
  const audioPlayerRef = useRef<WebAudioPlayer | null>(null);
  const nativeAudioPlayerRef = useRef<NativeAudioPlayer | null>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cameraRef = useRef<CameraView | null>(null);

  const onMicLevel = useCallback((level: number) => {
    setMicLevel(level);
  }, []);

  useEffect(() => {
    if (IS_WEB) return;
    setMicPermission('checking');
    Audio.getPermissionsAsync()
      .then((r) => setMicPermission(r.granted ? 'granted' : 'denied'))
      .catch(() => setMicPermission('denied'));
  }, []);

  const connect = useCallback(async () => {
    if (!API_KEY) {
      setError('Ustaw EXPO_PUBLIC_GEMINI_API_KEY w .env');
      return;
    }
    if (!isWebAudio && IS_IOS) {
      const { granted } = await Audio.requestPermissionsAsync();
      setMicPermission(granted ? 'granted' : 'denied');
      if (!granted) {
        setError('Potrzebny dostęp do mikrofonu – włącz w Ustawieniach');
        return;
      }
    }
    setError(null);
    setMicStatus('idle');
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const svc = new GeminiLiveService(API_KEY);
      serviceRef.current = svc;

      if (isWebAudio) {
        audioPlayerRef.current = new WebAudioPlayer();
      } else {
        nativeAudioPlayerRef.current = new NativeAudioPlayer({
          onPlayStart: () => { isPlayingRef.current = true; setIsPlaying(true); setMicLevel(0); },
          onPlayEnd: () => { isPlayingRef.current = false; setIsPlaying(false); },
        });
      }

      svc.setCallbacks({
        onOpen: () => {
          setConnected(true);
          if (isWebAudio) {
            const streamer = new WebAudioStreamer(
              (base64) => svc.sendAudio(base64),
              onMicLevel
            );
            audioStreamerRef.current = streamer;
            streamer.start().catch((e) => setError('Mikrofon: ' + (e as Error).message));
          } else {
            const streamer = new NativeAudioStreamer(
              (base64) => svc.sendAudio(base64),
              onMicLevel,
              () => !isPlayingRef.current // nie nagrywaj podczas odtwarzania odpowiedzi
            );
            nativeStreamerRef.current = streamer;
            streamer.start().catch((e) => setError('Mikrofon: ' + (e as Error).message));
          }
        },
        onClose: (reason) => {
          setConnected(false);
          if (reason) setError(`Połączenie zamknięte${reason}`);
        },
        onError: (msg) => setError(msg),
        onReceiveResponse: (msg: GeminiLiveResponse) => {
          if (msg.type === 'SETUP_COMPLETE') {
            // Opóźnienie, żeby streamer mikrofonu zdążył ustawić tryb nagrywania (unika race z setPlaybackMode)
            setTimeout(() => svc.sendText('Cześć!'), 800);
            return;
          }
          if (msg.type === 'OUTPUT_TRANSCRIPTION' && typeof msg.data === 'object' && 'text' in msg.data) {
            const d = msg.data as { text: string; finished?: boolean };
            setWaitingForResponse(false);
            if (d.finished) {
              setTranscript((t) => t + d.text + '\n');
              setCurrentReply('');
              if (!isWebAudio) nativeAudioPlayerRef.current?.finishTurn();
            } else {
              setCurrentReply(d.text);
            }
          }
          if (msg.type === 'INPUT_TRANSCRIPTION' && typeof msg.data === 'object' && 'text' in msg.data) {
            const d = msg.data as { text: string; finished?: boolean };
            if (d.finished && d.text) setTranscript((t) => t + '[Ty] ' + d.text + '\n');
            if (d.finished) setWaitingForResponse(true); // Gemini wykrył koniec mowy
          }
          if (msg.type === 'TURN_COMPLETE') {
            nativeAudioPlayerRef.current?.finishTurn();
            setWaitingForResponse(false);
            return;
          }
          if (msg.type === 'INTERRUPTED') {
            nativeAudioPlayerRef.current?.interrupt();
            return;
          }
          if (msg.type === 'AUDIO' && typeof msg.data === 'string') {
            setWaitingForResponse(false);
            if (isWebAudio) {
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
  }, [isWebAudio, onMicLevel]);

  const disconnect = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
    setTranscript('');
    setCurrentReply('');
    setIsPlaying(false);
    setWaitingForResponse(false);
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
        // Ignore frame errors
      }
    }, 1500);
    captureIntervalRef.current = interval;
    return () => {
      if (captureIntervalRef.current) clearInterval(captureIntervalRef.current);
    };
  }, [connected, cameraPermission?.granted]);

  const onRequestCamera = useCallback(async () => {
    const { granted } = await requestCameraPermission();
    if (!granted) {
      Alert.alert('Potrzebna jest zgoda na kamerę');
    }
  }, [requestCameraPermission]);

  const navigation = useNavigation();
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', () => {
      disconnect();
    });
    return unsubscribe;
  }, [navigation, disconnect]);

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.scrollContent}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
        >
        {!IS_WEB && !cameraPermission?.granted && (
          <View style={styles.permissionBlock}>
            <Text style={styles.permissionText}>Potrzebna zgoda na kamerę</Text>
            <Pressable style={styles.primaryBtn} onPress={onRequestCamera}>
              <Text style={styles.primaryBtnText}>Udostępnij kamerę</Text>
            </Pressable>
          </View>
        )}

        {!IS_WEB && cameraPermission?.granted && (
          <View style={styles.cameraWrap}>
            <CameraView
              ref={cameraRef}
              style={styles.camera}
              facing="front"
            />
          </View>
        )}

        <View style={styles.controls}>
          {!connected ? (
            <Pressable style={styles.primaryBtn} onPress={connect}>
              <Text style={styles.primaryBtnText}>Start</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.stopBtn} onPress={disconnect}>
              <Text style={styles.stopBtnText}>Stop</Text>
            </Pressable>
          )}

          {error && (
            <Text style={styles.errorText}>{error}</Text>
          )}

          {connected && (
            <>
              {/* Wizualizacja mikrofonu – fala dźwiękowa */}
              <View style={styles.micSection}>
                <View style={styles.micHeader}>
                  <Text style={styles.micLabel}>Mikrofon</Text>
                  <View style={[styles.hearingBadge, micLevel > SPEAKING_THRESHOLD && styles.hearingBadgeActive]}>
                    <Text style={styles.hearingText}>
                      {micLevel > SPEAKING_THRESHOLD ? '🎤 Słyszę Cię' : '🎤 Cisza'}
                    </Text>
                  </View>
                </View>

                {/* Fala dźwiękowa */}
                <MicWaveform level={micLevel} />

                {/* Tryb: nagrywanie / wysłano / odtwarzanie */}
                {!isWebAudio && (
                  <View style={[
                    styles.modeBadge,
                    isPlaying && styles.modeBadgePlaying,
                    waitingForResponse && styles.modeBadgeWaiting,
                  ]}>
                    <Text style={styles.modeBadgeText}>
                      {isPlaying
                        ? '🔊 Odtwarzanie (głośnik)'
                        : waitingForResponse
                          ? '📤 Wysłano – czekam na odpowiedź'
                          : '🎤 Mów – zatrzymaj się na ~1,5 s ciszy'}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={styles.hint}>
                {Platform.OS === 'web'
                  ? 'Mów do mikrofonu lub wpisz poniżej i naciśnij Wyślij'
                  : Platform.OS === 'ios'
                    ? 'Mów do mikrofonu lub wpisz i naciśnij Wyślij'
                    : 'Wpisz wiadomość i naciśnij Wyślij'}
              </Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.textInput}
                  placeholder="Napisz wiadomość..."
                  placeholderTextColor="#888"
                  value={inputText}
                  onChangeText={setInputText}
                  onSubmitEditing={sendText}
                  onKeyPress={
                    Platform.OS === 'web'
                      ? (e) => {
                          const ev = e.nativeEvent as { key: string; shiftKey?: boolean };
                          if (ev.key === 'Enter' && !ev.shiftKey) {
                            e.preventDefault();
                            sendText();
                          }
                        }
                      : undefined
                  }
                  returnKeyType="send"
                  blurOnSubmit={false}
                  multiline={!IS_WEB}
                  editable={connected}
                />
                <Pressable style={styles.sendBtn} onPress={sendText} hitSlop={12}>
                  <Text style={styles.sendBtnText}>Wyślij</Text>
                </Pressable>
              </View>
            </>
          )}

          {connected && (
            <View style={styles.transcriptWrap}>
              <Text style={styles.transcriptLabel}>Rozmowa:</Text>
              <ScrollView
                style={styles.transcriptScroll}
                contentContainerStyle={styles.transcriptContent}
                nestedScrollEnabled
                showsVerticalScrollIndicator={true}
              >
                <Text style={styles.transcriptText}>
                  {transcript || currentReply ? transcript + currentReply : 'Czekam na odpowiedź...'}
                </Text>
              </ScrollView>
            </View>
          )}
        </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 24,
  },
  micSection: {
    backgroundColor: '#222',
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  micHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  micLabel: {
    color: '#888',
    fontSize: 12,
  },
  hearingBadge: {
    backgroundColor: '#333',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  hearingBadgeActive: {
    backgroundColor: '#0a7ea4',
  },
  hearingText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  modeBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#333',
  },
  modeBadgePlaying: {
    backgroundColor: '#1a5f7a',
  },
  modeBadgeWaiting: {
    backgroundColor: '#2d5a3d',
  },
  modeBadgeText: {
    color: '#aaa',
    fontSize: 12,
  },
  permissionBlock: {
    padding: 24,
    alignItems: 'center',
    gap: 12,
  },
  permissionText: {
    color: '#fff',
    fontSize: 16,
  },
  cameraWrap: {
    flex: 1,
    minHeight: 200,
  },
  camera: {
    flex: 1,
  },
  controls: {
    padding: 16,
    gap: 12,
    backgroundColor: '#1a1a1a',
  },
  primaryBtn: {
    backgroundColor: '#0a7ea4',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 18,
  },
  stopBtn: {
    backgroundColor: '#c41e3a',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  stopBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 18,
  },
  hint: {
    color: '#aaa',
    fontSize: 13,
  },
  errorText: {
    color: '#f44336',
    fontSize: 14,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  textInput: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#333',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  sendBtn: {
    backgroundColor: '#0a7ea4',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 48,
  },
  sendBtnText: {
    color: '#fff',
    fontWeight: '600',
  },
  transcriptWrap: {
    flex: 1,
    minHeight: 200,
    maxHeight: 320,
    backgroundColor: '#222',
    borderRadius: 8,
    padding: 12,
  },
  transcriptScroll: {
    flex: 1,
  },
  transcriptContent: {
    flexGrow: 1,
  },
  transcriptLabel: {
    color: '#888',
    fontSize: 12,
    marginBottom: 6,
  },
  transcriptText: {
    color: '#eee',
    fontSize: 15,
    lineHeight: 22,
  },
});
