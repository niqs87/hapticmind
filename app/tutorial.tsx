import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { TutorialScreen } from '@/components/TutorialScreen';

const ONBOARDED_KEY = 'hapticmind_onboarded';

export default function TutorialRoute() {
  const router = useRouter();

  const handleDone = () => {
    AsyncStorage.setItem(ONBOARDED_KEY, '1').catch(() => {});
    router.replace('/gemini-live');
  };

  return <TutorialScreen onDone={handleDone} />;
}
