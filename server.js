// server.js - Express.js server for PacketRusher GUI
const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const path = require('path');
const { spawn, exec } = require('child_process');
const yaml = require('js-yaml');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // For serving static files if needed

// Paths to packetrusher folder (sibling folder)
const PACKETRUSHER_DIR = path.join(__dirname, '..', 'PacketRusher');
const CONFIG_PATH = path.join(PACKETRUSHER_DIR, 'config', 'config.yml');
const BINARY_PATH = path.join(PACKETRUSHER_DIR, 'packetrusher');

// Global WebSocket connections
let wsClients = [];

// Simple HTML interface
const HTML = `
<!DOCTYPE html>
<html>
<head>
    <title>PacketRusher Controller</title>
    <style>
        body { 
            font-family: Arial; 
            max-width: 800px; 
            margin: 20px auto; 
            padding: 20px;
            background: #1a1a1a;
            color: #e0e0e0;
        }
        .container {
            background: #2a2a2a;
            padding: 30px;
            border-radius: 10px;
        }
        input, button { 
            padding: 10px; 
            margin: 5px 0; 
            width: 100%;
            box-sizing: border-box;
        }
        input {
            background: #1a1a1a;
            border: 1px solid #444;
            color: #e0e0e0;
            border-radius: 5px;
        }
        button { 
            cursor: pointer;
            border: none;
            border-radius: 5px;
            color: white;
        }
        .start { background: #4CAF50; }
        .stop { background: #f44336; }
        .clear { background: #ff9800; margin-top: 10px; }
        .get-flight-data { background: #2196F3; margin-top: 10px; }
        button:disabled { opacity: 0.5; }
        .logs-container {
            display: flex;
            gap: 20px;
            margin-top: 20px;
        }
        .log-section {
            flex: 1;
        }
        .log-section h3 {
            margin: 0 0 10px 0;
            color: #4CAF50;
            font-size: 14px;
        }
        #logs, #packetrusher-logs { 
            background: #1a1a1a; 
            padding: 15px; 
            height: 300px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 12px;
            border-radius: 5px;
            border: 1px solid #444;
        }
        #packetrusher-logs {
            background: #0a0a0a;
            border-color: #4CAF50;
        }
        .path-info {
            font-size: 11px;
            color: #666;
            margin-top: 10px;
        }
        .input-group {
            display: flex;
            gap: 10px;
        }
        .input-group input {
            flex: 1;
        }
        .status {
            padding: 10px;
            margin: 10px 0;
            border-radius: 5px;
            text-align: center;
            font-weight: bold;
        }
        .status.connected { background: #2e7d32; }
        .status.disconnected { background: #d32f2f; }
        .status.running { background: #f57c00; }
    </style>
</head>
<body>
    <div class="container">
        <h1>PacketRusher Multi-UE Controller</h1>
        <div id="connection-status" class="status disconnected">Connecting to server...</div>
        
        <div class="input-group">
            <input type="text" id="mcc" placeholder="MCC (3 digits)" maxlength="3" value="001">
            <input type="text" id="mnc" placeholder="MNC (2 digits)" maxlength="2" value="01">
            <input type="text" id="msinBase" placeholder="Base MSIN (10 digits)" maxlength="10">
        </div>
        <small style="color: #888; font-size: 11px;">MSIN will increment for each UE. MCC & MNC are preset.</small>
        
        <div class="input-group" style="margin-top: 10px;">
            <input type="number" id="ueCountInput" placeholder="Number of UEs" value="1" min="1" max="100" disabled>
            <input type="number" id="intervalInput" placeholder="Interval (seconds)" value="60" min="1" disabled>
        </div>
        <small style="color: #888; font-size: 11px;">UE count and interval are now determined by flight data schedule.</small>
        
        <button class="start" onclick="start()">Start Sessions</button>
        <button class="stop" onclick="stop()" disabled>Stop Scheduled Sessions</button>
        <button class="clear" onclick="clearLogs()">Clear Logs</button>
        <button class="get-flight-data" onclick="getFlightData()">Get Flight Data</button>

        <div id="next-session-info" class="status" style="margin-top: 15px; background: #007bff; display: none;"></div>

        <div class="logs-container">
            <div class="log-section">
                <h3>Session Logs</h3>
                <div id="logs"></div>
            </div>
            <div class="log-section">
                <h3>PacketRusher Output</h3>
                <div id="packetrusher-logs"></div>
            </div>
        </div>
        
        <div class="path-info">
            Config: ../PacketRusher/config/config.yml<br>
            <span style="color: #4CAF50;">PacketRusher runs directly in the app with real-time logs</span><br>
            <span style="color: #888; font-size: 10px;">All output is captured and displayed in real-time</span>
        </div>
    </div>
    <script>
        let scheduledSessions = []; // Will store objects { id, scheduledAt, originalTimeStr, ueCount }
        let baseMsin = null; // Will store the numeric part of the base MSIN
        let currentMsinBase = null; // Tracks the current MSIN base for incrementing
        let totalUeCount = 0;
        let sessionCount = 0;
        let ws = null;
        
        // WebSocket connection for real-time logs
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);
            
            ws.onopen = function() {
                document.getElementById('connection-status').textContent = 'Connected to server';
                document.getElementById('connection-status').className = 'status connected';
            };
            
            ws.onmessage = function(event) {
                const data = JSON.parse(event.data);
                if (data.type === 'packetrusher-log') {
                    logPacketRusher(data.message, data.level);
                }
            };
            
            ws.onclose = function() {
                document.getElementById('connection-status').textContent = 'Disconnected from server';
                document.getElementById('connection-status').className = 'status disconnected';
                // Attempt to reconnect after 3 seconds
                setTimeout(connectWebSocket, 3000);
            };
            
            ws.onerror = function() {
                document.getElementById('connection-status').textContent = 'Connection error';
                document.getElementById('connection-status').className = 'status disconnected';
            };
        }
        
        function log(msg) {
            const logs = document.getElementById('logs');
            const time = new Date().toLocaleTimeString();
            logs.innerHTML = \`[\${time}] \${msg}<br>\` + logs.innerHTML;
        }
        
        function logPacketRusher(msg, level = 'info') {
            const logs = document.getElementById('packetrusher-logs');
            const time = new Date().toLocaleTimeString();
            const color = level === 'error' ? '#ff6b6b' : level === 'warn' ? '#ffa726' : '#e0e0e0';
            logs.innerHTML = \`<span style="color: \${color}">[\${time}] \${msg}</span><br>\` + logs.innerHTML;
            logs.scrollTop = 0;
        }
        
        function updateNextSessionDisplay() {
            const now = new Date();
            const upcomingSessions = scheduledSessions
                .filter(s => s.scheduledAt.getTime() > now.getTime())
                .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

            const nextSessionInfoDiv = document.getElementById('next-session-info');
            if (upcomingSessions.length > 0) {
                const nextSession = upcomingSessions[0];
                const timeToNext = Math.round((nextSession.scheduledAt.getTime() - now.getTime()) / 1000);
                nextSessionInfoDiv.textContent = \`Next session: \${nextSession.originalTimeStr} (\${nextSession.ueCount} UEs) in \${timeToNext}s\`;
                nextSessionInfoDiv.style.background = '#007bff'; // Blue for scheduled
                nextSessionInfoDiv.style.display = 'block';
            } else {
                const anySessionRunningOrJustFinished = scheduledSessions.some(s => s.isRunning);
                if (!anySessionRunningOrJustFinished && sessionCount > 0) { // Check if sessions actually ran
                     nextSessionInfoDiv.textContent = 'All scheduled sessions for today have finished.';
                     nextSessionInfoDiv.style.background = '#4CAF50'; // Green for completed
                } else if (sessionCount === 0 && document.querySelector('.start').disabled) { // Started but no valid flights
                    nextSessionInfoDiv.textContent = 'No future sessions scheduled for today.';
                    nextSessionInfoDiv.style.background = '#ff9800'; // Orange for warning/notice
                }
                else {
                    nextSessionInfoDiv.style.display = 'none';
                }
            }
        }
        
        function clearLogs() {
            document.getElementById('logs').innerHTML = '';
            document.getElementById('packetrusher-logs').innerHTML = '';
        }
        
        async function getFlightData() {
            try {
                const response = await fetch('/api/flight-data');
                if (!response.ok) {
                    throw new Error(\`Failed to fetch flight data: \${response.status} \${response.statusText}\`);
                }
                const data = await response.json();
                console.log('Flight data received:', data);
                return data;
            } catch (error) {
                log(\`Error fetching flight data: \${error.message}\`);
                console.error('Error fetching flight data:', error);
                return []; // Return empty array on error
            }
        }
        
        async function runMultiUeSession(baseIMSI, ueCountForSession, flightOriginalTimeStr) {
            document.getElementById('connection-status').textContent = 'Session Running...';
            document.getElementById('connection-status').className = 'status running';
            
            if (baseMsin === null) {
                const msinPart = baseIMSI.slice(-10);
                baseMsin = parseInt(msinPart);
                currentMsinBase = baseMsin;
                log(\`Warning: baseMsin not initialized by start(), fallback to: \${msinPart}\`)
            }
            
            sessionCount++;
            log(\`Session #\${sessionCount} - Starting \${ueCountForSession} UEs (IMSI base: \${baseIMSI.slice(0,5)}\${currentMsinBase.toString().padStart(10, '0')})\`);
            
            const startMsin = currentMsinBase.toString().padStart(10, '0');
            const endMsin = (currentMsinBase + ueCountForSession - 1).toString().padStart(10, '0');
            log(\` UE Range: MSIN \${startMsin} to \${endMsin} (\${ueCountForSession} UEs total for this session)\`);
            
            try {
                const result = await runMultiUeCommand(baseIMSI.slice(0,5) + currentMsinBase.toString().padStart(10, '0'), ueCountForSession, sessionCount);
                
                if (result.success) {
                    log(\`✅ Session #\${sessionCount} completed successfully\`);
                    totalUeCount += ueCountForSession;
                    currentMsinBase += ueCountForSession;
                } else {
                    log(\`Session #\${sessionCount} failed: \${result.error}\`);
                }
                
            } catch (e) {
                log(\`Session #\${sessionCount} error: \${e.message}\`);
            } finally {
                // Reset status after each session; might be quickly overwritten if many sessions
                const sessionToMarkDone = scheduledSessions.find(s => s.ueCount === ueCountForSession && s.originalTimeStr === flightOriginalTimeStr);
                if(sessionToMarkDone) sessionToMarkDone.isRunning = false;

                document.getElementById('connection-status').textContent = 'Connected to server';
                document.getElementById('connection-status').className = 'status connected';
                log(\`⏱️ Session #\${sessionCount} finished. Total UEs so far: \${totalUeCount}\`);
                updateNextSessionDisplay(); // Update display for the *next* session
            }
        }
        
        async function runMultiUeCommand(fullImsiForSession, ueCountForThisSession, sessionNumber) {
            try {
                const res = await fetch('/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        imsi: fullImsiForSession,
                        ueCount: ueCountForThisSession,
                        sessionNumber: sessionNumber 
                    })
                });
                const data = await res.json();
                return data;
            } catch (e) {
                return { success: false, error: e.message };
            }
        }
        
        async function start() {
            // Clear any existing session timeouts
            scheduledSessions.forEach(session => clearTimeout(session.id));
            scheduledSessions = [];

            const mcc = document.getElementById('mcc').value;
            const mnc = document.getElementById('mnc').value;
            const msinBaseInput = document.getElementById('msinBase').value;

            if (!mcc || mcc.length !== 3) {
                alert('Enter a valid 3-character MCC.');
                return;
            }
            if (!mnc || mnc.length !== 2) {
                alert('Enter a valid 2-character MNC.');
                return;
            }
            if (!msinBaseInput || msinBaseInput.length !== 10) {
                alert('Enter a valid 10-digit Base MSIN.');
                return;
            }

            const baseIMSI = mcc + mnc + msinBaseInput;
            baseMsin = parseInt(msinBaseInput);
            currentMsinBase = baseMsin;
            sessionCount = 0;
            totalUeCount = 0;

            document.querySelector('.start').disabled = true;
            document.querySelector('.stop').disabled = false;
            document.getElementById('mcc').disabled = true;
            document.getElementById('mnc').disabled = true;
            document.getElementById('msinBase').disabled = true;

            log(\`Fetching flight data to schedule PacketRusher sessions with base IMSI prefix: \${mcc}\${mnc} and MSIN starting from \${msinBaseInput}\`);
            
            const flightData = await getFlightData();

            if (!flightData || flightData.length === 0) {
                log('No flight data available or error fetching. Cannot schedule sessions.');
                stop();
                return;
            }

            log(\`Found \${flightData.length} flight entries. Scheduling sessions...\`);

            const now = new Date();
            let scheduledCount = 0;

            flightData.forEach((flight, index) => {
                const [timeStr, period] = flight.time.split(' ');
                let [hours, minutes, seconds] = timeStr.split(':').map(Number);

                if (period === 'PM' && hours !== 12) {
                    hours += 12;
                } else if (period === 'AM' && hours === 12) {
                    hours = 0;
                }

                const flightTimeToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds);
                const delay = flightTimeToday.getTime() - now.getTime();

                if (delay > 0) {
                    const currentFlightData = { ...flight }; // Capture current flight data for the timeout

                    const timeoutId = setTimeout(() => {
                        const nextSessionInfoDiv = document.getElementById('next-session-info');
                        nextSessionInfoDiv.textContent = \`Running session for: \${currentFlightData.time} (\${currentFlightData.foreignPassengers} UEs)\`;
                        nextSessionInfoDiv.style.background = '#f57c00'; // Orange for running
                        nextSessionInfoDiv.style.display = 'block';
                        
                        const sessionMarker = scheduledSessions.find(s => s.id === timeoutId);
                        if(sessionMarker) sessionMarker.isRunning = true;

                        // Pass the original baseIMSI (MCC+MNC+initial MSIN) 
                        // and the specific ueCount (foreignPassengers) for this flight
                        // Also pass the original flight time string for logging/identification if needed
                        runMultiUeSession(baseIMSI, currentFlightData.foreignPassengers, currentFlightData.time);
                    }, delay);
                    scheduledSessions.push({ 
                        id: timeoutId, 
                        scheduledAt: flightTimeToday, 
                        originalTimeStr: flight.time, 
                        ueCount: flight.foreignPassengers,
                        isRunning: false
                    });
                    scheduledCount++;
                } else {
                    log(\`Skipping past flight time: \${flight.time}\`);
                }
            });

            if (scheduledCount > 0) {
                log(\`Successfully scheduled \${scheduledCount} future sessions based on flight data.\`);
                log(\`Base MSIN for the first session will be \${currentMsinBase.toString().padStart(10, '0')}. It will increment for subsequent UEs/sessions.\`);
            } else {
                log('No future flight times found to schedule. All flight times may be in the past for today.');
                stop();
            }
            updateNextSessionDisplay(); // Initial display of the next session
        }
        
        function stop() {
            scheduledSessions.forEach(session => clearTimeout(session.id));
            scheduledSessions = [];
            
            document.querySelector('.start').disabled = false;
            document.querySelector('.stop').disabled = true;
            document.getElementById('mcc').disabled = false;
            document.getElementById('mnc').disabled = false;
            document.getElementById('msinBase').disabled = false;

            document.getElementById('connection-status').textContent = 'Connected to server';
            document.getElementById('connection-status').className = 'status connected';
            log(\`Stopped all scheduled sessions. \${sessionCount} sessions ran, \${totalUeCount} total UEs processed.\`);
            baseMsin = null;
            currentMsinBase = null;
            updateNextSessionDisplay(); // Clear the next session display
        }
        
        // Connect to WebSocket when page loads
        window.onload = function() {
            connectWebSocket();
        };
    </script>
</body>
</html>
`;

