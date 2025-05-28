// server.js - Simple Node.js server without any framework
const http = require('http');
const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const path = require('path');
const { spawn, exec } = require('child_process');
const yaml = require('js-yaml');

const PORT = 3000;

// Paths to packetrusher folder (sibling folder)
const PACKETRUSHER_DIR = path.join(__dirname, '..', 'PacketRusher');
const CONFIG_PATH = path.join(PACKETRUSHER_DIR, 'config', 'config.yml');
const BINARY_PATH = path.join(PACKETRUSHER_DIR, 'packetrusher');

// Simple HTML interface
const HTML = `
<!DOCTYPE html>
<html>
<head>
    <title>PacketRusher Controller</title>
    <style>
        body { 
            font-family: Arial; 
            max-width: 500px; 
            margin: 50px auto; 
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
        button:disabled { opacity: 0.5; }
        #logs { 
            background: #1a1a1a; 
            padding: 15px; 
            margin-top: 20px;
            height: 200px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 12px;
            border-radius: 5px;
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
    </style>
</head>
<body>
    <div class="container">
        <h1>PacketRusher Multi-UE Controller</h1>
        <input type="text" id="imsi" placeholder="Base IMSI (15 digits)" maxlength="15">
        <small style="color: #888; font-size: 11px;">MSIN will increment for each UE and continue from last run</small>
        
        <div class="input-group" style="margin-top: 10px;">
            <input type="number" id="ueCount" placeholder="Number of UEs" value="1" min="1" max="100">
            <input type="number" id="interval" placeholder="Interval (seconds)" value="60" min="1">
        </div>
        
        <button class="start" onclick="start()">Start Multi-UE Session</button>
        <button class="stop" onclick="stop()" disabled>Stop</button>
        <div id="logs"></div>
        <div class="path-info">
            Config: ../PacketRusher/config/config.yml<br>
            <span style="color: #4CAF50;">Each UE will run for 10 seconds max in separate terminals</span><br>
            <span style="color: #888; font-size: 10px;">If no terminal opens, install xterm: sudo apt install xterm</span>
        </div>
    </div>
    <script>
        let intervalId;
        let currentMsinBase = null;
        let baseMsin = null;
        let totalUeCount = 0; // Total UEs run across all sessions
        let sessionCount = 0;
        let isRunning = false; // Track if a session is currently running
        
        function log(msg) {
            const logs = document.getElementById('logs');
            const time = new Date().toLocaleTimeString();
            logs.innerHTML = \`[\${time}] \${msg}<br>\` + logs.innerHTML;
        }
        
        async function runMultiUeSession() {
            // Skip if already running a session
            if (isRunning) {
                log('⏳ Previous session still running, skipping this interval...');
                return;
            }
            
            isRunning = true;
            const imsi = document.getElementById('imsi').value;
            const ueCount = parseInt(document.getElementById('ueCount').value);
            
            // Initialize base MSIN on first run
            if (baseMsin === null) {
                baseMsin = parseInt(imsi.slice(-10));
                currentMsinBase = baseMsin;
            }
            
            sessionCount++;
            log(\`🚀 Session #\${sessionCount} - Starting \${ueCount} UEs (MSIN base: \${currentMsinBase.toString().padStart(10, '0')})\`);
            
            // Run multiple UEs in parallel
            const promises = [];
            for (let i = 0; i < ueCount; i++) {
                const ueNumber = totalUeCount + i + 1;
                const currentMsin = (currentMsinBase + i).toString().padStart(10, '0');
                const currentImsi = imsi.slice(0, 5) + currentMsin;
                
                log(\`  📱 UE #\${ueNumber} - IMSI: \${currentImsi} (MSIN: \${currentMsin})\`);
                
                promises.push(runSingleUe(currentImsi, ueNumber));
            }
            
            try {
                const results = await Promise.all(promises);
                const successCount = results.filter(r => r.success).length;
                const failCount = results.length - successCount;
                
                log(\`✅ Session #\${sessionCount} completed: \${successCount} success, \${failCount} failed\`);
                
                // Update counters for next session
                totalUeCount += ueCount;
                currentMsinBase += ueCount;
                
            } catch (e) {
                log(\`❌ Session #\${sessionCount} error: \${e.message}\`);
            } finally {
                isRunning = false; // Mark session as completed
                log(\`⏱️ Session #\${sessionCount} finished, ready for next batch\`);
            }
        }
        
        async function runSingleUe(imsi, ueNumber) {
            try {
                const res = await fetch('/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ imsi: imsi, ueNumber: ueNumber })
                });
                const data = await res.json();
                if (data.success) {
                    log(\`    ✓ UE #\${ueNumber}: \${data.output}\`);
                    return { success: true };
                } else {
                    log(\`    ✗ UE #\${ueNumber}: \${data.error}\`);
                    return { success: false };
                }
            } catch (e) {
                log(\`    ✗ UE #\${ueNumber}: \${e.message}\`);
                return { success: false };
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
            
            // Reset running state
            isRunning = false;
            
            document.querySelector('.start').disabled = true;
            document.querySelector('.stop').disabled = false;
            document.getElementById('imsi').disabled = true;
            document.getElementById('ueCount').disabled = true;
            document.getElementById('interval').disabled = true;
            
            log(\`🎯 Started multi-UE session: \${ueCount} UEs every \${interval}s (waiting for each batch to complete)\`);
            log(\`📍 Next MSIN base: \${currentMsinBase ? currentMsinBase.toString().padStart(10, '0') : imsi.slice(-10)}\`);
            
            runMultiUeSession();
            intervalId = setInterval(runMultiUeSession, interval * 1000);
        }
        
        function stop() {
            clearInterval(intervalId);
            isRunning = false; // Reset running state
            document.querySelector('.start').disabled = false;
            document.querySelector('.stop').disabled = true;
            document.getElementById('imsi').disabled = false;
            document.getElementById('ueCount').disabled = false;
            document.getElementById('interval').disabled = false;
            log(\`🛑 Stopped after \${sessionCount} sessions (\${totalUeCount} total UEs)\`);
        }
    </script>
</body>
</html>
`;

