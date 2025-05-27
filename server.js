const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const yaml = require('js-yaml');

const PORT = 3000;

// Paths to packetrusher folder (sibling folder)
const PACKETRUSHER_DIR = path.join(__dirname, '..', 'packetrusher');
const CONFIG_PATH = path.join(PACKETRUSHER_DIR, 'config.yaml');
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
    </style>
</head>
<body>
    <div class="container">
        <h1>PacketRusher Controller</h1>
        <input type="text" id="imsi" placeholder="IMSI (15 digits)" maxlength="15">
        <input type="number" id="interval" placeholder="Interval (seconds)" value="60" min="1">
        <button class="start" onclick="start()">Start</button>
        <button class="stop" onclick="stop()" disabled>Stop</button>
        <div id="logs"></div>
        <div class="path-info">Config: ../packetrusher/config.yaml</div>
    </div>
    <script>
        let intervalId;
        
        function log(msg) {
            const logs = document.getElementById('logs');
            const time = new Date().toLocaleTimeString();
            logs.innerHTML = \`[\${time}] \${msg}<br>\` + logs.innerHTML;
        }
        
        async function run() {
            const imsi = document.getElementById('imsi').value;
            log(\`Running with IMSI: \${imsi}\`);
            
            try {
                const res = await fetch('/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ imsi })
                });
                const data = await res.json();
                log(data.success ? 'Success' : \`Error: \${data.error}\`);
            } catch (e) {
                log(\`Error: \${e.message}\`);
            }
        }
        
        function start() {
            const imsi = document.getElementById('imsi').value;
            const interval = document.getElementById('interval').value;
            
            if (!imsi || imsi.length !== 15) {
                alert('Enter valid 15-digit IMSI');
                return;
            }
            
            document.querySelector('.start').disabled = true;
            document.querySelector('.stop').disabled = false;
            document.getElementById('imsi').disabled = true;
            document.getElementById('interval').disabled = true;
            
            log(\`Started with interval: \${interval}s\`);
            run();
            intervalId = setInterval(run, interval * 1000);
        }
        
        function stop() {
            clearInterval(intervalId);
            document.querySelector('.start').disabled = false;
            document.querySelector('.stop').disabled = true;
            document.getElementById('imsi').disabled = false;
            document.getElementById('interval').disabled = false;
            log('Stopped');
        }
    </script>
</body>
</html>
`;

// Run PacketRusher
function runPacketRusher() {
	return new Promise((resolve) => {
		// Run packetrusher from its directory
		const process = spawn(BINARY_PATH, ['-config', CONFIG_PATH], {
			cwd: PACKETRUSHER_DIR,
		});

		let output = '',
			error = '';

		process.stdout.on('data', (data) => (output += data));
		process.stderr.on('data', (data) => (error += data));

		process.on('close', (code) => {
			resolve({
				success: code === 0,
				output,
				error: error || (code !== 0 ? `Exit code: ${code}` : ''),
			});
		});

		process.on('error', (err) => {
			resolve({ success: false, error: err.message });
		});

		// Timeout after 30 seconds
		setTimeout(() => {
			process.kill();
			resolve({ success: false, error: 'Timeout after 30 seconds' });
		}, 30000);
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
				const { imsi } = JSON.parse(body);

				if (!imsi || imsi.length !== 15) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ success: false, error: 'Invalid IMSI' }));
					return;
				}

				// Check if config.yaml exists
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

				// Update MSIN (last 10 digits of IMSI)
				if (!config.ue) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(
						JSON.stringify({
							success: false,
							error: 'Invalid config.yaml structure - missing "ue" section',
						})
					);
					return;
				}

				config.ue.msin = imsi.slice(-10);

				// Write config back
				await fs.writeFile(CONFIG_PATH, yaml.dump(config), 'utf8');

				// Run PacketRusher
				const result = await runPacketRusher();

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

	// Check if packetrusher binary exists
	try {
		await fs.access(BINARY_PATH);
		console.log(`✓ PacketRusher binary found: ${BINARY_PATH}`);
	} catch (err) {
		console.error(`✗ PacketRusher binary NOT found at: ${BINARY_PATH}`);
	}

	// Check if config.yaml exists
	try {
		await fs.access(CONFIG_PATH);
		console.log(`✓ Config file found: ${CONFIG_PATH}`);
	} catch (err) {
		console.error(`✗ Config file NOT found at: ${CONFIG_PATH}`);
	}
});
