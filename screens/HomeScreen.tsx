import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  Animated,
  Switch,
} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import { Path } from 'react-native-svg';
import Svg from 'react-native-svg';

// Helper: Convert IP string to integer
function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + parseInt(part, 10), 0);
}

// Helper: Convert integer back to IP string
function intToIp(num: number): string {
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  ].join('.');
}

// Helper: Get prefix length from a subnet mask string (e.g., "255.255.255.0" -> 24)
function getPrefixLength(mask: string): number {
  return mask
    .split('.')
    .reduce((acc, octet) => acc + parseInt(octet, 10).toString(2).split('0').join('').length, 0);
}

// Helper: Generate IP range for a given IP and prefix.
// If the range is too big (and prefix < 24), fallback to /24.
function generateIPRange(ip: string, prefix: number): string[] {
  if (prefix < 24) {
    const count = Math.pow(2, 32 - prefix);
    if (count > 254) {
      console.log(`Range too big for prefix ${prefix}. Falling back to /24.`);
      return generateIPRange(ip, 24);
    }
  }
  const ipInt = ipToInt(ip);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const networkBase = ipInt & mask;
  const count = Math.pow(2, 32 - prefix);
  const range: string[] = [];
  // Skip the network and broadcast addresses.
  for (let i = 1; i < count - 1; i++) {
    range.push(intToIp(networkBase + i));
  }
  return range;
}

