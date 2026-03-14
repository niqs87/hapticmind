import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
  Vibration,
} from "react-native";
import Svg, { Circle } from "react-native-svg";
import * as Haptics from "expo-haptics";
import * as Speech from "expo-speech";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ALL_CHARS,
  Dots,
  TAP_DOT_ORDER,
  FIELD_DURATION,
  VIBRATION_PULSE,
  ROW_GAP,
  DEFAULT_THRESHOLD,
  HOLD_DURATION,
  HOLD_CIRCUMFERENCE,
  getRows,
  computeAdaptiveThreshold,
} from "@/constants/braille";
import { Colors } from "@/constants/colors";

function ReferenceDotGrid({
  dots,
  highlight,
}: {
  dots: Dots;
  highlight?: number | null;
}) {
  const rows = getRows(dots);
  return (
    <View style={{ gap: 6 }}>
      {rows.map(([l, r], ri) => (
        <View key={ri} style={{ flexDirection: "row", gap: 6 }}>
          {[l, r].map((on, ci) => {
            const dotIdx =
              ri === 0
                ? ci === 0
                  ? 0
                  : 3
                : ri === 1
                ? ci === 0
                  ? 1
                  : 4
                : ci === 0
                ? 2
                : 5;
            const tapPos = TAP_DOT_ORDER.indexOf(dotIdx);
            const isHighlight = highlight === tapPos;
            return (
              <View
                key={ci}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  backgroundColor: on
                    ? isHighlight
                      ? Colors.primary
                      : "rgba(255,255,0,0.7)"
                    : isHighlight
                    ? "rgba(255,255,0,0.3)"
                    : "rgba(63,63,70,0.5)",
                  transform: [{ scale: isHighlight ? 1.2 : 1 }],
                }}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

function WriteDotGrid({
  tapDots,
  inputPos,
  pressing,
  pressIsLong,
}: {
  tapDots: boolean[];
  inputPos: number;
  pressing: boolean;
  pressIsLong: boolean;
}) {
  const dotPairs = [
    [0, 3],
    [1, 4],
    [2, 5],
  ];

  return (
    <View style={{ gap: 12 }}>
      {dotPairs.map((pair, ri) => (
        <View key={ri} style={{ flexDirection: "row", gap: 12 }}>
          {pair.map((dotIdx) => {
            const tapPos = TAP_DOT_ORDER.indexOf(dotIdx);
            const isWaiting = tapPos === inputPos;
            const isPast = tapPos < inputPos || inputPos === 6;
            const isFilled = tapDots[dotIdx];

            return (
              <View
                key={dotIdx}
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor:
                    isFilled && isPast
                      ? Colors.primary
                      : isWaiting && pressing
                      ? pressIsLong
                        ? Colors.primary
                        : "rgba(255,255,0,0.3)"
                      : isWaiting
                      ? "rgba(255,255,0,0.12)"
                      : isPast && !isFilled
                      ? Colors.zinc800
                      : "rgba(255,255,0,0.06)",
                  borderWidth: isWaiting ? 3 : 2,
                  borderColor: isWaiting
                    ? "rgba(255,255,0,0.6)"
                    : "rgba(63,63,70,0.4)",
                  transform: [
                    { scale: isWaiting && pressing ? 1.1 : 1 },
                  ],
                }}
              >
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: "700",
                    color: isWaiting
                      ? Colors.primary
                      : isPast
                      ? isFilled
                        ? "#000"
                        : Colors.zinc600
                      : Colors.zinc700,
                  }}
                >
                  {tapPos + 1}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export function TutorialScreen({ onDone }: { onDone?: () => void }) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<"read" | "write">("read");
  const [charIdx, setCharIdx] = useState(0);

  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [activeField, setActiveField] = useState<"left" | "right" | null>(
    null
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const [tapDots, setTapDots] = useState<boolean[]>(Array(6).fill(false));
  const [inputPos, setInputPos] = useState(-1);
  const [tapThreshold, setTapThreshold] = useState(DEFAULT_THRESHOLD);
  const tapDurations = useRef<number[]>([]);
  const tapDownTime = useRef<number | null>(null);
  const [currentPressDur, setCurrentPressDur] = useState(0);
  const pressAnimRef = useRef<number | null>(null);
  const [writeResult, setWriteResult] = useState<"correct" | "wrong" | null>(
    null
  );

  const waitingRow =
    inputPos >= 0 && inputPos < 6 ? Math.floor(inputPos / 2) : null;
  const waitingField =
    inputPos >= 0 && inputPos < 6
      ? inputPos % 2 === 0
        ? ("left" as const)
        : ("right" as const)
      : null;
  const [writeHistory, setWriteHistory] = useState<
    { char: string; correct: boolean }[]
  >([]);

  const [writePhase, setWritePhase] = useState<"idle" | "tapping">("idle");
  const [isHolding, setIsHolding] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const holdStart = useRef<number | null>(null);
  const holdRaf = useRef<number | null>(null);
  const holdTriggerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const letter = ALL_CHARS[charIdx];
  const rows = getRows(letter.dots);
  const isFirst = charIdx === 0;
  const isLast = charIdx === ALL_CHARS.length - 1;

  const charName = (c: string) => {
    const names: Record<string, string> = {
      '.': 'period', ',': 'comma', '?': 'question mark',
      '!': 'exclamation mark', ' ': 'space',
    };
    return names[c] ?? c.toLowerCase();
  };

  const speak = useCallback((text: string) => {
    if (Platform.OS === "web") return;
    try {
      Speech.stop();
      Speech.speak(text, { rate: 0.9, pitch: 1.0 });
    } catch {
      // Speech not available (web, simulator)
    }
  }, []);

  function clearTimers() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }

  function play() {
    if (isPlaying) return;
    clearTimers();
    setIsPlaying(true);
    speak(charName(letter.char));
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    let cum = 0;
    const fieldHaptic = async (filled: boolean) => {
      if (Platform.OS === "web") return;
      if (filled) {
        if (Platform.OS === "android") {
          Vibration.vibrate(VIBRATION_PULSE);
        }
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
      } else {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    };
    const steps = [
      {
        delay: cum,
        fn: () => {
          setActiveRow(0);
          setActiveField("left");
          fieldHaptic(rows[0][0]);
        },
      },
      {
        delay: (cum += FIELD_DURATION),
        fn: () => {
          setActiveRow(0);
          setActiveField("right");
          fieldHaptic(rows[0][1]);
        },
      },
      {
        delay: (cum += FIELD_DURATION),
        fn: () => {
          setActiveRow(null);
          setActiveField(null);
        },
      },
      {
        delay: (cum += ROW_GAP),
        fn: () => {
          setActiveRow(1);
          setActiveField("left");
          fieldHaptic(rows[1][0]);
        },
      },
      {
        delay: (cum += FIELD_DURATION),
        fn: () => {
          setActiveRow(1);
          setActiveField("right");
          fieldHaptic(rows[1][1]);
        },
      },
      {
        delay: (cum += FIELD_DURATION),
        fn: () => {
          setActiveRow(null);
          setActiveField(null);
        },
      },
      {
        delay: (cum += ROW_GAP),
        fn: () => {
          setActiveRow(2);
          setActiveField("left");
          fieldHaptic(rows[2][0]);
        },
      },
      {
        delay: (cum += FIELD_DURATION),
        fn: () => {
          setActiveRow(2);
          setActiveField("right");
          fieldHaptic(rows[2][1]);
        },
      },
      {
        delay: (cum += FIELD_DURATION),
        fn: () => {
          setActiveRow(null);
          setActiveField(null);
          setIsPlaying(false);
        },
      },
    ];
    steps.forEach(({ delay, fn }) => timers.current.push(setTimeout(fn, delay)));
  }

  const isInitialMount = useRef(true);
  const shouldAutoPlay = useRef(false);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (mode === "read") {
      shouldAutoPlay.current = true;
    }
  }, [charIdx]);

  useEffect(() => {
    if (shouldAutoPlay.current && !isPlaying) {
      shouldAutoPlay.current = false;
      play();
    }
  });

  function next() {
    clearTimers();
    setActiveRow(null);
    setActiveField(null);
    setIsPlaying(false);
    setCharIdx((i) => Math.min(i + 1, ALL_CHARS.length - 1));
    resetWrite();
  }

  function prev() {
    clearTimers();
    setActiveRow(null);
    setActiveField(null);
    setIsPlaying(false);
    setCharIdx((i) => Math.max(i - 1, 0));
    resetWrite();
  }

  function resetWrite() {
    setTapDots(Array(6).fill(false));
    setInputPos(-1);
    setWriteResult(null);
    setWritePhase("idle");
    setIsHolding(false);
    setHoldProgress(0);
    holdStart.current = null;
    if (holdRaf.current) cancelAnimationFrame(holdRaf.current);
    if (holdTriggerTimer.current) clearTimeout(holdTriggerTimer.current);
    tapDownTime.current = null;
    setCurrentPressDur(0);
    if (pressAnimRef.current) cancelAnimationFrame(pressAnimRef.current);
    setTapThreshold(DEFAULT_THRESHOLD);
    tapDurations.current = [];
    setActiveRow(null);
    setActiveField(null);
  }

  useEffect(() => {
    return () => {
      clearTimers();
      if (holdRaf.current) cancelAnimationFrame(holdRaf.current);
      if (holdTriggerTimer.current) clearTimeout(holdTriggerTimer.current);
      if (pressAnimRef.current) cancelAnimationFrame(pressAnimRef.current);
      Speech.stop();
    };
  }, []);

  useEffect(() => {
    if (inputPos !== 6) return;
    const correct = letter.dots.every((v, i) => v === tapDots[i]);
    setWriteResult(correct ? "correct" : "wrong");
    setWriteHistory((prev) => [...prev, { char: letter.char, correct }]);
    speak(correct ? "correct" : "try again");
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(
        correct
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Error
      );
    }
  }, [inputPos]);

  const enterTappingMode = useCallback(() => {
    if (holdRaf.current) cancelAnimationFrame(holdRaf.current);
    if (holdTriggerTimer.current) clearTimeout(holdTriggerTimer.current);
    setIsHolding(false);
    setHoldProgress(0);
    holdStart.current = null;
    setWritePhase("tapping");
    setTapDots(Array(6).fill(false));
    setInputPos(-1);
    setTapThreshold(DEFAULT_THRESHOLD);
    tapDurations.current = [];
    tapDownTime.current = null;
    setCurrentPressDur(0);
    setActiveRow(null);
    setActiveField(null);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }
  }, []);

  const onWritePressIn = useCallback(() => {
    if (writeResult !== null) return;

    if (writePhase === "idle") {
      setIsHolding(true);
      setHoldProgress(0);
      holdStart.current = Date.now();
      const animate = () => {
        const elapsed = Date.now() - (holdStart.current ?? 0);
        const p = Math.min(elapsed / HOLD_DURATION, 1);
        setHoldProgress(p);
        if (p < 1) holdRaf.current = requestAnimationFrame(animate);
      };
      holdRaf.current = requestAnimationFrame(animate);
      holdTriggerTimer.current = setTimeout(enterTappingMode, HOLD_DURATION);
      return;
    }

    tapDownTime.current = Date.now();
    setCurrentPressDur(0);
    const animate = () => {
      if (tapDownTime.current === null) return;
      setCurrentPressDur(Date.now() - tapDownTime.current);
      pressAnimRef.current = requestAnimationFrame(animate);
    };
    pressAnimRef.current = requestAnimationFrame(animate);

    if (writePhase === "tapping" && inputPos === -1) {
      setTapDots(Array(6).fill(false));
      setInputPos(0);
    }

    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [inputPos, writeResult, writePhase, enterTappingMode]);

  const onWritePressOut = useCallback(() => {
    if (writePhase === "idle" && isHolding) {
      if (holdRaf.current) cancelAnimationFrame(holdRaf.current);
      if (holdTriggerTimer.current) clearTimeout(holdTriggerTimer.current);
      setIsHolding(false);
      setHoldProgress(0);
      holdStart.current = null;
      return;
    }

    if (pressAnimRef.current) cancelAnimationFrame(pressAnimRef.current);
    if (tapDownTime.current === null) return;

    const duration = Date.now() - tapDownTime.current;
    tapDownTime.current = null;
    setCurrentPressDur(0);

    if (writeResult !== null || inputPos < 0 || inputPos >= 6) return;

    const isLong = duration >= tapThreshold;
    const dotIdx = TAP_DOT_ORDER[inputPos];
    setTapDots((prev) => {
      const nd = [...prev];
      nd[dotIdx] = isLong;
      return nd;
    });
    setInputPos((p) => p + 1);

    tapDurations.current.push(duration);
    if (tapDurations.current.length > 20) tapDurations.current.shift();
    setTapThreshold(computeAdaptiveThreshold(tapDurations.current));

    if (Platform.OS !== "web") {
      Haptics.impactAsync(
        isLong
          ? Haptics.ImpactFeedbackStyle.Heavy
          : Haptics.ImpactFeedbackStyle.Light
      );
    }
  }, [inputPos, tapThreshold, writeResult, writePhase, isHolding]);

  const pressing = tapDownTime.current !== null;
  const pressIsLong = currentPressDur >= tapThreshold;


  const strokeOffset = HOLD_CIRCUMFERENCE * (1 - holdProgress);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { marginTop: insets.top }]}>
        <View style={styles.headerLeft}>
          <Text style={styles.brandText}>HAPTIC{"\n"}MIND</Text>
        </View>
        <Text style={styles.headerTitle}>Letter Training</Text>
        {onDone ? (
          <Pressable onPress={onDone} style={styles.closeButton} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close tutorial" accessibilityHint="Go back to World Lens">
            <Text style={styles.closeText}>CLOSE</Text>
          </Pressable>
        ) : (
          <View style={{ width: 50 }} />
        )}
      </View>

      <View style={styles.counterRow}>
        <Text style={styles.counterCurrent}>{charIdx + 1}</Text>
        <Text style={styles.counterTotal}>/ {ALL_CHARS.length}</Text>
      </View>

      <View style={styles.modeTabs}>
        {(["read", "write"] as const).map((m) => (
          <Pressable
            key={m}
            onPress={() => {
              setMode(m);
              resetWrite();
            }}
            style={[
              styles.modeTab,
              {
                backgroundColor:
                  mode === m
                    ? "rgba(255,255,0,0.12)"
                    : "rgba(39,39,42,0.4)",
                borderColor:
                  mode === m
                    ? "rgba(255,255,0,0.4)"
                    : "rgba(63,63,70,0.3)",
              },
            ]}
          >
            <Text
              style={[
                styles.modeTabText,
                { color: mode === m ? Colors.primary : Colors.zinc600 },
              ]}
            >
              {m === "read" ? "READ · FEEL" : "WRITE · TAP"}
            </Text>
          </Pressable>
        ))}
      </View>

      {mode === "read" ? (
        <View style={styles.readContent}>
          <View style={styles.readCenter}>
            <Pressable
              onPress={play}
              disabled={isPlaying}
              style={[
                styles.playCircle,
                {
                  borderColor: isPlaying
                    ? "rgba(255,255,0,0.4)"
                    : "rgba(63,63,70,0.5)",
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Feel letter ${letter.char} in Braille`}
              accessibilityHint="Plays the haptic pulse pattern for this letter"
            >
              <Text
                style={[
                  styles.playLetter,
                  {
                    textShadowColor: isPlaying
                      ? "rgba(255,255,0,0.4)"
                      : "transparent",
                    textShadowOffset: { width: 0, height: 0 },
                    textShadowRadius: isPlaying ? 50 : 0,
                  },
                ]}
              >
                {letter.char}
              </Text>
            </Pressable>

            <Text
              style={[
                styles.playHint,
                {
                  color: isPlaying ? Colors.primary : Colors.zinc500,
                },
              ]}
            >
              {isPlaying ? "FEELING THE PULSE..." : "TAP TO FEEL"}
            </Text>
          </View>

          <View style={styles.rowBreakdown}>
            {rows.map(([left, right], rowIdx) => {
              const isRowActive = activeRow === rowIdx;
              const isLeft = isRowActive && activeField === "left";
              const isRight = isRowActive && activeField === "right";
              return (
                <View
                  key={rowIdx}
                  style={[
                    styles.rowItem,
                    {
                      backgroundColor: isRowActive
                        ? "rgba(255,255,0,0.06)"
                        : "transparent",
                      borderColor: isRowActive
                        ? "rgba(255,255,0,0.2)"
                        : "rgba(63,63,70,0.2)",
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.rowNum,
                      {
                        color: isRowActive
                          ? Colors.primary
                          : Colors.zinc700,
                      },
                    ]}
                  >
                    {rowIdx + 1}
                  </Text>
                  <View
                    style={[
                      styles.dotIndicator,
                      {
                        backgroundColor:
                          isLeft && left
                            ? Colors.primary
                            : left
                            ? "rgba(255,255,0,0.6)"
                            : Colors.zinc900,
                        transform: [
                          { scale: isLeft && left ? 1.1 : 1 },
                        ],
                      },
                    ]}
                  >
                    <Text
                      style={{
                        color:
                          left
                            ? "#000"
                            : Colors.zinc700,
                        fontSize: 16,
                        fontWeight: "700",
                      }}
                    >
                      {left ? "●" : "○"}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.dotIndicator,
                      {
                        backgroundColor:
                          isRight && right
                            ? Colors.primary
                            : right
                            ? "rgba(255,255,0,0.6)"
                            : Colors.zinc900,
                        transform: [
                          { scale: isRight && right ? 1.1 : 1 },
                        ],
                      },
                    ]}
                  >
                    <Text
                      style={{
                        color:
                          right
                            ? "#000"
                            : Colors.zinc700,
                        fontSize: 16,
                        fontWeight: "700",
                      }}
                    >
                      {right ? "●" : "○"}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.rowLabel,
                      {
                        color: isRowActive
                          ? Colors.primary
                          : Colors.zinc600,
                      },
                    ]}
                  >
                    {left && right
                      ? "Both"
                      : left
                      ? "Left"
                      : right
                      ? "Right"
                      : "Silent"}
                  </Text>
                </View>
              );
            })}
          </View>

          <View style={styles.navRow}>
            <Pressable onPress={prev} style={[styles.navButton, isFirst && styles.navButtonDisabled]} disabled={isFirst} accessibilityRole="button" accessibilityLabel="Previous letter">
              <Text style={[styles.navButtonText, isFirst && styles.navButtonTextDisabled]}>← PREV</Text>
            </Pressable>
            <Pressable onPress={next} style={[styles.navButton, isLast && styles.navButtonDisabled]} disabled={isLast} accessibilityRole="button" accessibilityLabel="Next letter">
              <Text style={[styles.navButtonText, isLast && styles.navButtonTextDisabled]}>NEXT →</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.writeContent}>
          <View style={styles.writeTargetRow}>
            <View style={styles.writeTargetBox}>
              <Text style={styles.writeTargetChar}>{letter.char}</Text>
            </View>
            <View style={styles.writeTargetInfo}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <ReferenceDotGrid
                  dots={letter.dots}
                  highlight={
                    inputPos >= 0 && inputPos < 6 ? inputPos : null
                  }
                />
                <View style={{ gap: 2 }}>
                  <Text style={styles.writeTargetLabel}>TARGET PATTERN</Text>
                  <Text style={styles.writeTargetHint}>
                    Short = ○ · Long = ●
                  </Text>
                </View>
              </View>
              <View style={styles.tapSequence}>
                {TAP_DOT_ORDER.map((dotIdx, pos) => (
                  <View
                    key={pos}
                    style={[
                      styles.tapSeqDot,
                      {
                        backgroundColor:
                          pos < inputPos
                            ? tapDots[dotIdx] === letter.dots[dotIdx]
                              ? Colors.greenFaint
                              : Colors.redFaint
                            : pos === inputPos
                            ? Colors.primaryFaint
                            : "rgba(39,39,42,0.3)",
                        borderWidth: pos === inputPos ? 1 : 0,
                        borderColor:
                          pos === inputPos
                            ? "rgba(255,255,0,0.4)"
                            : "transparent",
                      },
                    ]}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: "700",
                        color:
                          pos < inputPos
                            ? tapDots[dotIdx] === letter.dots[dotIdx]
                              ? Colors.green
                              : Colors.red
                            : pos === inputPos
                            ? Colors.primary
                            : Colors.zinc600,
                      }}
                    >
                      {letter.dots[dotIdx] ? "●" : "○"}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          </View>

          <Pressable
            onPressIn={onWritePressIn}
            onPressOut={onWritePressOut}
            style={[
              styles.writeTapZone,
              {
                borderColor:
                  writeResult === "correct"
                    ? "rgba(34,197,94,0.5)"
                    : writeResult === "wrong"
                    ? "rgba(239,68,68,0.4)"
                    : pressing
                    ? "rgba(255,255,0,0.5)"
                    : "rgba(63,63,70,0.3)",
                backgroundColor:
                  writeResult === "correct"
                    ? "rgba(34,197,94,0.05)"
                    : writeResult === "wrong"
                    ? "rgba(239,68,68,0.03)"
                    : pressing
                    ? "rgba(255,255,0,0.03)"
                    : "transparent",
              },
            ]}
          >
            {writeResult !== null ? (
              <View style={styles.resultView}>
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 24 }}
                >
                  <WriteDotGrid
                    tapDots={tapDots}
                    inputPos={6}
                    pressing={false}
                    pressIsLong={false}
                  />
                  <View style={{ alignItems: "center", gap: 8 }}>
                    <Text
                      style={{
                        fontSize: 56,
                        fontWeight: "700",
                        color:
                          writeResult === "correct"
                            ? Colors.green
                            : Colors.red,
                      }}
                    >
                      {writeResult === "correct" ? "✓" : "✗"}
                    </Text>
                    <Text
                      style={{
                        fontSize: 16,
                        fontWeight: "700",
                        letterSpacing: 2,
                        textTransform: "uppercase",
                        color:
                          writeResult === "correct"
                            ? Colors.green
                            : Colors.red,
                      }}
                    >
                      {writeResult === "correct" ? "Correct!" : "Try again"}
                    </Text>
                  </View>
                </View>
                {writeResult === "wrong" && (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 20,
                      marginTop: 12,
                    }}
                  >
                    <View style={{ alignItems: "center", gap: 4 }}>
                      <Text style={styles.compLabel}>Yours</Text>
                      <ReferenceDotGrid dots={tapDots as Dots} />
                    </View>
                    <Text style={{ color: Colors.zinc600, fontSize: 24 }}>
                      →
                    </Text>
                    <View style={{ alignItems: "center", gap: 4 }}>
                      <Text style={styles.compLabel}>Target</Text>
                      <ReferenceDotGrid dots={letter.dots} />
                    </View>
                  </View>
                )}
                <Pressable
                  onPress={resetWrite}
                  style={styles.retryButton}
                >
                  <Text style={styles.retryButtonText}>
                    {writeResult === "correct"
                      ? "PRACTICE AGAIN"
                      : "RETRY"}
                  </Text>
                </Pressable>
              </View>
            ) : writePhase === "idle" ? (
              <View style={styles.holdView}>
                <View style={styles.holdRingContainer}>
                  <Svg
                    width={100}
                    height={100}
                    viewBox="0 0 76 76"
                    style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}
                  >
                    <Circle
                      cx="38"
                      cy="38"
                      r="34"
                      fill="none"
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="3"
                    />
                    {isHolding && (
                      <Circle
                        cx="38"
                        cy="38"
                        r="34"
                        fill="none"
                        stroke={Colors.primary}
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeDasharray={`${HOLD_CIRCUMFERENCE}`}
                        strokeDashoffset={`${strokeOffset}`}
                      />
                    )}
                  </Svg>
                  <View
                    style={[
                      styles.holdInnerCircle,
                      {
                        borderColor: isHolding
                          ? "rgba(255,255,0,0.6)"
                          : "rgba(255,255,255,0.1)",
                        backgroundColor: isHolding
                          ? "rgba(255,255,0,0.08)"
                          : "rgba(0,0,0,0.5)",
                      },
                    ]}
                  >
                    <Text
                      style={{
                        fontSize: 28,
                        fontWeight: "700",
                        color: isHolding
                          ? Colors.primary
                          : "rgba(255,255,255,0.2)",
                      }}
                    >
                      ✎
                    </Text>
                  </View>
                </View>
                <Text
                  style={[
                    styles.holdText,
                    {
                      color: isHolding
                        ? "rgba(255,255,0,0.8)"
                        : Colors.zinc400,
                    },
                  ]}
                >
                  {isHolding ? "KEEP HOLDING..." : "HOLD TO WRITE"}
                </Text>
                <Text style={styles.holdSubText}>
                  Then 6 presses to write "{letter.char}"
                </Text>
              </View>
            ) : inputPos === -1 ? (
              <View style={styles.readyView}>
                <WriteDotGrid
                  tapDots={tapDots}
                  inputPos={-1}
                  pressing={false}
                  pressIsLong={false}
                />
                <Text style={styles.readyText}>READY — START PRESSING</Text>
                <Text style={styles.readySubText}>
                  Short = blank · Long = filled
                </Text>
              </View>
            ) : (
              <View style={styles.activeInput}>
                <WriteDotGrid
                  tapDots={tapDots}
                  inputPos={inputPos}
                  pressing={pressing}
                  pressIsLong={pressIsLong}
                />
                <View style={styles.durationBarContainer}>
                  <View style={styles.durationBarLabels}>
                    <Text style={styles.durationLabel}>○ short</Text>
                    <Text style={styles.durationLabelCenter}>
                      {tapThreshold}ms
                    </Text>
                    <Text style={styles.durationLabel}>● long</Text>
                  </View>
                  <View style={styles.durationBar}>
                    <View
                      style={[
                        styles.durationFill,
                        {
                          width: pressing
                            ? `${
                                Math.min(
                                  currentPressDur / (tapThreshold * 2),
                                  1
                                ) * 100
                              }%`
                            : "0%",
                          backgroundColor: pressIsLong
                            ? Colors.primary
                            : "rgba(255,255,0,0.3)",
                        },
                      ]}
                    />
                    <View style={styles.durationThreshold} />
                  </View>
                  <Text
                    style={[
                      styles.durationStatus,
                      {
                        color: pressing
                          ? pressIsLong
                            ? Colors.primary
                            : Colors.zinc500
                          : Colors.zinc600,
                      },
                    ]}
                  >
                    {pressing
                      ? pressIsLong
                        ? "● FILLED"
                        : "○ BLANK"
                      : `POSITION ${inputPos + 1} OF 6`}
                  </Text>
                </View>
                <View style={styles.positionDots}>
                  {Array(6)
                    .fill(0)
                    .map((_, i) => (
                      <View
                        key={i}
                        style={{
                          width: 20,
                          height: 10,
                          borderRadius: 5,
                          backgroundColor:
                            i < inputPos
                              ? tapDots[TAP_DOT_ORDER[i]]
                                ? Colors.primary
                                : Colors.zinc700
                              : i === inputPos
                              ? "rgba(255,255,0,0.5)"
                              : Colors.zinc800,
                        }}
                      />
                    ))}
                </View>
              </View>
            )}
          </Pressable>

          <View style={styles.navRow}>
            <Pressable onPress={prev} style={[styles.navButton, isFirst && styles.navButtonDisabled]} disabled={isFirst} accessibilityRole="button" accessibilityLabel="Previous letter">
              <Text style={[styles.navButtonText, isFirst && styles.navButtonTextDisabled]}>← PREV</Text>
            </Pressable>
            <Pressable onPress={next} style={[styles.navButton, isLast && styles.navButtonDisabled]} disabled={isLast} accessibilityRole="button" accessibilityLabel="Next letter">
              <Text style={[styles.navButtonText, isLast && styles.navButtonTextDisabled]}>NEXT →</Text>
            </Pressable>
          </View>

          {writeHistory.length > 0 && (
            <View style={styles.historyContainer}>
              <View style={styles.historyHeader}>
                <Text style={styles.historyLabel}>HISTORY</Text>
                <View style={styles.historyDivider} />
                <Text style={styles.historyScore}>
                  {writeHistory.filter((h) => h.correct).length}/
                  {writeHistory.length}
                </Text>
              </View>
              <View style={styles.historyBadges}>
                {writeHistory.slice(-14).map((h, i) => (
                  <View
                    key={i}
                    style={[
                      styles.historyBadge,
                      {
                        backgroundColor: h.correct
                          ? Colors.greenFaint
                          : Colors.redFaint,
                        borderColor: h.correct
                          ? "rgba(34,197,94,0.3)"
                          : "rgba(239,68,68,0.2)",
                      },
                    ]}
                  >
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: "700",
                        color: h.correct ? Colors.green : Colors.red,
                      }}
                    >
                      {h.char}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>
      )}

      <View style={[styles.progressBarContainer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <View style={styles.progressBarTrack}>
          <View style={[styles.progressBarFill, { width: `${((charIdx + 1) / ALL_CHARS.length) * 100}%` }]} />
        </View>
        <Text style={styles.progressLabel}>{letter.char === ' ' ? 'SPC' : letter.char}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 4,
  },
  headerLeft: {
    width: 50,
  },
  brandText: {
    color: Colors.primary,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 2,
  },
  headerTitle: {
    color: Colors.white,
    fontSize: 18,
    fontWeight: "700",
  },
  closeButton: {
    height: 44,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: {
    color: "#000000",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 2,
  },
  counterRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "flex-end",
    paddingHorizontal: 24,
    gap: 4,
    marginBottom: 4,
  },
  counterCurrent: {
    color: Colors.primary,
    fontSize: 28,
    fontWeight: "700",
  },
  counterTotal: {
    color: Colors.zinc700,
    fontSize: 16,
    fontWeight: "400",
  },
  modeTabs: {
    flexDirection: "row",
    marginHorizontal: 20,
    gap: 8,
    marginTop: 4,
    marginBottom: 8,
  },
  modeTab: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  modeTabText: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 2,
  },
  readContent: {
    flex: 1,
  },
  readCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 12,
  },
  playCircle: {
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 2,
    backgroundColor: Colors.zinc950,
    alignItems: "center",
    justifyContent: "center",
  },
  playLetter: {
    fontSize: 96,
    fontWeight: "700",
    color: Colors.primary,
  },
  playHint: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
    marginTop: 16,
  },
  rowBreakdown: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    gap: 6,
  },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  rowNum: {
    fontSize: 18,
    fontWeight: "700",
    width: 24,
    textAlign: "center",
  },
  dotIndicator: {
    width: 48,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 8,
  },
  navRow: {
    flexDirection: "row",
    marginHorizontal: 20,
    gap: 10,
    marginBottom: 8,
  },
  navButton: {
    flex: 1,
    height: 52,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: Colors.zinc800,
    backgroundColor: Colors.zinc950,
    alignItems: "center",
    justifyContent: "center",
  },
  navButtonDisabled: {
    opacity: 0.3,
  },
  navButtonText: {
    color: Colors.zinc400,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 2,
  },
  navButtonTextDisabled: {
    color: Colors.zinc700,
  },
  writeContent: {
    flex: 1,
  },
  writeTargetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  writeTargetBox: {
    width: 72,
    height: 72,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: "rgba(255,255,0,0.3)",
    backgroundColor: "rgba(255,255,0,0.05)",
    alignItems: "center",
    justifyContent: "center",
  },
  writeTargetChar: {
    color: Colors.primary,
    fontSize: 44,
    fontWeight: "700",
  },
  writeTargetInfo: {
    flex: 1,
    gap: 8,
  },
  writeTargetLabel: {
    color: Colors.zinc500,
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 1,
  },
  writeTargetHint: {
    color: Colors.zinc700,
    fontSize: 10,
    fontWeight: "400",
  },
  tapSequence: {
    flexDirection: "row",
    gap: 6,
  },
  tapSeqDot: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  writeTapZone: {
    flex: 1,
    marginHorizontal: 20,
    marginVertical: 8,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  resultView: {
    alignItems: "center",
    gap: 16,
  },
  compLabel: {
    color: Colors.zinc500,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  retryButton: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: Colors.zinc800,
    backgroundColor: Colors.zinc950,
    marginTop: 4,
  },
  retryButtonText: {
    color: Colors.zinc400,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 2,
  },
  holdView: {
    alignItems: "center",
    gap: 16,
  },
  holdRingContainer: {
    width: 100,
    height: 100,
    alignItems: "center",
    justifyContent: "center",
  },
  holdInnerCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  holdText: {
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  holdSubText: {
    color: Colors.zinc700,
    fontSize: 13,
    fontWeight: "400",
  },
  readyView: {
    alignItems: "center",
    gap: 16,
  },
  readyText: {
    color: Colors.primary,
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  readySubText: {
    color: Colors.zinc600,
    fontSize: 13,
    fontWeight: "400",
  },
  activeInput: {
    alignItems: "center",
    gap: 16,
  },
  durationBarContainer: {
    width: 240,
    alignItems: "center",
    gap: 6,
  },
  durationBarLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    paddingHorizontal: 4,
  },
  durationLabel: {
    fontSize: 10,
    fontWeight: "400",
    color: Colors.zinc700,
  },
  durationLabelCenter: {
    fontSize: 10,
    fontWeight: "400",
    color: Colors.zinc600,
  },
  durationBar: {
    width: "100%",
    height: 16,
    backgroundColor: Colors.zinc900,
    borderRadius: 8,
    overflow: "hidden",
    position: "relative",
  },
  durationFill: {
    position: "absolute",
    top: 0,
    left: 0,
    height: "100%",
    borderRadius: 8,
  },
  durationThreshold: {
    position: "absolute",
    top: 0,
    left: "50%",
    height: "100%",
    width: 2,
    backgroundColor: "rgba(255,255,0,0.7)",
  },
  durationStatus: {
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  positionDots: {
    flexDirection: "row",
    gap: 8,
  },
  historyContainer: {
    paddingHorizontal: 20,
    paddingBottom: 4,
  },
  historyHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  historyLabel: {
    color: Colors.zinc600,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 2,
  },
  historyDivider: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.zinc900,
  },
  historyScore: {
    color: "rgba(34,197,94,0.7)",
    fontSize: 14,
    fontWeight: "700",
  },
  historyBadges: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  historyBadge: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  progressBarContainer: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    gap: 10,
    paddingTop: 4,
    paddingBottom: 8,
  },
  progressBarTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.zinc900,
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: Colors.primary,
  },
  progressLabel: {
    color: Colors.zinc500,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    width: 30,
    textAlign: "right",
  },
});
