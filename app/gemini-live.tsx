import { CameraView, useCameraPermissions } from 'expo-camera';
import { useNavigation } from 'expo-router';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
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

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || '';
const IS_WEB = Platform.OS === 'web';

/** Mikrofon głosowy: tylko iOS (urządzenie fizyczne). Android i symulator – brak wsparcia (expo-av). */
const IS_IOS = Platform.OS === 'ios';
const IS_ANDROID = Platform.OS === 'android';

export default function GeminiLiveScreen() {
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [connected, setConnected] = useState(false);
  const [currentReply, setCurrentReply] = useState('');
  const [currentUserSpeech, setCurrentUserSpeech] = useState('');
  const [inputText, setInputText] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isWebAudio] = useState(Platform.OS === 'web');
  const [micPermission, setMicPermission] = useState<'checking' | 'granted' | 'denied' | null>(null);
  const [cameraFacing, setCameraFacing] = useState<'front' | 'back'>('front');

  const serviceRef = useRef<GeminiLiveService | null>(null);
  const audioStreamerRef = useRef<WebAudioStreamer | null>(null);
  const nativeStreamerRef = useRef<NativeAudioStreamer | null>(null);
  const isPlayingRef = useRef(false);
  const audioPlayerRef = useRef<WebAudioPlayer | null>(null);
  const nativeAudioPlayerRef = useRef<NativeAudioPlayer | null>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cameraRef = useRef<CameraView | null>(null);

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
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const svc = new GeminiLiveService(API_KEY);
      serviceRef.current = svc;

      if (isWebAudio) {
        audioPlayerRef.current = new WebAudioPlayer();
      } else {
        nativeAudioPlayerRef.current = new NativeAudioPlayer({
          onPlayStart: () => { isPlayingRef.current = true; setIsPlaying(true); },
          onPlayEnd: () => { isPlayingRef.current = false; setIsPlaying(false); },
        });
      }

      svc.setCallbacks({
        onOpen: () => setConnected(true),

        onSetupComplete: () => {
          if (isWebAudio) {
            const streamer = new WebAudioStreamer(
              (base64) => svc.sendAudio(base64),
            );
            audioStreamerRef.current = streamer;
            streamer.start().catch((e) => setError('Mikrofon: ' + (e as Error).message));
          } else {
            const streamer = new NativeAudioStreamer((base64) => svc.sendAudio(base64));
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
          if (msg.type === 'SETUP_COMPLETE') return;

          if (msg.type === 'OUTPUT_TRANSCRIPTION' && typeof msg.data === 'object' && 'text' in msg.data) {
            const d = msg.data as { text: string; finished?: boolean };
            setCurrentReply((prev) => prev + d.text);
            if (d.finished && !isWebAudio) nativeAudioPlayerRef.current?.finishTurn();
          }
          if (msg.type === 'INPUT_TRANSCRIPTION' && typeof msg.data === 'object' && 'text' in msg.data) {
            const d = msg.data as { text: string; finished?: boolean };
            setCurrentUserSpeech((prev) => prev + d.text);
            if (d.finished) setCurrentUserSpeech('');
          }
          if (msg.type === 'TURN_COMPLETE') {
            nativeAudioPlayerRef.current?.finishTurn();
            setCurrentReply('');
            return;
          }
          if (msg.type === 'INTERRUPTED') {
            nativeAudioPlayerRef.current?.interrupt();
            setCurrentReply('');
            setCurrentUserSpeech('');
            return;
          }
          if (msg.type === 'AUDIO' && typeof msg.data === 'string') {
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
  }, [isWebAudio]);

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
    setCurrentReply('');
    setCurrentUserSpeech('');
    setIsPlaying(false);
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

  // Wysyła klatki z aktualnie wybranej kamery (front/back) do Gemini
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
  }, [connected, cameraPermission?.granted, cameraFacing]);

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
      >
        {/* Kamera z overlayem transkrypcji */}
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
            <CameraView ref={cameraRef} style={styles.camera} facing={cameraFacing} />

            <Pressable
              style={styles.cameraSwitch}
              onPress={() => {
                Haptics.selectionAsync();
                setCameraFacing((f) => (f === 'front' ? 'back' : 'front'));
              }}
            >
              <Text style={styles.cameraSwitchText}>
                {cameraFacing === 'front' ? '📷 Tył' : '📷 Przód'}
              </Text>
            </Pressable>

            {connected && (currentUserSpeech || currentReply) && (
              <View style={styles.transcriptOverlay}>
                {currentUserSpeech ? (
                  <Text style={styles.overlayUser}>{currentUserSpeech}</Text>
                ) : null}
                {currentReply ? (
                  <Text style={styles.overlayAI}>{currentReply}</Text>
                ) : null}
              </View>
            )}
          </View>
        )}

        {/* Kontrolki */}
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

          {error && <Text style={styles.errorText}>{error}</Text>}

          {connected && (
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
          )}
        </View>
      </KeyboardAvoidingView>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
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
    minHeight: 300,
    position: 'relative',
  },
  camera: {
    flex: 1,
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
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  transcriptOverlay: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 16,
    padding: 14,
    gap: 6,
  },
  overlayUser: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    fontStyle: 'italic',
    lineHeight: 20,
  },
  overlayAI: {
    color: '#fff',
    fontSize: 16,
    lineHeight: 23,
    fontWeight: '500',
  },
  controls: {
    padding: 16,
    gap: 12,
    backgroundColor: '#111',
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
});