// Run PacketRusher
function runPacketRusher(ueNumber = 1) {
	return new Promise((resolve) => {
		// Command that runs PacketRusher and forcefully closes terminal after 10 seconds
		// This starts PacketRusher, captures its PID, waits 10 seconds, then kills it if still running
		const command = `cd "${PACKETRUSHER_DIR}" && (./packetrusher ue & PID=$!; echo "UE #${ueNumber} PacketRusher started (PID: $PID)"; echo "Terminal will close in 10 seconds..."; sleep 10; kill $PID 2>/dev/null && echo "UE #${ueNumber} Process stopped" || echo "UE #${ueNumber} Process already finished")`;

		console.log(`\nExecuting command for UE #${ueNumber}: ${command}`);

		// Try different methods to open terminal
		// Method 1: gnome-terminal with bash -c
		exec(`gnome-terminal --title="PacketRusher UE #${ueNumber}" -- bash -c '${command}'`, (error) => {
			if (error) {
				console.log(`gnome-terminal failed for UE #${ueNumber}, trying xterm...`);
				// Method 2: xterm (without -hold so it closes automatically)
				exec(`xterm -title "PacketRusher UE #${ueNumber}" -e bash -c '${command}'`, (error2) => {
					if (error2) {
						console.log(`xterm failed for UE #${ueNumber}, trying x-terminal-emulator...`);
						// Method 3: x-terminal-emulator
						exec(`x-terminal-emulator -e bash -c '${command}'`, (error3) => {
							if (error3) {
								// If no terminal works, run directly in background
								console.log(`No terminal emulator worked for UE #${ueNumber}, running in background...`);
								console.log(`Executing: cd ${PACKETRUSHER_DIR} && ./packetrusher ue (with 10s timeout)`);

								const process = spawn('./packetrusher', ['ue'], {
									cwd: PACKETRUSHER_DIR,
									stdio: ['inherit', 'pipe', 'pipe'],
								});

								let output = '',
									errorOutput = '';
								let processKilled = false;

								// Kill process after 10 seconds
								const killTimer = setTimeout(() => {
									if (!processKilled) {
										processKilled = true;
										process.kill('SIGTERM');
										console.log(`UE #${ueNumber} PacketRusher process terminated after 10 seconds`);
									}
								}, 10000);

								process.stdout.on('data', (data) => {
									const text = data.toString();
									output += text;
									console.log(`[UE #${ueNumber} PacketRusher Output]:`, text.trim());
								});

								process.stderr.on('data', (data) => {
									const text = data.toString();
									errorOutput += text;
									console.error(`[UE #${ueNumber} PacketRusher Error]:`, text.trim());
								});

								process.on('close', (code) => {
									clearTimeout(killTimer);
									console.log(`UE #${ueNumber} PacketRusher exited with code ${code}`);
									resolve({
										success: true,
										output: processKilled
											? `UE #${ueNumber} Process stopped after 10 seconds`
											: `UE #${ueNumber} Process completed within 10 seconds`,
										error: errorOutput || '',
									});
								});

								process.on('error', (err) => {
									clearTimeout(killTimer);
									console.error(`Failed to start UE #${ueNumber} PacketRusher:`, err);
									resolve({ success: false, error: err.message });
								});
							} else {
								// x-terminal-emulator worked
								setTimeout(() => {
									resolve({
										success: true,
										output: `UE #${ueNumber} PacketRusher started in terminal (auto-closes after 10s)`,
										error: '',
									});
								}, 500);
							}
						});
					} else {
						// xterm worked
						setTimeout(() => {
							resolve({
								success: true,
								output: `UE #${ueNumber} PacketRusher started in xterm (auto-closes after 10s)`,
								error: '',
							});
						}, 500);
					}
				});
			} else {
				// gnome-terminal worked
				setTimeout(() => {
					resolve({
						success: true,
						output: `UE #${ueNumber} PacketRusher started in GNOME Terminal (auto-closes after 10s)`,
						error: '',
					});
				}, 500);
			}
		});
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
				const { imsi, ueNumber } = JSON.parse(body);

				if (!imsi || imsi.length !== 15) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ success: false, error: 'Invalid IMSI' }));
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

				// Update MSIN with the exact value from the incremented IMSI
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

				config.ue.msin = imsi.slice(-10);

				// Write config back
				await fs.writeFile(CONFIG_PATH, yaml.dump(config), 'utf8');

				// Run PacketRusher
				const result = await runPacketRusher(ueNumber);

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