export default function UmbrelScanner() {
  const [scanning, setScanning] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [foundInstances, setFoundInstances] = useState<Array<{ address: string; name: string }>>([]);
  const [error, setError] = useState('');
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [isAuto, setIsAuto] = useState(true);
  const [progress, setProgress] = useState(0);
  const progressAnim = useRef(new Animated.Value(0)).current;

  // On mount, load stored Umbrel instance if available
  useEffect(() => {
    const loadInstance = async () => {
      try {
        const instance = await AsyncStorage.getItem('umbrelInstance');
        if (instance) setSelectedInstance(instance);
      } catch (e) {
        console.error('Failed to load stored instance:', e);
      }
    };
    loadInstance();
  }, []);

  const storeInstance = async (url: string) => {
    try {
      await AsyncStorage.setItem('umbrelInstance', url);
    } catch (e) {
      console.error('Failed to store instance:', e);
    }
  };

  // Animate progressAnim to new progress value over 300ms
  const animateProgress = (toValue: number) => {
    Animated.timing(progressAnim, {
      toValue,
      duration: 300,
      useNativeDriver: false,
    }).start();
  };

  // Attempts to fetch system status from a given IP.
  // Expects a JSON response like: {"result":{"data":"running"}}
  const checkHost = async (ip: string): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`http://${ip}/trpc/system.status`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) return false;
      const json = await response.json();
      return json?.result?.data?.toLowerCase() === 'running';
    } catch (err) {
      return false;
    }
  };

  // Scan network using device's IP and subnet (via NetInfo)
  const scanNetworkJS = async () => {
    if (Platform.OS === 'web') {
      setError('Network scanning is only available on mobile devices');
      return;
    }
    setScanning(true);
    setError('');
    setFoundInstances([]);
    setProgress(0);
    animateProgress(0);

    try {
      const state = await NetInfo.fetch();
      console.log('NetInfo state:', state);
      const deviceIP = state.details && (state.details as any).ipAddress;
      if (!deviceIP) {
        setError('Unable to determine device IP address.');
        setScanning(false);
        return;
      }
      console.log(`Device IP: ${deviceIP}`);

      let prefix = 24;
      if (state.details && (state.details as any).subnet) {
        prefix = getPrefixLength((state.details as any).subnet);
      }
      console.log(`Using prefix: ${prefix}`);
      
      const ipRange = generateIPRange(deviceIP, prefix);
      console.log(`Generated IP range of ${ipRange.length} addresses`);
      const total = ipRange.length;
      const foundIPs: Array<{ address: string; name: string }> = [];
      const concurrency = 20;
      let processed = 0;

      const processIp = async (ip: string) => {
        const isUmbrel = await checkHost(ip);
        processed++;
        const currentProgress = (processed / total) * 100;
        setProgress(currentProgress);
        animateProgress(currentProgress);
        if (isUmbrel) {
          foundIPs.push({ address: ip, name: `Umbrel Instance ${foundIPs.length + 1}` });
          setFoundInstances([...foundIPs]);
        }
      };

      for (let i = 0; i < ipRange.length; i += concurrency) {
        const batch = ipRange.slice(i, i + concurrency);
        console.log(`Processing batch ${i / concurrency + 1}`);
        await Promise.all(batch.map(ip => processIp(ip)));
      }

      if (foundIPs.length === 0) {
        setError('No Umbrel instances found on the network. Try manual input.');
      }
    } catch (e) {
      console.error('Scan network error:', e);
      setError('Error scanning network.');
    }
    setScanning(false);
    setProgress(0);
    animateProgress(0);
  };

  const connectToUmbrel = (address: string) => {
    const url = address.startsWith('http') ? address : `http://${address}`;
    storeInstance(url);
    setSelectedInstance(url);
  };

  const handleManualConnect = () => {
    if (!manualInput) {
      setError('Please enter a valid address');
      return;
    }
    connectToUmbrel(manualInput);
  };

  // If an instance is selected, render a full-screen WebView.
  if (selectedInstance) {
    return <WebView source={{ uri: selectedInstance }} style={{ flex: 1 }} />;
  }

  return (
    <LinearGradient colors={['#1a1a1a', '#2d1b4e']} style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={styles.header}>
        <Svg
          width={96}
          height={96}
          viewBox="0 0 96 47"
          fill="none"
        >
          <Path
            fill="white"
            fillRule="evenodd"
            d="M47.416 8.723c10.404-.2 18.594 2.599 24.948 8.11 4.615 4.002 8.475 9.622 11.46 17.045-2.275-.56-4.679-.835-7.196-.835-5.324 0-10.102 1.232-14.083 3.912-4.46-2.722-9.258-4.152-14.34-4.152-5.198 0-10.188 1.495-14.923 4.302-4.571-2.875-9.722-4.302-15.341-4.302-2.03 0-3.97.188-5.802.582 2.684-6.827 6.235-12.09 10.546-15.946 6.16-5.512 14.278-8.516 24.731-8.716ZM7.761 45.613a4.35 4.35 0 0 0 .472-.493c1.901-2.205 4.878-3.604 9.708-3.604 4.557 0 8.466 1.266 11.884 3.768l.135.1a5.446 5.446 0 0 0 6.304.143c4.085-2.764 8.043-4.011 11.94-4.011 3.83 0 7.545 1.202 11.228 3.817l.076.055a5.446 5.446 0 0 0 6.727-.307c2.433-2.1 5.762-3.325 10.393-3.325 4.871 0 8.648 1.358 11.63 3.875a4.38 4.38 0 0 0 1.632.907 4.336 4.336 0 0 0 2.968-.168 4.364 4.364 0 0 0 2.592-4.66 4.39 4.39 0 0 0-.109-.51c-3.456-13.388-9.106-23.87-17.269-30.95C69.822 3.095 59.422-.222 47.25.012 35.124.245 24.874 3.79 16.876 10.945 8.948 18.037 3.639 28.312.633 41.3a4.352 4.352 0 0 0 2.533 5.081 4.352 4.352 0 0 0 4.595-.767Z"
            clipRule="evenodd"
          />
        </Svg>
        <Text style={styles.title}>Umbrel Web App</Text>
      </View>

        {/* Toggle Switch for Auto vs Manual */}
        <View style={styles.toggleContainer}>
          <Text style={[styles.toggleLabel, isAuto && styles.toggleLabelActive]}>Auto</Text>
          <Switch
            value={!isAuto}
            onValueChange={(val) => setIsAuto(!val)}
            thumbColor="#8257e6"
            trackColor={{ false: '#fff', true: '#fff' }}
          />
          <Text style={[styles.toggleLabel, !isAuto && styles.toggleLabelActive]}>Manual</Text>
        </View>

        {isAuto ? (
          <>
            <Text style={styles.sectionTitle}>Auto-detect</Text>
            <TouchableOpacity
              style={[styles.scanButton, scanning && styles.scanButtonScanning]}
              onPress={scanNetworkJS}
              disabled={scanning}
            >
              {scanning ? (
                <View style={styles.progressContainerInside}>
                  <View style={styles.progressBarContainer}>
                    <Animated.View style={[styles.progressBar, { width: progressAnim.interpolate({
                      inputRange: [0, 100],
                      outputRange: ['0%', '100%'],
                    }) }]} />
                  </View>
                  <Text style={styles.progressText}>Scanning: {Math.round(progress)}%</Text>
                </View>
              ) : (
                <>
                  <MaterialCommunityIcons name="radar" size={24} color="#fff" />
                  <Text style={styles.buttonText}>Scan Network</Text>
                </>
              )}
            </TouchableOpacity>
            {foundInstances.length > 0 && (
              <View style={styles.resultsContainer}>
                {foundInstances.map((instance, index) => (
                  <TouchableOpacity
                    key={index}
                    style={styles.instanceItem}
                    onPress={() => connectToUmbrel(instance.address)}
                  >
                    <Text style={styles.instanceText}>{instance.address}</Text>
                    <MaterialCommunityIcons name="arrow-right" size={20} color="#8257e6" />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        ) : (
          <View style={styles.manualInputContainer}>
            <Text style={styles.sectionTitle}>Manual Instance Connection</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter Umbrel hostname or IP"
              placeholderTextColor="#666"
              value={manualInput}
              onChangeText={setManualInput}
            />
            <TouchableOpacity style={styles.connectButton} onPress={handleManualConnect}>
              <Text style={styles.buttonText}>Connect</Text>
            </TouchableOpacity>
          </View>
        )}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingVertical: 20, paddingHorizontal: 40, minHeight: '100%' },
  header: { alignItems: 'center', marginBottom: 40, marginTop: 50 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#fff', marginTop: 10 },
  toggleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  toggleLabel: {
    fontSize: 16,
    color: '#ccc',
    marginHorizontal: 10,
  },
  toggleLabelActive: {
    color: '#fff',
    fontWeight: 'bold',
  },
  scanButton: {
    backgroundColor: '#8257e6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  scanButtonScanning: { flexDirection: 'column', paddingVertical: 20 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600', marginLeft: 8 },
  progressContainerInside: { width: '100%', alignItems: 'center' },
  progressBarContainer: {
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 4,
    overflow: 'hidden',
    width: '100%',
    marginBottom: 4,
  },
  progressBar: { height: '100%', backgroundColor: '#ffffff' },
  progressText: { color: '#fff', fontSize: 14, textAlign: 'center' },
  resultsContainer: { marginBottom: 20 },
  sectionTitle: { fontSize: 18, fontWeight: '600', color: '#fff', marginBottom: 12 },
  instanceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.1)',
    padding: 16,
    borderRadius: 8,
    marginBottom: 8,
  },
  instanceText: { color: '#fff', fontSize: 16 },
  manualInputContainer: { marginTop: 20 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 8,
    padding: 16,
    color: '#fff',
    fontSize: 16,
    marginBottom: 12,
  },
  connectButton: {
    backgroundColor: '#8257e6',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  errorText: { color: '#ff6b6b', marginTop: 12, textAlign: 'center' },
});