// Run PacketRusher directly in the app
function runPacketRusher(sessionNumber = 1, ueCount = 1) {
	return new Promise((resolve) => {
		console.log(`\nSession #${sessionNumber}: Starting PacketRusher multi-ue with ${ueCount} UEs`);

		// Broadcast to all WebSocket clients
		const broadcast = (message, level = 'info') => {
			const data = JSON.stringify({
				type: 'packetrusher-log',
				message: message,
				level: level,
				timestamp: new Date().toISOString(),
			});
			wsClients.forEach((ws) => {
				if (ws.readyState === 1) {
					// WebSocket.OPEN
					ws.send(data);
				}
			});
		};

		broadcast(`🚀 Session #${sessionNumber} starting with ${ueCount} UEs...`);

		const process = spawn('./packetrusher', ['multi-ue', '-n', ueCount.toString()], {
			cwd: PACKETRUSHER_DIR,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let output = '';
		let errorOutput = '';
		let processKilled = false;

		// Kill process after 30 seconds (increased timeout for multi-UE)
		const killTimer = setTimeout(() => {
			if (!processKilled) {
				processKilled = true;
				process.kill('SIGTERM');
				broadcast(`⏰ Session #${sessionNumber} terminated after 30 seconds`, 'warn');
				console.log(`Session #${sessionNumber} PacketRusher process terminated after 30 seconds`);
			}
		}, 30000);

		process.stdout.on('data', (data) => {
			const text = data.toString().trim();
			if (text) {
				output += text + '\n';
				// Split by lines and broadcast each line
				text.split('\n').forEach((line) => {
					if (line.trim()) {
						broadcast(line.trim());
						console.log(`[Session #${sessionNumber} Output]:`, line.trim());
					}
				});
			}
		});

		process.stderr.on('data', (data) => {
			const text = data.toString().trim();
			if (text) {
				errorOutput += text + '\n';
				// Split by lines and broadcast each line as error
				text.split('\n').forEach((line) => {
					if (line.trim()) {
						broadcast(line.trim(), 'error');
						console.error(`[Session #${sessionNumber} Error]:`, line.trim());
					}
				});
			}
		});

		process.on('close', (code) => {
			clearTimeout(killTimer);
			const duration = processKilled
				? '30s (timeout)'
				: `${Math.round((Date.now() - process.spawnargs.startTime) / 1000)}s`;

			if (code === 0) {
				broadcast(`✅ Session #${sessionNumber} completed successfully (exit code: ${code})`, 'info');
				console.log(`Session #${sessionNumber} PacketRusher completed successfully with code ${code}`);
				resolve({
					success: true,
					output: `Session #${sessionNumber} completed successfully (${ueCount} UEs)`,
					error: '',
					duration: duration,
				});
			} else {
				broadcast(`❌ Session #${sessionNumber} failed (exit code: ${code})`, 'error');
				console.log(`Session #${sessionNumber} PacketRusher exited with code ${code}`);
				resolve({
					success: false,
					output: output,
					error: errorOutput || `Process exited with code ${code}`,
					duration: duration,
				});
			}
		});

		process.on('error', (err) => {
			clearTimeout(killTimer);
			broadcast(`💥 Session #${sessionNumber} failed to start: ${err.message}`, 'error');
			console.error(`Failed to start Session #${sessionNumber} PacketRusher:`, err);
			resolve({
				success: false,
				error: `Failed to start PacketRusher: ${err.message}`,
				output: '',
				duration: '0s',
			});
		});

		// Store start time for duration calculation
		process.spawnargs.startTime = Date.now();
	});
}

// Express Routes

// Serve the main HTML page
app.get('/', (req, res) => {
	res.send(HTML);
});

// Handle PacketRusher execution
app.post('/run', async (req, res) => {
	try {
		const { imsi, ueCount, sessionNumber } = req.body;

		if (!imsi || imsi.length !== 15) {
			return res.status(400).json({ success: false, error: 'Invalid IMSI' });
		}

		if (!ueCount || ueCount < 1) {
			return res.status(400).json({ success: false, error: 'Invalid UE count' });
		}

		// Check if config.yml exists
		try {
			await fs.access(CONFIG_PATH);
		} catch (err) {
			return res.status(500).json({
				success: false,
				error: `Config not found at: ${CONFIG_PATH}`,
			});
		}

		// Read config
		const configContent = await fs.readFile(CONFIG_PATH, 'utf8');
		const config = yaml.load(configContent);

		// Update MSIN with the base value from the IMSI for multi-UE session
		if (!config.ue) {
			return res.status(500).json({
				success: false,
				error: 'Invalid config.yml structure - missing "ue" section',
			});
		}

		// Set the base MSIN - PacketRusher will increment from this base for each UE
		config.ue.msin = imsi.slice(-10);

		// Write config back
		await fs.writeFile(CONFIG_PATH, yaml.dump(config), 'utf8');

		console.log(`\nSession #${sessionNumber || 1}: Running ${ueCount} UEs with base MSIN: ${imsi.slice(-10)}`);

		// Run PacketRusher with multi-ue command
		const result = await runPacketRusher(sessionNumber || 1, ueCount);

		res.json(result);
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

// Health check endpoint
app.get('/health', (req, res) => {
	res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Flight data endpoint
app.get('/api/flight-data', async (req, res) => {
	try {
		const { airport = 'RKSI', accessToken } = req.query;

		// Calculate timestamps for last week same day (full 24 hours)
		const now = new Date();
		const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

		// Set to beginning of that day (00:00:00)
		const beginDate = new Date(lastWeek);
		beginDate.setHours(0, 0, 0, 0);

		// Set to end of that day (23:59:59)
		const endDate = new Date(lastWeek);
		endDate.setHours(23, 59, 59, 999);

		const beginTimestamp = Math.floor(beginDate.getTime() / 1000);
		const endTimestamp = Math.floor(endDate.getTime() / 1000);

		const estimatedPassengers = 174; // Passengers per arrival

		console.log('Fetching flight data from OpenSky Network...');
		console.log('Begin timestamp:', beginTimestamp);
		console.log('End timestamp:', endTimestamp);

		// Use dynamic import for ES module (server-side only)
		const flightModule = await import('./flight.mjs');

		const arrivalTimestamps = flightModule.flight.map((data) => data.firstSeen || data.lastSeen);
		const today = new Date();

		// From the timestamps, I should be able to get the time value, HH:MM:SS in KST timezone
		const arrivalTimes = arrivalTimestamps
			.filter((timestamp) => {
				const date = new Date(timestamp * 1000);
				return date.getDay() === today.getDay();
			})
			.sort((a, b) => a - b)
			.map((timestamp) => {
				const date = new Date(timestamp * 1000);
				// Estimated foreigners are 40% - 60% of total passengers, it should be random
				const estimatedForeigners = Math.floor(
					estimatedPassengers * 0.4 + Math.random() * (estimatedPassengers * 0.6 - estimatedPassengers * 0.4)
				);

				const data = {
					time: date.toLocaleTimeString('en-US', { timeZone: 'Asia/Seoul' }),
					foreignPassengers: estimatedForeigners,
				};

				return data;
			});

		console.log(today.getDay());

		console.log(arrivalTimes);

		res.json(arrivalTimes);
	} catch (error) {
		console.error('Flight data endpoint error:', error);
		res.status(500).json({
			success: false,
			error: error.message,
			data: [],
			length: 0,
		});
	}
});

// Start server
const server = app.listen(PORT, async () => {
	console.log(`Server running at http://localhost:${PORT}`);
	console.log(`PacketRusher directory: ${PACKETRUSHER_DIR}`);

	// Check if packetrusher binary exists
	try {
		await fs.access(BINARY_PATH);
		console.log(`\n✓ PacketRusher binary found: ${BINARY_PATH}`);
		// Check if it's executable
		try {
			await fs.access(BINARY_PATH, fsConstants.X_OK);
			console.log('✓ Binary is executable');
		} catch (err) {
			console.log('⚠ Binary may not be executable. Run: chmod +x ../PacketRusher/packetrusher');
		}
	} catch (err) {
		console.error(`\n✗ PacketRusher binary NOT found at: ${BINARY_PATH}`);
		console.error('Please ensure PacketRusher is built and located in the correct directory');
	}

	// Check if config.yml exists
	try {
		await fs.access(CONFIG_PATH);
		console.log(`✓ Config file found: ${CONFIG_PATH}`);
	} catch (err) {
		console.error(`✗ Config file NOT found at: ${CONFIG_PATH}`);
		console.error('Please ensure config.yml exists in the PacketRusher config directory');
	}

	console.log('\n📱 Open http://localhost:3000 in your browser to start using the controller');
});

// WebSocket Server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
	console.log('New WebSocket client connected');
	wsClients.push(ws);

	// Send welcome message
	ws.send(
		JSON.stringify({
			type: 'packetrusher-log',
			message: '🔗 Connected to PacketRusher Controller',
			level: 'info',
			timestamp: new Date().toISOString(),
		})
	);

	ws.on('close', () => {
		console.log('WebSocket client disconnected');
		wsClients = wsClients.filter((client) => client !== ws);
	});

	ws.on('error', (error) => {
		console.error('WebSocket error:', error);
		wsClients = wsClients.filter((client) => client !== ws);
	});
});