// Start server
server.listen(PORT, async () => {
	console.log(`Server running at http://localhost:${PORT}`);
	console.log(`PacketRusher directory: ${PACKETRUSHER_DIR}`);
	console.log('\nChecking terminal emulators...');

	// Check which terminal emulators are available
	exec('which gnome-terminal', (err) => {
		if (!err) console.log('✓ gnome-terminal found');
		else console.log('✗ gnome-terminal not found (install with: sudo apt install gnome-terminal)');
	});

	exec('which x-terminal-emulator', (err) => {
		if (!err) console.log('✓ x-terminal-emulator found');
		else console.log('✗ x-terminal-emulator not found');
	});

	exec('which xterm', (err) => {
		if (!err) console.log('✓ xterm found');
		else console.log('✗ xterm not found (install with: sudo apt install xterm)');
	});

	exec('which konsole', (err) => {
		if (!err) console.log('✓ konsole found');
		else console.log('✗ konsole not found');
	});

	// Check if packetrusher binary exists
	try {
		await fs.access(BINARY_PATH);
		console.log(`\n✓ PacketRusher binary found: ${BINARY_PATH}`);
		// Check if it's executable
		try {
			await fs.access(BINARY_PATH, fsConstants.X_OK);
		} catch (err) {
			console.log('⚠ Binary may not be executable. Run: chmod +x ../PacketRusher/packetrusher');
		}
	} catch (err) {
		console.error(`\n✗ PacketRusher binary NOT found at: ${BINARY_PATH}`);
	}

	// Check if config.yml exists
	try {
		await fs.access(CONFIG_PATH);
		console.log(`✓ Config file found: ${CONFIG_PATH}`);
	} catch (err) {
		console.error(`✗ Config file NOT found at: ${CONFIG_PATH}`);
	}
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
    "js-yaml": "^4.1.0"
  }
}
*/
