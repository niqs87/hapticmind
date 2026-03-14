const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Plugin dodaje AVAudioSessionCategoryOptionDefaultToSpeaker do expo-av,
 * gdy allowsRecordingIOS=true. Dzięki temu audio gra przez głośnik
 * zamiast słuchawki — tryb "głośnomówiący" (telefon leży obok).
 */
function withExpoAvSpeaker(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const filePath = path.join(
        process.cwd(),
        'node_modules',
        'expo-av',
        'ios',
        'EXAV',
        'EXAV.m'
      );

      if (!fs.existsSync(filePath)) {
        console.warn('[expo-av-speaker] EXAV.m not found, skipping patch');
        return config;
      }

      let content = fs.readFileSync(filePath, 'utf8');
      const oldLine =
        'requiredAudioCategoryOptions = requiredAudioCategoryOptions | AVAudioSessionCategoryOptionAllowBluetooth;';
      const newLine =
        'requiredAudioCategoryOptions = requiredAudioCategoryOptions | AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionDefaultToSpeaker;';

      if (content.includes(newLine)) {
        return config;
      }
      if (!content.includes(oldLine)) {
        console.warn('[expo-av-speaker] Patch pattern not found in EXAV.m');
        return config;
      }

      content = content.replace(oldLine, newLine);
      fs.writeFileSync(filePath, content);
      console.log('[expo-av-speaker] Patched EXAV.m for DefaultToSpeaker');
      return config;
    },
  ]);
}

module.exports = withExpoAvSpeaker;
