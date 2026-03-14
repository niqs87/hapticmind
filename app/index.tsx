import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { SplashView } from '@/components/SplashView';

const ONBOARDED_KEY = 'hapticmind_onboarded';

export default function IndexScreen() {
  const router = useRouter();
  const [isFirstRun, setIsFirstRun] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDED_KEY)
      .then((val) => {
        setIsFirstRun(val !== '1');
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const handleContinue = useCallback(() => {
    if (isFirstRun) {
      router.replace('/tutorial');
    } else {
      router.replace('/gemini-live');
    }
  }, [isFirstRun, router]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000000' }} />
    );
  }

  return <SplashView onContinue={handleContinue} />;
}
