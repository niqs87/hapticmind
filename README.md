# HapticMind

A mobile app built with [Expo](https://expo.dev) and Gemini Live API integration.

## Requirements

- Node.js
- Xcode (for iOS)
- [Expo CLI](https://docs.expo.dev/get-started/installation/)

## Configuration

1. Copy `.env.example` to `.env` (or create `.env` manually):

   ```bash
   cp .env.example .env
   ```

2. Add your Gemini API key to the `.env` file:

   ```
   EXPO_PUBLIC_GEMINI_API_KEY=your_api_key
   ```

   You can generate an API key at [Google AI Studio](https://aistudio.google.com/apikey).

## Running the app

> **Note:** This project requires a native build — it does not work with Expo Go.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Generate native project files:

   ```bash
   npx expo prebuild
   ```

3. Build and run the app on iOS:

   ```bash
   npx expo run:ios
   ```
