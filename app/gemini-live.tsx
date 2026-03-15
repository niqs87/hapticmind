import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { InputMode } from "@/components/InputChooserModal";
import { InputChooserModal } from "@/components/InputChooserModal";
import {
  BRAILLE_MAP,
  CHAR_RESET,
  computeAdaptiveThreshold,
  DEFAULT_THRESHOLD,
  dotsToChar,
  READ_CHARACTER_GAP,
  READ_FIELD_DURATION,
  READ_ROW_GAP,
  ROW_DOTS,
  SEND_TIMEOUT,
  TAP_DOT_ORDER,
  VIBRATION_PULSE,
} from "@/constants/braille";
import { Colors } from "@/constants/colors";
import type { GeminiLiveResponse } from "@/services/gemini-live";
import { GeminiLiveService } from "@/services/gemini-live";
import { NativeAudioPlayer } from "@/utils/gemini-audio-native";
import { NativeAudioStreamer } from "@/utils/gemini-media-native";
import { WebAudioPlayer, WebAudioStreamer } from "@/utils/gemini-media-web";

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || "";
const IS_WEB = Platform.OS === "web";

/** Włącz w konsoli Metro/Expo, aby debugować audio hold-to-speak */
const DEBUG_AUDIO = __DEV__;

type Dots = [boolean, boolean, boolean, boolean, boolean, boolean];

