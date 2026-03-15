# HapticMind – Project Description

> Summary of the Project's features and functionality, technologies used, information about any other data sources used, and findings and learnings as you worked through the project.

---

## Features and Functionality

HapticMind is an **accessibility assistive app** for people with visual impairments. It acts as a "World Lens" – users can ask questions about their surroundings (via voice, Braille input, or keyboard), and the AI responds with descriptions delivered through:

- **Audio** – natural voice synthesis (Gemini's TTS)
- **On-screen text** – for users with partial sight or companions
- **Haptic Braille** – each letter of the response is converted into a 6-dot Braille pattern and played via device vibrations, with row-scanning animation (left/right fields, top-to-bottom rows)

**Input modes:**

1. **Microphone (hold-to-speak)** – press and hold to record, release to send. Designed for quick voice queries.
2. **Braille tapping** – 3×2 matrix of virtual dots; short tap = blank, long tap = filled. Users spell out messages in Braille (A–Z, 0–9, punctuation) with adaptive tap threshold.
3. **Keyboard** – standard text input for users who prefer typing.

**Camera context** – The app continuously sends video frames to Gemini so the model has visual context when users ask questions like "What do you see?" or "Describe the room." For non-visual questions (e.g. "What is the weather?"), the model answers without relying on the camera.

Additional features: onboarding flow, **Practice** screen for learning Braille, and input mode selector (mic / tapping / keyboard).

---

## Technologies Used

| Category      | Technology                                                                 |
| ------------- | -------------------------------------------------------------------------- |
| Framework     | Expo SDK 54, React Native                                                   |
| Navigation    | Expo Router                                                                 |
| Styling       | NativeWind (Tailwind CSS v4)                                                |
| AI / Cloud    | **Gemini Live API** (Google) – WebSocket, real-time audio, multimodal       |
| Model         | `gemini-2.5-flash-native-audio-preview-12-2025`                             |
| Audio capture | `@speechmatics/expo-two-way-audio` (native PCM), Web Audio API (web)        |
| Haptics       | `expo-haptics`, `Vibration` API                                             |
| Camera        | `expo-camera`                                                               |
| State         | React state, React Query, Zustand                                            |
| Persistence   | `@react-native-async-storage/async-storage`                                  |

---

## Data Sources

- **Gemini Live API (Google)** – sole external data/API source. Handles speech-to-text, vision (image frames), text input, and text-to-speech. No other cloud services or databases.
- **Local device** – camera (video frames), microphone (audio), and device haptics/vibration.
- **AsyncStorage** – only for onboarding flag (`hapticmind_onboarded`), no user data or analytics.

---

## Findings and Learnings

1. **Gemini Live API** – The bidirectional WebSocket API works well for real-time assistive apps. Disabling automatic VAD and using manual `activityStart`/`activityEnd` gave better control for hold-to-speak, avoiding unintended cut-offs.

2. **Braille UX** – Short vs long tap for blank vs filled dots required an **adaptive threshold** (based on recent tap durations) to handle different user speeds. Row-scan animation (reading Braille letter-by-letter with haptics) needed careful timing constants (`READ_FIELD_DURATION`, `READ_ROW_GAP`) to feel natural.

3. **Platform differences** – Web uses Web Audio API; native uses `expo-two-way-audio` for PCM capture. The app needed separate implementations (`gemini-media-web.ts` vs `gemini-media-native.ts`) for streaming and playback.

4. **Multimodal prompt design** – A clear system instruction was needed so the model uses camera context only when relevant (e.g. "describe this") and ignores it for general questions.

5. **Simplicity** – Direct connection from the app to Gemini (no custom backend) keeps deployment and maintenance simple, at the cost of exposing the API key in the client (acceptable for a demo/prototype).
