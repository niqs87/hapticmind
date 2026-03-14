#!/usr/bin/env node
/**
 * Patch expo-av: dodaje DefaultToSpeaker przy PlayAndRecord
 * Dzięki temu audio gra przez głośnik zamiast słuchawki (tryb głośnomówiący).
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'node_modules', 'expo-av', 'ios', 'EXAV', 'EXAV.m');
if (!fs.existsSync(filePath)) {
  console.warn('[patch-expo-av-speaker] EXAV.m not found, skipping');
  process.exit(0);
}

let content = fs.readFileSync(filePath, 'utf8');
const newLine =
  'requiredAudioCategoryOptions = requiredAudioCategoryOptions | AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionDefaultToSpeaker;';
const oldLine =
  'requiredAudioCategoryOptions = requiredAudioCategoryOptions | AVAudioSessionCategoryOptionAllowBluetooth;';

if (content.includes(newLine)) {
  process.exit(0);
}
if (!content.includes(oldLine)) {
  console.warn('[patch-expo-av-speaker] Pattern not found in EXAV.m');
  process.exit(0);
}

content = content.replace(oldLine, newLine);
fs.writeFileSync(filePath, content);
console.log('[patch-expo-av-speaker] Patched for DefaultToSpeaker');