function BrailleMatrix({
  dots,
  activeRow,
  activeField,
  scanRow,
  tapDots,
  waitingRow,
  waitingField,
}: {
  dots: Dots | null;
  activeRow: number | null;
  activeField: "left" | "right" | null;
  scanRow?: number | null;
  tapDots?: boolean[];
  waitingRow?: number | null;
  waitingField?: "left" | "right" | null;
}) {
  const DOT_SIZE = 24;
  const COL_GAP = 12;
  const R_GAP = 12;

  return (
    <View style={{ gap: R_GAP }}>
      {ROW_DOTS.map(([leftIdx, rightIdx], ri) => {
        const rowFiring = activeRow === ri;
        const scanning = scanRow === ri;
        const leftActive = dots ? dots[leftIdx] : false;
        const rightActive = dots ? dots[rightIdx] : false;
        const firingLeft = rowFiring && activeField === "left";
        const firingRight = rowFiring && activeField === "right";
        const tapLeft = tapDots ? tapDots[leftIdx] : false;
        const tapRight = tapDots ? tapDots[rightIdx] : false;
        const isWaitingLeft = waitingRow === ri && waitingField === "left";
        const isWaitingRight = waitingRow === ri && waitingField === "right";

        const getDotStyle = (
          active: boolean,
          firing: boolean,
          tapped: boolean,
          waiting: boolean,
        ) => ({
          width: DOT_SIZE,
          height: DOT_SIZE,
          borderRadius: DOT_SIZE / 2,
          backgroundColor: tapped
            ? Colors.primary
            : waiting
              ? "rgba(255,255,0,0.25)"
              : scanning
                ? "rgba(255,255,0,0.6)"
                : firing && active
                  ? Colors.primary
                  : active
                    ? "rgba(255,255,0,0.35)"
                    : "#1c1c1e",
          borderWidth: active || tapped || waiting ? 0 : 1,
          borderColor: Colors.zinc800,
        });

        return (
          <View
            key={ri}
            style={{ flexDirection: "row", alignItems: "center", gap: COL_GAP }}
          >
            <Text
              style={{
                fontSize: 8,
                width: 10,
                textAlign: "right",
                color:
                  rowFiring ||
                  scanning ||
                  tapLeft ||
                  tapRight ||
                  isWaitingLeft ||
                  isWaitingRight
                    ? Colors.primary
                    : Colors.zinc700,
              }}
            >
              {ri + 1}
            </Text>
            <View
              style={getDotStyle(
                leftActive,
                firingLeft,
                tapLeft,
                isWaitingLeft,
              )}
            />
            <View
              style={getDotStyle(
                rightActive,
                firingRight,
                tapRight,
                isWaitingRight,
              )}
            />
          </View>
        );
      })}
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
  const [currentReply, setCurrentReply] = useState("");
  const [currentUserSpeech, setCurrentUserSpeech] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isWebAudio] = useState(IS_WEB);
  const [, setMicPermission] = useState<
    "checking" | "granted" | "denied" | null
  >(null);
  const [cameraFacing, setCameraFacing] = useState<"front" | "back">("back");
  const [heartPulse, setHeartPulse] = useState(false);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [activeField, setActiveField] = useState<"left" | "right" | null>(null);
  const [wordIdx, setWordIdx] = useState(0);
  const [letterIdx, setLetterIdx] = useState(0);
  const [readingDone, setReadingDone] = useState(false);

  const letterTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const serviceRef = useRef<GeminiLiveService | null>(null);
  const audioStreamerRef = useRef<WebAudioStreamer | null>(null);
  const nativeStreamerRef = useRef<NativeAudioStreamer | null>(null);
  const audioPlayerRef = useRef<WebAudioPlayer | null>(null);
  const nativeAudioPlayerRef = useRef<NativeAudioPlayer | null>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const cameraRef = useRef<CameraView | null>(null);

  const [inputMode, setInputMode] = useState<InputMode | null>(null);
  const [chooserVisible, setChooserVisible] = useState(true);
  const inputChosen = inputMode !== null;

  // --- Listen mode (tapping / mic / keyboard) ---
  const [listenMode, setListenMode] = useState(false);
  const listenModeRef = useRef(false);
  useEffect(() => {
    listenModeRef.current = listenMode;
  }, [listenMode]);

  const [listenPhase, setListenPhase] = useState<
    "ready" | "tapping" | "sending" | "received" | null
  >(null);
  const [scanRow, setScanRow] = useState<number | null>(null);

  // --- Tap state ---
  const [tapDots, setTapDots] = useState<boolean[]>(Array(6).fill(false));
  const [inputPos, setInputPos] = useState(-1);
  const [charCount, setCharCount] = useState(0);
  const [decodedText, setDecodedText] = useState("");
  const decodedTextRef = useRef("");
  const [lastDecodedChar, setLastDecodedChar] = useState<string | null>(null);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tapThreshold, setTapThreshold] = useState(DEFAULT_THRESHOLD);
  const tapDurationsRef = useRef<number[]>([]);
  const tapDownTimeRef = useRef<number | null>(null);
  const [currentPressDur, setCurrentPressDur] = useState(0);
  const pressAnimRef = useRef<number | null>(null);
  const finishTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const demoTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // --- Mic state ---
  const [micHolding, setMicHolding] = useState(false);
  const micHoldingRef = useRef(false);
  useEffect(() => {
    micHoldingRef.current = micHolding;
  }, [micHolding]);
  const micReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioBufferRef = useRef<string[]>([]);
  const chunksFromMicRef = useRef(0);

  // --- Keyboard state ---
  const [keyboardMode, setKeyboardMode] = useState(false);
  const [keyboardText, setKeyboardText] = useState("");
  const textInputRef = useRef<TextInput>(null);
  const kbFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const waitingRow =
    inputPos >= 0 && inputPos < 6 ? Math.floor(inputPos / 2) : null;
  const waitingField =
    inputPos >= 0 && inputPos < 6
      ? inputPos % 2 === 0
        ? ("left" as const)
        : ("right" as const)
      : null;

  const words = currentReply.trim().split(/\s+/).filter(Boolean);
  const currentWord = words[wordIdx] ?? "";
  const wordChars = currentWord
    .split("")
    .map((c) => c.toUpperCase())
    .filter((c) => c in BRAILLE_MAP);
  const currentChar = wordChars[letterIdx] ?? null;
  const readingDots: Dots | null =
    currentChar && currentChar in BRAILLE_MAP ? BRAILLE_MAP[currentChar] : null;
  const lastChar = currentReply.trim().slice(-1).toUpperCase() || null;
  const displayChar = currentChar ?? lastChar ?? null;
  const currentDots: Dots | null =
    readingDots ??
    (lastChar && lastChar in BRAILLE_MAP ? BRAILLE_MAP[lastChar] : null);

  const pressing = tapDownTimeRef.current !== null;
  const pressIsLong = currentPressDur >= tapThreshold;

  const LETTER_MS =
    READ_FIELD_DURATION * 2 +
    READ_ROW_GAP +
    READ_FIELD_DURATION * 2 +
    READ_ROW_GAP +
    READ_FIELD_DURATION * 2 +
    READ_CHARACTER_GAP / 2;

  // --- Flush audio buffer (mic) ---
  const flushAudioBufferAndEnd = useCallback(() => {
    const chunks = audioBufferRef.current;
    audioBufferRef.current = [];
    if (DEBUG_AUDIO) console.log("[Audio] flush:", chunks.length, "chunks, connected:", !!serviceRef.current?.isConnected());
    if (!serviceRef.current?.isConnected()) return;
    for (const base64 of chunks) {
      serviceRef.current.sendAudio(base64);
    }
    serviceRef.current.sendAudioStreamEnd();
    serviceRef.current.sendActivityEnd();
  }, []);

  // --- Mic permission ---
  useEffect(() => {
    if (IS_WEB) return;
    setMicPermission("checking");
    import("@speechmatics/expo-two-way-audio")
      .then(({ getMicrophonePermissionsAsync }) => getMicrophonePermissionsAsync())
      .then((r) => setMicPermission(r.granted ? "granted" : "denied"))
      .catch(() => setMicPermission("denied"));
  }, []);

  // --- Heartbeat ---
  const heartbeatActiveRef = useRef(false);
  useEffect(() => {
    heartbeatActiveRef.current = connected && !listenMode && !keyboardMode;
  }, [connected, listenMode, keyboardMode]);

  useEffect(() => {
    if (!screenReady) return;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const id = setInterval(() => {
      setHeartPulse(true);
      if (Platform.OS !== "web" && heartbeatActiveRef.current) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        timeouts.push(
          setTimeout(
            () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
            120,
          ),
        );
      }
      timeouts.push(setTimeout(() => setHeartPulse(false), 400));
    }, 4000);
    return () => {
      clearInterval(id);
      timeouts.forEach(clearTimeout);
    };
  }, [screenReady]);

  // --- Reply word/letter reading ---
  useEffect(() => {
    if (!currentReply.trim()) {
      setWordIdx(0);
      setLetterIdx(0);
      setReadingDone(false);
    } else {
      const w = currentReply.trim().split(/\s+/).filter(Boolean);
      setReadingDone((done) => (done && w.length > wordIdx ? false : done));
    }
  }, [currentReply]);

  useEffect(() => {
    if (
      !screenReady ||
      !connected ||
      listenMode ||
      keyboardMode ||
      readingDone ||
      !currentReply.trim()
    )
      return;
    const w = currentReply.split(/\s+/).filter(Boolean);
    if (w.length === 0) return;
    const wc =
      w[wordIdx]
        ?.split("")
        .map((c) => c.toUpperCase())
        .filter((c) => c in BRAILLE_MAP) ?? [];
    const advanceWord = () => {
      if (wordIdx >= w.length - 1) {
        setReadingDone(true);
      } else {
        setWordIdx((wi) => wi + 1);
        setLetterIdx(0);
      }
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (wc.length === 0) {
      timers.push(setTimeout(advanceWord, 50));
    } else {
      for (let i = 1; i < wc.length; i++) {
        timers.push(setTimeout(() => setLetterIdx(i), i * LETTER_MS));
      }
      const wordDuration = wc.length * LETTER_MS + READ_CHARACTER_GAP;
      timers.push(setTimeout(advanceWord, wordDuration));
    }
    return () => timers.forEach(clearTimeout);
  }, [
    wordIdx,
    currentReply,
    connected,
    screenReady,
    listenMode,
    keyboardMode,
    readingDone,
  ]);

  // --- Haptic reading per letter ---
  useEffect(() => {
    if (
      !screenReady ||
      !connected ||
      listenMode ||
      keyboardMode ||
      readingDone ||
      !currentReply.trim()
    )
      return;
    letterTimersRef.current.forEach(clearTimeout);
    letterTimersRef.current = [];
    const w = currentReply.split(/\s+/).filter(Boolean);
    const wc =
      w[wordIdx]
        ?.split("")
        .map((c) => c.toUpperCase())
        .filter((c) => c in BRAILLE_MAP) ?? [];
    const ch = wc[letterIdx];
    const d: Dots | null = ch && ch in BRAILLE_MAP ? BRAILLE_MAP[ch] : null;
    const rows = d
      ? [
          [d[0], d[3]],
          [d[1], d[4]],
          [d[2], d[5]],
        ]
      : [];
    const fieldHaptic = async (filled: boolean) => {
      if (Platform.OS === "web") return;
      if (filled) {
        if (Platform.OS === "android") Vibration.vibrate(VIBRATION_PULSE);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
      } else {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    };
    let cum = 0;
    const sched = [
      {
        delay: cum,
        fn: () => {
          setActiveRow(0);
          setActiveField("left");
          if (rows[0]) fieldHaptic(rows[0][0]);
        },
      },
      {
        delay: (cum += READ_FIELD_DURATION),
        fn: () => {
          setActiveRow(0);
          setActiveField("right");
          if (rows[0]) fieldHaptic(rows[0][1]);
        },
      },
      {
        delay: (cum += READ_FIELD_DURATION),
        fn: () => {
          setActiveRow(null);
          setActiveField(null);
        },
      },
      {
        delay: (cum += READ_ROW_GAP),
        fn: () => {
          setActiveRow(1);
          setActiveField("left");
          if (rows[1]) fieldHaptic(rows[1][0]);
        },
      },
      {
        delay: (cum += READ_FIELD_DURATION),
        fn: () => {
          setActiveRow(1);
          setActiveField("right");
          if (rows[1]) fieldHaptic(rows[1][1]);
        },
      },
      {
        delay: (cum += READ_FIELD_DURATION),
        fn: () => {
          setActiveRow(null);
          setActiveField(null);
        },
      },
      {
        delay: (cum += READ_ROW_GAP),
        fn: () => {
          setActiveRow(2);
          setActiveField("left");
          if (rows[2]) fieldHaptic(rows[2][0]);
        },
      },
      {
        delay: (cum += READ_FIELD_DURATION),
        fn: () => {
          setActiveRow(2);
          setActiveField("right");
          if (rows[2]) fieldHaptic(rows[2][1]);
        },
      },
      {
        delay: (cum += READ_FIELD_DURATION),
        fn: () => {
          setActiveRow(null);
          setActiveField(null);
        },
      },
    ];
    sched.forEach(({ delay, fn }) =>
      letterTimersRef.current.push(setTimeout(fn, delay)),
    );
    return () => letterTimersRef.current.forEach(clearTimeout);
  }, [
    letterIdx,
    wordIdx,
    currentReply,
    connected,
    screenReady,
    listenMode,
    keyboardMode,
    readingDone,
  ]);

  // --- Scan row animation in listen "ready" phase ---
  useEffect(() => {
    if (!listenMode || listenPhase !== "ready") {
      setScanRow(null);
      return;
    }
    let r = 0;
    const id = setInterval(() => {
      setScanRow(r % 3);
      r++;
    }, 200);
    return () => {
      clearInterval(id);
      setScanRow(null);
    };
  }, [listenMode, listenPhase]);

  // --- Tap: decode character when 6 dots entered ---
  useEffect(() => {
    if (inputPos !== 6) return;
    const ch = dotsToChar(tapDots);
    setLastDecodedChar(ch);
    setDecodedText((prev) => {
      const next = prev + ch;
      decodedTextRef.current = next;
      return next;
    });
    setCharCount((c) => c + 1);
    if (Platform.OS !== "web")
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const t = setTimeout(() => {
      setTapDots(Array(6).fill(false));
      setInputPos(-1);
    }, CHAR_RESET);
    return () => clearTimeout(t);
  }, [inputPos, tapDots]);

  // --- Cleanup ---
  useEffect(() => {
    return () => {
      letterTimersRef.current.forEach(clearTimeout);
      if (pressAnimRef.current) cancelAnimationFrame(pressAnimRef.current);
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
      if (kbFocusTimer.current) clearTimeout(kbFocusTimer.current);
      if (micReleaseTimerRef.current) clearTimeout(micReleaseTimerRef.current);
      finishTimers.current.forEach(clearTimeout);
      demoTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  // --- Interrupt all ---
  const interruptAll = useCallback(() => {
    letterTimersRef.current.forEach(clearTimeout);
    letterTimersRef.current = [];
    audioBufferRef.current = [];
    nativeAudioPlayerRef.current?.interrupt();
    audioPlayerRef.current?.interrupt?.();
    setCurrentReply("");
    setCurrentUserSpeech("");
    setActiveRow(null);
    setActiveField(null);
  }, []);

  // --- Finish listening (tap) ---
  const finishListening = useCallback(() => {
    setListenPhase("sending");
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    finishTimers.current.forEach(clearTimeout);
    finishTimers.current = [];

    finishTimers.current.push(
      setTimeout(() => {
        const textToSend = decodedTextRef.current.trim();
        if (textToSend && serviceRef.current?.isConnected()) {
          serviceRef.current.sendActivityStart();
          serviceRef.current.sendText(textToSend);
          serviceRef.current.sendActivityEnd();
        }
        setListenPhase("received");
        finishTimers.current.push(
          setTimeout(() => {
            setListenMode(false);
            listenModeRef.current = false;
            setListenPhase(null);
            setTapDots(Array(6).fill(false));
            setInputPos(-1);
            setCharCount(0);
            setDecodedText("");
            decodedTextRef.current = "";
            setLastDecodedChar(null);
            setTapThreshold(DEFAULT_THRESHOLD);
            tapDurationsRef.current = [];
            tapDownTimeRef.current = null;
            setCurrentPressDur(0);
          }, 1200),
        );
      }, 800),
    );
  }, []);

  // --- Enter listen mode (tapping) ---
  const enterListenMode = useCallback(() => {
    interruptAll();
    listenModeRef.current = true;
    setListenMode(true);
    setListenPhase("ready");
    setTapDots(Array(6).fill(false));
    setInputPos(-1);
    setCharCount(0);
    setDecodedText("");
    decodedTextRef.current = "";
    setLastDecodedChar(null);
    setTapThreshold(DEFAULT_THRESHOLD);
    tapDurationsRef.current = [];
    tapDownTimeRef.current = null;
    setCurrentPressDur(0);
    setActiveRow(null);
    setActiveField(null);
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  }, [interruptAll]);

  // --- Demo: symulacja wpisywania braille ---
  const runDemo = useCallback(() => {
    demoTimersRef.current.forEach(clearTimeout);
    demoTimersRef.current = [];

    const DEMO_TEXT = "WHAT DO YOU SEE AROUND ME";
    const DOT_DELAY = 120;

    interruptAll();
    listenModeRef.current = true;
    setListenMode(true);
    setListenPhase("tapping");
    setTapDots(Array(6).fill(false));
    setInputPos(-1);
    setCharCount(0);
    setDecodedText("");
    decodedTextRef.current = "";
    setLastDecodedChar(null);
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    let t = 400;

    for (let ci = 0; ci < DEMO_TEXT.length; ci++) {
      const ch = DEMO_TEXT[ci];
      const dots: boolean[] = BRAILLE_MAP[ch] ?? BRAILLE_MAP[" "];

      const startT = t;
      demoTimersRef.current.push(
        setTimeout(() => {
          setTapDots(Array(6).fill(false));
          setInputPos(0);
        }, startT),
      );
      t += DOT_DELAY;

      for (let di = 0; di < 6; di++) {
        const dotT = t;
        const dotIdx = TAP_DOT_ORDER[di];
        const filled = dots[dotIdx];

        demoTimersRef.current.push(
          setTimeout(() => {
            setTapDots((prev) => {
              const nd = [...prev];
              nd[dotIdx] = filled;
              return nd;
            });
            setInputPos(di + 1);
            if (Platform.OS !== "web") {
              Haptics.impactAsync(
                filled
                  ? Haptics.ImpactFeedbackStyle.Heavy
                  : Haptics.ImpactFeedbackStyle.Light,
              );
            }
          }, dotT),
        );
        t += DOT_DELAY;
      }

      t += CHAR_RESET + 200;
    }

    demoTimersRef.current.push(
      setTimeout(() => {
        finishListening();
      }, t),
    );
  }, [interruptAll, finishListening]);

  // --- Tap press in/out (Braille tapping) ---
  const onListenPressIn = useCallback(() => {
    if (inputMode !== "tapping") return;
    if (!listenMode || listenPhase === "sending" || listenPhase === "received")
      return;

    tapDownTimeRef.current = Date.now();
    setCurrentPressDur(0);
    const animate = () => {
      if (tapDownTimeRef.current === null) return;
      setCurrentPressDur(Date.now() - tapDownTimeRef.current);
      pressAnimRef.current = requestAnimationFrame(animate);
    };
    pressAnimRef.current = requestAnimationFrame(animate);

    if (
      listenPhase === "ready" ||
      (listenPhase === "tapping" && inputPos === -1)
    ) {
      setListenPhase("tapping");
      if (inputPos === -1) {
        setTapDots(Array(6).fill(false));
        setInputPos(0);
      }
    }
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [inputMode, listenMode, listenPhase, inputPos]);

  const onListenPressOut = useCallback(() => {
    if (pressAnimRef.current) cancelAnimationFrame(pressAnimRef.current);
    if (tapDownTimeRef.current === null) return;
    const duration = Date.now() - tapDownTimeRef.current;
    tapDownTimeRef.current = null;
    setCurrentPressDur(0);
    if (inputMode !== "tapping") return;
    if (
      !listenMode ||
      listenPhase !== "tapping" ||
      inputPos < 0 ||
      inputPos >= 6
    )
      return;

    const isLong = duration >= tapThreshold;
    const dotIdx = TAP_DOT_ORDER[inputPos];
    setTapDots((prev) => {
      const nd = [...prev];
      nd[dotIdx] = isLong;
      return nd;
    });
    setInputPos((p) => p + 1);
    tapDurationsRef.current.push(duration);
    if (tapDurationsRef.current.length > 20) tapDurationsRef.current.shift();
    setTapThreshold(computeAdaptiveThreshold(tapDurationsRef.current));

    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sendTimerRef.current = setTimeout(finishListening, SEND_TIMEOUT);

    if (Platform.OS !== "web") {
      Haptics.impactAsync(
        isLong
          ? Haptics.ImpactFeedbackStyle.Heavy
          : Haptics.ImpactFeedbackStyle.Light,
      );
    }
  }, [
    inputMode,
    listenMode,
    listenPhase,
    inputPos,
    tapThreshold,
    finishListening,
  ]);

  // --- Mic hold ---
  const onMicHoldStart = useCallback(async () => {
    if (inputMode !== "mic") return;
    interruptAll();
    listenModeRef.current = true;
    micHoldingRef.current = true;
    setListenMode(true);
    audioBufferRef.current = [];
    chunksFromMicRef.current = 0;
    // restart wywoływany w NativeAudioPlayer.interrupt() (przez interruptAll)
    if (DEBUG_AUDIO) console.log("[Audio] hold start, resuming streamer");
    serviceRef.current?.sendActivityStart();
    audioStreamerRef.current?.resume();
    nativeStreamerRef.current?.resume();
    setMicHolding(true);
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  }, [inputMode, interruptAll]);

  const onMicHoldEnd = useCallback(async () => {
    if (!micHolding) return;
    micHoldingRef.current = false;
    setMicHolding(false);
    chunksFromMicRef.current = 0;
    if (DEBUG_AUDIO) console.log("[Audio] hold end, buffer size:", audioBufferRef.current.length);
    audioStreamerRef.current?.pause(); // Web
    // Native: NIE wywołuj pause – mikrofon włączony cały czas, listenModeRef filtruje
    if (micReleaseTimerRef.current) clearTimeout(micReleaseTimerRef.current);
    micReleaseTimerRef.current = setTimeout(() => {
      micReleaseTimerRef.current = null;
      flushAudioBufferAndEnd();
      setListenMode(false);
      listenModeRef.current = false;
    }, 400);
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [micHolding, flushAudioBufferAndEnd]);

  // --- Keyboard mode ---
  const enterKeyboardMode = useCallback(() => {
    if (inputMode !== "keyboard") return;
    interruptAll();
    setKeyboardMode(true);
    setKeyboardText("");
    setActiveRow(null);
    setActiveField(null);
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (kbFocusTimer.current) clearTimeout(kbFocusTimer.current);
    kbFocusTimer.current = setTimeout(() => textInputRef.current?.focus(), 100);
  }, [inputMode, interruptAll]);

  const submitKeyboardText = useCallback(() => {
    const msg = keyboardText.trim();
    if (!msg || !serviceRef.current?.isConnected()) return;
    Haptics.selectionAsync();
    serviceRef.current.sendActivityStart();
    serviceRef.current.sendText(msg);
    serviceRef.current.sendActivityEnd();
    Keyboard.dismiss();
    setKeyboardMode(false);
    setKeyboardText("");
  }, [keyboardText]);

  const cancelKeyboardMode = useCallback(() => {
    if (kbFocusTimer.current) clearTimeout(kbFocusTimer.current);
    Keyboard.dismiss();
    setKeyboardMode(false);
    setKeyboardText("");
  }, []);

  // --- Connect ---
  const connect = useCallback(async () => {
    if (!API_KEY) {
      setError("Ustaw EXPO_PUBLIC_GEMINI_API_KEY w .env");
      return;
    }
    if (!isWebAudio) {
      const {
        requestMicrophonePermissionsAsync,
        initialize,
      } = await import("@speechmatics/expo-two-way-audio");
      const { granted } = await requestMicrophonePermissionsAsync();
      setMicPermission(granted ? "granted" : "denied");
      if (!granted) {
        setError("Potrzebny dostęp do mikrofonu – włącz w Ustawieniach");
        return;
      }
      try {
        await initialize();
        if (DEBUG_AUDIO) console.log("[Audio] expo-two-way-audio initialized");
      } catch (e) {
        console.warn("[Audio] init failed:", e);
      }
    }
    setError(null);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      const svc = new GeminiLiveService(API_KEY);
      serviceRef.current = svc;

      if (isWebAudio) {
        audioPlayerRef.current = new WebAudioPlayer();
      } else {
        nativeAudioPlayerRef.current = new NativeAudioPlayer();
      }

      svc.setCallbacks({
        onOpen: () => setConnected(true),
        onSetupComplete: () => {
          const onAudioChunk = (base64: string) => {
            if (!listenModeRef.current) return;
            if (micHoldingRef.current && serviceRef.current?.isConnected()) {
              chunksFromMicRef.current += 1;
              if (DEBUG_AUDIO && chunksFromMicRef.current <= 5) {
                console.log("[Audio] chunk #" + chunksFromMicRef.current + " len=" + (base64?.length ?? 0));
              }
              serviceRef.current.sendAudio(base64);
            } else {
              audioBufferRef.current.push(base64);
            }
          };
          if (isWebAudio) {
            const streamer = new WebAudioStreamer(onAudioChunk);
            audioStreamerRef.current = streamer;
            streamer
              .start()
              .then(() => streamer.pause())
              .catch((e) => setError("Mikrofon: " + (e as Error).message));
          } else {
            const streamer = new NativeAudioStreamer(onAudioChunk);
            nativeStreamerRef.current = streamer;
            streamer.start().catch((e) => setError("Mikrofon: " + (e as Error).message));
          }
        },
        onClose: (reason) => {
          setConnected(false);
          if (reason) setError(`Połączenie zamknięte${reason}`);
        },
        onError: (msg) => setError(msg),
        onReceiveResponse: (msg: GeminiLiveResponse) => {
          if (msg.type === "SETUP_COMPLETE") return;
          if (DEBUG_AUDIO && (msg.type === "INPUT_TRANSCRIPTION" || msg.type === "OUTPUT_TRANSCRIPTION" || msg.type === "AUDIO")) {
            const d = typeof msg.data === "object" && msg.data && "text" in msg.data ? (msg.data as { text: string }).text : msg.type === "AUDIO" ? `base64(${(msg.data as string)?.length ?? 0})` : "";
            console.log("[Audio] Gemini:", msg.type, d ? (d.length > 40 ? d.slice(0, 40) + "…" : d) : "");
          }
          if (
            msg.type === "OUTPUT_TRANSCRIPTION" &&
            typeof msg.data === "object" &&
            "text" in msg.data
          ) {
            if (listenModeRef.current) return;
            const d = msg.data as { text: string; finished?: boolean };
            setCurrentReply((prev) => prev + d.text);
          }
          if (
            msg.type === "INPUT_TRANSCRIPTION" &&
            typeof msg.data === "object" &&
            "text" in msg.data
          ) {
            const d = msg.data as { text: string; finished?: boolean };
            setCurrentUserSpeech((prev) => (d.finished ? "" : prev + d.text));
          }
          if (msg.type === "TURN_COMPLETE") return;
          if (msg.type === "INTERRUPTED") {
            nativeAudioPlayerRef.current?.interrupt();
            audioPlayerRef.current?.interrupt?.();
            setCurrentReply("");
            setCurrentUserSpeech("");
            return;
          }
          if (msg.type === "AUDIO" && typeof msg.data === "string") {
            if (listenModeRef.current) return;
            setCurrentUserSpeech("");
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

  // --- Disconnect ---
  const disconnect = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setChooserVisible(false);
    setListenMode(false);
    listenModeRef.current = false;
    setListenPhase(null);
    setKeyboardMode(false);
    setMicHolding(false);
    if (micReleaseTimerRef.current) {
      clearTimeout(micReleaseTimerRef.current);
      micReleaseTimerRef.current = null;
    }
    audioStreamerRef.current?.pause();
    nativeStreamerRef.current?.pause();
    letterTimersRef.current.forEach(clearTimeout);
    letterTimersRef.current = [];
    finishTimers.current.forEach(clearTimeout);
    finishTimers.current = [];
    demoTimersRef.current.forEach(clearTimeout);
    demoTimersRef.current = [];
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
    setCurrentReply("");
    setCurrentUserSpeech("");
    chunksFromMicRef.current = 0;
    setWordIdx(0);
    setLetterIdx(0);
    setReadingDone(false);
    setActiveRow(null);
    setActiveField(null);
  }, []);

  // --- Camera capture – zawsze wysyłaj klatki (także w mic); instrukcja systemowa steruje kiedy model używa video
  useEffect(() => {
    if (!connected || !cameraPermission?.granted || Platform.OS === "web")
      return;
    const interval = setInterval(async () => {
      if (!cameraRef.current || !serviceRef.current?.isConnected()) return;
      try {
        const photo = await cameraRef.current.takePictureAsync({
          quality: 0.7,
          base64: true,
          shutterSound: false,
        });
        if (photo?.base64) serviceRef.current.sendVideoFrame(photo.base64);
      } catch {}
    }, 1500);
    captureIntervalRef.current = interval;
    return () => {
      if (captureIntervalRef.current) clearInterval(captureIntervalRef.current);
    };
  }, [connected, cameraPermission?.granted, cameraFacing, inputMode]);

  // Auto-connect when screen is ready
  const connectCalledRef = useRef(false);
  useEffect(() => {
    if (screenReady && !connected && !connectCalledRef.current) {
      connectCalledRef.current = true;
      connect();
    }
  }, [screenReady, connected, connect]);

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", () =>
      disconnect(),
    );
    return unsubscribe;
  }, [navigation, disconnect]);

  // --- Camera permission gate ---
  if (
    Platform.OS !== "web" &&
    (!cameraPermission || !cameraPermission.granted)
  ) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionGate}>
          <View style={styles.permissionIcon}>
            <Feather name="camera" size={48} color={Colors.primary} />
          </View>
          <Text style={styles.permissionTitle}>WORLD LENS</Text>
          <Text style={styles.permissionDesc}>
            HapticMind uses the camera to see your surroundings and describe
            them through haptic Braille patterns.
          </Text>
          {!cameraPermission ? (
            <View style={styles.permissionLoading}>
              <Text style={styles.permissionLoadingText}>Loading...</Text>
            </View>
          ) : cameraPermission.canAskAgain ? (
            <Pressable
              style={styles.permissionButton}
              onPress={requestCameraPermission}
            >
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
              ? "Camera was denied. Open settings to enable it."
              : "Camera access is required to continue."}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Status bar */}
        <View style={[styles.statusBar, { marginTop: insets.top }]}>
          <Text style={styles.worldLensTitle}>WORLD LENS</Text>
          <View style={styles.statusRight}>
            <View style={styles.aiStatus}>
              <View
                style={[
                  styles.aiDot,
                  {
                    backgroundColor: heartPulse
                      ? Colors.primary
                      : "rgba(255,255,0,0.25)",
                  },
                ]}
              />
              <Text style={styles.aiLabel}>AI</Text>
            </View>
            <View style={styles.liveStatus}>
              <Feather name="eye" size={12} color={Colors.zinc600} />
              <Text style={[styles.liveLabel, { color: Colors.zinc600 }]}>
                CAMERA
              </Text>
            </View>
          </View>
        </View>

        {/* Top buttons: change input + practice */}
        {connected && inputChosen && !listenMode && !keyboardMode && (
          <View style={[styles.topButtons, { top: insets.top + 28 }]}>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                setChooserVisible(true);
              }}
              style={styles.changeInputButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Change input mode"
            >
              <Feather name="sliders" size={14} color="#000000" />
            </Pressable>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push("/tutorial");
              }}
              style={styles.practiceButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Practice"
            >
              <Text style={styles.practiceText}>PRACTICE</Text>
            </Pressable>
          </View>
        )}

        {/* "TAP TO INPUT" / "TAP TO TYPE" button for tapping/keyboard */}
        {connected &&
          inputChosen &&
          !listenMode &&
          !keyboardMode &&
          inputMode !== "mic" && (
            <View style={styles.tapPromptContainer}>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable
                  onPress={
                    inputMode === "tapping" ? enterListenMode : enterKeyboardMode
                  }
                  style={styles.holdButton}
                >
                  <Feather
                    name={inputMode === "tapping" ? "grid" : "type"}
                    size={18}
                    color="#000000"
                  />
                  <Text style={styles.holdButtonText}>
                    {inputMode === "tapping" ? "TAP TO INPUT" : "TAP TO TYPE"}
                  </Text>
                </Pressable>
                {inputMode === "tapping" && (
                  <Pressable onPress={runDemo} style={styles.demoButton}>
                    <Feather name="play" size={14} color="#000000" />
                    <Text style={styles.holdButtonText}>DEMO</Text>
                  </Pressable>
                )}
              </View>
            </View>
          )}

        {/* Camera zone */}
        <View style={styles.cameraZone}>
          {Platform.OS !== "web" && cameraPermission?.granted ? (
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing={cameraFacing}
            />
          ) : null}

          <Pressable
            onPressIn={
              inputMode === "tapping" && listenMode
                ? onListenPressIn
                : undefined
            }
            onPressOut={
              inputMode === "tapping" && listenMode
                ? onListenPressOut
                : undefined
            }
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={
              inputMode === "tapping"
                ? listenMode
                  ? "Tap to enter Braille dots"
                  : "Camera view"
                : "Camera view"
            }
          >
            {/* Grid overlay */}
            <View style={styles.gridOverlay}>
              {Array(10)
                .fill(0)
                .map((_, i) => (
                  <View
                    key={`h${i}`}
                    style={{
                      position: "absolute",
                      top: `${(i + 1) * 10}%`,
                      left: 0,
                      right: 0,
                      height: 1,
                      backgroundColor: "rgba(255,255,255,0.02)",
                    }}
                  />
                ))}
              {Array(10)
                .fill(0)
                .map((_, i) => (
                  <View
                    key={`v${i}`}
                    style={{
                      position: "absolute",
                      left: `${(i + 1) * 10}%`,
                      top: 0,
                      bottom: 0,
                      width: 1,
                      backgroundColor: "rgba(255,255,255,0.02)",
                    }}
                  />
                ))}
            </View>

            {/* Connecting indicator */}
            {!connected && (
              <View style={styles.connectContainer}>
                <View style={styles.connectingSpinner} />
                <Text style={styles.connectLabel}>CONNECTING...</Text>
              </View>
            )}

            {/* Mic hold button */}
            {connected && inputChosen && inputMode === "mic" && (
              <View style={styles.micHoldContainer}>
                <Pressable
                  onPressIn={onMicHoldStart}
                  onPressOut={onMicHoldEnd}
                  style={[
                    styles.holdButton,
                    micHolding && styles.holdButtonActive,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    micHolding ? "Release to send" : "Hold to speak"
                  }
                >
                  <Feather
                    name={micHolding ? "radio" : "mic"}
                    size={18}
                    color={micHolding ? Colors.primary : "#000000"}
                  />
                  <Text
                    style={[
                      styles.holdButtonText,
                      micHolding && styles.holdButtonTextActive,
                    ]}
                  >
                    {micHolding ? "RELEASE TO SEND" : "HOLD TO SPEAK"}
                  </Text>
                </Pressable>
              </View>
            )}

            {/* Keyboard overlay */}
            {keyboardMode && (
              <View style={styles.keyboardOverlay}>
                <View style={styles.kbTextArea}>
                  <TextInput
                    ref={textInputRef}
                    style={styles.kbTextInput}
                    value={keyboardText}
                    onChangeText={setKeyboardText}
                    placeholder="Type your message..."
                    placeholderTextColor="rgba(255,255,0,0.2)"
                    multiline
                    maxLength={500}
                    autoFocus
                    onSubmitEditing={submitKeyboardText}
                    accessibilityLabel="Message input"
                  />
                </View>
                <View style={styles.kbButtons}>
                  <Pressable
                    onPress={cancelKeyboardMode}
                    style={styles.kbCancelButton}
                  >
                    <Text style={styles.kbCancelText}>CANCEL</Text>
                  </Pressable>
                  <Pressable
                    onPress={submitKeyboardText}
                    style={[
                      styles.kbSendButton,
                      !keyboardText.trim() && { opacity: 0.35 },
                    ]}
                    disabled={!keyboardText.trim()}
                  >
                    <Text style={styles.kbSendText}>SEND</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Listen overlay (tapping mode) */}
            {listenMode && inputMode === "tapping" && (
              <View style={styles.listenOverlay}>
                <View
                  style={[
                    styles.listenBorder,
                    {
                      borderColor:
                        listenPhase === "tapping"
                          ? "rgba(255,255,0,0.5)"
                          : "rgba(255,255,0,0.2)",
                      backgroundColor:
                        listenPhase === "tapping"
                          ? "rgba(255,255,0,0.03)"
                          : "transparent",
                    },
                  ]}
                />

                {listenPhase === "sending" ? (
                  <View style={styles.sendingView}>
                    <View style={styles.spinner} />
                    <Text style={styles.sendingText}>SENDING...</Text>
                  </View>
                ) : listenPhase === "received" ? (
                  <View style={styles.receivedView}>
                    <View style={styles.checkCircle}>
                      <Text style={styles.checkMark}>✓</Text>
                    </View>
                    <Text style={styles.receivedText}>GOT IT</Text>
                  </View>
                ) : listenPhase === "tapping" &&
                  inputPos >= 0 &&
                  inputPos < 6 ? (
                  <View style={styles.tappingView}>
                    <View style={styles.tappingDots}>
                      {[0, 1, 2].map((r) => {
                        const p0 = r * 2;
                        const p1 = r * 2 + 1;
                        const leftFilled = tapDots[TAP_DOT_ORDER[p0]];
                        const rightFilled = tapDots[TAP_DOT_ORDER[p1]];
                        const leftWaiting = inputPos === p0;
                        const rightWaiting = inputPos === p1;
                        const leftPast = inputPos > p0;
                        const rightPast = inputPos > p1;

                        const getDotBg = (
                          filled: boolean,
                          w: boolean,
                          past: boolean,
                        ) =>
                          filled
                            ? Colors.primary
                            : w && pressing
                              ? pressIsLong
                                ? Colors.primary
                                : "rgba(255,255,0,0.25)"
                              : w
                                ? "rgba(255,255,0,0.15)"
                                : past && !filled
                                  ? Colors.zinc800
                                  : "rgba(255,255,0,0.08)";

                        return (
                          <View
                            key={r}
                            style={{ alignItems: "center", gap: 6 }}
                          >
                            <Text
                              style={{
                                fontSize: 8,
                                color:
                                  leftWaiting || rightWaiting
                                    ? Colors.primary
                                    : Colors.zinc600,
                              }}
                            >
                              R{r + 1}
                            </Text>
                            <View style={{ flexDirection: "row", gap: 8 }}>
                              <View
                                style={{
                                  width: 24,
                                  height: 24,
                                  borderRadius: 12,
                                  backgroundColor: getDotBg(
                                    leftFilled,
                                    leftWaiting,
                                    leftPast,
                                  ),
                                  borderWidth: leftWaiting ? 2 : 0,
                                  borderColor: "rgba(255,255,0,0.5)",
                                  transform: [
                                    {
                                      scale: leftWaiting && pressing ? 1.15 : 1,
                                    },
                                  ],
                                }}
                              />
                              <View
                                style={{
                                  width: 24,
                                  height: 24,
                                  borderRadius: 12,
                                  backgroundColor: getDotBg(
                                    rightFilled,
                                    rightWaiting,
                                    rightPast,
                                  ),
                                  borderWidth: rightWaiting ? 2 : 0,
                                  borderColor: "rgba(255,255,0,0.5)",
                                  transform: [
                                    {
                                      scale:
                                        rightWaiting && pressing ? 1.15 : 1,
                                    },
                                  ],
                                }}
                              />
                            </View>
                          </View>
                        );
                      })}
                    </View>
                    {/* Duration bar */}
                    <View style={styles.miniDurationBar}>
                      <View style={styles.miniBarTrack}>
                        <View
                          style={[
                            styles.miniBarFill,
                            {
                              width: pressing
                                ? `${Math.min(currentPressDur / (tapThreshold * 2), 1) * 100}%`
                                : "0%",
                              backgroundColor: pressIsLong
                                ? Colors.primary
                                : "rgba(255,255,0,0.3)",
                            },
                          ]}
                        />
                        <View style={styles.miniBarThreshold} />
                      </View>
                      <Text
                        style={[
                          styles.miniBarLabel,
                          {
                            color: pressIsLong
                              ? Colors.primary
                              : Colors.zinc600,
                          },
                        ]}
                      >
                        {pressing
                          ? pressIsLong
                            ? "● FILLED"
                            : "○ blank"
                          : `R${(waitingRow ?? 0) + 1} · ${waitingField ?? "—"} · ${tapThreshold}ms`}
                      </Text>
                    </View>
                    <Text style={styles.tappingHint}>
                      Short = blank · Long = filled
                    </Text>
                  </View>
                ) : listenPhase === "tapping" && inputPos === -1 ? (
                  <View style={styles.charReadyView}>
                    <View style={styles.charCountCircle}>
                      <Text style={styles.charCountText}>{charCount}</Text>
                    </View>
                    <Text style={styles.charReadyLabel}>
                      {charCount === 0
                        ? "PRESS TO START"
                        : `${charCount} CHAR${charCount > 1 ? "S" : ""} · PRESS NEXT`}
                    </Text>
                    <Text style={styles.tappingHint}>
                      Short = blank · Long = filled · {tapThreshold}ms
                    </Text>
                  </View>
                ) : (
                  <View style={styles.readyView}>
                    <View style={{ alignItems: "center", gap: 8 }}>
                      <Text style={styles.readyTitle}>READY</Text>
                      <Text style={styles.readySubtitle}>
                        Press to start Braille input
                      </Text>
                      <Text style={styles.readyHint}>
                        Short press = blank · Long press = filled
                      </Text>
                    </View>
                  </View>
                )}
              </View>
            )}

            {/* Camera switch */}
            {connected && inputChosen && !listenMode && !keyboardMode && (
              <Pressable
                style={styles.cameraSwitch}
                onPress={() => {
                  Haptics.selectionAsync();
                  setCameraFacing((f) => (f === "front" ? "back" : "front"));
                }}
              >
                <Text style={styles.cameraSwitchText}>
                  {cameraFacing === "front" ? "Tył" : "Przód"}
                </Text>
              </Pressable>
            )}
          </Pressable>
        </View>

        {error && (
          <View style={styles.errorBlock}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Bottom panel */}
        <View
          style={[
            styles.bottomPanel,
            { paddingBottom: Math.max(insets.bottom, 8) },
          ]}
        >
          <View style={styles.bottomContent}>
            {/* Left column: char + braille matrix */}
            <View style={styles.leftCol}>
              <Text style={styles.leftLabel}>
                {keyboardMode
                  ? "KEYBOARD"
                  : listenMode
                    ? listenPhase === "tapping"
                      ? "INPUT"
                      : "LISTEN"
                    : "NOW"}
              </Text>
              <View
                style={[
                  styles.leftCharBox,
                  {
                    backgroundColor:
                      keyboardMode || (listenMode && listenPhase === "tapping")
                        ? "rgba(255,255,0,0.12)"
                        : "rgba(255,255,0,0.08)",
                  },
                ]}
              >
                {keyboardMode ? (
                  <Feather name="type" size={24} color="rgba(255,255,0,0.7)" />
                ) : listenMode && lastDecodedChar ? (
                  <Text style={styles.leftChar}>{lastDecodedChar}</Text>
                ) : listenMode ? (
                  <Feather
                    name={inputMode === "mic" ? "mic" : "grid"}
                    size={24}
                    color="rgba(255,255,0,0.7)"
                  />
                ) : (
                  <Text style={styles.leftChar}>{displayChar ?? "·"}</Text>
                )}
              </View>
              <BrailleMatrix
                dots={listenMode || keyboardMode ? null : currentDots}
                activeRow={listenMode || keyboardMode ? null : activeRow}
                activeField={listenMode || keyboardMode ? null : activeField}
                scanRow={listenMode && listenPhase === "ready" ? scanRow : null}
                tapDots={
                  listenMode && listenPhase === "tapping" ? tapDots : undefined
                }
                waitingRow={
                  listenMode && listenPhase === "tapping" ? waitingRow : null
                }
                waitingField={
                  listenMode && listenPhase === "tapping" ? waitingField : null
                }
              />
              <View style={styles.leftStatusBadge}>
                <Text style={styles.leftStatusText}>
                  {keyboardMode
                    ? "typing"
                    : listenMode
                      ? listenPhase === "tapping"
                        ? inputPos === -1
                          ? `ch${charCount + 1} · ready`
                          : `R${(waitingRow ?? 0) + 1} · ${waitingField ?? "—"}`
                        : "listening"
                      : connected
                        ? currentWord || "listening"
                        : "ready"}
                </Text>
              </View>
            </View>

            <View style={styles.divider} />

            {/* Right column */}
            <View style={styles.rightCol}>
              <Text style={styles.rightLabel}>
                {keyboardMode
                  ? keyboardText.length > 0
                    ? `TYPING · ${keyboardText.length} CHARS`
                    : "TYPE A MESSAGE"
                  : listenMode
                    ? decodedText.length > 0
                      ? `YOUR INPUT · ${decodedText.length} CHARS`
                      : "YOUR TURN"
                    : "AI RESPONSE"}
              </Text>

              {keyboardMode ? (
                <View style={{ flex: 1, justifyContent: "center" }}>
                  <Text
                    style={{
                      color: Colors.zinc700,
                      fontSize: 14,
                      fontWeight: "500",
                    }}
                  >
                    Text appears in input above
                  </Text>
                </View>
              ) : listenMode && inputMode === "tapping" ? (
                <View style={{ gap: 12 }}>
                  <Text style={styles.decodedText}>
                    {decodedText.length > 0 ? (
                      decodedText.split("").map((ch, ci) => (
                        <Text
                          key={ci}
                          style={{
                            color:
                              ci === decodedText.length - 1
                                ? Colors.primary
                                : "rgba(255,255,255,0.85)",
                          }}
                        >
                          {ch}
                        </Text>
                      ))
                    ) : (
                      <Text
                        style={{
                          color: Colors.zinc700,
                          fontSize: 20,
                          fontStyle: "italic",
                        }}
                      >
                        Start pressing...
                      </Text>
                    )}
                  </Text>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <Text style={styles.posInfo}>
                      {inputPos === -1 && charCount > 0
                        ? "Next char ready"
                        : inputPos >= 0 && inputPos < 6
                          ? `Pos ${inputPos + 1}/6`
                          : inputPos === 6
                            ? "Decoding..."
                            : "Waiting"}
                    </Text>
                    <Text style={{ color: Colors.zinc800, fontSize: 8 }}>
                      ·
                    </Text>
                    <Text style={styles.thresholdInfo}>
                      {tapThreshold}ms threshold
                    </Text>
                  </View>
                </View>
              ) : (
                <View style={{ flex: 1, justifyContent: "center" }}>
                  <Text style={styles.aiResponseText}>
                    {words.length > 0 ? (
                      words.map((word, wi) => {
                        const isActive = wi === wordIdx;
                        const isPast = wi < wordIdx;
                        return (
                          <Text
                            key={wi}
                            style={{
                              color: isActive
                                ? Colors.primary
                                : isPast
                                  ? "rgba(255,255,255,0.28)"
                                  : "rgba(255,255,255,0.72)",
                              fontWeight: isActive ? "700" : "400",
                            }}
                          >
                            {word}
                            {wi < words.length - 1 ? " " : ""}
                          </Text>
                        );
                      })
                    ) : (
                      <Text style={{ color: Colors.zinc600 }}>
                        Połącz się i mów – AI opisze otoczenie.
                      </Text>
                    )}
                  </Text>
                </View>
              )}

            </View>
          </View>
        </View>

        {/* Input chooser modal */}
        <InputChooserModal
          visible={chooserVisible}
          dismissable={inputChosen}
          onChoose={(mode) => {
            setInputMode(mode);
            setChooserVisible(false);
          }}
          onClose={() => {
            if (inputChosen) setChooserVisible(false);
          }}
        />
      </KeyboardAvoidingView>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: "relative",
    backgroundColor: "#000000",
  },
  statusBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 28,
    paddingBottom: 4,
  },
  worldLensTitle: {
    color: Colors.primary,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 2.5,
  },
  statusRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  aiStatus: {
    flexDirection: "row",
    alignItems: "center",
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
    fontWeight: "600",
    letterSpacing: 1,
  },
  liveStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  liveLabel: {
    color: Colors.zinc500,
    fontSize: 10,
    fontWeight: "500",
  },
  topButtons: {
    position: "absolute",
    right: 20,
    left: 20,
    zIndex: 30,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  changeInputButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  practiceButton: {
    height: 44,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  practiceText: {
    color: "#000000",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 2,
  },
  tapPromptContainer: {
    position: "absolute",
    bottom: "38%",
    left: 0,
    right: 0,
    zIndex: 25,
    alignItems: "center",
  },
  holdButton: {
    height: 44,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  holdButtonActive: {
    backgroundColor: "rgba(0,0,0,0.7)",
    borderWidth: 1,
    borderColor: "rgba(255,255,0,0.5)",
  },
  demoButton: {
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,0,0.6)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  holdButtonText: {
    color: "#000000",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 2,
  },
  holdButtonTextActive: {
    color: Colors.primary,
  },
  cameraZone: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  permissionGate: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 20,
  },
  permissionIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "rgba(255,255,0,0.08)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  permissionTitle: {
    color: Colors.primary,
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: 4,
  },
  permissionDesc: {
    color: Colors.zinc400,
    fontSize: 15,
    fontWeight: "500",
    textAlign: "center",
    lineHeight: 22,
  },
  permissionButton: {
    height: 52,
    paddingHorizontal: 32,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  permissionButtonText: {
    color: "#000000",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 2,
  },
  permissionHint: {
    color: "rgba(255,255,255,0.25)",
    fontSize: 12,
    fontWeight: "500",
    textAlign: "center",
  },
  permissionLoading: {
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  permissionLoadingText: {
    color: Colors.zinc400,
    fontSize: 14,
    fontWeight: "500",
  },
  gridOverlay: {
    ...StyleSheet.absoluteFillObject,
    pointerEvents: "none",
  },
  connectContainer: {
    position: "absolute",
    bottom: 20,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 12,
  },
  connectingSpinner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "rgba(255,255,0,0.15)",
    borderTopColor: Colors.primary,
  },
  connectLabel: {
    fontSize: 8,
    fontWeight: "600",
    letterSpacing: 2,
    color: "rgba(255,255,255,0.15)",
  },
  micHoldContainer: {
    position: "absolute",
    bottom: 20,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 8,
  },
  listenOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  listenBorder: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    bottom: 12,
    borderRadius: 24,
    borderWidth: 2,
  },
  sendingView: {
    alignItems: "center",
    gap: 12,
  },
  spinner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "rgba(255,255,0,0.5)",
    borderTopColor: Colors.primary,
  },
  sendingText: {
    color: "rgba(255,255,0,0.7)",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 2,
  },
  receivedView: {
    alignItems: "center",
    gap: 12,
  },
  checkCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    borderColor: Colors.green,
    backgroundColor: "rgba(34,197,94,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  checkMark: {
    color: Colors.green,
    fontSize: 24,
    fontWeight: "700",
  },
  receivedText: {
    color: Colors.green,
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 2,
  },
  tappingView: {
    alignItems: "center",
    gap: 16,
  },
  tappingDots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  miniDurationBar: {
    width: 160,
    alignItems: "center",
    gap: 4,
  },
  miniBarTrack: {
    width: "100%",
    height: 8,
    backgroundColor: Colors.zinc900,
    borderRadius: 4,
    overflow: "hidden",
    position: "relative",
  },
  miniBarFill: {
    position: "absolute",
    top: 0,
    left: 0,
    height: "100%",
    borderRadius: 4,
  },
  miniBarThreshold: {
    position: "absolute",
    top: 0,
    left: "50%",
    height: "100%",
    width: 1,
    backgroundColor: "rgba(255,255,0,0.6)",
  },
  miniBarLabel: {
    fontSize: 9,
  },
  tappingHint: {
    color: Colors.zinc600,
    fontSize: 9,
    letterSpacing: 1,
  },
  charReadyView: {
    alignItems: "center",
    gap: 12,
  },
  charCountCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: "rgba(255,255,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  charCountText: {
    color: Colors.primary,
    fontSize: 20,
    fontWeight: "700",
  },
  charReadyLabel: {
    color: "rgba(255,255,0,0.8)",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 2,
  },
  readyView: {
    alignItems: "center",
    gap: 16,
  },
  readyTitle: {
    color: Colors.primary,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 2,
  },
  readySubtitle: {
    color: Colors.zinc500,
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 1,
  },
  readyHint: {
    color: Colors.zinc700,
    fontSize: 9,
  },
  keyboardOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000000",
    zIndex: 20,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
    justifyContent: "space-between",
  },
  kbTextArea: {
    flex: 1,
  },
  kbTextInput: {
    color: Colors.primary,
    fontSize: 32,
    fontWeight: "500",
    lineHeight: 46,
    textAlignVertical: "top",
    flex: 1,
  },
  kbButtons: {
    flexDirection: "row",
    gap: 12,
    paddingTop: 16,
  },
  kbCancelButton: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.zinc800,
    alignItems: "center",
    justifyContent: "center",
  },
  kbCancelText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 2,
  },
  kbSendButton: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  kbSendText: {
    color: "#000000",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 2,
  },
  cameraSwitch: {
    position: "absolute",
    top: 16,
    right: 16,
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  cameraSwitchText: {
    color: Colors.primary,
    fontSize: 14,
    fontWeight: "600",
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
    backgroundColor: "rgba(0,0,0,0.95)",
    borderTopWidth: 1,
    borderTopColor: Colors.zinc900,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  bottomContent: {
    flexDirection: "row",
    gap: 16,
  },
  leftCol: {
    width: 100,
    alignItems: "center",
    gap: 8,
  },
  leftLabel: {
    color: Colors.zinc600,
    fontSize: 8,
    fontWeight: "600",
    letterSpacing: 2,
  },
  leftCharBox: {
    width: 52,
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  leftChar: {
    color: Colors.primary,
    fontSize: 28,
    fontWeight: "700",
  },
  leftStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Colors.zinc800,
    backgroundColor: Colors.zinc950,
    width: "100%",
    alignItems: "center",
    marginTop: 4,
  },
  leftStatusText: {
    color: Colors.zinc500,
    fontSize: 8,
    letterSpacing: 1,
    textTransform: "uppercase",
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
    fontWeight: "600",
    letterSpacing: 2,
  },
  decodedText: {
    fontSize: 26,
    fontWeight: "700",
    lineHeight: 36,
    minHeight: 72,
  },
  posInfo: {
    color: Colors.zinc700,
    fontSize: 8,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  thresholdInfo: {
    color: Colors.zinc700,
    fontSize: 8,
  },
  aiResponseText: {
    fontSize: 28,
    lineHeight: 40,
  },
});
