import React, { useState, useEffect, useRef } from "react";
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, Platform, Animated, Switch, Modal, BackHandler } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { WebView } from "react-native-webview";
import Svg, { Path } from "react-native-svg";
import KeyEvent from "react-native-keyevent";

/* ========================================================================
   HELPER FUNCTIONS
   These functions help with IP address conversion, subnet calculation,
   and generating an IP range to scan on the network.
======================================================================== */

// Convert an IP string (e.g., "192.168.1.1") to a 32-bit integer.
function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + parseInt(part, 10), 0);
}

// Convert a 32-bit integer back into an IP string.
function intToIp(num: number): string {
  return [(num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff].join(".");
}

// Get the prefix length from a subnet mask (e.g., "255.255.255.0" becomes 24).
function getPrefixLength(mask: string): number {
  return mask.split(".").reduce((acc, octet) => acc + parseInt(octet, 10).toString(2).split("0").join("").length, 0);
}

// Generate an array of IP addresses for a given IP and subnet prefix.
// If the range is too large (for prefixes less than 24), it falls back to /24.
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
  // Skip network and broadcast addresses by starting at 1 and ending at count - 1.
  for (let i = 1; i < count - 1; i++) {
    range.push(intToIp(networkBase + i));
  }
  return range;
}

/* ========================================================================
   COMPONENT: UmbrelWebView
   This component renders a WebView that attempts to load the selected Umbrel
   instance. If loading fails, it shows a pop-up modal offering the user the
   option to retry or return to the setup menu.
======================================================================== */

