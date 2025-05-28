// server.js - Simple Node.js server without any framework
const http = require('http');
const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const path = require('path');
const { spawn, exec } = require('child_process');
const yaml = require('js-yaml');
const WebSocket = require('ws');

const PORT = 3000;

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
        
        <input type="text" id="imsi" placeholder="Base IMSI (15 digits)" maxlength="15">
        <small style="color: #888; font-size: 11px;">MSIN will increment for each UE and continue from last run</small>
        
        <div class="input-group" style="margin-top: 10px;">
            <input type="number" id="ueCount" placeholder="Number of UEs" value="1" min="1" max="100">
            <input type="number" id="interval" placeholder="Interval (seconds)" value="60" min="1">
        </div>
        
        <button class="start" onclick="start()">Start Multi-UE Session</button>
        <button class="stop" onclick="stop()" disabled>Stop</button>
        <button class="clear" onclick="clearLogs()">Clear Logs</button>
        
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
        let intervalId;
        let currentMsinBase = null;
        let baseMsin = null;
        let totalUeCount = 0;
        let sessionCount = 0;
        let isRunning = false;
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
        
        function clearLogs() {
            document.getElementById('logs').innerHTML = '';
            document.getElementById('packetrusher-logs').innerHTML = '';
        }
        
        async function runMultiUeSession() {
            if (isRunning) {
                log('⏳ Previous session still running, skipping this interval...');
                return;
            }
            
            isRunning = true;
            document.getElementById('connection-status').textContent = 'Session Running...';
            document.getElementById('connection-status').className = 'status running';
            
            const imsi = document.getElementById('imsi').value;
            const ueCount = parseInt(document.getElementById('ueCount').value);
            
            if (baseMsin === null) {
                baseMsin = parseInt(imsi.slice(-10));
                currentMsinBase = baseMsin;
            }
            
            sessionCount++;
            log(\`🚀 Session #\${sessionCount} - Starting \${ueCount} UEs with multi-ue command (MSIN base: \${currentMsinBase.toString().padStart(10, '0')})\`);
            
            const startMsin = currentMsinBase.toString().padStart(10, '0');
            const endMsin = (currentMsinBase + ueCount - 1).toString().padStart(10, '0');
            log(\`  📱 UE Range: MSIN \${startMsin} to \${endMsin} (\${ueCount} UEs total)\`);
            
            try {
                const result = await runMultiUeCommand(imsi, ueCount, sessionCount);
                
                if (result.success) {
                    log(\`✅ Session #\${sessionCount} completed successfully\`);
                    totalUeCount += ueCount;
                    currentMsinBase += ueCount;
                } else {
                    log(\`❌ Session #\${sessionCount} failed: \${result.error}\`);
                }
                
            } catch (e) {
                log(\`❌ Session #\${sessionCount} error: \${e.message}\`);
            } finally {
                isRunning = false;
                document.getElementById('connection-status').textContent = 'Connected to server';
                document.getElementById('connection-status').className = 'status connected';
                log(\`⏱️ Session #\${sessionCount} finished, ready for next batch\`);
            }
        }
        
        async function runMultiUeCommand(imsi, ueCount, sessionNumber) {
            try {
                const res = await fetch('/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        imsi: imsi, 
                        ueCount: ueCount,
                        sessionNumber: sessionNumber 
                    })
                });
                const data = await res.json();
                return data;
            } catch (e) {
                return { success: false, error: e.message };
            }
        }
        
        function start() {
            const imsi = document.getElementById('imsi').value;
            const ueCount = document.getElementById('ueCount').value;
            const interval = document.getElementById('interval').value;
            
            if (!imsi || imsi.length !== 15) {
                alert('Enter valid 15-digit IMSI');
                return;
            }
            
            if (!ueCount || ueCount < 1) {
                alert('Enter valid number of UEs (1 or more)');
                return;
            }
            
            isRunning = false;
            
            document.querySelector('.start').disabled = true;
            document.querySelector('.stop').disabled = false;
            document.getElementById('imsi').disabled = true;
            document.getElementById('ueCount').disabled = true;
            document.getElementById('interval').disabled = true;
            
            log(\`🎯 Started multi-UE session: \${ueCount} UEs every \${interval}s using 'multi-ue -n \${ueCount}' command\`);
            log(\`📍 Next MSIN base: \${currentMsinBase ? currentMsinBase.toString().padStart(10, '0') : imsi.slice(-10)}\`);
            
            runMultiUeSession();
            intervalId = setInterval(runMultiUeSession, interval * 1000);
        }
        
        function stop() {
            clearInterval(intervalId);
            isRunning = false;
            document.querySelector('.start').disabled = false;
            document.querySelector('.stop').disabled = true;
            document.getElementById('imsi').disabled = false;
            document.getElementById('ueCount').disabled = false;
            document.getElementById('interval').disabled = false;
            document.getElementById('connection-status').textContent = 'Connected to server';
            document.getElementById('connection-status').className = 'status connected';
            log(\`🛑 Stopped after \${sessionCount} sessions (\${totalUeCount} total UEs)\`);
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

// HTTP Server
const server = http.createServer(async (req, res) => {
	if (req.method === 'GET' && req.url === '/') {
		res.writeHead(200, { 'Content-Type': 'text/html' });
		res.end(HTML);
	} else if (req.method === 'POST' && req.url === '/run') {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', async () => {
			try {
				const { imsi, ueCount, sessionNumber } = JSON.parse(body);

				if (!imsi || imsi.length !== 15) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ success: false, error: 'Invalid IMSI' }));
					return;
				}

				if (!ueCount || ueCount < 1) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ success: false, error: 'Invalid UE count' }));
					return;
				}

				// Check if config.yml exists
				try {
					await fs.access(CONFIG_PATH);
				} catch (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(
						JSON.stringify({
							success: false,
							error: `Config not found at: ${CONFIG_PATH}`,
						})
					);
					return;
				}

				// Read config
				const configContent = await fs.readFile(CONFIG_PATH, 'utf8');
				const config = yaml.load(configContent);

				// Update MSIN with the base value from the IMSI for multi-UE session
				if (!config.ue) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(
						JSON.stringify({
							success: false,
							error: 'Invalid config.yml structure - missing "ue" section',
						})
					);
					return;
				}

				// Set the base MSIN - PacketRusher will increment from this base for each UE
				config.ue.msin = imsi.slice(-10);

				// Write config back
				await fs.writeFile(CONFIG_PATH, yaml.dump(config), 'utf8');

				console.log(`\nSession #${sessionNumber || 1}: Running ${ueCount} UEs with base MSIN: ${imsi.slice(-10)}`);

				// Run PacketRusher with multi-ue command
				const result = await runPacketRusher(sessionNumber || 1, ueCount);

				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(result));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ success: false, error: error.message }));
			}
		});
	} else {
		res.writeHead(404);
		res.end('Not found');
	}
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

// Start server
server.listen(PORT, async () => {
	console.log(`Server running at http://localhost:${PORT}`);
	console.log(`PacketRusher directory: ${PACKETRUSHER_DIR}`);
	console.log('\n🚀 PacketRusher Controller started with direct execution mode');
	console.log('📊 Real-time logs will be streamed to the web interface');

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

// package.json for standalone version
/*
{
  "name": "packetrusher-gui-simple",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "js-yaml": "^4.1.0",
    "ws": "^8.14.0"
  }
}
*/