function UmbrelWebView({ selectedInstance, setSelectedInstance }: { selectedInstance: string; setSelectedInstance: (instance: string | null) => void }) {
  // Manage the display of the error modal.
  const [showErrorModal, setShowErrorModal] = useState(false);
  // Create a ref to allow reloading the WebView.
  const webviewRef = useRef(null);
  // Ref to store the timestamp when the back button is pressed.
  const backButtonDownTimeRef = useRef(0);
  // Threshold for a long press (in milliseconds)
  const LONG_PRESS_THRESHOLD = 1000;

  // Reload the WebView when the user taps "Retry".
  const handleRetry = () => {
    setShowErrorModal(false);
    if (webviewRef.current) {
      // @ts-ignore
      webviewRef.current.reload();
    }
  };

  // This function returns to the setup screen.
  const handleReturn = () => {
    setShowErrorModal(false);
    setSelectedInstance(null);
  };

  useEffect(() => {
    if (Platform.OS === "android") {
      // Disable the default back button behavior.
      const backHandlerSubscription = BackHandler.addEventListener("hardwareBackPress", () => true);

      // Listen for key down events.
      KeyEvent.onKeyDownListener((keyEvent: { keyCode: number; }) => {
        // Android back button key code is 4.
        if (keyEvent.keyCode === 4) {
          backButtonDownTimeRef.current = Date.now();
        }
      });

      // Listen for key up events.
      KeyEvent.onKeyUpListener((keyEvent: { keyCode: number; }) => {
        if (keyEvent.keyCode === 4) {
          const pressDuration = Date.now() - backButtonDownTimeRef.current;
          if (pressDuration >= LONG_PRESS_THRESHOLD) {
            // Long press detected: return to the setup screen.
            handleReturn();
          }
        }
      });

      // Cleanup both BackHandler and KeyEvent listeners on unmount.
      return () => {
        backHandlerSubscription.remove();
        KeyEvent.removeKeyDownListener();
        KeyEvent.removeKeyUpListener();
      };
    }
  }, []);

  return (
    <View style={{ flex: 1 }}>
      <WebView
        ref={webviewRef}
        source={{ uri: selectedInstance }}
        style={{ flex: 1 }}
        onError={(syntheticEvent) => {
          console.error("WebView error: ", syntheticEvent.nativeEvent);
          setShowErrorModal(true);
        }}
      />

      {showErrorModal && (
        <Modal transparent animationType="slide" visible={showErrorModal} onRequestClose={() => setShowErrorModal(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Connection Failed</Text>
              <Text style={styles.modalMessage}>The app was unable to load the content. Would you like to try again or return to setup?</Text>
              <View style={styles.buttonRow}>
                <TouchableOpacity style={styles.modalButton} onPress={handleRetry}>
                  <Text style={styles.buttonText}>Retry</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalButton} onPress={handleReturn}>
                  <Text style={styles.buttonText}>Return</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

/* ========================================================================
   COMPONENT: UmbrelScanner
   This is the main component that:
     - Scans the local network to automatically detect Umbrel instances.
     - Provides manual input for connecting to an instance.
     - Stores and retrieves the selected instance.
     - Conditionally renders either the setup interface or the WebView.
======================================================================== */

export default function UmbrelScanner() {
  // States for scanning, manual input, found instances, error messages, selected instance, and mode.
  const [scanning, setScanning] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const [foundInstances, setFoundInstances] = useState<Array<{ address: string; name: string }>>([]);
  const [error, setError] = useState("");
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [isAuto, setIsAuto] = useState(true);
  const [progress, setProgress] = useState(0);
  // Animated value for the progress bar during network scanning.
  const progressAnim = useRef(new Animated.Value(0)).current;

  // On mount, load any stored Umbrel instance from AsyncStorage.
  useEffect(() => {
    const loadInstance = async () => {
      try {
        const instance = await AsyncStorage.getItem("umbrelInstance");
        if (instance) setSelectedInstance(instance);
      } catch (e) {
        console.error("Failed to load stored instance:", e);
      }
    };
    loadInstance();
  }, []);

  // Store the selected instance in persistent storage.
  const storeInstance = async (url: string) => {
    try {
      await AsyncStorage.setItem("umbrelInstance", url);
    } catch (e) {
      console.error("Failed to store instance:", e);
    }
  };

  // Animate the progress bar to a new value over 300ms.
  const animateProgress = (toValue: number) => {
    Animated.timing(progressAnim, {
      toValue,
      duration: 300,
      useNativeDriver: false,
    }).start();
  };

  // Check if a given IP address is hosting an Umbrel instance.
  // It does so by trying to fetch the system status.
  const checkHost = async (ip: string): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`http://${ip}/trpc/system.status`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) return false;
      const json = await response.json();
      return json?.result?.data?.toLowerCase() === "running";
    } catch (err) {
      return false;
    }
  };

  // Scan the local network for Umbrel instances using the device's IP and subnet.
  const scanNetworkJS = async () => {
    if (Platform.OS === "web") {
      setError("Network scanning is only available on mobile devices");
      return;
    }
    setScanning(true);
    setError("");
    setFoundInstances([]);
    setProgress(0);
    animateProgress(0);

    try {
      // Fetch network info from the device.
      const state = await NetInfo.fetch();
      console.log("NetInfo state:", state);
      const deviceIP = state.details && (state.details as any).ipAddress;
      if (!deviceIP) {
        setError("Unable to determine device IP address.");
        setScanning(false);
        return;
      }
      console.log(`Device IP: ${deviceIP}`);

      // Determine the subnet prefix; default to /24 if unavailable.
      let prefix = 24;
      if (state.details && (state.details as any).subnet) {
        prefix = getPrefixLength((state.details as any).subnet);
      }
      console.log(`Using prefix: ${prefix}`);

      // Generate a list of IP addresses to scan.
      const ipRange = generateIPRange(deviceIP, prefix);
      console.log(`Generated IP range of ${ipRange.length} addresses`);
      const total = ipRange.length;
      const foundIPs: Array<{ address: string; name: string }> = [];
      const concurrency = 20;
      let processed = 0;

      // Process each IP address to see if it is an Umbrel instance.
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

      // Process IP addresses in batches for efficiency.
      for (let i = 0; i < ipRange.length; i += concurrency) {
        const batch = ipRange.slice(i, i + concurrency);
        console.log(`Processing batch ${i / concurrency + 1}`);
        await Promise.all(batch.map((ip) => processIp(ip)));
      }

      // If no Umbrel instances are found, display an error message.
      if (foundIPs.length === 0) {
        setError("No Umbrel instances found on the network. Try manual input.");
      }
    } catch (e) {
      console.error("Scan network error:", e);
      setError("Error scanning network.");
    }
    setScanning(false);
    setProgress(0);
    animateProgress(0);
  };

  // Set the selected Umbrel instance and store it.
  const connectToUmbrel = (address: string) => {
    const url = address.startsWith("http://") || address.startsWith("https://") ? address.replace(/^https:\/\//, "http://") : `http://${address}`;

    storeInstance(url);
    setSelectedInstance(url);
  };

  // Handle a manual connection attempt.
  const handleManualConnect = () => {
    if (!manualInput) {
      setError("Please enter a valid address");
      return;
    }
    connectToUmbrel(manualInput);
  };

  // If a selected instance exists, render the UmbrelWebView with error handling.
  if (selectedInstance) {
    return <UmbrelWebView selectedInstance={selectedInstance} setSelectedInstance={setSelectedInstance} />;
  }

  // Render the scanning and manual connection setup UI.
  return (
    <LinearGradient colors={["#1a1a1a", "#2d1b4e"]} style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Header Section with App Logo and Title */}
        <View style={styles.header}>
          <Svg width={96} height={96} viewBox="0 0 96 47" fill="none">
            <Path
              fill="white"
              fillRule="evenodd"
              d="M47.416 8.723c10.404-.2 18.594 2.599 24.948 8.11 4.615 4.002 8.475 9.622 11.46 17.045-2.275-.56-4.679-.835-7.196-.835-5.324 0-10.102 1.232-14.083 3.912-4.46-2.722-9.258-4.152-14.34-4.152-5.198 0-10.188 1.495-14.923 4.302-4.571-2.875-9.722-4.302-15.341-4.302-2.03 0-3.97.188-5.802.582 2.684-6.827 6.235-12.09 10.546-15.946 6.16-5.512 14.278-8.516 24.731-8.716ZM7.761 45.613a4.35 4.35 0 0 0 .472-.493c1.901-2.205 4.878-3.604 9.708-3.604 4.557 0 8.466 1.266 11.884 3.768l.135.1a5.446 5.446 0 0 0 6.304.143c4.085-2.764 8.043-4.011 11.94-4.011 3.83 0 7.545 1.202 11.228 3.817l.076.055a5.446 5.446 0 0 0 6.727-.307c2.433-2.1 5.762-3.325 10.393-3.325 4.871 0 8.648 1.358 11.63 3.875a4.38 4.38 0 0 0 1.632.907 4.336 4.336 0 0 0 2.968-.168 4.364 4.364 0 0 0 2.592-4.66 4.39 4.39 0 0 0-.109-.51c-3.456-13.388-9.106-23.87-17.269-30.95C69.822 3.095 59.422-.222 47.25.012 35.124.245 24.874 3.79 16.876 10.945 8.948 18.037 3.639 28.312.633 41.3a4.352 4.352 0 0 0 2.533 5.081 4.352 4.352 0 0 0 4.595-.767Z"
              clipRule="evenodd"
            />
          </Svg>
          <Text style={styles.title}>Umbrel Web App</Text>
        </View>

        {/* Toggle Switch to select Auto-detect vs Manual connection */}
        <View style={styles.toggleContainer}>
          <Text style={[styles.toggleLabel, isAuto && styles.toggleLabelActive]}>Auto</Text>
          <Switch value={!isAuto} onValueChange={(val) => setIsAuto(!val)} thumbColor="#8257e6" trackColor={{ false: "#fff", true: "#fff" }} />
          <Text style={[styles.toggleLabel, !isAuto && styles.toggleLabelActive]}>Manual</Text>
        </View>

        {/* Render Auto-detect or Manual connection section based on toggle */}
        {isAuto ? (
          <>
            <Text style={styles.sectionTitle}>Auto-detect</Text>
            <TouchableOpacity style={[styles.scanButton, scanning && styles.scanButtonScanning]} onPress={scanNetworkJS} disabled={scanning}>
              {scanning ? (
                <View style={styles.progressContainerInside}>
                  <View style={styles.progressBarContainer}>
                    <Animated.View
                      style={[
                        styles.progressBar,
                        {
                          width: progressAnim.interpolate({
                            inputRange: [0, 100],
                            outputRange: ["0%", "100%"],
                          }),
                        },
                      ]}
                    />
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
            {/* List any detected Umbrel instances */}
            {foundInstances.length > 0 && (
              <View style={styles.resultsContainer}>
                {foundInstances.map((instance, index) => (
                  <TouchableOpacity key={index} style={styles.instanceItem} onPress={() => connectToUmbrel(instance.address)}>
                    <Text style={styles.instanceText}>{instance.address}</Text>
                    <MaterialCommunityIcons name="arrow-right" size={20} color="#8257e6" />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        ) : (
          // Manual connection input area.
          <View style={styles.manualInputContainer}>
            <Text style={styles.sectionTitle}>Manual Instance Connection</Text>
            <TextInput style={styles.input} placeholder="Enter Umbrel hostname or IP" placeholderTextColor="#666" value={manualInput} onChangeText={setManualInput} />
            <TouchableOpacity style={styles.connectButton} onPress={handleManualConnect}>
              <Text style={styles.buttonText}>Connect</Text>
            </TouchableOpacity>
          </View>
        )}
        {/* Display error messages if any */}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>
    </LinearGradient>
  );
}

/* ========================================================================
   STYLES
   These styles define the appearance of the UI elements and modal.
======================================================================== */

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingVertical: 20, paddingHorizontal: 40, minHeight: "100%" },
  header: { alignItems: "center", marginBottom: 40, marginTop: 50 },
  title: { fontSize: 28, fontWeight: "bold", color: "#fff", marginTop: 10 },
  toggleContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  toggleLabel: {
    fontSize: 16,
    color: "#ccc",
    marginHorizontal: 10,
  },
  toggleLabelActive: {
    color: "#fff",
    fontWeight: "bold",
  },
  scanButton: {
    backgroundColor: "#8257e6",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  scanButtonScanning: { flexDirection: "column", paddingVertical: 20 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600", marginLeft: 8 },
  progressContainerInside: { width: "100%", alignItems: "center" },
  progressBarContainer: {
    height: 8,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 4,
    overflow: "hidden",
    width: "100%",
    marginBottom: 4,
  },
  progressBar: { height: "100%", backgroundColor: "#ffffff" },
  progressText: { color: "#fff", fontSize: 14, textAlign: "center" },
  resultsContainer: { marginBottom: 20 },
  sectionTitle: { fontSize: 18, fontWeight: "600", color: "#fff", marginBottom: 12 },
  instanceItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(255,255,255,0.1)",
    padding: 16,
    borderRadius: 8,
    marginBottom: 8,
  },
  instanceText: { color: "#fff", fontSize: 16 },
  manualInputContainer: { marginTop: 20 },
  input: {
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: 16,
    color: "#fff",
    fontSize: 16,
    marginBottom: 12,
  },
  connectButton: {
    backgroundColor: "#8257e6",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  errorText: { color: "#ff6b6b", marginTop: 12, textAlign: "center" },
  // Modal styles for the WebView error pop-up.
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalContent: {
    width: "80%",
    backgroundColor: "#1a1a1a",
    padding: 20,
    borderRadius: 12,
    alignItems: "center",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 12,
    color: "#fff",
  },
  modalMessage: {
    fontSize: 16,
    textAlign: "center",
    marginBottom: 20,
    color: "#fff",
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
  },
  modalButton: {
    flex: 1,
    marginHorizontal: 5,
    paddingVertical: 10,
    backgroundColor: "#8257e6",
    borderRadius: 8,
    alignItems: "center",
    color: "#fff",
  },
});
